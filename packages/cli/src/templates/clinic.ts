import type { Template } from './types.js';

/** The sixth vertical shipped as a template, and the engine's sixth regression scenario. */
export const clinic: Template = {
  name: 'clinic',
  summary: 'Healthcare: a scan needs a doctor, a room and the machine at the same time.',
  vertical: '6. Healthcare (medical practices, physiotherapy, vets, dentists)',
  notes: [
    'The three requirements are intersected, and each is taken whole: a sonographer does not',
    'do half an examination. The machine has its own, narrower schedule, so it is the',
    'bottleneck and the availability follows it.',
    'Bookrail stores the minimum about a patient: link the record in your own system with',
    '`customer.external_id`.',
  ],
  config: {
    project: 'clinic',
    locations: [{ id: 'clinic', name: 'Clinic', timezone: 'Europe/Rome' }],
    schedules: {
      surgery: {
        name: 'Surgery hours',
        timezone: 'Europe/Rome',
        rules: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '13:00' }],
      },
      machine_hours: {
        name: 'Ultrasound hours',
        timezone: 'Europe/Rome',
        rules: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '10:00', to: '12:00' }],
      },
    },
    resources: [
      {
        id: 'dr_rossi',
        name: 'Dr Rossi',
        type: 'staff',
        location: 'clinic',
        schedule: 'surgery',
        attributes: { specialties: ['sonography'] },
      },
      {
        id: 'dr_bianchi',
        name: 'Dr Bianchi',
        type: 'staff',
        location: 'clinic',
        schedule: 'surgery',
        attributes: { specialties: ['sonography'] },
      },
      { id: 'room_2', name: 'Room 2', type: 'room', location: 'clinic', schedule: 'surgery' },
      {
        id: 'ultrasound',
        name: 'Ultrasound',
        type: 'device',
        location: 'clinic',
        schedule: 'machine_hours',
      },
    ],
    resourceGroups: {
      sonographers: {
        name: 'Sonographers',
        resources: ['dr_rossi', 'dr_bianchi'],
        allocationStrategy: 'priority',
      },
    },
    policies: {
      first_visit: {
        name: 'First visit',
        cancellation: [
          { before: '48h', refundPercent: 100 },
          { before: '0h', refundPercent: 0 },
        ],
        requireProviderConfirmation: true,
        noShow: { chargePercent: 100, graceMinutes: 15, autoMark: true },
        holdDuration: '10m',
      },
    },
    services: [
      {
        id: 'visit',
        name: 'Visit',
        duration: 20,
        slotInterval: 20,
        alignTo: 'hour',
        price: { amount: 8000, currency: 'EUR' },
        policy: 'first_visit',
        requirements: [{ group: 'sonographers', quantity: 1, consumes: 'whole', role: 'doctor' }],
      },
      {
        id: 'scan',
        name: 'Ultrasound scan',
        duration: 30,
        slotInterval: 30,
        alignTo: 'hour',
        price: { amount: 12000, currency: 'EUR' },
        policy: 'first_visit',
        requirements: [
          { group: 'sonographers', quantity: 1, consumes: 'whole', role: 'doctor' },
          { resource: 'room_2', quantity: 1, consumes: 'whole', role: 'room' },
          { resource: 'ultrasound', quantity: 1, consumes: 'whole', role: 'device' },
        ],
      },
    ],
  },
};
