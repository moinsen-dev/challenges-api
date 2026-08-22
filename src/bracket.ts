/**
 * Single-elimination bracket construction.
 *
 * Two properties matter and both are easy to get subtly wrong:
 *
 *   1. The best seed must meet the worst, second must meet second-worst, and
 *      so on — otherwise the two strongest entrants can meet in round one and
 *      the bracket stops meaning anything.
 *   2. When the field is not a power of two, the byes must go to the top
 *      seeds. A bye handed to a low seed is a bracket that rewards arriving
 *      late.
 */

/** Standard seeding order for a bracket of `size` (a power of two). */
export function seedOrder(size: number): number[] {
  let order = [1, 2]
  while (order.length < size) {
    const round = order.length * 2
    const next: number[] = []
    for (const seed of order) {
      next.push(seed)
      next.push(round + 1 - seed)
    }
    order = next
  }
  return order
}

export const bracketSize = (entrants: number) => {
  let size = 1
  while (size < entrants) size *= 2
  return Math.max(size, 2)
}

export type FirstRoundPair = { slot: number; a: number | null; b: number | null }

/**
 * The first round, as seed numbers. A `null` is an empty chair: the seed
 * opposite it advances without playing.
 */
export function firstRound(entrants: number): FirstRoundPair[] {
  const size = bracketSize(entrants)
  const order = seedOrder(size)
  const pairs: FirstRoundPair[] = []
  for (let i = 0; i < size; i += 2) {
    const a = order[i]
    const b = order[i + 1]
    pairs.push({
      slot: i / 2 + 1,
      a: a <= entrants ? a : null,
      b: b <= entrants ? b : null,
    })
  }
  return pairs
}

export const roundCount = (entrants: number) => Math.log2(bracketSize(entrants))

/** Where the winner of (round, slot) goes next. Null means they have won it. */
export function advancesTo(round: number, slot: number, entrants: number) {
  if (round >= roundCount(entrants)) return null
  return { round: round + 1, slot: Math.ceil(slot / 2), side: slot % 2 === 1 ? 'a' : 'b' } as const
}
