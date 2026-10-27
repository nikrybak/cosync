/**
 * Serialises tasks: each one starts only after the previous one settled. This is the
 * actor's single-writer loop; no state is shared, so no locks are needed, and a failing
 * task does not poison the tasks queued behind it.
 */
export class Mailbox {
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;

  get size(): number {
    return this.depth;
  }

  post<T>(task: () => T | Promise<T>): Promise<T> {
    this.depth++;
    const result = this.tail.then(task).finally(() => {
      this.depth--;
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Resolves once every task posted so far has settled. */
  drain(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}
