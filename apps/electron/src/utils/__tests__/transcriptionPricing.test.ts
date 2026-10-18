import { describe, expect, it } from 'vitest'
import {
  estimateOpenAITranscriptionCost,
  formatUsdEstimate,
  getOpenAITranscriptionPricingSummary
} from '../transcriptionPricing'

describe('transcriptionPricing', () => {
  it('estimates gpt-transcribe audio cost from exact duration without rounding minutes up', () => {
    expect(estimateOpenAITranscriptionCost('gpt-transcribe', 30 * 60)).toEqual({
      model: 'gpt-transcribe',
      ratePerMinuteUsd: 0.0045,
      minutes: 30,
      estimatedAudioCostUsd: 0.135
    })
  })

  it('returns an unknown estimate instead of guessing for unsupported models', () => {
    expect(estimateOpenAITranscriptionCost('future-model', 3600).estimatedAudioCostUsd).toBeNull()
    expect(getOpenAITranscriptionPricingSummary('future-model')).toBeNull()
  })

  it('formats sub-cent estimates with enough precision to remain meaningful', () => {
    expect(formatUsdEstimate(0.0045)).toBe('$0.0045')
    expect(formatUsdEstimate(0.135)).toBe('$0.14')
  })

  it('provides familiar 30-minute and hourly examples', () => {
    expect(getOpenAITranscriptionPricingSummary('gpt-transcribe')).toBe(
      '$0.0045/minute · about $0.14 for 30 minutes or $0.27 per hour'
    )
  })
})
