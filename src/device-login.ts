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

/** Sign-ins one principal may have pending at once; its own oldest is dropped first. */
const MAX_PENDING_PER_PRINCIPAL = 4;
/**
 * Sign-ins pending at once across every principal. Past it a new sign-in is
 * refused rather than evicting somebody else's: dropping another principal's
 * sign-in would let one caller keep everyone else from ever signing in.
 */
const MAX_PENDING_LOGINS = 256;

export class DeviceLogins {
  private readonly pending = new Map<string, PendingLogin>();
  private readonly signedIn = new Map<string, SignedIn>();
  /** The id of the token each principal last revoked, until it signs in again. */
  private readonly revoked = new Map<string, string | null>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Keep a started sign-in for `principal`; returns the id its polls name it by.
   *
   * A principal holds at most a few at once, and starting another drops only
   * its own oldest. Throws when the server as a whole holds as many as it will.
   */
  start(principal: string, api: ThalovantControlPlane, authorization: DeviceAuthorization): string {
    this.prune();
    const own = [...this.pending].filter(([, login]) => login.principal === principal);
    for (const [loginId] of own.slice(0, Math.max(0, own.length - MAX_PENDING_PER_PRINCIPAL + 1))) {
      this.pending.delete(loginId);
    }
    if (this.pending.size >= MAX_PENDING_LOGINS) {
      throw new Error("Too many device sign-ins are in progress on this server. Try again once some have finished or expired.");
    }
    const loginId = randomUUID();
    this.pending.set(loginId, {
      principal,
      api,
      authorization,
      expiresAt: this.now() + authorization.expiresIn * 1000,
    });
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
    this.revoked.delete(principal);
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

  /** Forget `principal`'s token, remembering its id as revoked. */
  signOut(principal: string, tokenId: string | null = null): void {
    this.signedIn.delete(principal);
    this.revoked.set(principal, tokenId);
  }

  /**
   * The id of the token `principal` signed out of, when it has signed out and
   * not signed in since; undefined when it never signed out.
   */
  revokedOf(principal: string): string | null | undefined {
    return this.revoked.has(principal) ? this.revoked.get(principal)! : undefined;
  }

  private prune(): void {
    const now = this.now();
    for (const [loginId, login] of this.pending) {
      if (login.expiresAt <= now) this.pending.delete(loginId);
    }
  }
}
