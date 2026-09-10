/**
 * The one error the engine's pure layers throw when an argument is out of bounds.
 *
 * These used to be plain `RangeError`s, and the HTTP layer told a ceiling
 * (`discretize`'s `maxInstants`, `materializeSchedule`'s `maxDays`) apart from a bad parameter
 * by running a regular expression over the **message**:
 *
 * ```ts
 * const code = /instants|local days/.test(error.message) ? 'range_too_large' : 'parameter_invalid';
 * ```
 *
 * That is a contract nobody declared. Rewording a message (translating it, adding the offending
 * value, dropping the word "instants") silently changed the error code of a public API, and
 * nothing in the engine's tests would have noticed. The code is a property of the failure, so it
 * travels with the failure.
 *
 * It **extends `RangeError`** on purpose. The engine is a library first: `discretize` refusing a
 * non-integer interval is a range error in the ordinary JavaScript sense, dozens of tests assert
 * `toThrow(RangeError)`, and a consumer that never learns about Bookrail's error codes should
 * still be able to catch what it always caught. The subclass adds information; it does not take
 * any away.
 */

/** The two error codes the engine reports for an argument it will not accept. */
export type EngineLimitCode = 'range_too_large' | 'parameter_invalid';

export class EngineLimitError extends RangeError {
  readonly code: EngineLimitCode;
  /** The request field to blame, when the engine knows it. `undefined` when it does not. */
  readonly param: string | undefined;

  constructor(code: EngineLimitCode, message: string, param?: string) {
    super(message);
    this.name = 'EngineLimitError';
    this.code = code;
    this.param = param;
  }
}

/**
 * A ceiling the caller crossed: the request is well formed and simply too big.
 *
 * The two that exist are the number of candidate instants a discretization may produce and the
 * number of local days a materialization may span. Both are `400 range_too_large`, never a 500:
 * the engine protecting itself is not the server failing.
 */
export function rangeTooLarge(message: string, param?: string): EngineLimitError {
  return new EngineLimitError('range_too_large', message, param);
}

/** An argument the engine cannot make sense of: a malformed time of day, a negative capacity. */
export function parameterInvalid(message: string, param?: string): EngineLimitError {
  return new EngineLimitError('parameter_invalid', message, param);
}
