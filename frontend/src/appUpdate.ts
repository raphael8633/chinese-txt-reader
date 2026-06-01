import { registerSW } from 'virtual:pwa-register'

export type AppUpdateState = 'idle' | 'checking' | 'available' | 'updated' | 'error' | 'unsupported'

type Listener = (state: AppUpdateState) => void

let updateSW: ((reloadPage?: boolean) => Promise<void>) | undefined
let state: AppUpdateState = 'idle'
const listeners = new Set<Listener>()

function setState(next: AppUpdateState) {
  state = next
  listeners.forEach(listener => listener(state))
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
}

async function updateActiveAppRegistration(): Promise<boolean> {
  const registration = await navigator.serviceWorker.ready
  try {
    await registration.update()
    return true
  } catch (error) {
    // iOS Safari can throw a DOMException ("The string did not match the expected pattern.")
    // while updating an otherwise usable registration. Do not let that browser-specific
    // update probe failure break the library page or keep the update UI in an error state.
    console.warn('App update check failed', error)
    return false
  }
}

export async function checkForAppUpdate(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    setState('unsupported')
    return
  }

  setState('checking')
  try {
    await updateActiveAppRegistration()
    setState(state === 'available' ? 'available' : 'updated')
  } catch {
    setState('error')
  }
}

export async function activateAppUpdate(): Promise<void> {
  if (!updateSW) {
    await checkForAppUpdate()
    return
  }
  await updateSW(true)
}
