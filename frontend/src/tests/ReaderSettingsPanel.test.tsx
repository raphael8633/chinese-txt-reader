import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ReaderSettingsPanel } from '../components/reader/ReaderSettingsPanel.js'
import { resetRememberedSettingsSection } from '../components/reader/settingsSectionMemory.js'
import { DEFAULT_SETTINGS } from '../utils/readerUtils.js'

function setup(overrides = {}) {
  const onUpdate = vi.fn()
  const onClose = vi.fn()
  const view = render(
    <ReaderSettingsPanel
      settings={{ ...DEFAULT_SETTINGS, ...overrides }}
      onClose={onClose}
      onUpdate={onUpdate}
    />,
  )
  return { onUpdate, onClose, unmount: view.unmount }
}

describe('ReaderSettingsPanel', () => {
  beforeEach(() => {
    resetRememberedSettingsSection()
  })

  it('starts on the 字型 tab and hides options from other tabs', () => {
    setup()
    expect(screen.getByText('字體大小')).toBeTruthy()
    expect(screen.queryByText('段首縮進')).toBeNull()
    expect(screen.queryByText('米白')).toBeNull()
  })

  it('switches tabs without scrolling — clicking 排版 shows 段首縮進', () => {
    setup()
    fireEvent.click(screen.getByTestId('settings-tab-layout'))
    expect(screen.getByText('段首縮進')).toBeTruthy()
    expect(screen.queryByText('字體大小')).toBeNull()
  })

  it('switches to 主題 tab and exposes theme presets', () => {
    setup()
    fireEvent.click(screen.getByTestId('settings-tab-theme'))
    expect(screen.getByText('米白')).toBeTruthy()
    expect(screen.getByText('暗黑')).toBeTruthy()
    expect(screen.getByText('護眼')).toBeTruthy()
  })

  it('switches to 操作 tab and exposes 工具列 + 點擊模式', () => {
    setup()
    fireEvent.click(screen.getByTestId('settings-tab-control'))
    expect(screen.getByText('工具列')).toBeTruthy()
    expect(screen.getByText('點擊模式')).toBeTruthy()
  })

  it('offers 換行 next to the other text layout options in 排版', () => {
    const { onUpdate } = setup()
    fireEvent.click(screen.getByTestId('settings-tab-layout'))
    expect(screen.getByText('換行')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保留' }))
    expect(onUpdate).toHaveBeenCalledWith({ hardWrapMode: 'preserve' })
  })

  it('switches to 過濾 tab and propagates newline-separated content filters', () => {
    const { onUpdate } = setup({ contentFilters: ['舊廣告'] })
    fireEvent.click(screen.getByTestId('settings-tab-filter'))
    expect(screen.getByText('廣告字串')).toBeTruthy()
    const textarea = screen.getByLabelText('廣告字串') as HTMLTextAreaElement
    expect(textarea.value).toBe('舊廣告')

    fireEvent.change(textarea, { target: { value: '請收藏本站\n\n[廣告]' } })
    expect(onUpdate).toHaveBeenCalledWith({ contentFilters: ['請收藏本站', '[廣告]'] })
  })

  it('propagates a stepper increment in the current tab to onUpdate', () => {
    const { onUpdate } = setup({ fontSizePx: 18 })
    fireEvent.click(screen.getByLabelText('增加字體大小'))
    expect(onUpdate).toHaveBeenCalledWith({ fontSizePx: 19 })
  })

  it('propagates a pill-group click on the 操作 tab to onUpdate', () => {
    const { onUpdate } = setup()
    fireEvent.click(screen.getByTestId('settings-tab-control'))
    fireEvent.click(screen.getByText('左側'))
    expect(onUpdate).toHaveBeenCalledWith({ toolbarSide: 'left' })
  })

  it('reopens on the tab selected before the panel closed', () => {
    const first = setup()
    fireEvent.click(screen.getByTestId('settings-tab-theme'))
    expect(screen.getByTestId('settings-section-theme')).toBeTruthy()
    first.unmount()

    setup()
    expect(screen.getByTestId('settings-tab-theme').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('settings-tab-font').getAttribute('aria-selected')).toBe('false')
    expect(screen.getByText('米白')).toBeTruthy()
    expect(screen.queryByText('字體大小')).toBeNull()
  })

  it('marks the active tab via aria-selected for screen readers', () => {
    setup()
    expect(screen.getByTestId('settings-tab-font').getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByTestId('settings-tab-theme'))
    expect(screen.getByTestId('settings-tab-theme').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('settings-tab-font').getAttribute('aria-selected')).toBe('false')
  })
})
