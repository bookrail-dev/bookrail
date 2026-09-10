/**
 * The Redis the cache suites run against.
 *
 * There is no in-memory stand-in and no `skip`: an adapter that has never spoken to a real
 * server has not been tested. `TEST_REDIS_URL` wins; otherwise `REDIS_URL` is reused with
 * logical database 15, which the suites `FLUSHDB` before they start.
 */
export function testRedisUrl(): string {
  const explicit = process.env.TEST_REDIS_URL;
  if (explicit !== undefined && explicit !== '') return explicit;
  const base = process.env.REDIS_URL;
  if (base === undefined || base === '') {
    throw new Error(
      'The availability cache suites need a real Redis. Start one and set REDIS_URL ' +
        '(e.g. redis://localhost:6379) or TEST_REDIS_URL. On the development Mac: ' +
        'redis-server --daemonize yes --save "" --appendonly no',
    );
  }
  return `${base.replace(/\/+$/, '')}/15`;
}
