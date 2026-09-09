/** Runtime identities admit one Noise session at a time across MCP tool calls. */
interface RuntimeClosable {
  close(): Promise<void>;
  waitForClosed(): Promise<void>;
}

const leases = new Map<string, Promise<void>>();

function cancellationError(): Error {
  // MCP cancellation reasons are caller supplied and may contain credentials.
  const error = new Error("Runtime tool request cancelled.");
  error.name = "AbortError";
  return error;
}

export function throwIfRuntimeCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationError();
}

/** Caller cancellation/deadlines never release an identity before owned work and cleanup settle. */
export async function withRuntimeLease<T, C extends RuntimeClosable>(
  key: string, createClient: () => C, run: (client: C) => Promise<T>,
  acquireTimeoutMs = 6000, signal?: AbortSignal,
): Promise<T> {
  throwIfRuntimeCancelled(signal);
  if (!Number.isFinite(acquireTimeoutMs) || acquireTimeoutMs <= 0) {
    throw new Error("Runtime identity acquisition deadline expired.");
  }
  const previous = leases.get(key) ?? Promise.resolve();
  let release!: () => void;
  let fail!: (error: Error) => void;
  const current = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
  // Observe poisoned barriers even when no later caller arrives.
  void current.catch(() => undefined);
  leases.set(key, current);
  const releaseIdentity = () => {
    release();
    if (leases.get(key) === current) leases.delete(key);
  };
  const failIdentity = () => {
    fail(new Error("Previous runtime session cleanup failed; this identity remains unavailable."));
  };
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(cancellationError());
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  // The signal may fire during a synchronous client factory or cleanup callback.
  // Observe it even when execution fails before the final race is installed.
  void cancelled.catch(() => undefined);
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        previous, cancelled,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Runtime identity acquisition deadline expired; previous session cleanup is still pending.")), acquireTimeoutMs);
        }),
      ]);
      throwIfRuntimeCancelled(signal);
    } catch (error) {
      // An abandoned waiter never constructs a client or runs later. Its place
      // in the chain remains occupied until the prior owner actually retires.
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
    const owned = (async () => {
      try {
        throwIfRuntimeCancelled(signal);
        return await run(client);
      } finally {
        let closing: Promise<void>;
        try {
          closing = client.close();
          // Observe close independently if waitForClosed throws synchronously.
          void closing.catch(() => undefined);
          void client.waitForClosed().then(releaseIdentity, failIdentity);
        } catch (error) {
          failIdentity();
          throw error;
        }
        await closing;
      }
    })();
    // SDK methods accepting a signal can retire promptly. Other admitted work
    // must finish naturally before close begins; cancellation never replays it.
    // The race observes both branches, including late work/cleanup rejections.
    return await Promise.race([owned, cancelled]);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
