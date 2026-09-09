/** Runtime identities admit one Noise session at a time across MCP tool calls. */
interface RuntimeClosable {
  close(): Promise<void>;
  waitForClosed(): Promise<void>;
}

const leases = new Map<string, Promise<void>>();

/** A caller timeout never releases an identity before actual cleanup settles. */
export async function withRuntimeLease<T, C extends RuntimeClosable>(
  key: string, client: C, run: (client: C) => Promise<T>,
): Promise<T> {
  const previous = leases.get(key) ?? Promise.resolve();
  let release!: () => void;
  let fail!: (error: Error) => void;
  const current = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
  // A failed cleanup poisons this identity's barrier. Observe it even when no
  // later caller arrives; later tools fail instead of replacing that session.
  void current.catch(() => undefined);
  leases.set(key, current);
  try {
    await previous;
  } catch (error) {
    fail(new Error("Previous runtime session cleanup failed; this identity remains unavailable."));
    throw error;
  }
  try {
    return await run(client);
  } finally {
    const closing = client.close();
    void client.waitForClosed().then(() => {
      release();
      if (leases.get(key) === current) leases.delete(key);
    }, () => {
      fail(new Error("Previous runtime session cleanup failed; this identity remains unavailable."));
    });
    await closing;
  }
}
