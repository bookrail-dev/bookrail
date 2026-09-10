/**
 * `bookrail webhooks`, end to end against the real API and a real receiver on a real socket.
 *
 * Nothing is mocked here either. `webhooks test` really delivers, over HTTP, to a `node:http`
 * server this file opens; `webhooks listen` really registers an endpoint, really receives the
 * signed payload, and really verifies it with the CLI's own verifier, which is the only way
 * to know that the copy of the signature check that ships with the CLI agrees with the one the
 * server signs with.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signatureVerdict } from '../src/commands/listen.js';
import { createHarness, type Harness, type Project } from './harness.js';

interface Received {
  headers: Record<string, string>;
  body: string;
}

/** A minimal receiver: records what arrives, answers what it is told to. */
class Receiver {
  status = 200;
  readonly requests: Received[] = [];

  constructor(
    private readonly server: Server,
    readonly origin: string,
  ) {}

  get url(): string {
    return `${this.origin}/hook`;
  }

  handle(request: IncomingMessage, response: ServerResponse): void {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : (value ?? '');
      }
      this.requests.push({ headers, body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(this.status, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }
}

async function startReceiver(): Promise<Receiver> {
  const holder: { current: Receiver | null } = { current: null };
  const server = createServer((request, response) => holder.current?.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const receiver = new Receiver(server, `http://127.0.0.1:${String(address.port)}`);
  holder.current = receiver;
  return receiver;
}

/** A port that is free right now, so `listen` can be told the URL that will reach it. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('bookrail webhooks', () => {
  let h: Harness;
  let project: Project;
  let receiver: Receiver;

  beforeAll(async () => {
    h = await createHarness();
    project = await h.bootstrap('Webhooks');
    receiver = await startReceiver();
  }, 120_000);

  afterAll(async () => {
    await receiver.close();
    await h.close();
  });

  const env = (): { env: Record<string, string> } => ({
    env: { BOOKRAIL_SECRET_KEY: project.testKey },
  });

  describe('the endpoint CRUD', () => {
    let id: string;
    let secret: string;

    it('creates one, shows the secret once, and warns about it', async () => {
      const created = await h.cli(
        [
          'webhooks',
          'create',
          '--url',
          receiver.url,
          '--events',
          'booking.created,booking.cancelled',
          '--description',
          'test endpoint',
          '--json',
        ],
        env(),
      );
      expect(created.code).toBe(0);
      const body = created.json<{
        id: string;
        object: string;
        url: string;
        events: string[];
        status: string;
        secret: string;
      }>().data!;
      expect(body.object).toBe('webhook');
      expect(body.url).toBe(receiver.url);
      expect(body.events).toEqual(['booking.created', 'booking.cancelled']);
      expect(body.status).toBe('active');
      expect(body.secret.startsWith('whsec_')).toBe(true);
      id = body.id;
      secret = body.secret;

      const human = await h.cli(
        ['webhooks', 'create', '--url', `${receiver.origin}/second`],
        env(),
      );
      expect(human.code).toBe(0);
      expect(human.stdout).toContain('signing secret:');
      expect(human.stdout).toContain('only time the secret is shown');
      const secondId = /created (wh_[A-Za-z0-9]+)/.exec(human.stdout)?.[1];
      expect(secondId).toBeDefined();
      await h.cli(['webhooks', 'delete', secondId!, '--yes', '--json'], env());
    });

    it('never returns the secret again, from any read', async () => {
      const read = await h.cli(['webhooks', 'get', id, '--json'], env());
      expect(read.code).toBe(0);
      expect(JSON.stringify(read.json())).not.toContain(secret);
      expect(read.stdout).not.toContain('whsec_');

      const list = await h.cli(['webhooks', 'list', '--json'], env());
      expect(JSON.stringify(list.json())).not.toContain(secret);
      expect(list.json<{ data: { id: string }[] }>().data!.data.some((row) => row.id === id)).toBe(
        true,
      );
    });

    it('updates the subscriptions and the status', async () => {
      const updated = await h.cli(
        ['webhooks', 'update', id, '--events', '*', '--description', 'all of them', '--json'],
        env(),
      );
      expect(updated.code).toBe(0);
      expect(updated.json<{ events: string[] }>().data?.events).toEqual(['*']);

      const disabled = await h.cli(
        ['webhooks', 'update', id, '--status', 'disabled', '--json'],
        env(),
      );
      expect(disabled.json<{ status: string }>().data?.status).toBe('disabled');

      // `disabled` stops all traffic, and `test` is traffic.
      const refused = await h.cli(['webhooks', 'test', id, '--json'], env());
      expect(refused.code).toBe(4);
      expect(refused.json().error?.code).toBe('webhook_disabled');

      const back = await h.cli(['webhooks', 'update', id, '--status', 'active', '--json'], env());
      expect(back.json<{ status: string }>().data?.status).toBe('active');
    });

    it('refuses an update with nothing to change, and a `failing` status', async () => {
      const empty = await h.cli(['webhooks', 'update', id, '--json'], env());
      expect(empty.code).toBe(1);
      expect(empty.json().error?.code).toBe('missing_input');

      const failing = await h.cli(
        ['webhooks', 'update', id, '--status', 'failing', '--json'],
        env(),
      );
      expect(failing.code).toBe(1);
      expect(failing.json().error?.code).toBe('parameter_invalid');
    });

    it('delivers a synthetic test, synchronously, and the CLI verifier accepts its signature', async () => {
      const before = receiver.requests.length;
      const result = await h.cli(['webhooks', 'test', id, '--json'], env());
      expect(result.code).toBe(0);
      const delivery = result.json<{
        object: string;
        status: string;
        response_status: number;
        event_id: string;
        event_type: string;
      }>().data!;
      expect(delivery.object).toBe('webhook_delivery');
      expect(delivery.status).toBe('succeeded');
      expect(delivery.response_status).toBe(200);
      expect(delivery.event_type).toBe('webhook.test');

      expect(receiver.requests.length).toBe(before + 1);
      const arrived = receiver.requests.at(-1)!;
      expect(arrived.headers['bookrail-event-id']).toBe(delivery.event_id);
      // The verifier that ships with the CLI, against a payload the real server signed.
      const verdict = signatureVerdict(arrived.body, arrived.headers['bookrail-signature'], secret);
      expect(verdict).toEqual({ valid: true, reason: 'ok' });
      // And it rejects the same payload under any other secret.
      expect(
        signatureVerdict(arrived.body, arrived.headers['bookrail-signature'], 'whsec_wrong').valid,
      ).toBe(false);
      // ...and a body that was re-serialised rather than kept raw.
      const reserialised = JSON.stringify(JSON.parse(arrived.body));
      const sameBytes = reserialised === arrived.body;
      expect(
        signatureVerdict(`${arrived.body} `, arrived.headers['bookrail-signature'], secret).valid,
      ).toBe(false);
      expect(typeof sameBytes).toBe('boolean');
    });

    it('reports a failed test as data, not as an exit code', async () => {
      receiver.status = 500;
      const result = await h.cli(['webhooks', 'test', id, '--json'], env());
      receiver.status = 200;
      expect(result.code).toBe(0);
      const delivery = result.json<{ status: string; response_status: number }>().data!;
      expect(delivery.status).toBe('failed');
      expect(delivery.response_status).toBe(500);
      expect(result.json().next_steps?.join(' ')).toContain('never retried');
    });

    it('lists the deliveries newest first and replays one', async () => {
      const list = await h.cli(['webhooks', 'deliveries', id, '--json'], env());
      expect(list.code).toBe(0);
      const rows = list.json<{ data: { id: string; status: string; attempt: number }[] }>().data!
        .data;
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const failed = rows.find((row) => row.status === 'failed');
      expect(failed).toBeDefined();

      const filtered = await h.cli(
        ['webhooks', 'deliveries', id, '--status', 'succeeded', '--json'],
        env(),
      );
      expect(
        filtered
          .json<{ data: { status: string }[] }>()
          .data!.data.every((row) => row.status === 'succeeded'),
      ).toBe(true);

      const retried = await h.cli(['webhooks', 'retry', id, failed!.id, '--json'], env());
      expect(retried.code).toBe(0);
      const queued = retried.json<{ status: string; attempt: number; next_attempt_at: string }>()
        .data!;
      expect(queued.status).toBe('pending');
      expect(queued.attempt).toBe(0);
      expect(queued.next_attempt_at).not.toBeNull();
    });

    it('needs --yes to delete, and takes the deliveries with it', async () => {
      const refused = await h.cli(['webhooks', 'delete', id, '--json'], env());
      expect(refused.code).toBe(1);
      expect(refused.json().error?.code).toBe('confirmation_required');
      expect(refused.json().error?.fix).toContain('--status disabled');

      const deleted = await h.cli(['webhooks', 'delete', id, '--yes', '--json'], env());
      expect(deleted.code).toBe(0);
      expect(deleted.json<{ deleted: boolean }>().data?.deleted).toBe(true);

      const gone = await h.cli(['webhooks', 'get', id, '--json'], env());
      expect(gone.code).toBe(1);
      expect(gone.json().error?.code).toBe('resource_missing');
    });

    it('refuses a URL the SSRF guard will not accept', async () => {
      const result = await h.cli(
        ['webhooks', 'create', '--url', 'ftp://example.com/x', '--json'],
        env(),
      );
      expect(result.code).toBe(1);
      expect(result.json().error?.code).toBe('invalid_webhook_url');
      expect(result.json().error?.fix).toContain('public');
    });

    it('refuses a create with no --url before any request', async () => {
      const before = h.seenRequests.length;
      const result = await h.cli(['webhooks', 'create', '--json'], env());
      expect(result.code).toBe(1);
      expect(result.json().error?.code).toBe('missing_input');
      expect(result.json().error?.param).toBe('url');
      expect(h.seenRequests.length).toBe(before);
    });
  });

  describe('listen, tunnel mode', () => {
    it('registers a temporary endpoint, receives a signed delivery, forwards it, and cleans up', async () => {
      const port = await freePort();
      const forwardTo = await startReceiver();

      const listening = h.cli(
        [
          'webhooks',
          'listen',
          '--url',
          `http://127.0.0.1:${String(port)}/bookrail`,
          '--port',
          String(port),
          '--forward',
          forwardTo.url,
          '--max',
          '1',
          '--duration',
          '25',
          '--json',
        ],
        env(),
      );

      // Wait for the temporary endpoint to appear, then make one delivery happen.
      let temporary: string | null = null;
      for (let attempt = 0; attempt < 100 && temporary === null; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const list = await h.cli(['webhooks', 'list', '--all', '--json'], env());
        const rows = list.json<{ data: { id: string; description: string | null }[] }>().data!.data;
        temporary =
          rows.find((row) => row.description?.includes('webhooks listen') === true)?.id ?? null;
      }
      expect(temporary).not.toBeNull();

      const tested = await h.cli(['webhooks', 'test', temporary!, '--json'], env());
      expect(tested.code).toBe(0);
      expect(tested.json<{ status: string }>().data?.status).toBe('succeeded');

      const result = await listening;
      expect(result.code).toBe(0);
      const body = result.json<{
        mode: string;
        webhook_id: string;
        deleted: boolean;
        received: {
          event_id: string;
          event_type: string;
          signature_valid: boolean;
          forwarded_status: number | null;
        }[];
        counts: { total: number; invalid_signature: number };
      }>().data!;
      expect(body.mode).toBe('tunnel');
      expect(body.webhook_id).toBe(temporary);
      expect(body.received).toHaveLength(1);
      expect(body.received[0]!.event_type).toBe('webhook.test');
      expect(body.received[0]!.signature_valid).toBe(true);
      expect(body.received[0]!.forwarded_status).toBe(200);
      expect(body.counts.invalid_signature).toBe(0);
      expect(body.deleted).toBe(true);

      // Forwarded, byte for byte, with the signature header intact.
      expect(forwardTo.requests).toHaveLength(1);
      expect(forwardTo.requests[0]!.headers['bookrail-signature']).toBeDefined();

      // And the temporary endpoint is gone.
      const after = await h.cli(['webhooks', 'get', temporary!, '--json'], env());
      expect(after.code).toBe(1);
      expect(after.json().error?.code).toBe('resource_missing');

      await forwardTo.close();
    }, 90_000);

    it('refuses --json without a bound, naming the two flags', async () => {
      const result = await h.cli(
        ['webhooks', 'listen', '--url', 'https://example.com/hook', '--json'],
        env(),
      );
      expect(result.code).toBe(1);
      expect(result.json().error?.code).toBe('missing_input');
      expect(result.json().error?.fix).toContain('--max');
    });
  });

  describe('listen, poll mode', () => {
    it('registers nothing, says so, and reprints the events instead', async () => {
      const before = (await h.cli(['webhooks', 'list', '--all', '--json'], env())).json<{
        data: unknown[];
      }>().data!.data.length;

      const result = await h.cli(
        ['webhooks', 'listen', '--interval', '1', '--duration', '2', '--json'],
        env(),
      );
      expect(result.code).toBe(0);
      const body = result.json<{ mode: string; webhook_id: null; stopped_by: string }>().data!;
      expect(body.mode).toBe('poll');
      expect(body.webhook_id).toBeNull();
      expect(body.stopped_by).toBe('duration');
      expect(result.json().next_steps?.join(' ')).toContain('registers nothing');

      const after = (await h.cli(['webhooks', 'list', '--all', '--json'], env())).json<{
        data: unknown[];
      }>().data!.data.length;
      expect(after).toBe(before);
    }, 30_000);

    it('says in the human output that it followed the log rather than receiving deliveries', async () => {
      const result = await h.cli(
        ['webhooks', 'listen', '--interval', '1', '--duration', '2'],
        env(),
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('no --url given');
      expect(result.stdout).toContain('following the event log');
    }, 30_000);
  });
});
