/**
 * Waiting for a condition, which is the only honest way to observe something that is in
 * flight.
 *
 * A test that wants to look at a row *while* a worker is holding it has to arrive during a
 * window. `setTimeout(250)` aims at the middle of that window and is right until the machine
 * is loaded, or has two cores, or is a CI runner sharing a disk, at which point the same code
 * arrives too early or too late and the suite goes red for being slow rather than for being
 * wrong. Asking again until the condition holds removes the guess without changing what is
 * proved: the assertions come after, and they are made once.
 *
 * This is not a retry of a failing assertion. The predicate is the precondition of the
 * observation, never the thing under test, and running out of time is a failure that names
 * what it was waiting for rather than a mystery a hundred lines away.
 */

export interface UntilOptions {
  /** How long to wait before giving up. */
  timeoutMs?: number;
  /** How long to wait between two probes. */
  pollMs?: number;
}

export async function until<T>(
  probe: () => Promise<T>,
  holds: (value: T) => boolean,
  what: string,
  options: UntilOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (holds(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `Waited ${String(timeoutMs)} ms for ${what} and it never happened. ` +
          `The last thing seen was ${JSON.stringify(value)}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
