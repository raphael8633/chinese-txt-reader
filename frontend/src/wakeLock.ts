import { useEffect } from 'react'

/** No interaction for this long lets the screen sleep normally (phone left on the table). */
export const WAKE_LOCK_IDLE_MS = 10 * 60 * 1000

const ACTIVITY_EVENTS = ['touchstart', 'pointerdown', 'keydown', 'wheel', 'scroll'] as const
const ACTIVITY_THROTTLE_MS = 1000

interface Sentinel extends EventTarget {
  released: boolean
  release(): Promise<void>
}

/**
 * Keep the screen on while `active` and the reader is being used. The browser
 * drops the lock when the page is hidden; it is re-acquired on return or on the
 * next interaction. Unsupported browsers (no `navigator.wakeLock`) are a no-op.
 */
export function useScreenWakeLock(active: boolean, idleMs: number = WAKE_LOCK_IDLE_MS): void {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined') return undefined
    const wakeLock = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<Sentinel> } }).wakeLock
    if (!wakeLock) return undefined

    let disposed = false
    let sentinel: Sentinel | null = null
    let requesting = false
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let lastActivity = 0

    const release = () => {
      const current = sentinel
      sentinel = null
      if (current && !current.released) current.release().catch(() => {})
    }

    const acquire = () => {
      if (disposed || requesting || sentinel || document.visibilityState !== 'visible') return
      requesting = true
      wakeLock.request('screen').then(next => {
        requesting = false
        if (disposed || idleTimer === undefined) {
          next.release().catch(() => {})
          return
        }
        sentinel = next
        next.addEventListener('release', () => {
          if (sentinel === next) sentinel = null
        })
      }, () => {
        // Denied (e.g. low-power mode, no user gesture yet): retry on next interaction.
        requesting = false
      })
    }

    const armIdleTimer = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleTimer = undefined
        release()
      }, idleMs)
    }

    const onActivity = () => {
      const now = Date.now()
      if (sentinel && now - lastActivity < ACTIVITY_THROTTLE_MS) return
      lastActivity = now
      armIdleTimer()
      acquire()
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') onActivity()
    }

    for (const type of ACTIVITY_EVENTS) document.addEventListener(type, onActivity, { capture: true, passive: true })
    document.addEventListener('visibilitychange', onVisibility)
    onActivity()

    return () => {
      disposed = true
      clearTimeout(idleTimer)
      for (const type of ACTIVITY_EVENTS) document.removeEventListener(type, onActivity, { capture: true })
      document.removeEventListener('visibilitychange', onVisibility)
      release()
    }
  }, [active, idleMs])
}
