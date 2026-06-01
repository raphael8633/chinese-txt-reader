import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AppUpdateBanner, AppUpdateControl } from '../AppUpdateBanner.js'
import * as appUpdate from '../appUpdate.js'

vi.mock('../appUpdate.js', () => ({
  activateAppUpdate: vi.fn().mockResolvedValue(undefined),
  checkForAppUpdate: vi.fn().mockResolvedValue(undefined),
  subscribeAppUpdate: vi.fn(),
}))

describe('AppUpdateBanner', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('does not show a floating manual update check button while idle', () => {
    vi.mocked(appUpdate.subscribeAppUpdate).mockImplementation(listener => {
      listener('idle')
      return vi.fn()
    })

    render(<MemoryRouter><AppUpdateBanner /></MemoryRouter>)

    expect(screen.queryByText('檢查更新')).toBeNull()
  })

  it('activates an available app update', () => {
    vi.mocked(appUpdate.subscribeAppUpdate).mockImplementation(listener => {
      listener('available')
      return vi.fn()
    })

    render(<MemoryRouter><AppUpdateBanner /></MemoryRouter>)
    expect(screen.getByText('有新版本可用')).toBeTruthy()
    fireEvent.click(screen.getByText('更新'))

    expect(appUpdate.activateAppUpdate).toHaveBeenCalled()
  })

  it('hides the floating update button while reading', () => {
    vi.mocked(appUpdate.subscribeAppUpdate).mockImplementation(listener => {
      listener('idle')
      return vi.fn()
    })

    render(<MemoryRouter initialEntries={['/read/book-1']}><AppUpdateBanner /></MemoryRouter>)

    expect(screen.queryByText('檢查更新')).toBeNull()
  })

  it('renders an embeddable update control for reader toolbar', () => {
    vi.mocked(appUpdate.subscribeAppUpdate).mockImplementation(listener => {
      listener('idle')
      return vi.fn()
    })

    render(<MemoryRouter><AppUpdateControl /></MemoryRouter>)
    fireEvent.click(screen.getByText('檢查更新'))

    expect(appUpdate.checkForAppUpdate).toHaveBeenCalled()
  })
})
