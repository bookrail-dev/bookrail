import type { Template } from './types.js';

/** The third vertical shipped as a template, and the engine's third regression scenario. */
export const gym: Template = {
  name: 'gym',
  summary: 'Group classes: the seats live on the class, the instructor is taken whole.',
  vertical: '3. Gyms and studios (yoga, pilates, crossfit)',
  notes: [
    'The class is a resource with capacity 15: that is where the seats are counted.',
    'The instructor has capacity 1 and `consumes: "whole"`, so a class of one student and a',
    'class of fifteen take exactly one of her either way (migration 0009).',
  ],
  config: {
    project: 'gym',
    locations: [{ id: 'studio', name: 'Studio', timezone: 'Europe/Rome' }],
    schedules: {
      evening: {
        name: 'Evening classes',
        timezone: 'Europe/Rome',
        rules: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '18:00', to: '21:00' }],
      },
    },
    resources: [
      {
        id: 'vinyasa',
        name: 'Vinyasa',
        type: 'class',
        capacity: 15,
        location: 'studio',
        schedule: 'evening',
      },
      {
        id: 'sara',
        name: 'Sara',
        type: 'staff',
        capacity: 1,
        location: 'studio',
        schedule: 'evening',
      },
      {
        id: 'studio_a',
        name: 'Studio A',
        type: 'room',
        capacity: 20,
        location: 'studio',
        schedule: 'evening',
      },
    ],
    policies: {
      class_policy: {
        name: 'Class',
        cancellation: [
          { before: '2h', refundPercent: 100 },
          { before: '0h', refundPercent: 0 },
        ],
        holdDuration: '10m',
        autoStart: true,
        autoComplete: true,
        noShow: { graceMinutes: 10, autoMark: true },
      },
    },
    services: [
      {
        id: 'lesson',
        name: 'Vinyasa lesson',
        duration: 60,
        alignTo: 'hour',
        price: { amount: 1500, currency: 'EUR' },
        policy: 'class_policy',
        requirements: [
          { resource: 'vinyasa', quantity: 1, role: 'class' },
          { resource: 'sara', quantity: 1, consumes: 'whole', role: 'staff' },
          { resource: 'studio_a', quantity: 1, role: 'room' },
        ],
      },
    ],
  },
};
