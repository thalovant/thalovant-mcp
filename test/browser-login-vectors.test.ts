/**
 * Browser sign-in against the reference's vectors, `browser-login-vectors.json`.
 *
 * This server signs a person in through `@thalovant/sdk`, so every case runs
 * against the SDK that resolves here: the pure sections (PKCE, the redirect,
 * the authorization URL, the configuration, the browser rule) against the
 * functions that decide them, the callbacks through the SDK's own loopback
 * listener (a raw browser request to the port `browserLogin()` bound), and
 * `sign_ins` and `chooser` for real -- a loopback API serves each case's
 * exchanges in order and checks every request, and a raw TCP client plays the
 * browser against the port in the URL.
 *
 * `sign_ins` and `chooser` then run a second time through the tools, over
 * stdio against the built server: `thalovant_begin_browser_login` (method
 * browser for a sign-in case; the case's method for a chooser case, in a server
 * started with the case's environment and platform),
 * `thalovant_poll_browser_login` and `thalovant_revoke_device_login`. What the
 * tools produced is recorded under the same `<section>/<name>`, so a tool that
 * produced anything else than the SDK fails the recorder. Through the tools,
 * the prompt the SDK prints must reach the server's stderr, and the consent
 * page must be opened with the platform's opener (stand-ins here) while a
 * device login's page is not.
 */
import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
  browserAuthorizationUrl,
  canOpenBrowser,
  challengeFor,
  loopbackRedirectUri,
  NativeSignInConfig,
  ThalovantApiError,
  ThalovantControlPlane,
  ThalovantDeviceLoginDeniedError,
  ThalovantDeviceLoginExpiredError,
} from "@thalovant/sdk";
import { afterAll, beforeAll, describe, test } from "vitest";

import {
  BROWSER,
  BROWSER_VARIABLES,
  BrowserShims,
  checkPageHeaders,
  deadline,
  failedResult,
  http,
  NODE_PLATFORMS,
  noSecretsIn,
  pollUntilEnded,
  polledResult,
  refused,
  ScriptedApi,
  Signing,
  sleep,
  stdioServer,
  tool,
  type Json,
  type SignInCase,
} from "./browser-login-harness.js";
import { record } from "./conformance-record.js";

const SECTIONS = ["pkce", "redirect_uris", "authorization_urls", "config", "environment", "callbacks", "sign_ins", "chooser"];

function recorded(section: string, name: string, produced: unknown): void {
  record("browser-login-vectors.json", `${section}/${name}`, produced);
}

// -- the pure sections, through the SDK under this server ----------------------------

describe("the SDK under this server decides what the vectors say", () => {
  for (const vector of BROWSER.pkce) {
    test(`pkce: ${vector.name}`, async () => {
      const produced = { challenge: await challengeFor(vector.verifier) };
      recorded("pkce", vector.name, produced);
      assert.deepEqual(produced, vector.expect);
    });
  }

  for (const vector of BROWSER.redirect_uris) {
    test(`redirect_uris: ${vector.name}`, () => {
      let produced: Json;
      try {
        produced = { redirect_uri: loopbackRedirectUri(vector.port) };
      } catch (error) {
        assert.ok(error instanceof RangeError, String(error));
        produced = { error: "invalid_port" };
      }
      recorded("redirect_uris", vector.name, produced);
      assert.deepEqual(produced, vector.expect);
    });
  }

  for (const vector of BROWSER.authorization_urls) {
    test(`authorization_urls: ${vector.name}`, () => {
      const given = vector.input;
      const produced = {
        url: browserAuthorizationUrl(given.authorization_endpoint, {
          clientId: given.client_id,
          redirectUri: loopbackRedirectUri(given.port),
          codeChallenge: given.code_challenge,
          state: given.state,
          scopes: given.scopes,
          deviceName: given.device_name,
        }),
      };
      recorded("authorization_urls", vector.name, produced);
      assert.deepEqual(produced, vector.expect);
    });
  }

  for (const vector of BROWSER.config) {
    test(`config: ${vector.name}`, () => {
      let produced: Json;
      try {
        const config = NativeSignInConfig.fromResponse(vector.body);
        produced = {
          usable: true,
          authorization_endpoint: config.authorizationEndpoint,
          token_endpoint: config.tokenEndpoint,
          sdk_client_id: config.sdkClientId,
        };
      } catch (error) {
        // Unusable is an error with no status: the API did not refuse.
        assert.ok(error instanceof ThalovantApiError, String(error));
        assert.equal(error.statusCode, undefined);
        produced = { usable: false };
      }
      recorded("config", vector.name, produced);
      assert.deepEqual(produced, vector.expect);
    });
  }

  for (const vector of BROWSER.environment) {
    test(`environment: ${vector.name}`, () => {
      const produced = { browser: canOpenBrowser(vector.env, vector.platform) };
      recorded("environment", vector.name, produced);
      assert.deepEqual(produced, vector.expect);
    });
  }
});

// -- what the SDK did, read the vectors' way ------------------------------------------

/** The vectors' result shape, read from what a sign-in resolved or rejected with. */
function result(plane: ThalovantControlPlane, outcome: { value?: Json; error?: unknown }): Json {
  const error = outcome.error;
  if (error !== undefined) {
    if (error instanceof ThalovantDeviceLoginDeniedError) return { outcome: "denied", status: error.statusCode ?? null };
    if (error instanceof ThalovantDeviceLoginExpiredError) return { outcome: "expired", status: error.statusCode ?? null };
    assert.ok(error instanceof ThalovantApiError, String(error));
    const produced: Json = { outcome: "error", status: error.statusCode ?? null, code: error.code ?? null };
    if (error.statusCode !== undefined) produced.detail = error.detail ?? null;
    return produced;
  }
  const token = outcome.value!;
  assert.equal(plane.accessToken, token.access_token);
  assert.equal(plane.tokenId, token.token_id);
  return { outcome: "approved", token_type: token.token_type, scopes: token.scopes, expires_at: token.expires_at, token_id: token.token_id };
}

/** No synthetic secret, nor the verifier or the state this sign-in generated, in any printed form of the error. */
function noSecrets(error: unknown, api: ScriptedApi): void {
  const forms = error instanceof Error
    ? [
        error.message,
        String(error),
        inspect(error),
        JSON.stringify(error),
        error.stack ?? "",
        JSON.stringify((error as ThalovantApiError).problem ?? null),
        JSON.stringify(error.cause ?? null),
      ]
    : [String(error)];
  for (const form of forms) noSecretsIn(form, api);
}

/**
 * Run one sign-in through the SDK for real: serve the case's API, take the URL
 * from `handOver`, play the case's browser requests against its port, and
 * read what came of it.
 */
async function sdkSignIn(
  vector: SignInCase,
  start: (plane: ThalovantControlPlane, handOver: (url: string) => void) => Promise<Json>,
): Promise<{ produced: Json; api: ScriptedApi }> {
  const api = await new ScriptedApi(vector.exchanges).start();
  const plane = new ThalovantControlPlane(api.url);
  try {
    let handOver!: (url: string) => void;
    const opened = new Promise<string>((resolve) => {
      handOver = resolve;
    });
    const task = start(plane, (url) => handOver(url)).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const produced: Json = {};
    const first = await deadline(
      Promise.race([opened.then((url) => ({ url })), task.then(() => ({ url: undefined }))]),
      10_000,
      "the sign-in neither opened a URL nor ended",
    );
    if (first.url !== undefined) {
      const signing = (api.signing = new Signing(first.url));
      produced.authorization_url = signing.urlRecord();
      const browser: Json[] = [];
      for (const request of vector.requests) {
        const answer = await http(signing.port, request.method, request.target.replaceAll("{state}", signing.state));
        checkPageHeaders(answer);
        browser.push(answer.status === 200 ? { status: answer.status, page: answer.page } : { status: answer.status });
      }
      produced.browser = browser;
    }
    const outcome: { value?: Json; error?: unknown } = await deadline(task, 10_000, "the sign-in");
    if ("error" in outcome) noSecrets(outcome.error, api);
    if (api.signing) produced.closed = await refused(api.signing.port);
    if (api.exchange) produced.exchange = api.exchange;
    produced.result = result(plane, outcome);
    if (vector.call.then === "revoke" && (produced.result as Json).outcome === "approved") {
      await plane.revokeApiToken();
      assert.equal(plane.accessToken, undefined);
      // Idempotent: revoking again sends nothing.
      await plane.revokeApiToken();
      produced.result = { outcome: "revoked" };
    }
    return { produced, api };
  } finally {
    await api.stop();
  }
}

/** This process as a case's machine, for `run`: its platform and the variables the browser rule reads. */
async function asMachine<T>(vector: SignInCase, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(BROWSER_VARIABLES.map((name) => [name, process.env[name]]));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    for (const name of BROWSER_VARIABLES) delete process.env[name];
    Object.assign(process.env, vector.env ?? {});
    Object.defineProperty(process, "platform", { ...platform, value: NODE_PLATFORMS[vector.platform!] ?? vector.platform });
    return await run();
  } finally {
    Object.defineProperty(process, "platform", platform);
    for (const name of BROWSER_VARIABLES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

/** A callback's meaning as the vectors record it, from what the listener answered and how the sign-in ended. */
async function callbackThroughListener(vector: (typeof BROWSER.callbacks)[number]): Promise<Json> {
  // A code is exchanged, so the API answers the exchange; nothing else reaches it after the configuration.
  const config = BROWSER.sign_ins[0]!.exchanges[0]!;
  const token = BROWSER.sign_ins[0]!.exchanges[1]!;
  const api = await new ScriptedApi([config, { request: { method: "POST", path: token.request.path }, response: token.response }]).start();
  const plane = new ThalovantControlPlane(api.url);
  const stop = new AbortController();
  try {
    let url: string | undefined;
    const task = plane
      .browserLogin({ openBrowser: false, prompt: (shown) => (url = shown), signal: stop.signal, timeoutMs: 10_000, deviceName: "callbacks" })
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    const until = Date.now() + 10_000;
    while (url === undefined && Date.now() < until) await sleep(5);
    assert.ok(url, "the sign-in showed no URL");
    const signing = (api.signing = new Signing(url));
    const answer = await http(signing.port, vector.request.method, vector.request.target.replaceAll("{state}", signing.state));
    checkPageHeaders(answer);
    let ended: { value?: Json; error?: unknown };
    if (answer.status !== 200) {
      // Turned away, and the sign-in waits on: still pending until it is stopped.
      const pending = await Promise.race([task.then(() => false), sleep(100).then(() => true)]);
      assert.equal(pending, true, "a turned-away request ended the sign-in");
      stop.abort();
      ended = await task;
      assert.equal((ended.error as Error | undefined)?.name, "AbortError");
      return { status: answer.status, outcome: "ignored" };
    }
    ended = await deadline(task, 10_000, "the sign-in");
    if (!("error" in ended)) return { status: 200, outcome: "code", code: (api.exchange as Json).code };
    noSecrets(ended.error, api);
    if (ended.error instanceof ThalovantDeviceLoginDeniedError) return { status: 200, outcome: "denied" };
    assert.ok(ended.error instanceof ThalovantApiError, String(ended.error));
    assert.equal(ended.error.statusCode, undefined);
    return { status: 200, outcome: "failed", error: ended.error.code ?? null };
  } finally {
    stop.abort();
    await api.stop();
  }
}

describe("the SDK under this server signs in as the vectors say", () => {
  for (const vector of BROWSER.callbacks) {
    test(`callbacks: ${vector.name}`, async () => {
      const produced = await callbackThroughListener(vector);
      recorded("callbacks", vector.name, produced);
      assert.deepEqual(produced, vector.expect);
    });
  }

  for (const vector of BROWSER.sign_ins) {
    test(`sign_ins: ${vector.name}`, async () => {
      const call = vector.call;
      let opened = false;
      const { produced, api } = await sdkSignIn(vector, (plane, handOver) =>
        plane.browserLogin({
          scopes: call.scopes,
          deviceName: call.device_name,
          openBrowser: false,
          prompt: handOver,
          openUrl: () => {
            opened = true;
          },
          ...(call.timeout_ms !== undefined ? { timeoutMs: call.timeout_ms } : {}),
        }),
      );
      recorded("sign_ins", vector.name, produced);
      assert.equal(opened, false, "openBrowser: false opened the browser");
      assert.deepEqual(api.mismatches, []);
      assert.equal(api.index, vector.exchanges.length, `not every exchange was used: ${JSON.stringify(api.sent)}`);
      assert.deepEqual(produced, vector.expect);
    });
  }

  for (const vector of BROWSER.chooser) {
    test(`chooser: ${vector.name}`, async () => {
      const call = vector.call;
      const printed: string[] = [];
      const log = console.log;
      console.log = (...items: unknown[]) => void printed.push(items.map(String).join(" "));
      let consent: string | undefined;
      let outcome: { produced: Json; api: ScriptedApi };
      try {
        outcome = await asMachine(vector, () =>
          sdkSignIn(vector, (plane, handOver) =>
            plane.interactiveLogin({
              method: call.method as "auto" | "browser" | "device",
              deviceName: call.device_name,
              // The browser the SDK opens. A device login opens its
              // verification page too; only the consent page is this test's to answer.
              openUrl: (url: string) => {
                if (url.includes("response_type=code")) {
                  consent = url;
                  handOver(url);
                }
              },
              ...(call.timeout_ms !== undefined ? { timeoutMs: call.timeout_ms } : {}),
            }),
          ),
        );
      } finally {
        console.log = log;
      }
      const { produced, api } = outcome;
      const method = api.sent.includes("POST /v1/auth/device/authorize") ? "device" : "browser";
      const chosen = { method, result: produced.result };
      recorded("chooser", vector.name, chosen);
      assert.deepEqual(api.mismatches, []);
      assert.equal(api.index, vector.exchanges.length, `not every exchange was used: ${JSON.stringify(api.sent)}`);
      assert.deepEqual(chosen, vector.expect);
      if (consent !== undefined) {
        assert.equal(produced.closed, true);
        // Shown as well as opened: opening a browser can fail without a word.
        assert.ok(printed.includes(BROWSER.prompt.opening.replace("{url}", consent)), JSON.stringify(printed));
      }
    });
  }
});

// -- through the tools, over stdio ------------------------------------------------------

/** The begin arguments for a case: method, the name on the consent page, the scopes and the tool's own one-second floor on the wait. */
function beginArguments(call: SignInCase["call"], method: string): Json {
  return {
    method,
    deviceName: call.device_name,
    ...(call.scopes ? { scopes: call.scopes } : {}),
    ...(call.timeout_ms !== undefined ? { timeoutMs: Math.max(1_000, call.timeout_ms) } : {}),
  };
}

/**
 * One case through the tools against `api`: begin, play the browser against
 * the port in the URL the tool answered with, poll until it ended, check the
 * port and sign out when the case says so. `stderr` is the server's log.
 */
async function toolSignIn(
  client: Awaited<ReturnType<typeof stdioServer>>,
  api: ScriptedApi,
  shims: BrowserShims,
  vector: SignInCase,
  method: string,
): Promise<{ produced: Json; shown?: string }> {
  const produced: Json = {};
  const begun = await tool(client.client, "thalovant_begin_browser_login", beginArguments(vector.call, method));
  if (begun.error) {
    // Ended before anything was shown: the tool's error text, read the way a model reads it.
    noSecretsIn(begun.text, api);
    produced.result = failedResult(begun.text);
    return { produced };
  }
  const out = begun.json!;
  assert.equal(typeof out.loginId, "string");
  let shown: string | undefined;
  if (out.method === "browser") {
    const url = out.authorizationUrl as string;
    shown = url;
    const signing = (api.signing = new Signing(url));
    noSecretsIn(begun.text, api, true);
    produced.authorization_url = signing.urlRecord();
    const browser: Json[] = [];
    for (const request of vector.requests) {
      const answer = await http(signing.port, request.method, request.target.replaceAll("{state}", signing.state));
      checkPageHeaders(answer);
      browser.push(answer.status === 200 ? { status: answer.status, page: answer.page } : { status: answer.status });
    }
    produced.browser = browser;
    // Shown on the server's log as well as in the answer, and the consent page opened.
    assert.ok(await shims.openedWithin(url), `the consent page was not opened: ${JSON.stringify(shims.opened())}`);
  } else {
    assert.equal(out.method, "device");
    assert.equal(typeof out.userCode, "string");
    noSecretsIn(begun.text, api);
  }
  const ended = await pollUntilEnded(client.client, out.loginId as string);
  assert.equal(ended.error, false, ended.text);
  noSecretsIn(ended.text, api);
  assert.equal(ended.json!.method, out.method);
  if (api.signing) produced.closed = await refused(api.signing.port);
  if (api.exchange) produced.exchange = api.exchange;
  produced.result = polledResult(ended.json!);
  if (vector.call.then === "revoke" && (produced.result as Json).outcome === "approved") {
    const revoked = await tool(client.client, "thalovant_revoke_device_login", {});
    assert.equal(revoked.error, false, revoked.text);
    assert.equal(revoked.json!.revoked, true);
    // Idempotent: signing out again answers without a request.
    const sent = api.sent.length;
    const again = await tool(client.client, "thalovant_revoke_device_login", {});
    assert.equal(again.json!.alreadyRevoked, true);
    assert.equal(api.sent.length, sent);
    produced.result = { outcome: "revoked" };
  }
  return { produced, shown };
}

/** The prompt the SDK printed for a consent page, which must be on the server's stderr. */
async function promptedOnStderr(stderr: () => string, expected: string): Promise<boolean> {
  const until = Date.now() + 5_000;
  while (Date.now() < until && !stderr().includes(expected)) await sleep(25);
  return stderr().includes(expected);
}

describe("the browser sign-in tools sign in as the vectors say", () => {
  const api = new ScriptedApi();
  const shims = new BrowserShims();
  let server: Awaited<ReturnType<typeof stdioServer>>;
  beforeAll(async () => {
    await api.start();
    server = await stdioServer({ env: { THALOVANT_API_URL: api.url }, shims });
  }, 15_000);
  afterAll(async () => {
    await server?.client.close();
    await api.stop();
    shims.remove();
  });

  for (const vector of BROWSER.sign_ins) {
    test(`sign_ins: ${vector.name}`, async () => {
      api.use(vector.exchanges);
      const { produced, shown } = await toolSignIn(server, api, shims, vector, "browser");
      recorded("sign_ins", vector.name, produced);
      assert.deepEqual(api.mismatches, []);
      assert.ok(api.allUsed, `not every exchange was used: ${JSON.stringify(api.sent)}`);
      assert.deepEqual(produced, vector.expect);
      if (shown) assert.ok(await promptedOnStderr(server.stderr, BROWSER.prompt.opening.replace("{url}", shown)), server.stderr());
    }, 20_000);
  }

  for (const vector of BROWSER.chooser) {
    test(`chooser: ${vector.name}`, async () => {
      const own = await new ScriptedApi(vector.exchanges).start();
      const ownShims = new BrowserShims();
      const machine = await stdioServer({ env: { THALOVANT_API_URL: own.url, ...(vector.env ?? {}) }, shims: ownShims, platform: vector.platform });
      try {
        const { produced, shown } = await toolSignIn(machine, own, ownShims, vector, vector.call.method!);
        const method = own.sent.includes("POST /v1/auth/device/authorize") ? "device" : "browser";
        const chosen = { method, result: produced.result };
        recorded("chooser", vector.name, chosen);
        assert.deepEqual(own.mismatches, []);
        assert.ok(own.allUsed, `not every exchange was used: ${JSON.stringify(own.sent)}`);
        assert.deepEqual(chosen, vector.expect);
        if (shown) {
          assert.equal(produced.closed, true);
          assert.ok(await promptedOnStderr(machine.stderr, BROWSER.prompt.opening.replace("{url}", shown)), machine.stderr());
        }
        if (method === "device") {
          // The device login's prompt reached the log too, and its page was not opened.
          assert.ok(await promptedOnStderr(machine.stderr, "To sign in, visit "), machine.stderr());
          assert.deepEqual(ownShims.opened(), []);
        }
      } finally {
        await machine.client.close();
        await own.stop();
        ownShims.remove();
      }
    }, 20_000);
  }
});

// -- the file itself ---------------------------------------------------------------------

test("every section of the vectors is run", () => {
  const present = Object.entries(BROWSER)
    .filter(([, value]) => Array.isArray(value) && value.length && typeof value[0] === "object" && "name" in value[0])
    .map(([key]) => key)
    .sort();
  assert.deepEqual(present, [...SECTIONS].sort());
  const total = SECTIONS.reduce((sum, section) => sum + (BROWSER[section as keyof typeof BROWSER] as unknown[]).length, 0);
  assert.equal(total, 98);
});

test("the RFC 7636 vector is the first PKCE case", () => {
  const first = BROWSER.pkce[0]!;
  assert.equal(first.verifier, "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
  assert.deepEqual(first.expect, { challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" });
});
