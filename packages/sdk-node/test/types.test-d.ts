/**
 * What the compiler must know, checked by the compiler.
 *
 * `vitest --typecheck` runs this file through `tsc`; a `@ts-expect-error` that stops being an
 * error is itself an error, which is what makes the negative cases real assertions.
 */
import { describe, expectTypeOf, it } from 'vitest';
import Bookrail, {
  type Page,
  type PagePromise,
  type BookrailPromise,
  type Booking,
  type BookingCreated,
  type Customer,
  type Event,
  type HoldCreated,
  type Location,
  type WithResponse,
} from '../src/index.js';

const bookrail = new Bookrail('sk_test_0123456789abcdef');

describe('return types', () => {
  /**
   * `bookings.create` answers a `BookingCreated`, which is a `Booking` plus `payment_intent`.
   *
   * A schema of its own rather than a nullable field on `Booking`, because a `GET` can never
   * carry a `client_secret` and a `Booking` that declared the field would be promising one
   * everywhere and delivering it in one place.
   */
  it('bookings.create resolves to a BookingCreated, which extends Booking', () => {
    expectTypeOf(
      bookrail.bookings.create({ service_id: 'svc_1', start: '2026-09-08T07:00:00Z' }),
    ).toEqualTypeOf<BookrailPromise<BookingCreated>>();
    expectTypeOf(
      bookrail.bookings.create({ service_id: 'svc_1', start: '2026-09-08T07:00:00Z' }),
    ).resolves.toEqualTypeOf<BookingCreated>();
    // Every field of a booking is there, so a caller that only wanted the booking is unchanged.
    expectTypeOf<BookingCreated>().toMatchTypeOf<Booking>();
  });

  it('withResponse resolves to the object plus the envelope', () => {
    expectTypeOf(
      bookrail.bookings
        .create({ service_id: 'svc_1', start: '2026-09-08T07:00:00Z' })
        .withResponse(),
    ).resolves.toEqualTypeOf<WithResponse<BookingCreated>>();
  });

  it('a list is a page, and iterating one yields the objects', () => {
    expectTypeOf(bookrail.customers.list()).toEqualTypeOf<PagePromise<Customer>>();
    expectTypeOf(bookrail.customers.list()).resolves.toEqualTypeOf<Page<Customer>>();
    expectTypeOf(bookrail.customers.list()).toMatchTypeOf<AsyncIterable<Customer>>();
  });

  it('creating a hold and reading one are two different objects', () => {
    expectTypeOf(
      bookrail.holds.create({ service_id: 'svc_1', start: 'x' }),
    ).resolves.toEqualTypeOf<HoldCreated>();
    expectTypeOf(bookrail.holds.retrieve('hold_1')).resolves.not.toEqualTypeOf<HoldCreated>();
  });

  it('constructEvent returns an Event, synchronously', () => {
    expectTypeOf(
      bookrail.webhooks.constructEvent('{}', 't=1,v1=x', 'whsec'),
    ).toEqualTypeOf<Event>();
  });

  it('a location is a Location', () => {
    expectTypeOf(
      bookrail.locations.create({ name: 'Club', timezone: 'Europe/Rome' }),
    ).resolves.toEqualTypeOf<Location>();
  });
});

describe('parameters', () => {
  it('refuses a create with the required fields missing', () => {
    // @ts-expect-error `service_id` and `start` are required.
    void bookrail.bookings.create({});
    // @ts-expect-error `start` is required.
    void bookrail.bookings.create({ service_id: 'svc_1' });
    // @ts-expect-error `name` and `timezone` are required.
    void bookrail.locations.create({});
  });

  it('refuses a field the API does not declare', () => {
    void bookrail.bookings.create({
      service_id: 'svc_1',
      start: '2026-09-08T07:00:00Z',
      // @ts-expect-error the API has no `serviceId`: the SDK uses the API's own names.
      serviceId: 'svc_1',
    });
    void bookrail.bookings.create({
      service_id: 'svc_1',
      start: '2026-09-08T07:00:00Z',
      // @ts-expect-error no such field.
      nonsense: true,
    });
  });

  it('refuses a value outside a closed list', () => {
    // @ts-expect-error `status` is a union of the eight booking states.
    void bookrail.bookings.list({ status: 'almost' });
    // @ts-expect-error `expand[]` is a closed list too.
    void bookrail.bookings.list({ 'expand[]': ['nope'] });
  });

  it('refuses a request option that is not one', () => {
    // @ts-expect-error `idempotency_key` is not the name of the option.
    void bookrail.bookings.create({ service_id: 's', start: 'x' }, { idempotency_key: 'k' });
  });
});
