import type { ReaderSettings } from '../../api.js'

interface ProgressConflictDialogProps {
  serverChapterIndex: number
  serverChapterProgress?: number
  localChapterProgress?: number
  localChapterIndex: number
  settings: ReaderSettings
  reason: 'gap' | 'offline-earlier'
  onChoose: (source: 'local' | 'server') => void
}

export function ProgressConflictDialog({
  serverChapterIndex,
  localChapterIndex,
  serverChapterProgress,
  localChapterProgress,
  settings,
  reason,
  onChoose,
}: ProgressConflictDialogProps) {
  return (
    <div
      className="absolute inset-0 z-[60] flex items-center justify-center bg-black/40 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="progress-conflict-title"
    >
      <div
        className="w-full max-w-sm rounded border p-4 shadow-lg"
        style={{
          backgroundColor: settings.backgroundColor,
          color: settings.textColor,
          borderColor: settings.textColor,
        }}
        data-testid="progress-conflict"
      >
        <h2 id="progress-conflict-title" className="mb-2 text-base font-semibold">閱讀進度不同步</h2>
        <p className="mb-4 text-sm opacity-75">
          {reason === 'gap'
            ? '此裝置與雲端進度差距超過 10%，請選擇要繼續的位置。'
            : '此裝置離線時讀到較前面的章節，尚未同步到雲端，請選擇要繼續的位置。'}
        </p>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="min-h-11 rounded border px-3 py-2 text-left text-sm"
            style={{ borderColor: settings.textColor }}
            onClick={() => onChoose('local')}
          >
            使用此裝置：第 {localChapterIndex + 1} 章{localChapterProgress === undefined ? '' : ` · ${Math.floor(localChapterProgress * 100)}%`}
          </button>
          <button
            type="button"
            className="min-h-11 rounded border px-3 py-2 text-left text-sm"
            style={{ borderColor: settings.textColor }}
            onClick={() => onChoose('server')}
          >
            使用雲端：第 {serverChapterIndex + 1} 章{serverChapterProgress === undefined ? '' : ` · ${Math.floor(serverChapterProgress * 100)}%`}
          </button>
        </div>
      </div>
    </div>
  )
}
