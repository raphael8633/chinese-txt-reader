import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { activateAppUpdate, checkForAppUpdate, subscribeAppUpdate, type AppUpdateState } from './appUpdate.js'

function useAppUpdateState() {
  const [state, setState] = useState<AppUpdateState>('idle')

  useEffect(() => subscribeAppUpdate(setState), [])

  return state
}

export function AppUpdateControl({ className = '' }: { className?: string }) {
  const state = useAppUpdateState()

  if (state === 'unsupported') return null

  const label = state === 'checking'
    ? '檢查中'
    : state === 'available'
      ? '更新'
      : state === 'updated'
        ? '已更新'
        : state === 'error'
          ? '重試更新'
          : '檢查更新'

  return (
    <button
      type="button"
      className={className}
      onClick={() => void (state === 'available' ? activateAppUpdate() : checkForAppUpdate())}
      disabled={state === 'checking'}
    >
      {label}
    </button>
  )
}

export function AppUpdateBanner() {
  const location = useLocation()
  const isReading = location.pathname.startsWith('/read/')
  const [state, setState] = useState<AppUpdateState>('idle')

  useEffect(() => subscribeAppUpdate(setState), [])

  if (state === 'unsupported' || isReading) return null

  const showBanner = state === 'available' || state === 'checking' || state === 'updated' || state === 'error'

  if (!showBanner) return null

  return (
    <div className="fixed bottom-3 left-3 right-3 z-50 flex items-center justify-between gap-3 rounded border border-black/20 bg-white px-3 py-2 text-sm text-black shadow-lg">
      <span>
        {state === 'available' && '有新版本可用'}
        {state === 'checking' && '檢查更新中...'}
        {state === 'updated' && '目前已是最新版'}
        {state === 'error' && '更新檢查失敗'}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        {state === 'available' ? (
          <button
            type="button"
            className="rounded bg-black px-3 py-1 text-white"
            onClick={() => void activateAppUpdate()}
          >
            更新
          </button>
        ) : (
          <button
            type="button"
            className="rounded border border-black/30 px-3 py-1"
            onClick={() => void checkForAppUpdate()}
            disabled={state === 'checking'}
          >
            重新檢查
          </button>
        )}
      </div>
    </div>
  )
}
