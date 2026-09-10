/**
 * SSRF: the address table, the URL gate, and the DNS gate.
 *
 * A webhook is a URL the customer picks and we fetch from inside our network. Every case here
 * is an address a delivery must never reach, including the two that a naive implementation
 * always misses: a **hostname** that resolves to a private address (checked by resolving a real
 * name at delivery time), and `::ffff:127.0.0.1`, which is loopback wearing an IPv6 hat.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { assertWebhookUrl, blockedReason, resolveWebhookTarget } from '../src/webhooks/ssrf.js';
import { deliver } from '../src/webhooks/deliver.js';
import { startReceiver, type TestReceiver } from './webhook-receiver.js';

const SECRET = 'whsec_test';

function delivery(url: string, environment: 'test' | 'live' = 'test') {
  return {
    url,
    environment,
    secret: SECRET,
    body: '{"id":"evt_1"}',
    eventId: 'evt_1',
    webhookId: 'wh_1',
    deliveryId: 'whd_1',
    timeoutMs: 2000,
  };
}

describe('SSRF: which addresses are off limits', () => {
  it('refuses loopback, the private ranges, link-local and the cloud metadata address', () => {
    for (const address of [
      '127.0.0.1',
      '127.10.20.30',
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.0.1',
      '192.168.255.254',
      '169.254.0.1',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.1.1',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(blockedReason(address), address).not.toBeNull();
    }
  });

  it('refuses ::1, fc00::/7, fe80::/10 and IPv4 loopback wearing an IPv6 hat', () => {
    for (const address of [
      '::1',
      '::',
      'fc00::1',
      'fd12:3456:789a::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:10.1.2.3',
      '::ffff:7f00:1',
      '2001:db8::1',
    ]) {
      expect(blockedReason(address), address).not.toBeNull();
    }
  });

  it('unwraps every form that carries an IPv4 inside an IPv6', () => {
    // The review's M1. `::ffff:` was handled; the other three wrappers were not, so
    // `64:ff9b::7f00:1`, loopback behind a NAT64 prefix, walked straight through.
    for (const address of [
      '::ffff:127.0.0.1', // IPv4-mapped
      '::ffff:7f00:1', // the same, in hex
      '::ffff:0:127.0.0.1', // IPv4-translated, ::ffff:0:0/96
      '64:ff9b::7f00:1', // NAT64 well-known prefix
      '64:ff9b::169.254.169.254', // NAT64 to the cloud metadata address
      '::127.0.0.1', // IPv4-compatible, deprecated
      '::10.0.0.1',
      '2002:7f00:1::', // 6to4, blocked whole
      '2002:a00:1::',
    ]) {
      expect(blockedReason(address), address).not.toBeNull();
    }
    // And they are refused at creation too, not only at delivery.
    for (const url of [
      'http://[64:ff9b::7f00:1]/hook',
      'http://[2002:7f00:1::]/hook',
      'http://[::127.0.0.1]/hook',
      'http://[::ffff:0:127.0.0.1]/hook',
    ]) {
      expect(() => assertWebhookUrl(url, 'test'), url).toThrow();
    }
  });

  it('names the reason after the IPv4 range, and still calls ::1 loopback', () => {
    expect(blockedReason('::1')).toBe('loopback');
    expect(blockedReason('::')).toBe('unspecified');
    expect(blockedReason('64:ff9b::7f00:1')).toMatch(/NAT64.*loopback/);
    expect(blockedReason('::ffff:169.254.169.254')).toMatch(/metadata/);
  });

  it('lets a public address through', () => {
    for (const address of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111']) {
      expect(blockedReason(address), address).toBeNull();
    }
  });

  it('refuses anything that is not an address at all', () => {
    expect(blockedReason('example.com')).not.toBeNull();
    expect(blockedReason('')).not.toBeNull();
  });
});

describe('SSRF: the URL a webhook may be registered with', () => {
  it('refuses http in live and accepts it in test', () => {
    expect(() => assertWebhookUrl('http://example.com/hook', 'live')).toThrow(/https/i);
    expect(assertWebhookUrl('http://example.com/hook', 'test').hostname).toBe('example.com');
    expect(assertWebhookUrl('https://example.com/hook', 'live').hostname).toBe('example.com');
  });

  it('refuses a scheme that is not http or https', () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com']) {
      expect(() => assertWebhookUrl(url, 'test'), url).toThrow();
    }
  });

  it('refuses credentials in the URL', () => {
    expect(() => assertWebhookUrl('https://user:pass@example.com/hook', 'live')).toThrow(
      /credentials/i,
    );
  });

  it('refuses a literal address that is off the public internet, at creation', () => {
    for (const url of [
      'https://127.0.0.1/hook',
      'https://10.0.0.5/hook',
      'https://172.16.4.4/hook',
      'https://192.168.1.10/hook',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/hook',
      'https://[fd00::1]/hook',
    ]) {
      expect(() => assertWebhookUrl(url, 'test'), url).toThrow();
    }
  });

  it('restricts the ports a URL may name', () => {
    expect(assertWebhookUrl('https://example.com:443/hook', 'live').port).toBe('');
    expect(assertWebhookUrl('http://example.com:80/hook', 'test').port).toBe('');
    expect(assertWebhookUrl('http://example.com:8080/hook', 'test').port).toBe('8080');
    expect(() => assertWebhookUrl('https://example.com:8080/hook', 'live')).toThrow(/port/i);
    expect(() => assertWebhookUrl('https://example.com:22/hook', 'test')).toThrow(/port/i);
    expect(() => assertWebhookUrl('https://example.com:6379/hook', 'test')).toThrow(/port/i);
  });

  it('keeps the port rule when only the address rule is relaxed', () => {
    // The review's M10: one flag used to govern both, so no delivery test anywhere exercised
    // the port rule: a security rule switched off as a side effect of another one.
    const loopbackOnly = { allowPrivateTargets: true };
    expect(assertWebhookUrl('http://127.0.0.1/hook', 'test', loopbackOnly).hostname).toBe(
      '127.0.0.1',
    );
    expect(() => assertWebhookUrl('http://127.0.0.1:6379/hook', 'test', loopbackOnly)).toThrow(
      /port/i,
    );
    // And with both relaxed, which is what the test harness does, the ephemeral port passes.
    expect(
      assertWebhookUrl('http://127.0.0.1:54321/hook', 'test', {
        allowPrivateTargets: true,
        allowAnyPort: true,
      }).port,
    ).toBe('54321');
  });

  it('refuses something that is not a URL at all', () => {
    for (const url of ['', 'not a url', '/relative/path', 'example.com/hook']) {
      expect(() => assertWebhookUrl(url, 'test'), url).toThrow();
    }
  });
});

describe('SSRF: what the hostname resolves to, at delivery time', () => {
  it('refuses a name that resolves to loopback', async () => {
    // `localhost` is the name every resolver on earth points at 127.0.0.1, so it is the honest
    // test of "hostname that resolves to a private address" without inventing a fake resolver.
    await expect(resolveWebhookTarget(new URL('http://localhost/hook'))).rejects.toThrow(
      /blocked address/i,
    );
  });

  it('refuses a delivery to a port the environment does not allow, even on a public host', async () => {
    const attempt = await deliver(delivery('https://example.com:6379/hook', 'live'));
    expect(attempt.ok).toBe(false);
    expect(attempt.error).toMatch(/port/i);
    expect(attempt.status).toBeNull();
  });

  it('lets the same name through when the guard is explicitly relaxed', async () => {
    const target = await resolveWebhookTarget(new URL('http://localhost/hook'), {
      allowPrivateTargets: true,
    });
    expect(target.addresses.length).toBeGreaterThan(0);
  });

  it('reports a name that does not resolve as a failure, not a crash', async () => {
    await expect(
      resolveWebhookTarget(new URL('https://no-such-host.bookrail-invalid./hook')),
    ).rejects.toThrow(/could not resolve/i);
  });
});

describe('SSRF: a delivery never reaches a blocked address', () => {
  let receiver: TestReceiver;
  let elsewhere: Server;
  let elsewhereUrl: string;
  let reached = 0;

  beforeAll(async () => {
    receiver = await startReceiver();
    elsewhere = createServer((_req, res) => {
      reached += 1;
      res.writeHead(200);
      res.end('reached');
    });
    await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', resolve));
    const address = elsewhere.address() as AddressInfo;
    elsewhereUrl = `http://127.0.0.1:${String(address.port)}/secret`;
  });

  afterAll(async () => {
    await receiver.close();
    await new Promise<void>((resolve) => elsewhere.close(() => resolve()));
  });

  it('refuses every private target without opening a socket', async () => {
    for (const url of [
      'http://127.0.0.1/hook',
      'http://10.1.2.3/hook',
      'http://172.16.0.9/hook',
      'http://192.168.0.9/hook',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/hook',
      'http://localhost/hook',
    ]) {
      const attempt = await deliver(delivery(url));
      expect(attempt.ok, url).toBe(false);
      expect(attempt.status, url).toBeNull();
      expect(attempt.error, url).toBeTruthy();
    }
  });

  it('refuses http in live before it resolves anything', async () => {
    const attempt = await deliver(delivery('http://example.com/hook', 'live'));
    expect(attempt.ok).toBe(false);
    expect(attempt.error).toMatch(/https/i);
  });

  it('does not follow a redirect, least of all one pointing at a private address', async () => {
    reached = 0;
    receiver.reset();
    receiver.redirectTo = elsewhereUrl;
    const attempt = await deliver(delivery(receiver.url), {
      allowPrivateTargets: true,
      allowAnyPort: true,
    });
    expect(attempt.ok).toBe(false);
    expect(attempt.status).toBe(302);
    // The delivery stopped at the 302. Nothing was sent to the address it pointed at.
    expect(reached).toBe(0);
    expect(receiver.requests).toHaveLength(1);
  });
});
