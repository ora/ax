// Copied from @ora-ai/tunnel-protocol (tunnel-protocol-v0.2.0). DO NOT EDIT BY HAND.
// See ../index.ts for why this is a copy and how to update it.

/**
 * Push-based bounded queue exposed as an AsyncIterable — the bridge from
 * frame callbacks to `for await` body streams.
 *
 * `end()` finishes iteration after buffered items drain; `fail(err)` makes the
 * iterator throw. Both are idempotent and race-safe with a pending `next()`.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private pending: { resolve: (r: IteratorResult<T>) => void; reject: (e: Error) => void } | null =
    null;
  private ended = false;
  private error: Error | null = null;

  push(value: T): void {
    if (this.ended || this.error) return; // late frames after end/reset are dropped
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.resolve({ value, done: false });
      return;
    }
    this.buffered.push(value);
  }

  end(): void {
    if (this.ended || this.error) return;
    this.ended = true;
    if (this.pending && this.buffered.length === 0) {
      const p = this.pending;
      this.pending = null;
      p.resolve({ value: undefined, done: true });
    }
  }

  fail(error: Error): void {
    if (this.ended || this.error) return;
    this.error = error;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffered.length > 0) {
          return Promise.resolve({ value: this.buffered.shift() as T, done: false });
        }
        if (this.error) return Promise.reject(this.error);
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          this.pending = { resolve, reject };
        });
      },
    };
  }
}
