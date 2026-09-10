import type { Template } from './types.js';

/** The seventh vertical shipped as a template, and the engine's seventh regression scenario. */
export const coworking: Template = {
  name: 'coworking',
  summary: 'Coworking: desks by the day, meeting rooms from half an hour to eight.',
  vertical: '7. Coworking and meeting rooms',
  notes: [
    'The meeting room uses `durationRange`: availability answers one continuous range per day',
    'and the maximum is capped by the service, not by the closing time.',
    '`bookingWindow.minNoticeMinutes: 0` is what makes booking from the tablet outside the',
    'room, for right now, legal.',
  ],
  config: {
    project: 'coworking',
    locations: [{ id: 'space', name: 'Space', timezone: 'Europe/Rome' }],
    schedules: {
      office_hours: {
        name: 'Office hours',
        timezone: 'Europe/Rome',
        rules: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '08:00', to: '20:00' }],
      },
    },
    resources: [
      {
        id: 'open_space',
        name: 'Open space',
        type: 'desk',
        capacity: 40,
        location: 'space',
        schedule: 'office_hours',
      },
      {
        id: 'room_1',
        name: 'Meeting room 1',
        type: 'room',
        location: 'space',
        schedule: 'office_hours',
        attributes: { seats: 8, screen: true, whiteboard: true },
      },
    ],
    policies: {
      member: {
        name: 'Member',
        cancellation: [{ before: '1h', refundPercent: 100 }],
        holdDuration: '5m',
        maxActiveBookingsPerCustomer: 3,
        autoStart: true,
        autoComplete: true,
      },
    },
    services: [
      {
        id: 'desk_day',
        name: 'Desk for a day',
        duration: 480,
        alignTo: 'schedule_start',
        price: { amount: 2000, currency: 'EUR' },
        policy: 'member',
        requirements: [{ resource: 'open_space', quantity: 1 }],
      },
      {
        id: 'meeting_room',
        name: 'Meeting room',
        durationRange: { min: 30, max: 480 },
        slotInterval: 30,
        price: { amount: 1500, currency: 'EUR' },
        policy: 'member',
        bookingWindow: { minNoticeMinutes: 0, maxAdvanceDays: 60 },
        requirements: [{ resource: 'room_1', quantity: 1, consumes: 'whole' }],
      },
    ],
  },
};
