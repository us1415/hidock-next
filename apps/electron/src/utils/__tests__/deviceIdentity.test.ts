import { describe, expect, it } from 'vitest'
import { getStableDeviceId } from '../deviceIdentity'

describe('getStableDeviceId', () => {
  it('prefers and sanitizes the connected device serial number', () => {
    expect(getStableDeviceId({
      getState: () => ({ connected: true, serialNumber: ' P1 / 123 ', model: 'hidock-p1' })
    })).toBe('hidock:P1___123')
  })

  it('uses the model only when a connected device has no serial number', () => {
    expect(getStableDeviceId({
      getState: () => ({ connected: true, model: 'hidock-p1' })
    })).toBe('hidock:hidock-p1')
  })

  it('rejects disconnected and unknown devices', () => {
    expect(getStableDeviceId({ getState: () => ({ connected: false, serialNumber: 'P1' }) })).toBeNull()
    expect(getStableDeviceId({ getState: () => ({ connected: true, model: 'unknown' }) })).toBeNull()
  })
})
