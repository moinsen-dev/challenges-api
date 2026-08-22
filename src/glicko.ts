/**
 * Glicko-2 after Glickman. Tested against the published reference example
 * (see tests/glicko.test.ts) — a rating that merely "looks plausible" is
 * worthless.
 */
export type Rating = { rating: number; rd: number; volatility: number }
export type Opponent = { rating: number; rd: number; score: number } // score: 1 | 0.5 | 0

const SCALE = 173.7178
const TAU = 0.5
const EPSILON = 0.000001

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI))
const expected = (mu: number, muJ: number, phiJ: number) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)))

export function updateRating(player: Rating, opponents: Opponent[]): Rating {
  const mu = (player.rating - 1500) / SCALE
  const phi = player.rd / SCALE
  const sigma = player.volatility

  // Without opponents only the uncertainty grows.
  if (opponents.length === 0) {
    const phiStar = Math.sqrt(phi * phi + sigma * sigma)
    return { rating: player.rating, rd: Math.min(phiStar * SCALE, 350), volatility: sigma }
  }

  const scaled = opponents.map((o) => ({
    mu: (o.rating - 1500) / SCALE,
    phi: o.rd / SCALE,
    score: o.score,
  }))

  let vInv = 0
  let deltaSum = 0
  for (const o of scaled) {
    const e = expected(mu, o.mu, o.phi)
    const gj = g(o.phi)
    vInv += gj * gj * e * (1 - e)
    deltaSum += gj * (o.score - e)
  }
  const v = 1 / vInv
  const delta = v * deltaSum

  const sigmaPrime = newVolatility(delta, phi, v, sigma)
  const phiStar = Math.sqrt(phi * phi + sigmaPrime * sigmaPrime)
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v)
  const muPrime = mu + phiPrime * phiPrime * deltaSum

  return {
    rating: muPrime * SCALE + 1500,
    rd: phiPrime * SCALE,
    volatility: sigmaPrime,
  }
}

/** Illinois algorithm for the new volatility. */
function newVolatility(delta: number, phi: number, v: number, sigma: number): number {
  const a = Math.log(sigma * sigma)
  const f = (x: number) => {
    const ex = Math.exp(x)
    const d2 = delta * delta
    const sum = phi * phi + v + ex
    return (ex * (d2 - sum)) / (2 * sum * sum) - (x - a) / (TAU * TAU)
  }

  let A = a
  let B: number
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v)
  } else {
    let k = 1
    while (f(a - k * TAU) < 0) k++
    B = a - k * TAU
  }

  let fA = f(A)
  let fB = f(B)
  while (Math.abs(B - A) > EPSILON) {
    const C = A + ((A - B) * fA) / (fB - fA)
    const fC = f(C)
    if (fC * fB <= 0) {
      A = B
      fA = fB
    } else {
      fA = fA / 2
    }
    B = C
    fB = fC
  }
  return Math.exp(A / 2)
}

/**
 * Translate match placements into pairwise results: everyone against everyone,
 * the lower placement wins, an equal placement is a draw.
 */
export function pairwiseScores(
  placements: { player_id: string; placement: number }[],
): Map<string, { opponentId: string; score: number }[]> {
  const out = new Map<string, { opponentId: string; score: number }[]>()
  for (const a of placements) {
    const list: { opponentId: string; score: number }[] = []
    for (const b of placements) {
      if (a.player_id === b.player_id) continue
      list.push({
        opponentId: b.player_id,
        score: a.placement < b.placement ? 1 : a.placement > b.placement ? 0 : 0.5,
      })
    }
    out.set(a.player_id, list)
  }
  return out
}
