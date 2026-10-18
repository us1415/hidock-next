export interface TranscriptionPriceEstimate {
  model: string
  ratePerMinuteUsd: number | null
  minutes: number
  estimatedAudioCostUsd: number | null
}

/**
 * Estimated audio transcription prices published by OpenAI on 2026-10-18.
 * Keep this table deliberately small and return null for unknown models so the UI
 * never invents a price for a newly configured provider/model.
 */
export const OPENAI_TRANSCRIPTION_USD_PER_MINUTE: Readonly<Record<string, number>> = {
  'gpt-transcribe': 0.0045,
  'gpt-4o-mini-transcribe': 0.003,
  'gpt-4o-transcribe': 0.006
}

export function estimateOpenAITranscriptionCost(
  model: string,
  durationSeconds: number
): TranscriptionPriceEstimate {
  const normalizedSeconds = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0
  const minutes = normalizedSeconds / 60
  const ratePerMinuteUsd = OPENAI_TRANSCRIPTION_USD_PER_MINUTE[model] ?? null
  const rawEstimate = ratePerMinuteUsd === null ? null : minutes * ratePerMinuteUsd

  return {
    model,
    ratePerMinuteUsd,
    minutes,
    estimatedAudioCostUsd: rawEstimate === null ? null : Math.round(rawEstimate * 1_000_000) / 1_000_000
  }
}

export function formatUsdEstimate(value: number): string {
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

export function getOpenAITranscriptionPricingSummary(model: string): string | null {
  const rate = OPENAI_TRANSCRIPTION_USD_PER_MINUTE[model]
  if (rate === undefined) return null

  const thirtyMinutes = estimateOpenAITranscriptionCost(model, 30 * 60).estimatedAudioCostUsd!
  const sixtyMinutes = estimateOpenAITranscriptionCost(model, 60 * 60).estimatedAudioCostUsd!
  return `${formatUsdEstimate(rate)}/minute · about ${formatUsdEstimate(thirtyMinutes)} for 30 minutes or ${formatUsdEstimate(sixtyMinutes)} per hour`
}
