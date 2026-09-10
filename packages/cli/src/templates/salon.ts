import type { Template } from './types.js';

/** The first vertical shipped as a template, and the engine's first regression scenario. */
export const salon: Template = {
  name: 'salon',
  summary: 'Hair salon: stylists with skills, a treatment cabin, a colour with cleaning time.',
  vertical: '1. Salon, barber, beauty studio',
  notes: [
    'The colour takes 90 minutes plus 15 of cleaning: `bufferAfter` is the cleaning, and it',
    'keeps the next booking away from the chair without being sold to anyone.',
    'A customer who wants "anyone" books the group; one who wants Anna passes her resource id.',
  ],
  config: {
    project: 'salon',
    locations: [{ id: 'main', name: 'Salon', timezone: 'Europe/Rome' }],
    schedules: {
      opening: {
        name: 'Opening hours',
        timezone: 'Europe/Rome',
        rules: [
          { days: ['tue', 'wed', 'thu', 'fri'], from: '09:00', to: '19:00' },
          { days: ['sat'], from: '09:00', to: '18:00' },
        ],
      },
    },
    resources: [
      {
        id: 'anna',
        name: 'Anna',
        type: 'staff',
        location: 'main',
        schedule: 'opening',
        attributes: { skills: ['cut', 'color'] },
      },
      {
        id: 'bruno',
        name: 'Bruno',
        type: 'staff',
        location: 'main',
        schedule: 'opening',
        attributes: { skills: ['cut'] },
      },
      {
        id: 'nadia',
        name: 'Nadia',
        type: 'staff',
        location: 'main',
        schedule: 'opening',
        attributes: { skills: ['nails'] },
      },
      { id: 'cabin_1', name: 'Cabin 1', type: 'room', location: 'main', schedule: 'opening' },
    ],
    resourceGroups: {
      stylists: {
        name: 'Stylists',
        resources: ['anna', 'bruno'],
        allocationStrategy: 'least_busy',
      },
      stylists_color: {
        name: 'Stylists (colour)',
        resources: ['anna'],
        allocationStrategy: 'least_busy',
      },
      nail_techs: { name: 'Nail technicians', resources: ['nadia'] },
      cabins: { name: 'Cabins', resources: ['cabin_1'] },
    },
    policies: {
      standard: {
        name: 'Standard',
        cancellation: [
          { before: '24h', refundPercent: 100 },
          { before: '0h', refundPercent: 0 },
        ],
        deposit: { type: 'percent', value: 20 },
        noShow: { chargePercent: 50, graceMinutes: 15, autoMark: true },
        holdDuration: '10m',
        autoComplete: true,
      },
    },
    services: [
      {
        id: 'cut',
        name: 'Cut',
        duration: 30,
        slotInterval: 30,
        alignTo: 'half_hour',
        price: { amount: 2500, currency: 'EUR' },
        policy: 'standard',
        requirements: [{ group: 'stylists', quantity: 1 }],
      },
      {
        id: 'color',
        name: 'Colour',
        duration: 90,
        bufferAfter: 15,
        slotInterval: 30,
        alignTo: 'hour',
        price: { amount: 6000, currency: 'EUR' },
        policy: 'standard',
        requirements: [{ group: 'stylists_color', quantity: 1 }],
      },
      {
        id: 'manicure',
        name: 'Manicure',
        duration: 45,
        slotInterval: 15,
        price: { amount: 3000, currency: 'EUR' },
        policy: 'standard',
        requirements: [
          { group: 'nail_techs', quantity: 1, role: 'staff' },
          { group: 'cabins', quantity: 1, role: 'room' },
        ],
      },
    ],
  },
};
