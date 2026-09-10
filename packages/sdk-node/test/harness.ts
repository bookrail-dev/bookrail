/**
 * The real thing: `createApp` from `@bookrail/api` behind `@hono/node-server`, on a real
 * socket, against the real Postgres named by `DATABASE_URL`.
 *
 * Nothing is mocked here. The SDK speaks HTTP to something that answers HTTP, the rows are
 * written by the real engine under Row Level Security, and the webhook deliveries are signed by
 * the real dispatcher and arrive at a real `node:http` receiver. The recorder in front of the
 * app is what makes the operation-coverage check possible.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { createApp } from '@bookrail/api';
import { createDatabase, createPool, resolveDatabaseUrls } from '@bookrail/db';
import { MemoryAvailabilityCache } from '@bookrail/engine';
import { silentLogger } from '@bookrail/shared';
import Bookrail, { type BookrailOptions } from '../src/index.js';
import { TEST_DB_NAME } from './db-name.js';
import { operationFor } from './operations.js';

const BOOTSTRAP_TOKEN = 'bootstrap-token-for-sdk-tests';

/** Fixed and obviously a test value; it only ever encrypts rows of the SDK test database. */
const WEBHOOK_SECRET_KEY = Buffer.alloc(32, 0x5d);

export interface Project {
  projectId: string;
  testKey: string;
  liveKey: string;
}

export interface SeenRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
}

export interface Harness {
  url: string;
  /** Every request the server saw, in order. */
  seen: SeenRequest[];
  /** The `operationId` of every request that matched the registry, in order. */
  operations: string[];
  bootstrap(name: string): Promise<Project>;
  /** A client pointed at this server. */
  client(secretKey: string, options?: BookrailOptions): Bookrail;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const urls = resolveDatabaseUrls({ databaseName: TEST_DB_NAME });
  const appPool = createPool({ connectionString: urls.app, max: 4 });
  const adminPool = createPool({ connectionString: urls.admin, max: 1 });
  const cache = new MemoryAvailabilityCache();

  const app = createApp({
    db: createDatabase(appPool),
    adminDb: createDatabase(adminPool),
    logger: silentLogger,
    cache,
    bootstrapToken: BOOTSTRAP_TOKEN,
    webhookSecretKey: WEBHOOK_SECRET_KEY,
    // The receiver below lives on 127.0.0.1, which the SSRF guard refuses in production.
    allowPrivateWebhookTargets: true,
  });

  const seen: SeenRequest[] = [];
  const operations: string[] = [];

  const server: ServerType = serve({
    fetch: (request: Request) => {
      const parsed = new URL(request.url);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      seen.push({
        method: request.method,
        path: parsed.pathname,
        query: parsed.search,
        headers,
      });
      const operation = operationFor(request.method, parsed.pathname);
      if (operation !== null) operations.push(operation);
      return app.fetch(request);
    },
    port: 0,
    hostname: '127.0.0.1',
  });

  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const url = `http://127.0.0.1:${String(port)}`;

  return {
    url,
    seen,
    operations,
    async bootstrap(name: string): Promise<Project> {
      const response = await fetch(`${url}/internal/bootstrap`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${BOOTSTRAP_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          account_name: name,
          project_name: name,
          default_timezone: 'Europe/Rome',
        }),
      });
      if (response.status !== 201) {
        throw new Error(`bootstrap failed: ${String(response.status)} ${await response.text()}`);
      }
      const body = (await response.json()) as {
        project: { id: string };
        secrets: { test: string; live: string };
      };
      // `POST /internal/bootstrap` is not in the registry, so it never counts as coverage;
      // the recorder is deliberately **not** cleared here, because a second project must not
      // erase what the first one proved.
      return { projectId: body.project.id, testKey: body.secrets.test, liveKey: body.secrets.live };
    },
    client(secretKey: string, options: BookrailOptions = {}): Bookrail {
      return new Bookrail(secretKey, { baseUrl: url, ...options });
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await cache.close();
      await appPool.end();
      await adminPool.end();
    },
  };
}

export interface Received {
  headers: Record<string, string>;
  body: string;
}

/** A minimal webhook receiver on a real socket: records what arrives, answers what it is told. */
export class Receiver {
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

export async function startReceiver(): Promise<Receiver> {
  const holder: { current: Receiver | null } = { current: null };
  const server = createServer((request, response) => holder.current?.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const receiver = new Receiver(server, `http://127.0.0.1:${String(address.port)}`);
  holder.current = receiver;
  return receiver;
}
