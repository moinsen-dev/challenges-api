import { describe, expect, it } from 'vitest'
import { inRing } from '../src/geo'

/**
 * The ring arithmetic, away from a database. Everything else about resolving
 * a district is a query; this is the only real computation, and the only part
 * that can be wrong without any row being wrong.
 */
describe('inRing', () => {
  // A unit square, counter-clockwise, closed.
  const square = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
    [0, 0],
  ]

  it('accepts a point inside', () => {
    expect(inRing(1, 1, square)).toBe(true)
  })

  it('rejects a point outside on every side', () => {
    expect(inRing(3, 1, square)).toBe(false)
    expect(inRing(-1, 1, square)).toBe(false)
    expect(inRing(1, 3, square)).toBe(false)
    expect(inRing(1, -1, square)).toBe(false)
  })

  it('rejects a point beyond a corner', () => {
    expect(inRing(3, 3, square)).toBe(false)
  })

  /**
   * A ring shaped like a C: the point sits in the opening, inside the bounding
   * box and outside the boundary. This is the case a bounding box alone gets
   * wrong, which is the whole reason the ray cast exists.
   */
  it('rejects a point in the notch of a concave ring', () => {
    const c = [
      [0, 0],
      [3, 0],
      [3, 1],
      [1, 1],
      [1, 2],
      [3, 2],
      [3, 3],
      [0, 3],
      [0, 0],
    ]
    expect(inRing(2, 1.5, c)).toBe(false)
    expect(inRing(0.5, 1.5, c)).toBe(true)
  })

  it('handles real coordinates around Hamburg', () => {
    // A coarse quadrilateral over the inner city.
    const hh = [
      [9.9, 53.5],
      [10.1, 53.5],
      [10.1, 53.6],
      [9.9, 53.6],
      [9.9, 53.5],
    ]
    expect(inRing(9.992, 53.5503, hh)).toBe(true) // town hall
    expect(inRing(13.4132, 52.5219, hh)).toBe(false) // Berlin
  })

  it('is not confused by a ring given clockwise', () => {
    const clockwise = [...square].reverse()
    expect(inRing(1, 1, clockwise)).toBe(true)
    expect(inRing(3, 1, clockwise)).toBe(false)
  })
})
