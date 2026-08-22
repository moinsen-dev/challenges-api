import { describe, expect, it } from 'vitest'
import { pairwiseScores, updateRating } from '../src/glicko'

describe('Glicko-2', () => {
  it('matches the published reference example', () => {
    // Glickman, "Example calculation": 1500/200/0.06 gegen 1400/30 (S),
    // 1550/100 (N), 1700/300 (N) ergibt 1464.06 / 151.52 / 0.05999.
    const result = updateRating({ rating: 1500, rd: 200, volatility: 0.06 }, [
      { rating: 1400, rd: 30, score: 1 },
      { rating: 1550, rd: 100, score: 0 },
      { rating: 1700, rd: 300, score: 0 },
    ])
    expect(result.rating).toBeCloseTo(1464.06, 1)
    expect(result.rd).toBeCloseTo(151.52, 1)
    expect(result.volatility).toBeCloseTo(0.05999, 4)
  })

  it('only raises uncertainty without opponents', () => {
    const result = updateRating({ rating: 1500, rd: 200, volatility: 0.06 }, [])
    expect(result.rating).toBe(1500)
    expect(result.rd).toBeGreaterThan(200)
    expect(result.volatility).toBe(0.06)
  })

  it('caps uncertainty at 350', () => {
    const result = updateRating({ rating: 1500, rd: 350, volatility: 0.06 }, [])
    expect(result.rd).toBeLessThanOrEqual(350)
  })

  it('barely moves a draw between equals', () => {
    const result = updateRating({ rating: 1500, rd: 100, volatility: 0.06 }, [
      { rating: 1500, rd: 100, score: 0.5 },
    ])
    expect(result.rating).toBeCloseTo(1500, 5)
  })

  it('rewards a win against a stronger player more than against a weaker one', () => {
    const vsStrong = updateRating({ rating: 1500, rd: 200, volatility: 0.06 }, [
      { rating: 1900, rd: 50, score: 1 },
    ])
    const vsWeak = updateRating({ rating: 1500, rd: 200, volatility: 0.06 }, [
      { rating: 1100, rd: 50, score: 1 },
    ])
    expect(vsStrong.rating - 1500).toBeGreaterThan(vsWeak.rating - 1500)
  })

  it('translates placements into pairwise results', () => {
    const pairs = pairwiseScores([
      { player_id: 'a', placement: 1 },
      { player_id: 'b', placement: 2 },
      { player_id: 'c', placement: 2 },
    ])
    expect(pairs.get('a')!.map((x) => x.score)).toEqual([1, 1])
    expect(pairs.get('b')!.find((x) => x.opponentId === 'a')!.score).toBe(0)
    // Gleiche Platzziffer ist ein Unentschieden.
    expect(pairs.get('b')!.find((x) => x.opponentId === 'c')!.score).toBe(0.5)
    expect(pairs.get('c')!.find((x) => x.opponentId === 'b')!.score).toBe(0.5)
  })

  it('never gives anyone themselves as an opponent', () => {
    const pairs = pairwiseScores([
      { player_id: 'a', placement: 1 },
      { player_id: 'b', placement: 2 },
    ])
    expect(pairs.get('a')!.every((x) => x.opponentId !== 'a')).toBe(true)
  })
})
