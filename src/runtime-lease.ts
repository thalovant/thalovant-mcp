/** Runtime identities admit one Noise session at a time across MCP tool calls. */
interface RuntimeClosable {
  close(): Promise<void>;
  waitForClosed(): Promise<void>;
}

const leases = new Map<string, Promise<void>>();

/** A caller timeout never releases an identity before actual cleanup settles. */
export async function withRuntimeLease<T, C extends RuntimeClosable>(
  key: string, createClient: () => C, run: (client: C) => Promise<T>,
  acquireTimeoutMs = 6000,
): Promise<T> {
  if (!Number.isFinite(acquireTimeoutMs) || acquireTimeoutMs <= 0) {
    throw new Error("Runtime identity acquisition deadline expired.");
  }
  const previous = leases.get(key) ?? Promise.resolve();
  let release!: () => void;
  let fail!: (error: Error) => void;
  const current = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
  // A failed cleanup poisons this identity's barrier. Observe it even when no
  // later caller arrives; later tools fail instead of replacing that session.
  void current.catch(() => undefined);
  leases.set(key, current);
  const releaseIdentity = () => {
    release();
    if (leases.get(key) === current) leases.delete(key);
  };
  const failIdentity = () => {
    fail(new Error("Previous runtime session cleanup failed; this identity remains unavailable."));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Runtime identity acquisition deadline expired; previous session cleanup is still pending.")), acquireTimeoutMs);
      }),
    ]);
  } catch (error) {
    // An expired waiter never runs or closes its unused client. Its place in
    // the chain remains occupied until the prior owner actually retires.
    void previous.then(releaseIdentity, failIdentity);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  let client: C;
  try {
    client = createClient();
  } catch (error) {
    releaseIdentity();
    throw error;
  }
  try {
    return await run(client);
  } finally {
    let closing: Promise<void>;
    try {
      closing = client.close();
    } catch (error) {
      failIdentity();
      throw error;
    }
    void client.waitForClosed().then(releaseIdentity, failIdentity);
    await closing;
  }
}
