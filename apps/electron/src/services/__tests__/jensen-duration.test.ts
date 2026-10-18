import { describe, expect, it } from 'vitest'
import { calculateDurationSeconds } from '../jensen'

describe('calculateDurationSeconds', () => {
  it('calculates P1 version 5 MP3 duration at 96 kbps', () => {
    expect(calculateDurationSeconds(147_000, 5)).toBe(12)
    expect(calculateDurationSeconds(24_559_500, 5)).toBe(2047)
  })

  it('preserves the verified version 1 byte rate', () => {
    expect(calculateDurationSeconds(15_672_000, 1)).toBe(1959)
  })
})
