/**
 * Runs tasks one after another, in the order they were queued. A task that
 * rejects does not stop the ones queued behind it.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** Starts `task` once every earlier task has finished, and resolves with its result. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result: Promise<T> = this.tail.then(task);
    this.tail = result.catch((): undefined => undefined);
    return result;
  }
}
