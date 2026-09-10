import type { Template } from './types.js';

/** The ninth vertical shipped as a template, and the engine's ninth regression scenario. */
export const tutoring: Template = {
  name: 'tutoring',
  summary: 'Tutoring: private lessons on the teacher clock, plus a group course.',
  vertical: '9. Teaching (courses, private lessons, tutoring)',
  notes: [
    'The grid follows the **teacher**: the schedule of a virtual resource carries the zone the',
    'lessons are sold in, and a student in another zone simply reads the same instants on his',
    'own clock. Prof. Neri teaches on New York hours.',
    'A group course is one resource with the capacity of the classroom.',
  ],
  config: {
    project: 'tutoring',
    locations: [{ id: 'online', name: 'Online', timezone: 'Europe/Rome' }],
    schedules: {
      rome_hours: {
        name: 'Rome hours',
        timezone: 'Europe/Rome',
        rules: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '15:00', to: '20:00' }],
      },
      new_york_hours: {
        name: 'New York hours',
        timezone: 'America/New_York',
        rules: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '12:00' }],
      },
    },
    resources: [
      {
        id: 'prof_verdi',
        name: 'Prof. Verdi',
        type: 'staff',
        location: 'online',
        schedule: 'rome_hours',
        attributes: { subjects: ['maths', 'physics'] },
      },
      {
        id: 'prof_neri',
        name: 'Prof. Neri',
        type: 'staff',
        location: 'online',
        schedule: 'new_york_hours',
        attributes: { subjects: ['english'] },
      },
      {
        id: 'course_maths',
        name: 'Maths course',
        type: 'class',
        capacity: 12,
        location: 'online',
        schedule: 'rome_hours',
      },
    ],
    resourceGroups: {
      teachers: {
        name: 'Teachers',
        resources: ['prof_verdi', 'prof_neri'],
        allocationStrategy: 'least_busy',
      },
    },
    policies: {
      lesson_policy: {
        name: 'Lesson',
        cancellation: [
          { before: '24h', refundPercent: 100 },
          { before: '0h', refundPercent: 0 },
        ],
        maxReschedules: 2,
        reschedule: [
          { before: '24h', refundPercent: 100 },
          { before: '0h', fee: 500 },
        ],
        holdDuration: '10m',
        autoComplete: true,
      },
    },
    services: [
      {
        id: 'private_lesson',
        name: 'Private lesson',
        duration: 60,
        slotInterval: 60,
        alignTo: 'hour',
        price: { amount: 3500, currency: 'EUR' },
        policy: 'lesson_policy',
        requirements: [{ group: 'teachers', quantity: 1, consumes: 'whole', role: 'teacher' }],
      },
      {
        id: 'group_course',
        name: 'Maths group course',
        duration: 90,
        slotInterval: 30,
        alignTo: 'half_hour',
        price: { amount: 1800, currency: 'EUR' },
        policy: 'lesson_policy',
        requirements: [
          { resource: 'course_maths', quantity: 1, role: 'seat' },
          { resource: 'prof_verdi', quantity: 1, consumes: 'whole', role: 'teacher' },
        ],
      },
    ],
  },
};
