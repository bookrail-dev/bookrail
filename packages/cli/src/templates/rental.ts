import type { Template } from './types.js';

/** The fourth vertical shipped as a template, and the engine's fourth regression scenario. */
export const rental: Template = {
  name: 'rental',
  summary: 'Rental: continuous ranges from one day to thirty, with cleaning time after each.',
  vertical: '4. Rental (cars, bikes, boats, equipment)',
  notes: [
    'The shop is open around the clock: a rule from 00:00 to 00:00 is the whole local day.',
    '`durationRange` plus `allowMultiDay` is what makes availability answer continuous ranges',
    'instead of a grid of slots; ask for it with `--granularity ranges`.',
  ],
  config: {
    project: 'rental',
    locations: [{ id: 'depot', name: 'Depot', timezone: 'Europe/Rome' }],
    schedules: {
      always: {
        name: 'Always open',
        timezone: 'Europe/Rome',
        rules: [
          { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '00:00', to: '00:00' },
        ],
      },
    },
    resources: [
      {
        id: 'compact_1',
        name: 'Compact 1',
        type: 'vehicle',
        location: 'depot',
        schedule: 'always',
        attributes: { category: 'compact', seats: 5, gearbox: 'manual' },
      },
      {
        id: 'compact_2',
        name: 'Compact 2',
        type: 'vehicle',
        location: 'depot',
        schedule: 'always',
        attributes: { category: 'compact', seats: 5, gearbox: 'automatic' },
      },
    ],
    resourceGroups: {
      compacts: {
        name: 'Compact cars',
        resources: ['compact_1', 'compact_2'],
        allocationStrategy: 'least_busy',
      },
    },
    policies: {
      rental_policy: {
        name: 'Rental',
        cancellation: [
          { before: '7d', refundPercent: 100 },
          { before: '48h', refundPercent: 50 },
          { before: '0h', refundPercent: 0 },
        ],
        deposit: { type: 'fixed', value: 20000 },
        paymentTiming: 'at_booking',
        holdDuration: '15m',
      },
    },
    services: [
      {
        id: 'car_rental',
        name: 'Car rental',
        durationRange: { min: 1440, max: 43200 },
        bufferAfter: 120,
        allowMultiDay: true,
        price: { amount: 4900, currency: 'EUR' },
        policy: 'rental_policy',
        requirements: [{ group: 'compacts', quantity: 1 }],
      },
    ],
  },
};
