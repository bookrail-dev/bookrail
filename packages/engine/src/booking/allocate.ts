/**
 * The exact assignment of resources to requirements, for the write path.
 *
 * The availability engine is deliberately **conservative**: `resourceOptionsAt` enumerates
 * concrete assignments so that a slot nobody can be assigned to is never offered, but the
 * capacity intersection behind it can still lose a slot in a pathological configuration.
 * Here the assignment is not an illustration, it is the thing being written, so the search is
 * complete: a depth-first walk with backtracking over every requirement, no resource used
 * twice, in the order the group's `allocation_strategy` dictates.
 *
 * The order is where this differs from the read path, and it is why the two searches are not
 * one function. In a response the engine has no state, so `round_robin` can only rotate by
 * the index of the slot; here the rotation starts from `resource_groups.round_robin_cursor`
 * and `least_busy` is the real sum of `capacity_used` over the resource's local day, both
 * read from the database inside the transaction.
 */
import type { AllocationStrategy, RequirementData } from '../availability/index.js';

/** A resource a requirement could take, with the units it would take from it. */
export interface AllocationCandidate {
  readonly resourceId: string;
  /** Residual capacity of the resource over the whole footprint. */
  readonly capacity: number;
  /** Units this requirement would consume: `quantity`, or the resource's whole capacity. */
  readonly need: number;
}

/** One requirement with its candidates already ordered by the group's strategy. */
export interface RequirementPlan {
  readonly requirement: RequirementData;
  readonly candidates: readonly AllocationCandidate[];
}

export interface PlannedAllocation {
  readonly requirementId: string;
  readonly resourceId: string;
  readonly role: string | null;
  readonly capacityUsed: number;
}

/** Ceiling on the nodes the search may visit, as in `resourceOptionsAt`. */
const MAX_SEARCH_STEPS = 200_000;

/**
 * Puts the candidates of one requirement in the order the strategy prescribes.
 *
 * The input order is the loader's: `resource_group_members.priority`, then resource id. That
 * is already `priority`. `first_available` re-sorts by id alone: it means "order of id", not
 * "order of priority". `least_busy` sorts by the day usage the
 * caller measured, ascending, breaking ties by id so that two idle resources are still
 * ordered deterministically. `round_robin` rotates the priority order so that it starts just
 * after the resource the group allocated last.
 */
export function orderCandidates(
  candidates: readonly AllocationCandidate[],
  strategy: AllocationStrategy,
  context: {
    /** `resource_groups.round_robin_cursor`, or null when the group never allocated. */
    readonly cursor?: string | null;
    /** Sum of `capacity_used` over the resource's local day, by resource id. */
    readonly dayUsage?: ReadonlyMap<string, number>;
  } = {},
): AllocationCandidate[] {
  const list = [...candidates];
  if (strategy === 'first_available') {
    return list.sort((a, b) =>
      a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0,
    );
  }
  if (strategy === 'least_busy') {
    const usage = context.dayUsage ?? new Map<string, number>();
    return list.sort(
      (a, b) =>
        (usage.get(a.resourceId) ?? 0) - (usage.get(b.resourceId) ?? 0) ||
        (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0),
    );
  }
  if (strategy === 'round_robin') {
    const cursor = context.cursor ?? null;
    if (cursor === null || list.length < 2) return list;
    const at = list.findIndex((candidate) => candidate.resourceId === cursor);
    // A cursor pointing at a resource that is not a candidate right now (busy, removed from
    // the group, deleted) leaves the order alone: rotating by a phantom would be arbitrary.
    if (at === -1) return list;
    const next = (at + 1) % list.length;
    return [...list.slice(next), ...list.slice(0, next)];
  }
  return list;
}

/**
 * The first complete assignment, or `null` when none exists.
 *
 * "Complete" means: every requirement gets `quantity` distinct resources (or, with
 * `allow_split`, a set of resources whose shares add up to the requested quantity), no
 * resource serves two requirements, and every chosen resource has the residual capacity the
 * requirement needs. "First" means: the first in the lexicographic order of the strategies,
 * which is what makes `priority` and `round_robin` mean anything at all.
 */
export function planAllocation(
  plans: readonly RequirementPlan[],
  options: { readonly allowSplit: boolean; readonly quantity: number },
): PlannedAllocation[] | null {
  if (plans.length === 0) return null;
  const chosen: PlannedAllocation[] = [];
  const used = new Set<string>();
  let steps = 0;

  const walk = (index: number): boolean => {
    if (steps > MAX_SEARCH_STEPS) return false;
    if (index === plans.length) return true;
    const plan = plans[index]!;
    const requirement = plan.requirement;
    const split = options.allowSplit && requirement.consumes !== 'whole';

    if (split) {
      for (let first = 0; first < plan.candidates.length; first += 1) {
        steps += 1;
        if (steps > MAX_SEARCH_STEPS) return false;
        const picked = pickSplit(plan.candidates, first, requirement, used, options.quantity);
        if (picked === null) continue;
        for (const allocation of picked) {
          chosen.push(allocation);
          used.add(allocation.resourceId);
        }
        if (walk(index + 1)) return true;
        for (const allocation of picked) used.delete(allocation.resourceId);
        chosen.length -= picked.length;
      }
      return false;
    }

    let taken = 0;
    const choose = (fromIndex: number): boolean => {
      if (steps > MAX_SEARCH_STEPS) return false;
      if (taken === requirement.quantity) return walk(index + 1);
      for (let i = fromIndex; i < plan.candidates.length; i += 1) {
        steps += 1;
        if (steps > MAX_SEARCH_STEPS) return false;
        const candidate = plan.candidates[i]!;
        if (used.has(candidate.resourceId) || candidate.capacity < candidate.need) continue;
        chosen.push({
          requirementId: requirement.id,
          resourceId: candidate.resourceId,
          role: requirement.role,
          capacityUsed: candidate.need,
        });
        used.add(candidate.resourceId);
        taken += 1;
        if (choose(i + 1)) return true;
        taken -= 1;
        used.delete(candidate.resourceId);
        chosen.pop();
      }
      return false;
    };
    return choose(0);
  };

  return walk(0) ? [...chosen] : null;
}

/**
 * One `allow_split` assignment for a single requirement, starting from `first`, or `null`.
 *
 * Same rule as the read engine's `pickSplit`: each resource keeps one unit in reserve for
 * every resource the requirement still has to name, so a requirement asking for two tables
 * never gives all the covers to the first one and then finds itself with nothing to name.
 */
function pickSplit(
  candidates: readonly AllocationCandidate[],
  first: number,
  requirement: RequirementData,
  used: ReadonlySet<string>,
  quantity: number,
): PlannedAllocation[] | null {
  const taken: PlannedAllocation[] = [];
  let remaining = quantity;
  for (let i = first; i < candidates.length; i += 1) {
    const candidate = candidates[i]!;
    if (used.has(candidate.resourceId)) continue;
    const stillToName = Math.max(0, requirement.quantity - taken.length - 1);
    const share = Math.min(candidate.capacity, remaining - stillToName);
    if (share <= 0) continue;
    taken.push({
      requirementId: requirement.id,
      resourceId: candidate.resourceId,
      role: requirement.role,
      capacityUsed: share,
    });
    remaining -= share;
    if (remaining === 0 && taken.length >= requirement.quantity) return taken;
  }
  return null;
}
