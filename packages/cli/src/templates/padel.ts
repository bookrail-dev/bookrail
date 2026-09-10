import type { Template } from './types.js';

/** The second vertical shipped as a template, and the engine's second regression scenario. */
export const padel: Template = {
  name: 'padel',
  summary: 'Sports courts: capacity one, two match lengths, payment up front.',
  vertical: '2. Sports courts (padel, tennis, five a side)',
  notes: [
    'A court is a resource with capacity 1, so the exclusion constraint of the database, not',
    'the application, is what makes a double booking impossible.',
    '`durationOptions` offers 60 and 90 minutes from the same grid of half hours.',
  ],
  config: {
    project: 'padel',
    locations: [{ id: 'club', name: 'Club', timezone: 'Europe/Rome' }],
    schedules: {
      club_hours: {
        name: 'Club hours',
        timezone: 'Europe/Rome',
        rules: [
          { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '08:00', to: '23:00' },
        ],
      },
    },
    resources: [
      { id: 'court_1', name: 'Court 1', type: 'court', location: 'club', schedule: 'club_hours' },
      { id: 'court_2', name: 'Court 2', type: 'court', location: 'club', schedule: 'club_hours' },
    ],
    resourceGroups: {
      courts: {
        name: 'Courts',
        resources: ['court_1', 'court_2'],
        allocationStrategy: 'first_available',
      },
    },
    policies: {
      prepaid: {
        name: 'Prepaid',
        cancellation: [
          { before: '12h', refundPercent: 100 },
          { before: '0h', refundPercent: 0 },
        ],
        deposit: { type: 'percent', value: 100 },
        paymentTiming: 'at_booking',
        holdDuration: '10m',
        autoComplete: true,
      },
    },
    services: [
      {
        id: 'match',
        name: 'Match',
        durationOptions: [60, 90],
        slotInterval: 30,
        alignTo: 'hour',
        price: { amount: 3000, currency: 'EUR' },
        policy: 'prepaid',
        bookingWindow: { minNoticeMinutes: 60, maxAdvanceDays: 14 },
        requirements: [{ group: 'courts', quantity: 1 }],
      },
    ],
  },
};
