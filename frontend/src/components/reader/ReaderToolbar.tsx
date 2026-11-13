import type { CSSProperties } from 'react'
import type { ReaderSettings } from '../../api.js'
import { AppUpdateControl } from '../../AppUpdateBanner.js'

interface ReaderToolbarProps {
  settings: ReaderSettings
  showToolbar: boolean
  onToggleChapters: () => void
  onToggleSettings: () => void
  /** Present only for a shared work with more than one source. */
  onToggleSources?: () => void
}

const sideStyles: Record<'left' | 'right', string> = {
  left: 'right-0 border-l md:right-auto md:left-0 md:border-l-0 md:border-r',
  right: 'right-0 border-l',
}

function IconWithLabel({ d, label }: { d: string; label: string }) {
  return (
    <span className="flex items-center gap-2 md:flex-col md:gap-0.5">
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        className="h-4 w-4 md:h-5 md:w-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={d} />
      </svg>
      <span>{label}</span>
    </span>
  )
}

const chapterIconD = 'M4 5h12 M4 10h12 M4 15h12'
const sourcesIconD = 'M4 7h10l-3-3 M16 13H6l3 3'
const settingsIconD = 'M10 13a3 3 0 100-6 3 3 0 000 6z M10 3v2 M10 15v2 M3 10h2 M15 10h2 M5.6 5.6l1.4 1.4 M13 13l1.4 1.4 M5.6 14.4l1.4-1.4 M13 7l1.4-1.4'

export function ReaderToolbar({
  settings,
  showToolbar,
  onToggleChapters,
  onToggleSettings,
  onToggleSources,
}: ReaderToolbarProps) {
  const toolbarOnLeft = settings.toolbarSide === 'left'
  const sideClass = sideStyles[toolbarOnLeft ? 'left' : 'right']
  const mobileTranslate = showToolbar ? 'translate-x-0' : 'translate-x-full md:translate-x-0'
  const buttonStyle: CSSProperties = { borderColor: settings.textColor, color: settings.textColor }
  const buttonBase =
    'flex h-11 items-center justify-start rounded border px-3 text-sm md:justify-center md:px-1 md:text-xs'

  return (
    <aside
      className={`fixed bottom-0 top-0 z-40 flex w-72 max-w-[82vw] flex-col items-stretch gap-3 border-black/10 px-4 py-16 shadow-lg transition-transform md:absolute md:w-24 md:px-2 md:shadow-none ${sideClass} ${mobileTranslate}`}
      style={{ backgroundColor: settings.backgroundColor, color: settings.textColor }}
      data-testid="reader-toolbar"
    >
      <button type="button" onClick={onToggleChapters} className={buttonBase} style={buttonStyle}>
        <IconWithLabel d={chapterIconD} label="章節" />
      </button>
      <button type="button" onClick={onToggleSettings} className={buttonBase} style={buttonStyle}>
        <IconWithLabel d={settingsIconD} label="設定" />
      </button>
      {onToggleSources && (
        <button type="button" onClick={onToggleSources} className={buttonBase} style={buttonStyle}>
          <IconWithLabel d={sourcesIconD} label="切換書源" />
        </button>
      )}
      <AppUpdateControl className="min-h-11 rounded border px-3 text-left text-sm disabled:opacity-50 md:px-1 md:text-center md:text-xs" />
    </aside>
  )
}
