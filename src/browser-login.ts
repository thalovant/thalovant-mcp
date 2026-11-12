import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  DeviceAuthorization,
  MAX_DEVICE_NAME_LENGTH,
  ThalovantDeviceLoginDeniedError,
  ThalovantDeviceLoginExpiredError,
  ThalovantTimeoutError,
} from "@thalovant/sdk";
import type { ThalovantControlPlane } from "@thalovant/sdk";

/**
 * Interactive sign-ins, held by a stdio server between the tool calls that run
 * them.
 *
 * A tool call cannot wait for a person, so `thalovant_begin_browser_login`
 * starts `interactiveLogin()` of `@thalovant/sdk` and answers as soon as the
 * person has something to open; the sign-in keeps running here, in this
 * process, and `thalovant_poll_browser_login` reads how it ended. The SDK
 * chooses: through the browser (PKCE on a loopback redirect, RFC 8252) when
 * this computer can show one and the API offers it, a device login otherwise.
 *
 * Only over stdio. A loopback redirect reaches the computer the browser runs
 * on, and a stdio server runs on the person's own computer; a hosted server's
 * `127.0.0.1` is not theirs, so over Streamable HTTP the tools start a device
 * login instead and nothing here is used.
 *
 * Nothing secret reaches the model: the SDK keeps the PKCE verifier, the state
 * and the device code to itself, and the token an approved sign-in minted is
 * kept server-side for the principal that started it (see device-login.ts),
 * never returned.
 */

/** How a sign-in went: the browser, or a device code. */
export type SignInMethod = "browser" | "device";

/** What the person is shown: the consent page to open, or a code to enter. */
export type Shown =
  | { readonly method: "browser"; readonly authorizationUrl: string }
  | {
      readonly method: "device";
      readonly userCode: string;
      readonly verificationUri: string;
      readonly verificationUriComplete: string | null;
      readonly interval: number;
      readonly expiresIn: number;
    };

/** How a sign-in ended. */
export type SignInOutcome =
  | { readonly outcome: "approved"; readonly token: Record<string, unknown> }
  | { readonly outcome: "denied"; readonly status: number | null }
  | { readonly outcome: "expired"; readonly status: number | null }
  | { readonly outcome: "error"; readonly error: unknown };

/** A sign-in that was shown to the person and has not been reported as ended. */
interface Running {
  readonly principal: string;
  readonly shown: Shown;
  readonly abort: AbortController;
  /** Forgotten after this, whether or not anybody asked how it ended. */
  readonly keepUntil: number;
  outcome?: SignInOutcome;
}

/** Sign-ins one principal may have running at once; starting another stops its own oldest. */
const MAX_RUNNING_PER_PRINCIPAL = 4;
/** Sign-ins running at once on this server; past it a new one is refused rather than stopping another principal's. */
const MAX_RUNNING = 256;
/** How long an ended sign-in's outcome waits to be polled, past its own timeout. */
const OUTCOME_GRACE_MS = 300_000;
/** Each method's own wait, as the SDK applies it when none is given. */
export const DEFAULT_SIGN_IN_TIMEOUT_MS: Readonly<Record<SignInMethod, number>> = { browser: 300_000, device: 900_000 };
/** The name this server gives itself on the consent page. */
const DEVICE_LABEL = "thalovant-mcp";

/**
 * `thalovant-mcp on <hostname>`: what the consent page and the token show when
 * the caller names nothing, cut to the API's 120 code points. Over stdio the
 * host is the person's own computer.
 */
export function defaultDeviceName(host: string = hostname()): string {
  const name = host ? `${DEVICE_LABEL} on ${host}` : DEVICE_LABEL;
  return Array.from(name).slice(0, MAX_DEVICE_NAME_LENGTH).join("");
}

/**
 * The command that opens `url` in this computer's default browser, or
 * undefined for anything that is not a plain http(s) URL.
 *
 * `open` on macOS; `rundll32 url.dll,FileProtocolHandler` on Windows, never
 * `cmd /c start`, which splits the query at its `&`; `xdg-open` elsewhere. The
 * URL is one argument, never shell text. Read at every call, so a test that
 * sets `process.platform` is answered.
 */
export function browserCommand(url: string, platform: string = process.platform): [string, string[]] | undefined {
  if (/[\s\u0000-\u001f\u007f-\u009f]/u.test(url)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) return undefined;
  if (platform === "darwin") return ["open", ["--", parsed.href]];
  if (platform === "win32") return ["rundll32.exe", ["url.dll,FileProtocolHandler", parsed.href]];
  return ["xdg-open", [parsed.href]];
}

/**
 * Open `url` in this computer's browser, best-effort and without waiting.
 *
 * The child gets no stdio of ours: over stdio this process's stdout is the
 * protocol stream, and a browser that wrote to it would corrupt it. A failure
 * changes nothing, because the URL is in the tool's answer either way.
 */
export function openInBrowser(url: string): void {
  const command = browserCommand(url);
  if (!command) return;
  try {
    const child = spawn(command[0], command[1], { stdio: "ignore", detached: true, windowsHide: true });
    child.once("error", () => undefined);
    child.unref();
  } catch {
    // Best-effort: the URL was shown.
  }
}

/** The request a `fetch` was given, as a method and a path. */
function requestLine(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): { method: string; path: string } | undefined {
  try {
    const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    return { method, path: url.pathname };
  } catch {
    return undefined;
  }
}

/**
 * What one interactive sign-in showed the person, read from what the SDK did.
 *
 * `interactiveLogin()` prints its prompt rather than handing it over, so the
 * two moments the tool answers at are taken where the SDK lets a caller in:
 * `openUrl`, which it calls with the consent page, and the `fetch` the control
 * plane sends with, which sees the device authorization answer (the code to
 * enter; the device code itself is not kept). Whichever comes first is the
 * method the SDK chose. A device login's verification page, which the SDK
 * also hands to `openUrl`, is not opened: over this server a person reads the
 * code from the model, as with `thalovant_begin_device_login`.
 */
export class SignInWatch {
  /** Resolves with what the person is shown, once there is something. */
  readonly shown: Promise<Shown>;
  private resolveShown!: (shown: Shown) => void;
  private seen?: Shown;

  constructor(
    private readonly open: (url: string) => void = openInBrowser,
    private readonly send: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {
    this.shown = new Promise<Shown>((resolve) => {
      this.resolveShown = resolve;
    });
  }

  /** What was shown so far, if anything. */
  get current(): Shown | undefined {
    return this.seen;
  }

  /** Pass to the SDK as `openUrl`. */
  readonly openUrl = (url: string): void => {
    if (this.seen) return;
    this.show({ method: "browser", authorizationUrl: url });
    this.open(url);
  };

  /** Pass to the control plane as its `fetch`. */
  readonly fetch: typeof fetch = async (input, init) => {
    const response = await this.send(input, init);
    const line = requestLine(input, init);
    if (!this.seen && response.ok && line?.method === "POST" && line.path.endsWith("/v1/auth/device/authorize")) {
      try {
        const body: unknown = await response.clone().json();
        if (body && typeof body === "object" && !Array.isArray(body)) {
          // The SDK's own reading, with its checks: a grant it would refuse is
          // never shown, and the sign-in fails with the SDK's error instead.
          const grant = DeviceAuthorization.fromGrant(body as Record<string, unknown>);
          this.show({
            method: "device",
            userCode: grant.userCode,
            verificationUri: grant.verificationUri,
            verificationUriComplete: grant.verificationUriComplete,
            interval: grant.interval,
            expiresIn: grant.expiresIn,
          });
        }
      } catch {
        // Not a grant the SDK accepts; it says so itself.
      }
    }
    return response;
  };

  private show(shown: Shown): void {
    this.seen = shown;
    this.resolveShown(shown);
  }
}

/**
 * How an interactive sign-in's error reads as an outcome. A device login that
 * ran out of the wait it was given rejects with the SDK's own timeout error
 * rather than the expired one (the SDK keeps that error as it was); for the
 * person it is the same thing, nobody approved it in time, so it reads as
 * expired too.
 */
export function outcomeOf(error: unknown): SignInOutcome {
  if (error instanceof ThalovantDeviceLoginDeniedError) return { outcome: "denied", status: error.statusCode ?? null };
  if (error instanceof ThalovantDeviceLoginExpiredError) return { outcome: "expired", status: error.statusCode ?? null };
  if (error instanceof ThalovantTimeoutError) return { outcome: "expired", status: null };
  return { outcome: "error", error };
}

/** Options for {@link BrowserLogins.start}. */
export interface StartOptions {
  /** The wait the sign-in was given, or undefined for each method's own. */
  timeoutMs?: number;
  /** The tool call's own cancellation: it stops a sign-in that has not been shown yet. */
  signal?: AbortSignal;
}

export class BrowserLogins {
  private readonly running = new Map<string, Running>();

  /**
   * `approved` is told about every sign-in that ends approved, at once, so the
   * token is used from then on whether or not anybody polls.
   */
  constructor(
    private readonly approved: (principal: string, api: ThalovantControlPlane, scopes?: readonly string[]) => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Run `signIn` for `principal` and answer once the person has something to
   * open, with the id its polls name it by.
   *
   * `signIn` gets the signal that stops it. A sign-in that ends before
   * anything was shown -- an API that does not offer the forced method, a
   * cleartext API URL, a refused device authorization -- rejects here with
   * its own error. A principal runs at most a few at once, and starting
   * another stops only its own oldest; past the server's limit a new one is
   * refused.
   */
  async start(
    principal: string,
    api: ThalovantControlPlane,
    watch: SignInWatch,
    signIn: (signal: AbortSignal) => Promise<Record<string, unknown>>,
    options: StartOptions = {},
  ): Promise<{ loginId: string; shown: Shown }> {
    this.prune();
    const own = [...this.running].filter(([, login]) => login.principal === principal);
    for (const [loginId, login] of own.slice(0, Math.max(0, own.length - MAX_RUNNING_PER_PRINCIPAL + 1))) {
      login.abort.abort();
      this.running.delete(loginId);
    }
    if (this.running.size >= MAX_RUNNING) {
      throw new Error("Too many sign-ins are in progress on this server. Try again once some have finished or expired.");
    }
    const abort = new AbortController();
    const cancel = () => abort.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) abort.abort();
    let task: Promise<Record<string, unknown>>;
    try {
      task = signIn(abort.signal);
    } catch (error) {
      options.signal?.removeEventListener("abort", cancel);
      throw error;
    }
    const settled = task.then(
      (token) => ({ token }),
      (error: unknown) => ({ error }),
    );
    let first: { shown: Shown } | { token: Record<string, unknown> } | { error: unknown };
    try {
      first = await Promise.race([watch.shown.then((shown) => ({ shown })), settled]);
    } finally {
      // Once shown, the sign-in belongs to the person, not to the call that began it.
      options.signal?.removeEventListener("abort", cancel);
    }
    if ("error" in first && !watch.current) throw first.error;
    const shown = "shown" in first ? first.shown : watch.current;
    if (!shown) {
      // Approved without ever showing anything: not a sign-in this server can report.
      throw new Error("The sign-in ended before it showed anything to open.");
    }
    const loginId = randomUUID();
    const login: Running = {
      principal,
      shown,
      abort,
      keepUntil: this.now() + (options.timeoutMs ?? DEFAULT_SIGN_IN_TIMEOUT_MS[shown.method]) + OUTCOME_GRACE_MS,
    };
    this.running.set(loginId, login);
    void settled.then((ended) => {
      if ("token" in ended) {
        login.outcome = { outcome: "approved", token: ended.token };
        // A sign-in stopped to make room was never approved by anyone waiting for it.
        if (!abort.signal.aborted) this.approved(principal, api, scopesOfToken(ended.token));
      } else {
        login.outcome = outcomeOf(ended.error);
      }
    });
    return { loginId, shown };
  }

  /**
   * How the sign-in `loginId` names is going, if `principal` started it: its
   * outcome once it ended, which forgets it, or undefined for still pending.
   * Returns null when there is no such sign-in for this principal.
   */
  poll(loginId: string, principal: string): { shown: Shown; outcome?: SignInOutcome } | null {
    this.prune();
    const login = this.running.get(loginId);
    if (!login || login.principal !== principal) return null;
    if (login.outcome) this.running.delete(loginId);
    return { shown: login.shown, outcome: login.outcome };
  }

  private prune(): void {
    const now = this.now();
    for (const [loginId, login] of this.running) {
      if (login.keepUntil > now) continue;
      login.abort.abort();
      this.running.delete(loginId);
    }
  }
}

/**
 * The scopes a token answer grants: `scopes` as a list, or `scope` as the
 * space-separated string OAuth uses; undefined when it says neither.
 */
function scopesOfToken(token: Record<string, unknown>): string[] | undefined {
  if (Array.isArray(token.scopes) && token.scopes.every((scope) => typeof scope === "string")) return [...token.scopes] as string[];
  if (typeof token.scope === "string") return token.scope.split(/\s+/u).filter(Boolean);
  return undefined;
}
