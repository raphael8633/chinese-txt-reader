import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('virtual:pwa-register', () => ({
  registerSW: vi.fn(),
}))

describe('appUpdate', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    Reflect.deleteProperty(globalThis.navigator, 'serviceWorker')
  })

  it('checks only the active app registration via serviceWorker.ready', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      configurable: true,
      value: {
        ready: Promise.resolve({ update }),
        getRegistrations: vi.fn(),
      },
    })
    const { checkForAppUpdate, subscribeAppUpdate } = await import('../appUpdate.js')
    const states: string[] = []
    subscribeAppUpdate(state => states.push(state))

    await checkForAppUpdate()

    expect(update).toHaveBeenCalledTimes(1)
    expect(navigator.serviceWorker.getRegistrations).not.toHaveBeenCalled()
    expect(states).toEqual(['idle', 'checking', 'updated'])
  })

  it('does not enter error state for iOS Safari registration.update pattern failures', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const update = vi.fn().mockRejectedValue(new DOMException(
      'The string did not match the expected pattern.',
      'SyntaxError',
    ))
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      configurable: true,
      value: {
        ready: Promise.resolve({ update }),
      },
    })
    const { checkForAppUpdate, subscribeAppUpdate } = await import('../appUpdate.js')
    const states: string[] = []
    subscribeAppUpdate(state => states.push(state))

    await checkForAppUpdate()

    expect(states).toEqual(['idle', 'checking', 'updated'])
  })

  it('reports error when no ready service worker registration is available', async () => {
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      configurable: true,
      value: {
        get ready() {
          return Promise.reject(new Error('registration unavailable'))
        },
      },
    })
    const { checkForAppUpdate, subscribeAppUpdate } = await import('../appUpdate.js')
    const states: string[] = []
    subscribeAppUpdate(state => states.push(state))

    await checkForAppUpdate()

    expect(states).toEqual(['idle', 'checking', 'error'])
  })
})
