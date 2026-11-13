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

  it('reports available instead of updated when a new worker is already waiting', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      configurable: true,
      value: {
        ready: Promise.resolve({ update, waiting: { state: 'installed' }, installing: null }),
      },
    })
    const { checkForAppUpdate, subscribeAppUpdate } = await import('../appUpdate.js')
    const states: string[] = []
    subscribeAppUpdate(state => states.push(state))

    await checkForAppUpdate()

    expect(states).toEqual(['idle', 'checking', 'available'])
    expect(states).not.toContain('updated')
  })

  it('waits for an in-flight install instead of flapping updated -> available', async () => {
    const installing: {
      state: string
      listeners: Record<string, () => void>
      addEventListener: (type: string, cb: () => void) => void
      removeEventListener: (type: string) => void
    } = {
      state: 'installing',
      listeners: {},
      addEventListener(type, cb) { this.listeners[type] = cb },
      removeEventListener(type) { delete this.listeners[type] },
    }
    const registration = {
      update: vi.fn().mockResolvedValue(undefined),
      waiting: null as null | { state: string },
      installing: installing as unknown as ServiceWorker,
    }
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve(registration) },
    })
    const { checkForAppUpdate, subscribeAppUpdate } = await import('../appUpdate.js')
    const states: string[] = []
    subscribeAppUpdate(state => states.push(state))

    const pending = checkForAppUpdate()
    await Promise.resolve()
    await Promise.resolve()
    installing.state = 'installed'
    registration.waiting = installing
    installing.listeners.statechange?.()
    await pending

    expect(states).toEqual(['idle', 'checking', 'available'])
    expect(states).not.toContain('updated')
  })

  it('keeps available sticky across later manual checks', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      configurable: true,
      value: {
        ready: Promise.resolve({ update, waiting: { state: 'installed' }, installing: null }),
      },
    })
    const { checkForAppUpdate, subscribeAppUpdate } = await import('../appUpdate.js')
    await checkForAppUpdate()
    const states: string[] = []
    subscribeAppUpdate(state => states.push(state))

    await checkForAppUpdate()

    expect(states).toEqual(['available'])
  })

  it('silent checks do not surface checking or updated states', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      configurable: true,
      value: {
        ready: Promise.resolve({ update, waiting: null, installing: null }),
      },
    })
    const { checkForAppUpdate, subscribeAppUpdate } = await import('../appUpdate.js')
    const states: string[] = []
    subscribeAppUpdate(state => states.push(state))

    await checkForAppUpdate({ silent: true })

    expect(update).toHaveBeenCalledTimes(1)
    expect(states).toEqual(['idle'])
  })

  it('silent checks surface a discovered update as available', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      configurable: true,
      value: {
        ready: Promise.resolve({ update, waiting: { state: 'installed' }, installing: null }),
      },
    })
    const { checkForAppUpdate, subscribeAppUpdate } = await import('../appUpdate.js')
    const states: string[] = []
    subscribeAppUpdate(state => states.push(state))

    await checkForAppUpdate({ silent: true })

    expect(states).toEqual(['idle', 'available'])
  })

  it('auto check polls every minute while online and skips offline ticks', async () => {
    vi.useFakeTimers()
    try {
      const update = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(globalThis.navigator, 'serviceWorker', {
        configurable: true,
        value: {
          ready: Promise.resolve({ update, waiting: null, installing: null }),
        },
      })
      const onLine = vi.spyOn(globalThis.navigator, 'onLine', 'get')
      const { startAppUpdateAutoCheck, stopAppUpdateAutoCheck } = await import('../appUpdate.js')
      startAppUpdateAutoCheck()

      onLine.mockReturnValue(true)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(update).toHaveBeenCalledTimes(1)

      onLine.mockReturnValue(false)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(update).toHaveBeenCalledTimes(1)

      onLine.mockReturnValue(true)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(update).toHaveBeenCalledTimes(2)

      stopAppUpdateAutoCheck()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(update).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns updated to idle after a short confirmation window', async () => {
    vi.useFakeTimers()
    try {
      const update = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(globalThis.navigator, 'serviceWorker', {
        configurable: true,
        value: {
          ready: Promise.resolve({ update, waiting: null, installing: null }),
        },
      })
      const { checkForAppUpdate, subscribeAppUpdate } = await import('../appUpdate.js')
      const states: string[] = []
      subscribeAppUpdate(state => states.push(state))

      await checkForAppUpdate()
      expect(states).toEqual(['idle', 'checking', 'updated'])

      await vi.advanceTimersByTimeAsync(4_000)
      expect(states).toEqual(['idle', 'checking', 'updated', 'idle'])
    } finally {
      vi.useRealTimers()
    }
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
