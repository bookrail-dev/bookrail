/**
 * The Redis the rate limiter suite runs against.
 *
 * No in-memory stand-in and no `skip`: a limiter whose Lua script has never been executed by a
 * real server has not been tested, and the one property that matters about it (that two requests
 * arriving together cannot both be allowed) is a property of the server and not of this code.
 * `TEST_REDIS_URL` wins; otherwise `REDIS_URL` is reused with logical database 15, which the
 * suite flushes before it starts.
 */
export function testRedisUrl(): string {
  const explicit = process.env.TEST_REDIS_URL;
  if (explicit !== undefined && explicit !== '') return explicit;
  const base = process.env.REDIS_URL;
  if (base === undefined || base === '') {
    throw new Error(
      'The rate limiter suite needs a real Redis. Start one and set REDIS_URL ' +
        '(e.g. redis://localhost:6379) or TEST_REDIS_URL. On the development Mac: ' +
        'redis-server --daemonize yes --save "" --appendonly no',
    );
  }
  return `${base.replace(/\/+$/, '')}/15`;
}
