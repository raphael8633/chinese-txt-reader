import { registerSW } from 'virtual:pwa-register'

export type AppUpdateState = 'idle' | 'checking' | 'available' | 'updated' | 'error' | 'unsupported'

type Listener = (state: AppUpdateState) => void

const AUTO_CHECK_INTERVAL_MS = 60_000
const UPDATED_CONFIRMATION_MS = 4_000

let updateSW: ((reloadPage?: boolean) => Promise<void>) | undefined
let state: AppUpdateState = 'idle'
const listeners = new Set<Listener>()
let updatedDecayTimer: ReturnType<typeof setTimeout> | undefined
let autoCheckTimer: ReturnType<typeof setInterval> | undefined
let checkInFlight = false

function setState(next: AppUpdateState) {
  // A discovered update stays discovered: the waiting service worker persists until the
  // user activates it (which reloads the page), so never downgrade away from available.
  if (state === 'available' && next !== 'available') return
  if (state === next) return
  if (updatedDecayTimer) {
    clearTimeout(updatedDecayTimer)
    updatedDecayTimer = undefined
  }
  state = next
  listeners.forEach(listener => listener(state))
  if (next === 'updated') {
    updatedDecayTimer = setTimeout(() => {
      updatedDecayTimer = undefined
      if (state === 'updated') setState('idle')
    }, UPDATED_CONFIRMATION_MS)
  }
}

export function subscribeAppUpdate(listener: Listener): () => void {
  listeners.add(listener)
  listener(state)
  return () => listeners.delete(listener)
}

export function registerAppUpdate() {
  if (!('serviceWorker' in navigator)) {
    setState('unsupported')
    return
  }

  updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      setState('available')
    },
    onRegisteredSW(_swUrl, registration) {
      void registration?.update().catch(() => undefined)
    },
    onRegisterError() {
      setState('error')
    },
  })
  startAppUpdateAutoCheck()
}

export function startAppUpdateAutoCheck() {
  if (autoCheckTimer) return
  autoCheckTimer = setInterval(() => {
    if (navigator.onLine === false) return
    void checkForAppUpdate({ silent: true })
  }, AUTO_CHECK_INTERVAL_MS)
  window.addEventListener('online', handleBackOnline)
  document.addEventListener('visibilitychange', handleVisibilityChange)
}

export function stopAppUpdateAutoCheck() {
  if (!autoCheckTimer) return
  clearInterval(autoCheckTimer)
  autoCheckTimer = undefined
  window.removeEventListener('online', handleBackOnline)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
}

function handleBackOnline() {
  void checkForAppUpdate({ silent: true })
}

function handleVisibilityChange() {
  if (document.visibilityState !== 'visible') return
  if (navigator.onLine === false) return
  void checkForAppUpdate({ silent: true })
}

async function updateActiveAppRegistration(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.ready
  try {
    await registration.update()
  } catch (error) {
    // iOS Safari can throw a DOMException ("The string did not match the expected pattern.")
    // while updating an otherwise usable registration. Do not let that browser-specific
    // update probe failure break the library page or keep the update UI in an error state.
    console.warn('App update check failed', error)
  }
  return registration
}

// registration.update() resolves while a discovered worker may still be installing, so the
// outcome has to come from the registration itself instead of whichever state onNeedRefresh
// happened to set first — guessing here is what made the UI flap updated -> available.
async function resolveUpdateOutcome(registration: ServiceWorkerRegistration): Promise<'available' | 'updated'> {
  if (registration.waiting) return 'available'
  const installing = registration.installing
  if (!installing) return 'updated'
  return new Promise((resolve) => {
    const onStateChange = () => {
      if (installing.state === 'installing') return
      installing.removeEventListener('statechange', onStateChange)
      resolve(installing.state === 'redundant' ? 'updated' : 'available')
    }
    installing.addEventListener('statechange', onStateChange)
  })
}

export async function checkForAppUpdate(options: { silent?: boolean } = {}): Promise<void> {
  const silent = options.silent ?? false
  if (!('serviceWorker' in navigator)) {
    if (!silent) setState('unsupported')
    return
  }
  if (state === 'available' || checkInFlight) return

  checkInFlight = true
  if (!silent) setState('checking')
  try {
    const registration = await updateActiveAppRegistration()
    const outcome = await resolveUpdateOutcome(registration)
    if (outcome === 'available') {
      setState('available')
    } else if (!silent) {
      setState('updated')
    }
  } catch {
    if (!silent) setState('error')
  } finally {
    checkInFlight = false
  }
}

export async function activateAppUpdate(): Promise<void> {
  if (!updateSW) {
    await checkForAppUpdate()
    return
  }
  await updateSW(true)
}
