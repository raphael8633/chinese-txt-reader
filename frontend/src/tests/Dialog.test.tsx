import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConfirmDialog, PromptDialog } from '../components/Dialog.js'

describe('ConfirmDialog', () => {
  it('renders title + message + buttons and triggers onConfirm', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(
      <ConfirmDialog
        title="刪除書籍"
        message="確定要刪除？"
        confirmLabel="刪除"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    )

    expect(screen.getByText('刪除書籍')).toBeTruthy()
    expect(screen.getByText('確定要刪除？')).toBeTruthy()
    fireEvent.click(screen.getByText('刪除'))
    expect(onConfirm).toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('focuses the confirm button on mount for non-destructive actions', () => {
    render(
      <ConfirmDialog
        title="title"
        message="message"
        confirmLabel="OK"
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    )
    expect(document.activeElement?.textContent).toBe('OK')
  })

  it('focuses the cancel button on mount for destructive actions', () => {
    render(
      <ConfirmDialog
        title="title"
        message="message"
        confirmLabel="刪除"
        cancelLabel="取消"
        destructive
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    )
    expect(document.activeElement?.textContent).toBe('取消')
  })

  it('closes on Escape key', () => {
    const onCancel = vi.fn()
    render(
      <ConfirmDialog
        title="title"
        message="message"
        onCancel={onCancel}
        onConfirm={() => undefined}
      />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
  })

  it('exposes aria-modal and role=dialog', () => {
    render(
      <ConfirmDialog
        title="title"
        message="message"
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
  })
})

describe('PromptDialog', () => {
  it('starts with initialValue and submits the trimmed value', () => {
    const onSubmit = vi.fn()
    render(
      <PromptDialog
        title="重新命名"
        initialValue="三體"
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    )
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('三體')
    fireEvent.change(input, { target: { value: '  新名稱  ' } })
    fireEvent.click(screen.getByText('儲存'))
    expect(onSubmit).toHaveBeenCalledWith('新名稱')
  })

  it('disables submit while the value is empty', () => {
    render(
      <PromptDialog
        title="t"
        initialValue=""
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    )
    const submitBtn = screen.getByText('儲存') as HTMLButtonElement
    expect(submitBtn.disabled).toBe(true)
  })

  it('submits on form submit (Enter)', () => {
    const onSubmit = vi.fn()
    render(
      <PromptDialog
        title="t"
        initialValue="hello"
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    )
    const form = screen.getByRole('textbox').closest('form') as HTMLFormElement
    fireEvent.submit(form)
    expect(onSubmit).toHaveBeenCalledWith('hello')
  })

  it('cancels on Escape', () => {
    const onCancel = vi.fn()
    render(
      <PromptDialog
        title="t"
        initialValue="x"
        onCancel={onCancel}
        onSubmit={() => undefined}
      />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
  })
})
