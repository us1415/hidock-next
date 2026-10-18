import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockDatabase = {
  exec: vi.fn(() => []),
  run: vi.fn()
}

const mockOllama = {
  isAvailable: vi.fn(),
  generateEmbedding: vi.fn()
}

vi.mock('../database', () => ({
  getDatabase: vi.fn(() => mockDatabase)
}))

vi.mock('../ollama', () => ({
  getOllamaService: vi.fn(() => mockOllama)
}))

describe('VectorStore transcript indexing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('checks Ollama once and skips all chunks when it is unavailable', async () => {
    mockOllama.isAvailable.mockResolvedValue(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { VectorStore } = await import('../vector-store')
    const store = new VectorStore()

    const indexed = await store.indexTranscript(
      'First sentence. Second sentence. Third sentence.',
      { recordingId: 'rec-1' }
    )

    expect(indexed).toBe(0)
    expect(mockOllama.isAvailable).toHaveBeenCalledTimes(1)
    expect(mockOllama.generateEmbedding).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
