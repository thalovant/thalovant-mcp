import { randomUUID } from "node:crypto";
import type { DeviceAuthorization, ThalovantControlPlane } from "@thalovant/sdk";

/**
 * Device sign-ins, held by the server between the tool calls that run them.
 *
 * A tool call cannot wait for a person to approve a sign-in in a browser, so
 * the device flow is two tools: one starts it and one polls it. What sits
 * between them stays here, in this process, and never reaches the model: the
 * device code (the secret half of the grant) behind an opaque login id, and
 * the token an approved sign-in minted. Both belong to the principal that
 * started the sign-in; another principal can neither poll it nor use its token.
 */

/** A sign-in started and not finished. */
interface PendingLogin {
  readonly principal: string;
  readonly api: ThalovantControlPlane;
  readonly authorization: DeviceAuthorization;
  readonly expiresAt: number;
}

/** The token an approved sign-in minted, on the control plane that holds it. */
export interface SignedIn {
  readonly api: ThalovantControlPlane;
  readonly origin: string;
}

/** Sign-ins pending at once, across principals; the oldest is dropped first. */
const MAX_PENDING_LOGINS = 32;

export class DeviceLogins {
  private readonly pending = new Map<string, PendingLogin>();
  private readonly signedIn = new Map<string, SignedIn>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Keep a started sign-in for `principal`; returns the id its polls name it by. */
  start(principal: string, api: ThalovantControlPlane, authorization: DeviceAuthorization): string {
    this.prune();
    const loginId = randomUUID();
    this.pending.set(loginId, {
      principal,
      api,
      authorization,
      expiresAt: this.now() + authorization.expiresIn * 1000,
    });
    while (this.pending.size > MAX_PENDING_LOGINS) {
      const oldest = this.pending.keys().next();
      if (oldest.done) break;
      this.pending.delete(oldest.value);
    }
    return loginId;
  }

  /** The pending sign-in `loginId` names, if `principal` started it and it has not expired. */
  find(loginId: string, principal: string): PendingLogin | undefined {
    this.prune();
    const login = this.pending.get(loginId);
    return login && login.principal === principal ? login : undefined;
  }

  /** Forget a sign-in that ended: approved, expired or denied. */
  finish(loginId: string): void {
    this.pending.delete(loginId);
  }

  /** Keep the token an approved sign-in minted, as `principal`'s. */
  approve(principal: string, api: ThalovantControlPlane): void {
    this.signedIn.set(principal, { api, origin: new URL(api.apiUrl).origin });
  }

  /** The token `principal` signed in with on `origin`, if there is one. */
  signedInOn(principal: string, origin: string): SignedIn | undefined {
    const signedIn = this.signedIn.get(principal);
    return signedIn && signedIn.origin === origin && signedIn.api.accessToken ? signedIn : undefined;
  }

  /** The token `principal` signed in with, wherever. */
  signedInAs(principal: string): SignedIn | undefined {
    const signedIn = this.signedIn.get(principal);
    return signedIn?.api.accessToken ? signedIn : undefined;
  }

  signOut(principal: string): void {
    this.signedIn.delete(principal);
  }

  private prune(): void {
    const now = this.now();
    for (const [loginId, login] of this.pending) {
      if (login.expiresAt <= now) this.pending.delete(loginId);
    }
  }
}
