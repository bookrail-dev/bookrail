/**
 * One regression scenario per vertical, against a real Postgres: salon, sports court, class
 * studio, rental, restaurant, healthcare, meeting room, tour and private lesson. Those nine are
 * the use cases the engine covers with what exists today; marketplaces, on-site service jobs
 * and multi-day stays wait on features it does not have yet.
 *
 * Every expected value in this file was worked out by hand from the fixture (schedule,
 * duration, buffers, occupancies), and none of it was produced by running the engine first.
 * Each test therefore states what the product promises that vertical, not what the code
 * currently does.
 *
 * Rome is on CEST (+02:00) in June, so 09:00 local is 07:00Z.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, utc, DAY, HOUR, MINUTE, type Harness } from './availability-harness.js';

const WEEKDAYS = [1, 2, 3, 4, 5];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const MONDAY = utc(2026, 6, 1);
const TUESDAY = utc(2026, 6, 2);
const WEDNESDAY = utc(2026, 6, 3);
const THURSDAY = utc(2026, 6, 4);
const SATURDAY = utc(2026, 6, 6);

function starts(result: { slots: readonly { start: number }[] }): number[] {
  return result.slots.map((slot) => slot.start);
}

describe('regression scenarios for the nine verticals the engine covers today', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness('Verticals');
  });

  afterAll(async () => {
    await h.close();
  });

  async function rome(
    rules: { daysOfWeek: number[]; startTime: string; endTime: string }[],
  ): Promise<string> {
    return h.schedule({ timezone: 'Europe/Rome', rules });
  }

  /** 1. Salon: one stylist out of two, colour 90 minutes with a quarter hour of cleaning. */
  it('1. salon: a colour with an after buffer on a morning shift', async () => {
    const schedule = await rome([{ daysOfWeek: WEEKDAYS, startTime: '09:00', endTime: '12:00' }]);
    const anna = await h.resource({ name: 'Anna', scheduleId: schedule });
    const bruno = await h.resource({ name: 'Bruno', scheduleId: schedule });
    const stylists = await h.group({
      name: 'stylists_color',
      strategy: 'least_busy',
      members: [
        { resourceId: anna, priority: 0 },
        { resourceId: bruno, priority: 1 },
      ],
    });
    const colour = await h.service({
      name: 'Colore',
      durationMinutes: 90,
      bufferAfter: 15,
      slotInterval: 30,
      alignTo: 'hour',
      price: { amount: 6000, currency: 'EUR' },
    });
    await h.requirement({ serviceId: colour, groupId: stylists });

    const result = await h.compute(
      { serviceId: colour, from: MONDAY, to: TUESDAY },
      { now: MONDAY - DAY },
    );
    // 09:00-12:00 leaves room for 90 minutes plus 15 of cleaning until 10:15; on a half hour
    // grid that is 09:00, 09:30 and 10:00 local.
    expect(starts(result)).toEqual([
      MONDAY + 7 * HOUR,
      MONDAY + 7 * HOUR + 30 * MINUTE,
      MONDAY + 8 * HOUR,
    ]);
    expect(result.slots[0]!.price).toEqual({ amount: 6000, currency: 'EUR' });
    expect(result.slots[0]!.resourceOptions).toHaveLength(2);
  });

  /** 2. Sports field: one court, two possible lengths, an evening already half booked. */
  it('2. padel court: duration options around an existing match', async () => {
    const schedule = await rome([{ daysOfWeek: WEEKDAYS, startTime: '18:00', endTime: '22:00' }]);
    const court = await h.resource({ name: 'Court 1', scheduleId: schedule });
    const match = await h.service({
      name: 'Partita',
      durationOptions: [60, 90],
      slotInterval: 30,
      alignTo: 'hour',
    });
    await h.requirement({ serviceId: match, resourceId: court });
    // Someone already has 19:00-20:00 local.
    await h.occupancy({
      resourceId: court,
      from: MONDAY + 17 * HOUR,
      to: MONDAY + 18 * HOUR,
    });

    const result = await h.compute(
      { serviceId: match, from: MONDAY, to: TUESDAY },
      { now: MONDAY - DAY },
    );
    expect(result.slots.map((slot) => [slot.start, slot.durationMinutes])).toEqual([
      [MONDAY + 16 * HOUR, 60], // 18:00-19:00 local, the only hour before the match
      [MONDAY + 18 * HOUR, 60], // 20:00 local
      [MONDAY + 18 * HOUR, 90],
      [MONDAY + 18 * HOUR + 30 * MINUTE, 60],
      [MONDAY + 18 * HOUR + 30 * MINUTE, 90], // 20:30-22:00 local, exact fit
      [MONDAY + 19 * HOUR, 60], // 21:00-22:00 local
    ]);
  });

  /**
   * 3. Gym: the seats of a class live on the class resource; the instructor is one person
   * whatever the class size, and the studio holds twenty.
   *
   * This is the vertical that `service_requirements.consumes` exists for (migration 0009).
   * The engine used to compare the requested quantity with **every** resource, so
   * the instructor had to be given a fictitious capacity of fifteen; with `consumes: 'whole'`
   * she is one person with capacity one, and the requirement takes her entirely whether the
   * class has one student or fifteen.
   */
  it('3. yoga class: fifteen seats, one instructor, one room', async () => {
    const schedule = await rome([{ daysOfWeek: WEEKDAYS, startTime: '18:00', endTime: '20:00' }]);
    const klass = await h.resource({ name: 'Vinyasa', capacity: 15, scheduleId: schedule });
    const instructor = await h.resource({ name: 'Sara', capacity: 1, scheduleId: schedule });
    const room = await h.resource({ name: 'Studio A', capacity: 20, scheduleId: schedule });
    const lesson = await h.service({ name: 'Lezione', durationMinutes: 60, alignTo: 'hour' });
    await h.requirement({ serviceId: lesson, resourceId: klass, position: 0, role: 'class' });
    await h.requirement({
      serviceId: lesson,
      resourceId: instructor,
      position: 1,
      role: 'staff',
      consumes: 'whole',
    });
    await h.requirement({ serviceId: lesson, resourceId: room, position: 2, role: 'room' });
    // Thirteen people already signed up for the 18:00 class.
    await h.occupancy({
      resourceId: klass,
      from: MONDAY + 16 * HOUR,
      to: MONDAY + 17 * HOUR,
      capacityUsed: 13,
    });

    const single = await h.compute(
      { serviceId: lesson, from: MONDAY, to: TUESDAY },
      { now: MONDAY - DAY },
    );
    expect(starts(single)).toEqual([MONDAY + 16 * HOUR, MONDAY + 17 * HOUR]);
    expect(single.slots[0]!.availableCapacity).toBe(2);
    expect(single.slots[1]!.availableCapacity).toBe(15);
    // The instructor is taken whole: one unit of her own capacity, not one per student.
    const staff = single.slots[1]!.resourceOptions[0]!.resources.find((r) => r.role === 'staff');
    expect(staff).toEqual({ resourceId: instructor, role: 'staff', capacityUsed: 1 });

    // A couple wanting three places can only take the 19:00 class.
    const three = await h.compute(
      { serviceId: lesson, from: MONDAY, to: TUESDAY },
      { now: MONDAY - DAY, quantity: 3 },
    );
    expect(starts(three)).toEqual([MONDAY + 17 * HOUR]);
    const seats = three.slots[0]!.resourceOptions[0]!.resources;
    expect(seats.find((r) => r.role === 'class')?.capacityUsed).toBe(3);
    expect(seats.find((r) => r.role === 'staff')?.capacityUsed).toBe(1);
  });

  /** 4. Rental: a shop open round the clock, a car out for a day, continuous ranges. */
  it('4. car rental: continuous ranges around a booking, with cleaning time', async () => {
    // `00:00-00:00` is the whole local day; migration 0008 is what makes it storable.
    const schedule = await rome([{ daysOfWeek: EVERY_DAY, startTime: '00:00', endTime: '00:00' }]);
    const car = await h.resource({ name: 'Compact 1', scheduleId: schedule });
    const rental = await h.service({
      name: 'Noleggio',
      durationRange: { min: 1440, max: 43200 },
      bufferAfter: 120,
    });
    await h.requirement({ serviceId: rental, resourceId: car });
    // The rental already out carries the two hours of cleaning of its own service.
    await h.occupancy({
      resourceId: car,
      from: WEDNESDAY + 8 * HOUR,
      to: THURSDAY + 8 * HOUR,
      bufferAfterMs: 120 * MINUTE,
    });

    const result = await h.compute(
      { serviceId: rental, from: MONDAY, to: SATURDAY },
      { now: MONDAY - DAY, granularity: 'ranges' },
    );
    expect(result.slots).toHaveLength(2);
    // Everything up to two hours before the car goes out, then everything from two hours
    // after it comes back.
    expect(result.slots[0]!.start).toBe(MONDAY);
    expect(result.slots[0]!.end).toBe(WEDNESDAY + 6 * HOUR);
    expect(result.slots[0]!.minDurationMinutes).toBe(1440);
    expect(result.slots[0]!.maxDurationMinutes).toBe(54 * 60);
    expect(result.slots[1]!.start).toBe(THURSDAY + 10 * HOUR);
  });

  /** 5. Restaurant: eight covers over two tables of four, which needs `allow_split`. */
  it('5. restaurant: a large party split over two tables', async () => {
    const schedule = await rome([{ daysOfWeek: EVERY_DAY, startTime: '19:30', endTime: '23:00' }]);
    const first = await h.resource({ name: 'Table 1', capacity: 4, scheduleId: schedule });
    const second = await h.resource({ name: 'Table 2', capacity: 4, scheduleId: schedule });
    const tables = await h.group({
      members: [
        { resourceId: first, priority: 0 },
        { resourceId: second, priority: 1 },
      ],
    });
    const dinner = await h.service({
      name: 'Cena',
      durationMinutes: 120,
      slotInterval: 30,
      alignTo: 'half_hour',
      allowSplit: true,
    });
    await h.requirement({ serviceId: dinner, groupId: tables });

    const eight = await h.compute(
      { serviceId: dinner, from: MONDAY, to: TUESDAY },
      { now: MONDAY - DAY, quantity: 8 },
    );
    expect(starts(eight)).toEqual([
      MONDAY + 17 * HOUR + 30 * MINUTE, // 19:30 local
      MONDAY + 18 * HOUR,
      MONDAY + 18 * HOUR + 30 * MINUTE,
      MONDAY + 19 * HOUR, // 21:00-23:00 local, exact fit
    ]);
    expect(eight.slots[0]!.availableCapacity).toBe(8);

    // Three covers on table 1 for the whole evening leave five seats, not eight.
    await h.occupancy({
      resourceId: first,
      from: MONDAY + 18 * HOUR,
      to: MONDAY + 20 * HOUR,
      capacityUsed: 3,
    });
    const stillEight = await h.compute(
      { serviceId: dinner, from: MONDAY, to: TUESDAY },
      { now: MONDAY - DAY, quantity: 8 },
    );
    expect(stillEight.slots).toEqual([]);

    const five = await h.compute(
      { serviceId: dinner, from: MONDAY, to: TUESDAY },
      { now: MONDAY - DAY, quantity: 5 },
    );
    expect(five.slots).toHaveLength(4);
    expect(five.slots[0]!.availableCapacity).toBe(5);
  });

  /**
   * 6. Healthcare: an ultrasound needs a doctor, a room and the machine at the same time, and
   * each of the three is taken **whole**: a sonographer does not do half an examination.
   */
  it('6. ultrasound: three requirements intersected', async () => {
    const wide = await rome([{ daysOfWeek: WEEKDAYS, startTime: '09:00', endTime: '13:00' }]);
    const machineHours = await rome([
      { daysOfWeek: WEEKDAYS, startTime: '10:00', endTime: '12:00' },
    ]);
    const doctorOne = await h.resource({ name: 'Dr Rossi', scheduleId: wide });
    const doctorTwo = await h.resource({ name: 'Dr Bianchi', scheduleId: wide });
    const doctors = await h.group({
      name: 'sonographers',
      strategy: 'priority',
      members: [
        { resourceId: doctorOne, priority: 0 },
        { resourceId: doctorTwo, priority: 1 },
      ],
    });
    const room = await h.resource({ name: 'Room 2', scheduleId: wide });
    const machine = await h.resource({ name: 'Ultrasound', scheduleId: machineHours });

    const scan = await h.service({
      name: 'Ecografia',
      durationMinutes: 30,
      slotInterval: 30,
      alignTo: 'hour',
    });
    for (const [position, requirement] of [
      { groupId: doctors, role: 'doctor' },
      { resourceId: room, role: 'room' },
      { resourceId: machine, role: 'device' },
    ].entries()) {
      await h.requirement({ serviceId: scan, position, consumes: 'whole', ...requirement });
    }

    const result = await h.compute(
      { serviceId: scan, from: MONDAY, to: TUESDAY },
      { now: MONDAY - DAY },
    );
    // The machine is the bottleneck: 10:00 to 12:00 local, four half hours.
    expect(starts(result)).toEqual([
      MONDAY + 8 * HOUR,
      MONDAY + 8 * HOUR + 30 * MINUTE,
      MONDAY + 9 * HOUR,
      MONDAY + 9 * HOUR + 30 * MINUTE,
    ]);
    expect(result.slots[0]!.resourceOptions[0]!.resources.map((r) => r.role)).toEqual([
      'doctor',
      'room',
      'device',
    ]);
    // `priority` puts the first member of the group first.
    expect(result.slots[0]!.resourceOptions[0]!.resources[0]!.resourceId).toBe(doctorOne);
    // Nothing bounds the quantity when every requirement is `whole`, so the slot reports the
    // quantity that was asked for rather than an unbounded number.
    expect(result.slots[0]!.availableCapacity).toBe(1);
    expect(result.slots[0]!.resourceOptions[0]!.resources.every((r) => r.capacityUsed === 1)).toBe(
      true,
    );
  });

  /** 7. Coworking: a meeting room booked for anything from half an hour to eight. */
  it('7. meeting room: one open ended range capped by the service maximum', async () => {
    const schedule = await rome([{ daysOfWeek: WEEKDAYS, startTime: '08:00', endTime: '20:00' }]);
    const room = await h.resource({ name: 'Sala 1', scheduleId: schedule });
    const booking = await h.service({
      name: 'Sala 1h',
      durationRange: { min: 30, max: 480 },
      slotInterval: 30,
    });
    await h.requirement({ serviceId: booking, resourceId: room });

    const result = await h.compute(
      { serviceId: booking, from: MONDAY, to: TUESDAY },
      { now: MONDAY - DAY, granularity: 'ranges' },
    );
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0]).toMatchObject({
      start: MONDAY + 6 * HOUR,
      end: MONDAY + 18 * HOUR,
      minDurationMinutes: 30,
      // Twelve hours of room, but the service never sells more than eight.
      maxDurationMinutes: 480,
    });
  });

  /** 8. Tour: a fixed date, expressed as an `open` exception on a schedule with no rules. */
  it('8. guided tour: a fixed date and a nearly full departure', async () => {
    const schedule = await h.schedule({
      timezone: 'Europe/Rome',
      exceptions: [{ date: '2026-06-03', type: 'open', startTime: '10:00', endTime: '13:00' }],
    });
    const departure = await h.resource({ name: 'Tour 3h', capacity: 20, scheduleId: schedule });
    const guide = await h.resource({ name: 'Guide', capacity: 20, scheduleId: schedule });
    // An hourly grid: with `slot_interval` left to default to the duration, a three hour
    // grid on the local clock would only ever offer 09:00 and 12:00 local, not 10:00.
    const tour = await h.service({
      name: 'Tour',
      durationMinutes: 180,
      slotInterval: 60,
      alignTo: 'hour',
    });
    await h.requirement({ serviceId: tour, resourceId: departure, position: 0 });
    await h.requirement({ serviceId: tour, resourceId: guide, position: 1 });

    const open = await h.compute(
      { serviceId: tour, from: WEDNESDAY, to: THURSDAY },
      { now: WEDNESDAY - DAY, quantity: 4 },
    );
    expect(starts(open)).toEqual([WEDNESDAY + 8 * HOUR]); // 10:00 local, ends at 13:00
    expect(open.slots[0]!.availableCapacity).toBe(20);

    // Eighteen already sold: a party of four no longer fits, a couple does.
    await h.occupancy({
      resourceId: departure,
      from: WEDNESDAY + 8 * HOUR,
      to: WEDNESDAY + 11 * HOUR,
      capacityUsed: 18,
    });
    const four = await h.compute(
      { serviceId: tour, from: WEDNESDAY, to: THURSDAY },
      { now: WEDNESDAY - DAY, quantity: 4 },
    );
    expect(four.slots).toEqual([]);
    const two = await h.compute(
      { serviceId: tour, from: WEDNESDAY, to: THURSDAY },
      { now: WEDNESDAY - DAY, quantity: 2 },
    );
    expect(starts(two)).toEqual([WEDNESDAY + 8 * HOUR]);
    expect(two.slots[0]!.availableCapacity).toBe(2);

    // Nothing on any other day: the schedule has no rules at all.
    const thursday = await h.compute(
      { serviceId: tour, from: THURSDAY, to: utc(2026, 6, 5) },
      { now: WEDNESDAY - DAY, quantity: 2 },
    );
    expect(thursday.slots).toEqual([]);
  });

  /**
   * 9. Training: the virtual resource carries the **teacher's** zone. The student's own
   * time zone never enters the computation: availability is computed on the resource, and
   * only presented in whatever zone the caller asks for.
   */
  it('9. private lesson: the grid follows the teacher, not the student', async () => {
    const schedule = await h.schedule({
      timezone: 'America/New_York',
      rules: [{ daysOfWeek: WEEKDAYS, startTime: '09:00', endTime: '12:00' }],
    });
    const teacher = await h.resource({ name: 'Prof. Neri', scheduleId: schedule });
    const lesson = await h.service({
      name: 'Lezione privata',
      durationMinutes: 60,
      slotInterval: 60,
      alignTo: 'hour',
    });
    await h.requirement({ serviceId: lesson, resourceId: teacher });
    const student = await h.customer();
    await h.setCustomerTimezone(student, 'Asia/Tokyo');

    const result = await h.compute(
      { serviceId: lesson, from: MONDAY, to: TUESDAY, customerId: student },
      { now: MONDAY - DAY },
    );
    // New York is on EDT (-04:00) in June: 09:00 local is 13:00Z.
    expect(starts(result)).toEqual([MONDAY + 13 * HOUR, MONDAY + 14 * HOUR, MONDAY + 15 * HOUR]);
  });
});
