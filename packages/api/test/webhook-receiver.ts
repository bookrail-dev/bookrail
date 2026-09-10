/**
 * A real HTTP server on 127.0.0.1, for the delivery tests.
 *
 * `node:http`, no dependency, and a real socket: the point of these tests is that the delivery
 * worker speaks HTTP correctly (headers, signature, timeout, redirects) and a mocked `fetch`
 * would prove only that the mock was called.
 *
 * The receiver is programmable between requests (`status`, `delayMs`, `redirectTo`, `bodyText`)
 * so that one server can play a healthy endpoint, a broken one, one that hangs and one that
 * tries to redirect the delivery somewhere it should not go.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  /**
   * When the request arrived and when it was answered, in milliseconds.
   *
   * Together they are the interval during which the delivery was in flight, which is how a
   * test can say "these four POSTs overlapped" without measuring how long the tick took. A
   * stopwatch on the tick answers the same question only on a machine of a known speed;
   * `answeredAt` is null while the receiver is still holding the request.
   */
  receivedAt: number;
  answeredAt: number | null;
}

/**
 * The largest number of the given requests that the receiver was holding at the same instant.
 *
 * A running sum over the interval boundaries, with the closes ordered before the opens so that
 * a request answered at the exact millisecond another arrives does not count as an overlap.
 * One means the sender waited for each answer before sending the next; four means four were in
 * flight together. A request the receiver never answered counts as open for ever, which is the
 * honest reading of "still in flight when the test looked".
 */
export function peakOverlap(requests: readonly ReceivedRequest[]): number {
  const boundaries: { at: number; delta: number }[] = [];
  for (const request of requests) {
    boundaries.push({ at: request.receivedAt, delta: 1 });
    boundaries.push({ at: request.answeredAt ?? Number.POSITIVE_INFINITY, delta: -1 });
  }
  // Compared, not subtracted: two requests that were never answered both sit at Infinity,
  // and `Infinity - Infinity` is NaN, which would only order them right by accident.
  boundaries.sort((a, b) => (a.at === b.at ? a.delta - b.delta : a.at < b.at ? -1 : 1));
  let open = 0;
  let peak = 0;
  for (const boundary of boundaries) {
    open += boundary.delta;
    if (open > peak) peak = open;
  }
  return peak;
}

export class TestReceiver {
  /** What the next request will be answered with. */
  status = 200;
  bodyText = '{"ok":true}';
  /** Milliseconds to hold the request before answering. Used to exercise the timeout. */
  delayMs = 0;
  /** When set, the answer is a 302 to this location instead of `status`. */
  redirectTo: string | null = null;
  readonly requests: ReceivedRequest[] = [];

  private readonly pending = new Set<ServerResponse>();

  constructor(
    private readonly server: Server,
    readonly origin: string,
  ) {}

  get url(): string {
    return `${this.origin}/hook`;
  }

  get last(): ReceivedRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  reset(): void {
    this.requests.length = 0;
    this.status = 200;
    this.bodyText = '{"ok":true}';
    this.delayMs = 0;
    this.redirectTo = null;
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : (value ?? '');
      }
      const record: ReceivedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers,
        body: Buffer.concat(chunks).toString('utf8'),
        receivedAt: Date.now(),
        answeredAt: null,
      };
      this.requests.push(record);
      const answer = (): void => {
        this.pending.delete(res);
        record.answeredAt = Date.now();
        if (res.writableEnded) return;
        if (this.redirectTo !== null) {
          res.writeHead(302, { location: this.redirectTo, 'content-length': '0' });
          res.end();
          return;
        }
        res.writeHead(this.status, { 'content-type': 'application/json' });
        res.end(this.bodyText);
      };
      if (this.delayMs > 0) {
        this.pending.add(res);
        setTimeout(answer, this.delayMs);
      } else {
        answer();
      }
    });
  }

  async close(): Promise<void> {
    for (const res of this.pending) {
      if (!res.writableEnded) res.end();
    }
    this.pending.clear();
    await new Promise<void>((resolve) => {
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }
}

export async function startReceiver(): Promise<TestReceiver> {
  // The server has to exist before the receiver (it needs the port) and the handler has to
  // exist before the server (it needs the receiver), so the two are tied together through a
  // holder rather than through a variable used before it is assigned.
  const holder: { current: TestReceiver | null } = { current: null };
  const server = createServer((req, res) => holder.current?.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const receiver = new TestReceiver(server, `http://127.0.0.1:${String(address.port)}`);
  holder.current = receiver;
  return receiver;
}
