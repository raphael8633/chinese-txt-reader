import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useScreenWakeLock } from '../wakeLock.js'

class FakeSentinel extends EventTarget {
  released = false
  release = vi.fn(async () => {
    if (this.released) return
    this.released = true
    this.dispatchEvent(new Event('release'))
  })
}

let sentinels: FakeSentinel[]
let request: ReturnType<typeof vi.fn>
let visibility: DocumentVisibilityState

function held() {
  return sentinels.filter(s => !s.released)
}

async function flush() {
  await act(async () => { await Promise.resolve() })
}

function setVisibility(state: DocumentVisibilityState) {
  visibility = state
  if (state === 'hidden') {
    // Browsers release screen wake locks themselves when the page is hidden.
    held().forEach(s => { void s.release() })
  }
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  sentinels = []
  visibility = 'visible'
  request = vi.fn(async () => {
    const sentinel = new FakeSentinel()
    sentinels.push(sentinel)
    return sentinel
  })
  Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true })
  Object.defineProperty(document, 'visibilityState', { get: () => visibility, configurable: true })
})

afterEach(() => {
  vi.useRealTimers()
  Reflect.deleteProperty(navigator, 'wakeLock')
  Reflect.deleteProperty(document, 'visibilityState')
})

describe('useScreenWakeLock', () => {
  it('keeps the screen on while active and releases on unmount', async () => {
    const { unmount } = renderHook(() => useScreenWakeLock(true, 60_000))
    await flush()
    expect(request).toHaveBeenCalledWith('screen')
    expect(held()).toHaveLength(1)

    unmount()
    await flush()
    expect(held()).toHaveLength(0)
  })

  it('does nothing while inactive', async () => {
    renderHook(() => useScreenWakeLock(false, 60_000))
    await flush()
    expect(request).not.toHaveBeenCalled()
  })

  it('lets the screen sleep after the idle period, and re-locks on the next interaction', async () => {
    renderHook(() => useScreenWakeLock(true, 60_000))
    await flush()
    expect(held()).toHaveLength(1)

    await act(async () => { vi.advanceTimersByTime(60_000) })
    await flush()
    expect(held()).toHaveLength(0)

    document.dispatchEvent(new Event('touchstart'))
    await flush()
    expect(held()).toHaveLength(1)
  })

  it('treats scrolling inside the reader as activity that postpones the idle release', async () => {
    renderHook(() => useScreenWakeLock(true, 60_000))
    await flush()

    await act(async () => { vi.advanceTimersByTime(50_000) })
    const scroller = document.createElement('div')
    document.body.appendChild(scroller)
    scroller.dispatchEvent(new Event('scroll')) // does not bubble; must be captured
    await act(async () => { vi.advanceTimersByTime(50_000) })
    await flush()
    expect(held()).toHaveLength(1)
    scroller.remove()
  })

  it('re-acquires the lock when the page becomes visible again', async () => {
    renderHook(() => useScreenWakeLock(true, 60_000))
    await flush()
    setVisibility('hidden')
    await flush()
    expect(held()).toHaveLength(0)

    setVisibility('visible')
    await flush()
    expect(held()).toHaveLength(1)
  })

  it('releases a lock that resolves after the hook was turned off', async () => {
    let resolve!: (s: FakeSentinel) => void
    request.mockImplementationOnce(() => new Promise<FakeSentinel>(r => { resolve = r }))
    const { rerender } = renderHook(({ active }) => useScreenWakeLock(active, 60_000), { initialProps: { active: true } })
    rerender({ active: false })
    const late = new FakeSentinel()
    resolve(late)
    await flush()
    expect(late.released).toBe(true)
  })

  it('is a no-op when the browser has no Wake Lock API', async () => {
    Reflect.deleteProperty(navigator, 'wakeLock')
    expect(() => renderHook(() => useScreenWakeLock(true, 60_000))).not.toThrow()
  })
})
