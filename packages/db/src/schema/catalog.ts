import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { projectScopeColumns, timestampColumns, tstzrange } from './columns.js';

export const locations = pgTable(
  'locations',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    tenantId: text('tenant_id'),
    name: text('name').notNull(),
    timezone: text('timezone').notNull(),
    address: jsonb('address'),
    metadata: jsonb('metadata').notNull().default({}),
    ...timestampColumns(),
  },
  (t) => [index('locations_scope_idx').on(t.projectId, t.environment)],
);

export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    name: text('name').notNull(),
    timezone: text('timezone'),
    metadata: jsonb('metadata').notNull().default({}),
    ...timestampColumns(),
  },
  (t) => [index('schedules_scope_idx').on(t.projectId, t.environment)],
);

export const scheduleRules = pgTable(
  'schedule_rules',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    scheduleId: uuid('schedule_id').notNull(),
    daysOfWeek: smallint('days_of_week').array().notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    validFrom: date('valid_from'),
    validUntil: date('valid_until'),
    ...timestampColumns(),
  },
  (t) => [
    index('schedule_rules_schedule_idx').on(t.scheduleId),
    index('schedule_rules_scope_idx').on(t.projectId, t.environment),
  ],
);

export const scheduleExceptions = pgTable(
  'schedule_exceptions',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    scheduleId: uuid('schedule_id').notNull(),
    date: date('date').notNull(),
    type: text('type').notNull().$type<'closed' | 'open'>(),
    startTime: time('start_time'),
    endTime: time('end_time'),
    reason: text('reason'),
    ...timestampColumns(),
  },
  (t) => [
    index('schedule_exceptions_schedule_date_idx').on(t.scheduleId, t.date),
    index('schedule_exceptions_scope_idx').on(t.projectId, t.environment),
  ],
);

export const resources = pgTable(
  'resources',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    tenantId: text('tenant_id'),
    name: text('name').notNull(),
    type: text('type').notNull().default('staff'),
    locationId: uuid('location_id'),
    scheduleId: uuid('schedule_id'),
    capacity: integer('capacity').notNull().default(1),
    attributes: jsonb('attributes').notNull().default({}),
    status: text('status').notNull().default('active').$type<'active' | 'inactive'>(),
    metadata: jsonb('metadata').notNull().default({}),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestampColumns(),
  },
  (t) => [
    index('resources_scope_idx').on(t.projectId, t.environment),
    index('resources_location_idx').on(t.locationId),
  ],
);

export const resourceGroups = pgTable(
  'resource_groups',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    name: text('name').notNull(),
    selector: jsonb('selector'),
    allocationStrategy: text('allocation_strategy')
      .notNull()
      .default('first_available')
      .$type<'least_busy' | 'round_robin' | 'first_available' | 'priority'>(),
    /** Last resource this group allocated; `round_robin` starts from the next one. */
    roundRobinCursor: uuid('round_robin_cursor'),
    metadata: jsonb('metadata').notNull().default({}),
    ...timestampColumns(),
  },
  (t) => [index('resource_groups_scope_idx').on(t.projectId, t.environment)],
);

export const resourceGroupMembers = pgTable(
  'resource_group_members',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    resourceGroupId: uuid('resource_group_id').notNull(),
    resourceId: uuid('resource_id').notNull(),
    priority: integer('priority').notNull().default(0),
    ...timestampColumns(),
  },
  (t) => [
    index('resource_group_members_resource_idx').on(t.resourceId),
    index('resource_group_members_scope_idx').on(t.projectId, t.environment),
  ],
);

export const resourceBlocks = pgTable(
  'resource_blocks',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    resourceId: uuid('resource_id').notNull(),
    period: tstzrange('period').notNull(),
    reason: text('reason'),
    metadata: jsonb('metadata').notNull().default({}),
    ...timestampColumns(),
  },
  (t) => [index('resource_blocks_scope_idx').on(t.projectId, t.environment)],
);

export const policies = pgTable(
  'policies',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    name: text('name').notNull(),
    cancellation: jsonb('cancellation').notNull().default([]),
    reschedule: jsonb('reschedule').notNull().default([]),
    deposit: jsonb('deposit'),
    paymentTiming: text('payment_timing')
      .notNull()
      .default('none')
      .$type<'at_booking' | 'before_start' | 'after_service' | 'none'>(),
    paymentDeadline: text('payment_deadline'),
    noShow: jsonb('no_show'),
    holdDurationSeconds: integer('hold_duration_seconds').notNull().default(600),
    maxActiveBookingsPerCustomer: integer('max_active_bookings_per_customer'),
    requireCustomerConfirmation: boolean('require_customer_confirmation').notNull().default(false),
    requireProviderConfirmation: boolean('require_provider_confirmation').notNull().default(false),
    autoStart: boolean('auto_start').notNull().default(false),
    autoComplete: boolean('auto_complete').notNull().default(false),
    maxReschedules: integer('max_reschedules'),
    metadata: jsonb('metadata').notNull().default({}),
    ...timestampColumns(),
  },
  (t) => [index('policies_scope_idx').on(t.projectId, t.environment)],
);

export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    tenantId: text('tenant_id'),
    name: text('name').notNull(),
    description: text('description'),
    durationMinutes: integer('duration_minutes'),
    durationOptions: integer('duration_options').array(),
    durationMinMinutes: integer('duration_min_minutes'),
    durationMaxMinutes: integer('duration_max_minutes'),
    capacityPerBooking: integer('capacity_per_booking').notNull().default(1),
    bufferBeforeMinutes: integer('buffer_before_minutes').notNull().default(0),
    bufferAfterMinutes: integer('buffer_after_minutes').notNull().default(0),
    slotIntervalMinutes: integer('slot_interval_minutes'),
    alignTo: text('align_to').$type<'hour' | 'half_hour' | 'schedule_start'>(),
    priceAmount: integer('price_amount'),
    priceCurrency: text('price_currency'),
    pricingRules: jsonb('pricing_rules').notNull().default([]),
    policyId: uuid('policy_id'),
    bookingWindow: jsonb('booking_window'),
    allowRecurring: boolean('allow_recurring').notNull().default(false),
    allowMultiDay: boolean('allow_multi_day').notNull().default(false),
    /** Two adjacent bookings may share the gap between them instead of each demanding one. */
    bufferSharing: boolean('buffer_sharing').notNull().default(false),
    /** A quantity larger than one resource may be summed across resources of the same group. */
    allowSplit: boolean('allow_split').notNull().default(false),
    metadata: jsonb('metadata').notNull().default({}),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestampColumns(),
  },
  (t) => [
    index('services_scope_idx').on(t.projectId, t.environment),
    index('services_policy_idx').on(t.policyId),
  ],
);

export const serviceRequirements = pgTable(
  'service_requirements',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    serviceId: uuid('service_id').notNull(),
    resourceId: uuid('resource_id'),
    resourceGroupId: uuid('resource_group_id'),
    quantity: integer('quantity').notNull().default(1),
    /** `per_unit`: takes `quantity` units. `whole`: takes the resource entirely. */
    consumes: text('consumes').notNull().default('per_unit').$type<'per_unit' | 'whole'>(),
    role: text('role'),
    position: integer('position').notNull().default(0),
    ...timestampColumns(),
  },
  (t) => [
    index('service_requirements_service_idx').on(t.serviceId, t.position),
    index('service_requirements_scope_idx').on(t.projectId, t.environment),
  ],
);

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey(),
    ...projectScopeColumns(),
    tenantId: text('tenant_id'),
    externalId: text('external_id'),
    email: text('email'),
    phone: text('phone'),
    name: text('name'),
    timezone: text('timezone'),
    locale: text('locale'),
    metadata: jsonb('metadata').notNull().default({}),
    ...timestampColumns(),
  },
  (t) => [index('customers_scope_idx').on(t.projectId, t.environment)],
);
