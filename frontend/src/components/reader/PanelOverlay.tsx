import { useEffect, useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'

interface PanelOverlayProps {
  onClose: () => void
  title: string
  children: ReactNode
  style?: CSSProperties
  'data-testid'?: string
}

export function PanelOverlay({ onClose, title, children, style, 'data-testid': testId }: PanelOverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const titleId = `panel-overlay-title-${title}`

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    // Skip the close × button — landing focus there means Enter closes what the user just opened.
    const candidates = Array.from(
      panel?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    )
    const target = candidates.find(el => el.getAttribute('aria-label') !== '關閉') ?? candidates[0]
    target?.focus()
    return () => previousFocusRef.current?.focus?.()
  }, [])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 md:flex md:items-center md:justify-center md:bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div
        ref={panelRef}
        className="flex h-full flex-col md:h-auto md:max-h-[80vh] md:w-full md:max-w-md md:rounded-xl md:shadow-2xl"
        style={style}
        data-testid={testId}
      >
        <div className="relative flex items-center border-b px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="flex h-11 w-11 -ml-2 items-center justify-center text-2xl leading-none opacity-60 hover:opacity-100"
            aria-label="關閉"
          >×</button>
          <span
            id={titleId}
            className="pointer-events-none absolute left-1/2 -translate-x-1/2 max-w-[70%] truncate text-base font-semibold"
          >{title}</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  )
}

export function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-4 pb-1 pt-5">
      <span className="text-xs font-semibold uppercase tracking-widest opacity-40">{label}</span>
    </div>
  )
}

interface StepperRowProps {
  label: string
  value: number
  min?: number
  max?: number
  onDecrease: () => void
  onIncrease: () => void
  display?: string
}

export function StepperRow({ label, value, min, max, onDecrease, onIncrease, display }: StepperRowProps) {
  return (
    <div className="flex items-center border-b px-4 py-2.5">
      <span className="flex-1 text-sm">{label}</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onDecrease}
          disabled={min !== undefined && value <= min}
          className="flex h-10 w-10 items-center justify-center rounded-lg border text-base font-medium disabled:opacity-25 hover:opacity-70 transition-opacity"
          aria-label={`減少${label}`}
        >
          −
        </button>
        <span className="w-16 text-center text-sm tabular-nums">{display ?? value}</span>
        <button
          type="button"
          onClick={onIncrease}
          disabled={max !== undefined && value >= max}
          className="flex h-10 w-10 items-center justify-center rounded-lg border text-base font-medium disabled:opacity-25 hover:opacity-70 transition-opacity"
          aria-label={`增加${label}`}
        >
          +
        </button>
      </div>
    </div>
  )
}
