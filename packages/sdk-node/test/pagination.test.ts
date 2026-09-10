/** Cursor pagination: one page, every page, and the exact number of requests it costs. */
import { describe, expect, it } from 'vitest';
import Bookrail, { Page, BookrailError } from '../src/index.js';
import { fake, pagesOf, type Outcome } from './fake.js';

const KEY = 'sk_test_0123456789abcdef';

function client(outcomes: Outcome[]): {
  bookrail: Bookrail;
  network: ReturnType<typeof fake>;
} {
  const network = fake(outcomes);
  return {
    bookrail: new Bookrail(KEY, {
      baseUrl: 'https://api.example.test',
      fetch: network.fetch,
      sleep: network.sleep,
    }),
    network,
  };
}

describe('one page', () => {
  it('awaits to a Page with data, has_more and the envelope', async () => {
    const { bookrail } = client(pagesOf(25, 10));
    const page = await bookrail.customers.list({ limit: 10 });
    expect(page).toBeInstanceOf(Page);
    expect(page.data).toHaveLength(10);
    expect(page.has_more).toBe(true);
    expect(page.hasNextPage()).toBe(true);
    expect(page.response.status).toBe(200);
  });

  it('rejects nextPage on the last page instead of answering an empty one', async () => {
    const { bookrail } = client(pagesOf(3, 10));
    const page = await bookrail.customers.list({ limit: 10 });
    expect(page.hasNextPage()).toBe(false);
    const error = (await page.nextPage().catch((caught: unknown) => caught)) as BookrailError;
    expect(error).toBeInstanceOf(BookrailError);
    expect(error.code).toBe('no_more_pages');
  });
});

describe('for await', () => {
  it('walks 25 objects with limit 10 in exactly three requests', async () => {
    const { bookrail, network } = client(pagesOf(25, 10));
    const seen: string[] = [];
    for await (const customer of bookrail.customers.list({ limit: 10 })) {
      seen.push((customer as { id: string }).id);
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(network.calls).toHaveLength(3);
  });

  it('sends starting_after equal to the id of the last object of the page before', async () => {
    const { bookrail, network } = client(pagesOf(25, 10));
    for await (const _customer of bookrail.customers.list({ limit: 10 })) {
      void _customer;
    }
    const cursors = network.calls.map((call) =>
      new URL(call.url).searchParams.get('starting_after'),
    );
    expect(cursors).toEqual([null, 'cus_0009', 'cus_0019']);
    // The limit and any filter travel with the cursor, untouched.
    for (const call of network.calls) {
      expect(new URL(call.url).searchParams.get('limit')).toBe('10');
    }
  });

  it('carries the filters and expand of the first call across pages', async () => {
    const { bookrail, network } = client(pagesOf(25, 10, 'bk'));
    for await (const _booking of bookrail.bookings.list(
      { limit: 10, status: 'confirmed' },
      { expand: ['customer'] },
    )) {
      void _booking;
    }
    expect(network.calls).toHaveLength(3);
    for (const call of network.calls) {
      const url = new URL(call.url);
      expect(url.searchParams.get('status')).toBe('confirmed');
      expect(url.searchParams.getAll('expand[]')).toEqual(['customer']);
    }
  });

  it('stops at has_more false even when the last page is full', async () => {
    const { bookrail, network } = client(pagesOf(20, 10));
    let count = 0;
    for await (const _customer of bookrail.customers.list({ limit: 10 })) {
      void _customer;
      count += 1;
    }
    expect(count).toBe(20);
    expect(network.calls).toHaveLength(2);
  });

  it('yields nothing, and asks once, for an empty list', async () => {
    const { bookrail, network } = client([
      { status: 200, body: { object: 'list', data: [], has_more: false } },
    ]);
    const seen = [];
    for await (const customer of bookrail.customers.list()) seen.push(customer);
    expect(seen).toHaveLength(0);
    expect(network.calls).toHaveLength(1);
  });

  it('can be walked from a Page as well as from the promise', async () => {
    const { bookrail, network } = client(pagesOf(25, 10));
    const first = await bookrail.customers.list({ limit: 10 });
    let count = 0;
    for await (const _customer of first) {
      void _customer;
      count += 1;
    }
    expect(count).toBe(25);
    expect(network.calls).toHaveLength(3);
  });

  it('refuses to page a list whose objects have no id', async () => {
    const { bookrail } = client([
      { status: 200, body: { object: 'list', data: [{ nope: 1 }], has_more: true } },
    ]);
    const page = await bookrail.customers.list();
    const error = (await page.nextPage().catch((caught: unknown) => caught)) as BookrailError;
    expect(error.message).toContain('cursor');
  });

  it('reports a body that is not a list envelope', async () => {
    const { bookrail } = client([{ status: 200, body: { object: 'customer', id: 'cus_1' } }]);
    const error = (await bookrail.customers
      .list()
      .catch((caught: unknown) => caught)) as BookrailError;
    expect(error.code).toBe('unexpected_response');
  });
});
