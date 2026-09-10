import type { Template } from './types.js';

/** The eighth vertical shipped as a template, and the engine's eighth regression scenario. */
export const tours: Template = {
  name: 'tours',
  summary: 'Tours and experiences: fixed departures, participants counted on the departure.',
  vertical: '8. Tours, experiences, events',
  notes: [
    'A departure is not recurring: the schedule has no rules at all, only `open` exceptions,',
    'one per date the tour actually runs. Add a date by adding an exception.',
    '`quantity` is the number of participants; the departure resource holds the seats.',
  ],
  config: {
    project: 'tours',
    locations: [{ id: 'meeting_point', name: 'Meeting point', timezone: 'Europe/Rome' }],
    schedules: {
      departures: {
        name: 'Departures',
        timezone: 'Europe/Rome',
        exceptions: [
          { date: '2026-06-03', type: 'open', from: '10:00', to: '13:00' },
          { date: '2026-06-10', type: 'open', from: '10:00', to: '13:00' },
          { date: '2026-06-17', type: 'open', from: '10:00', to: '13:00' },
        ],
      },
    },
    resources: [
      {
        id: 'departure',
        name: 'City tour departure',
        type: 'departure',
        capacity: 20,
        location: 'meeting_point',
        schedule: 'departures',
      },
      {
        id: 'guide',
        name: 'Guide',
        type: 'staff',
        capacity: 20,
        location: 'meeting_point',
        schedule: 'departures',
      },
    ],
    policies: {
      tour_policy: {
        name: 'Tour',
        cancellation: [
          { before: '24h', refundPercent: 100 },
          { before: '0h', refundPercent: 0 },
        ],
        deposit: { type: 'percent', value: 100 },
        paymentTiming: 'at_booking',
        holdDuration: '15m',
        autoComplete: true,
      },
    },
    services: [
      {
        id: 'city_tour',
        name: 'City tour',
        duration: 180,
        slotInterval: 60,
        alignTo: 'hour',
        price: { amount: 4500, currency: 'EUR' },
        policy: 'tour_policy',
        requirements: [
          { resource: 'departure', quantity: 1, role: 'seat' },
          { resource: 'guide', quantity: 1, role: 'guide' },
        ],
      },
    ],
  },
};
