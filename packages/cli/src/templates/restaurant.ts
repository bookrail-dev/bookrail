import type { Template } from './types.js';

/** The fifth vertical shipped as a template, and the engine's fifth regression scenario. */
export const restaurant: Template = {
  name: 'restaurant',
  summary: 'Restaurant: covers on tables, two services a day, large parties split over tables.',
  vertical: '5. Restaurants',
  notes: [
    "`quantity` is the number of covers, and a table's capacity is how many it seats.",
    '`allowSplit` lets a party of eight take two tables of four; without it, eight covers',
    'would need a single table that seats eight.',
  ],
  config: {
    project: 'restaurant',
    locations: [{ id: 'dining', name: 'Dining room', timezone: 'Europe/Rome' }],
    schedules: {
      services: {
        name: 'Lunch and dinner',
        timezone: 'Europe/Rome',
        rules: [
          { days: ['tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '12:30', to: '14:30' },
          { days: ['tue', 'wed', 'thu', 'fri', 'sat'], from: '19:30', to: '23:00' },
        ],
      },
    },
    resources: [
      {
        id: 'table_1',
        name: 'Table 1',
        type: 'table',
        capacity: 4,
        location: 'dining',
        schedule: 'services',
        attributes: { area: 'inside', min_party: 2, max_party: 4 },
      },
      {
        id: 'table_2',
        name: 'Table 2',
        type: 'table',
        capacity: 4,
        location: 'dining',
        schedule: 'services',
        attributes: { area: 'terrace', min_party: 2, max_party: 4 },
      },
    ],
    resourceGroups: {
      tables: {
        name: 'Tables',
        resources: ['table_1', 'table_2'],
        allocationStrategy: 'first_available',
      },
    },
    policies: {
      no_prepayment: {
        name: 'No prepayment',
        cancellation: [{ before: '0h', refundPercent: 100 }],
        holdDuration: '10m',
        noShow: { chargePercent: 0, graceMinutes: 20 },
      },
    },
    services: [
      {
        id: 'dinner',
        name: 'Dinner',
        duration: 120,
        slotInterval: 30,
        alignTo: 'half_hour',
        allowSplit: true,
        policy: 'no_prepayment',
        requirements: [{ group: 'tables', quantity: 1 }],
      },
    ],
  },
};
