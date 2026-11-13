import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

interface DialogShellProps {
  title: string
  onClose: () => void
  children: ReactNode
  'data-testid'?: string
}

function DialogShell({ title, onClose, children, 'data-testid': testId }: DialogShellProps) {
  const titleId = `dialog-title-${title.replace(/\s+/g, '-')}`

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid={testId}
    >
      <div className="w-full max-w-sm rounded-lg border border-neutral-700 bg-neutral-900 p-4 text-neutral-100 shadow-xl">
        <h2 id={titleId} className="mb-3 text-base font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  )
}

interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = '確認',
  cancelLabel = '取消',
  destructive = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    // Destructive actions default focus to Cancel so a stray Enter doesn't trigger the action.
    if (destructive) cancelRef.current?.focus()
    else confirmRef.current?.focus()
  }, [destructive])

  const confirmClass = destructive
    ? 'rounded border border-red-700 bg-red-900/40 px-3 py-2 text-sm text-red-100 hover:bg-red-900/60'
    : 'rounded border border-cyan-700 bg-cyan-900/40 px-3 py-2 text-sm text-cyan-100 hover:bg-cyan-900/60'

  return (
    <DialogShell title={title} onClose={onCancel} data-testid="confirm-dialog">
      <p className="mb-4 text-sm text-neutral-300">{message}</p>
      <div className="flex justify-end gap-2">
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          className="rounded border border-neutral-700 px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-800"
        >
          {cancelLabel}
        </button>
        <button
          ref={confirmRef}
          type="button"
          onClick={onConfirm}
          className={confirmClass}
        >
          {confirmLabel}
        </button>
      </div>
    </DialogShell>
  )
}

interface PromptDialogProps {
  title: string
  label?: string
  initialValue?: string
  confirmLabel?: string
  cancelLabel?: string
  placeholder?: string
  onCancel: () => void
  onSubmit: (value: string) => void
}

export function PromptDialog({
  title,
  label,
  initialValue = '',
  confirmLabel = '儲存',
  cancelLabel = '取消',
  placeholder,
  onCancel,
  onSubmit,
}: PromptDialogProps) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function handleSubmit(event?: React.FormEvent) {
    event?.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) return
    onSubmit(trimmed)
  }

  return (
    <DialogShell title={title} onClose={onCancel} data-testid="prompt-dialog">
      <form onSubmit={handleSubmit}>
        {label && <label className="mb-1 block text-xs text-neutral-400">{label}</label>}
        <input
          ref={inputRef}
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          className="mb-4 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-cyan-600 focus:outline-none"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-neutral-700 px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-800"
          >
            {cancelLabel}
          </button>
          <button
            type="submit"
            disabled={!value.trim()}
            className="rounded border border-cyan-700 bg-cyan-900/40 px-3 py-2 text-sm text-cyan-100 hover:bg-cyan-900/60 disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </DialogShell>
  )
}
