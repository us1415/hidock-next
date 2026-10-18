interface DeviceIdentityState {
  connected: boolean
  serialNumber?: string | null
  model?: string
}

interface DeviceIdentitySource {
  getState?: () => DeviceIdentityState
}

/**
 * Builds the durable key used for per-device discovery state.
 * Prefer the hardware serial number; model is only a fallback for devices that
 * do not expose one. Unknown/disconnected devices are deliberately rejected so
 * separate inventories cannot be merged accidentally.
 */
export function getStableDeviceId(deviceService: DeviceIdentitySource): string | null {
  const state = deviceService.getState?.()
  if (!state?.connected) return null
  const identity = state.serialNumber?.trim() || state.model
  if (!identity || identity === 'unknown') return null
  return `hidock:${identity.replace(/[^A-Za-z0-9._-]/g, '_')}`
}
