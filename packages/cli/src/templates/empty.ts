import type { Template } from './types.js';

/** The starting point for a model that none of the nine vertical templates fits. */
export const empty: Template = {
  name: 'empty',
  summary: 'One location, one schedule, one resource, one service: the smallest thing that works.',
  vertical: 'none',
  notes: [
    'Rename the ids, then run `bookrail push --dry-run` to see what would be created.',
    '`bookrail examples <vertical>` prints a fuller model for each of the nine verticals.',
  ],
  config: {
    project: 'my-project',
    locations: [{ id: 'main', name: 'Main', timezone: 'Europe/Rome' }],
    schedules: {
      weekdays: {
        name: 'Weekdays',
        timezone: 'Europe/Rome',
        rules: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '18:00' }],
      },
    },
    resources: [
      { id: 'staff_1', name: 'Staff 1', type: 'staff', location: 'main', schedule: 'weekdays' },
    ],
    policies: {
      standard: {
        name: 'Standard',
        cancellation: [
          { before: '24h', refundPercent: 100 },
          { before: '0h', refundPercent: 0 },
        ],
        holdDuration: '10m',
      },
    },
    services: [
      {
        id: 'appointment',
        name: 'Appointment',
        duration: 60,
        slotInterval: 30,
        alignTo: 'hour',
        price: { amount: 5000, currency: 'EUR' },
        policy: 'standard',
        requirements: [{ resource: 'staff_1', quantity: 1 }],
      },
    ],
  },
};
