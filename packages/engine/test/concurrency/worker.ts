/**
 * One process of the concurrency suite.
 *
 * It gets its instructions over IPC, opens **its own** pool against the application role
 * (no connection is shared with the coordinator or with the other workers), fires every
 * request at once, and reports one outcome string per request.
 *
 * Only the code paths the API uses are exercised: `createBooking`, `createHold`,
 * `releaseHold` and, for the `block_race` scenario, `takeOccupancy`, which is exactly what
 * `POST /v1/resources/{id}/block` calls. No shortcut, no privileged
 * connection.
 */
import { createDatabase, createPool, resolveDatabaseUrls, withProjectContext } from '@bookrail/db';
import { uuidv7 } from '@bookrail/shared';

import {
  createBooking,
  createHold,
  releaseHold,
  takeOccupancy,
  transition,
} from '../../src/index.js';

export type ScenarioName =
  | 'capacity'
  | 'composite'
  | 'hold_race'
  | 'block_race'
  | 'mixed'
  | 'two_services'
  | 'reschedule_race'
  | 'customer_limit_race';

interface Instruction {
  databaseName: string;
  projectId: string;
  serviceId: string;
  /** `two_services`: the second service racing for the same resource, taken `whole`. */
  otherServiceId?: string | null;
  /** `block_race`: the resource a block would close, and its capacity. */
  blockResourceId?: string | null;
  blockCapacity?: number | null;
  /** `reschedule_race`: the booking to move, where to, and onto which resource. */
  bookingId?: string | null;
  targetResourceId?: string | null;
  targetStart?: number | null;
  /** `customer_limit_race`: one room per request, and the customer they all book for. */
  resourceIds?: string[];
  customerId?: string | null;
  start: number;
  end: number;
  scenario: ScenarioName;
  count: number;
  /** The global index of this process's first request, so every request picks its own room. */
  firstIndex?: number;
  connections: number;
  maxRetries: number;
  isolationLevel: 'read committed' | 'serializable';
  offset: number;
}

function outcomeOf(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  return typeof code === 'string' ? code : `unknown:${String((error as Error).message)}`;
}

process.on('message', (raw: Instruction) => {
  void run(raw);
});

/**
 * Exactly what `POST /v1/resources/{id}/block` does: the catalogue row, then `takeOccupancy`
 * with the whole capacity of the resource.
 */
async function block(
  db: ReturnType<typeof createDatabase>,
  instruction: Instruction,
): Promise<void> {
  const resourceId = instruction.blockResourceId;
  const capacity = instruction.blockCapacity;
  if (resourceId == null || capacity == null) throw new Error('block scenario misconfigured');
  const blockId = uuidv7();
  await withProjectContext(
    db,
    { projectId: instruction.projectId, environment: 'test' },
    async (tx) => {
      await takeOccupancy(tx, {
        projectId: instruction.projectId,
        environment: 'test',
        resourceIds: [resourceId],
        allocations: [{ resourceId, capacityUsed: capacity }],
        start: instruction.start,
        end: instruction.end,
        kind: 'block',
        refId: blockId,
        capacities: new Map([[resourceId, capacity]]),
      });
    },
    // The block has to run at the **same** isolation level as everything else it races with.
    // Postgres only guarantees serializability between serializable transactions: a
    // `read committed` block committing while a `serializable` booking waits on the lock is
    // invisible to SSI, and the booking then writes over a capacity it cannot see. Measured:
    // one resource over capacity per two rounds until this argument was passed.
    { isolationLevel: instruction.isolationLevel },
  );
}

async function run(instruction: Instruction): Promise<void> {
  const urls = resolveDatabaseUrls({ databaseName: instruction.databaseName });
  const pool = createPool({ connectionString: urls.app, max: instruction.connections });
  const db = createDatabase(pool);
  const now = Date.now();

  const one = async (index: number): Promise<string> => {
    const parity = (index + instruction.offset) % 2 === 0;
    const request = {
      projectId: instruction.projectId,
      environment: 'test' as const,
      serviceId: instruction.serviceId,
      start: instruction.start,
      quantity: 1,
      now,
      maxRetries: instruction.maxRetries,
      isolationLevel: instruction.isolationLevel,
    };
    try {
      switch (instruction.scenario) {
        case 'hold_race':
          // Half the fleet asks for a hold and half for a booking: they compete for the same
          // units and only one of them may have them.
          if (parity) await createHold(db, request);
          else await createBooking(db, { ...request, kind: 'booking' });
          return 'won';

        case 'block_race':
          // One request in four closes the resource the way the block route does. A block
          // takes the whole capacity, so it and the bookings genuinely fight; what must never
          // happen is that both get through.
          if ((index + instruction.offset) % 4 === 0) {
            await block(db, instruction);
            return 'won';
          }
          await createBooking(db, { ...request, kind: 'booking' });
          return 'won';

        case 'mixed': {
          // A hold, then either the conversion or the release. Only a conversion counts as a
          // win: a released hold gave its capacity back, and a request that ends holding
          // nothing has not taken any.
          const hold = await createHold(db, request);
          if (parity) {
            await createBooking(db, { ...request, kind: 'booking', holdId: hold.id });
            return 'won';
          }
          await releaseHold(db, {
            projectId: instruction.projectId,
            environment: 'test',
            holdId: hold.id,
            now,
            maxRetries: instruction.maxRetries,
            isolationLevel: instruction.isolationLevel,
          });
          return 'released';
        }

        case 'reschedule_race': {
          // Every process asks to move the **same** booking to the same later hour, forced
          // onto the same capacity-1 room. Exactly one may win; the rest have to be refused by
          // the state machine, because the booking they wanted is no longer `confirmed`.
          if (
            instruction.bookingId == null ||
            instruction.targetResourceId == null ||
            instruction.targetStart == null
          ) {
            throw new Error('reschedule scenario misconfigured');
          }
          await transition(db, {
            projectId: instruction.projectId,
            environment: 'test',
            bookingId: instruction.bookingId,
            action: 'reschedule',
            actor: { type: 'system', id: null },
            now,
            start: instruction.targetStart,
            resourceIds: [instruction.targetResourceId],
            maxRetries: instruction.maxRetries,
            isolationLevel: instruction.isolationLevel,
          });
          return 'won';
        }

        case 'customer_limit_race': {
          // Every request books for the **same** customer, on a room of its own. The rooms are
          // disjoint, so no two requests share an advisory lock on a resource: what has to stop
          // the fourth booking is the lock on the customer, and nothing else.
          const rooms = instruction.resourceIds ?? [];
          const global = (instruction.firstIndex ?? 0) + index;
          const room = rooms[global % rooms.length];
          if (room === undefined || instruction.customerId == null) {
            throw new Error('customer limit scenario misconfigured');
          }
          await createBooking(db, {
            ...request,
            kind: 'booking',
            customerId: instruction.customerId,
            resourceIds: [room],
          });
          return 'won';
        }

        case 'two_services':
          // Two services on the same resource: one takes a single unit, the other takes the
          // resource `whole`. They must never both succeed on the same instant.
          await createBooking(db, {
            ...request,
            serviceId:
              parity && instruction.otherServiceId != null
                ? instruction.otherServiceId
                : instruction.serviceId,
            kind: 'booking',
          });
          return 'won';

        default:
          await createBooking(db, { ...request, kind: 'booking' });
          return 'won';
      }
    } catch (error) {
      return outcomeOf(error);
    }
  };

  try {
    const outcomes = await Promise.all(
      Array.from({ length: instruction.count }, (_unused, index) => one(index)),
    );
    process.send?.(outcomes);
  } finally {
    await pool.end();
  }
  process.exit(0);
}
