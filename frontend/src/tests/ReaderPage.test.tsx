import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ReaderPage } from '../pages/ReaderPage.js'
import * as api from '../api.js'
import * as dbModule from '../db.js'
import * as offline from '../offline.js'

vi.mock('../api.js')
vi.mock('../offline.js', () => ({
  getOfflineBook: vi.fn().mockResolvedValue(null),
  readBookContentChunks: vi.fn().mockResolvedValue(null),
  settingsToLocal: vi.fn((settings, bookId) => ({ ...settings, bookId })),
}))

const mockScrollToIndex = vi.fn()

vi.mock('../db.js', () => {
  const mockDb = {
    progress: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue('book-1' as never),
    },
    settings: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue('book-1' as never),
    },
  }
  return { db: mockDb, RaphReaderDb: vi.fn() }
})

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 10) }, (_, i) => ({
        key: i, index: i, start: i * 80, size: 80,
    })),
    getTotalSize: () => count * 80,
    scrollToIndex: mockScrollToIndex,
    measureElement: vi.fn(),
  }),
}))

const defaultSettings: api.ReaderSettings = {
  fontSizePx: 18, lineHeight: 1.8, letterSpacingPx: 0,
  textColor: '#333333', backgroundColor: '#f5f0e8', readingMode: 'scroll',
  tapScrollPercent: 90, tapScrollMode: 'allDown', toolbarSide: 'right', hardWrapMode: 'auto',
  chineseConversion: 'none',
  paddingTop: 9, paddingBottom: 8,
  annotationMarginTop: 20, annotationMarginBottom: 0,
  marginLeft: 16, marginRight: 16,
  paragraphSpacing: 7, paragraphIndent: 1,
  fontWeight: 400, justifyText: true,
}

function renderReaderPage(bookId = 'book-1') {
  return render(
    <MemoryRouter initialEntries={[`/read/${bookId}`]}>
      <Routes>
        <Route path="/read/:bookId" element={<ReaderPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

function mockStreamContent(content: string) {
  vi.mocked(api.streamBookContent).mockImplementation(async function* () { yield content })
}

describe('ReaderPage', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(offline.getOfflineBook).mockResolvedValue(null)
    vi.mocked(offline.readBookContentChunks).mockResolvedValue(null)
    vi.mocked(offline.settingsToLocal).mockImplementation((settings, bookId) => ({ ...settings, bookId }))
    vi.mocked(dbModule.db.progress.get).mockResolvedValue(null)
    vi.mocked(dbModule.db.progress.put).mockResolvedValue('book-1' as never)
    vi.mocked(dbModule.db.settings.get).mockResolvedValue(null)
    vi.mocked(dbModule.db.settings.put).mockResolvedValue('book-1' as never)
    mockScrollToIndex.mockReset()
    vi.mocked(api.streamBookContent).mockImplementation(async function* () {})
    vi.mocked(api.isAuthExpiredError).mockImplementation(error => error instanceof Error && error.name === 'AuthExpiredError')
  })

  it('shows loading state initially', () => {
    vi.mocked(api.streamBookContent).mockImplementation(async function* () { await new Promise(() => {}) })
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    expect(screen.getByTestId('loading')).toBeTruthy()
  })

  it('shows error when content fetch fails', async () => {
    vi.mocked(api.streamBookContent).mockImplementation(async function* () { throw new Error('Network error') })
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => {
      expect(screen.getByTestId('error')).toBeTruthy()
      expect(screen.getByText(/Network error/)).toBeTruthy()
    })
  })

  it('shows a manual login button when content fetch is redirected by expired auth', async () => {
    const authError = Object.assign(new Error('Session 已過期'), { name: 'AuthExpiredError' })
    vi.mocked(api.streamBookContent).mockImplementation(async function* () { throw authError })
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])

    renderReaderPage()

    await waitFor(() => {
      expect(screen.getByTestId('auth-expired')).toBeTruthy()
      expect(screen.getByText('Session 已過期')).toBeTruthy()
      expect(screen.getByText('重新登入')).toBeTruthy()
    })
    expect(screen.queryByTestId('error')).toBeNull()
  })

  it('uses the reader app route when logging in after a reading session expires', async () => {
    const authError = Object.assign(new Error('Session 已過期'), { name: 'AuthExpiredError' })
    vi.mocked(api.streamBookContent).mockImplementation(async function* () { throw authError })
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])

    renderReaderPage()

    await waitFor(() => screen.getByText('重新登入'))
    fireEvent.click(screen.getByText('重新登入'))

    expect(api.loginToReader).toHaveBeenCalled()
  })

  it('loads global settings from IndexedDB using __global__ key', async () => {
    vi.mocked(dbModule.db.settings.get).mockResolvedValue({ ...defaultSettings, bookId: '__global__' })
    mockStreamContent('段落')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => screen.getByText('段落'))
    expect(dbModule.db.settings.get).toHaveBeenCalledWith('__global__')
  })

  it('saves global settings to IndexedDB using __global__ key on server load', async () => {
    vi.mocked(dbModule.db.settings.get).mockResolvedValue(null)
    mockStreamContent('段落')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => screen.getByText('段落'))
    expect(dbModule.db.settings.put).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: '__global__' }),
    )
  })

  it('renders paragraphs from API when no IndexedDB cache', async () => {
    mockStreamContent('第一段\n\n第二段\n\n第三段')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([
      { id: 'book-1', title: '三體', charCount: 100, fileSize: 200, createdAt: '2026-01-01T00:00:00Z' },
    ])
    renderReaderPage()
    await waitFor(() => {
      expect(screen.getByText('第一段')).toBeTruthy()
    })
    expect(api.streamBookContent).toHaveBeenCalledWith('book-1')
  })

  it('merges hard-wrapped narrative lines on desktop auto mode while preserving dialogue breaks', async () => {
    mockStreamContent('第一章 開始\n這是被原檔\n硬換行的敘事。\n「這句對話要獨立。」\n後續敘事\n繼續接回同段。')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()

    await waitFor(() => {
      expect(screen.getByText('這是被原檔硬換行的敘事。')).toBeTruthy()
      expect(screen.getByText('「這句對話要獨立。」')).toBeTruthy()
      expect(screen.getByText('後續敘事繼續接回同段。')).toBeTruthy()
    })
  })

  it('preserves original hard wraps on mobile auto mode', async () => {
    const listeners: Array<(event: MediaQueryListEvent) => void> = []
    const originalMatchMedia = window.matchMedia
    window.matchMedia = vi.fn((query: string): MediaQueryList => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: (_event: string, listener: EventListenerOrEventListenerObject) => {
        if (typeof listener === 'function') listeners.push(listener as (event: MediaQueryListEvent) => void)
      },
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    mockStreamContent('這是被原檔\n硬換行的敘事。')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])

    renderReaderPage()

    await waitFor(() => {
      expect(screen.getByText('這是被原檔')).toBeTruthy()
      expect(screen.getByText('硬換行的敘事。')).toBeTruthy()
    })
    expect(screen.queryByText('這是被原檔硬換行的敘事。')).toBeNull()
    window.matchMedia = originalMatchMedia
  })

  it('uses IndexedDB cache instead of API when content is cached', async () => {
    vi.mocked(offline.readBookContentChunks).mockResolvedValue('快取段落')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => {
      expect(screen.getByText('快取段落')).toBeTruthy()
    })
    expect(api.streamBookContent).not.toHaveBeenCalled()
  })

  it('renders cached content when progress, settings, and books APIs fail offline', async () => {
    vi.mocked(offline.readBookContentChunks).mockResolvedValue('離線段落')
    vi.mocked(offline.getOfflineBook).mockResolvedValue({
      id: 'book-1', title: '離線書', charCount: 4, fileSize: 8, createdAt: '2026-01-01T00:00:00Z',
    })
    vi.mocked(dbModule.db.progress.get).mockResolvedValue({
      bookId: 'book-1',
      positionType: 'paragraph_index',
      positionValue: 0,
      updatedAt: '2026-01-01T00:00:00Z',
    })
    vi.mocked(dbModule.db.settings.get).mockResolvedValue({ ...defaultSettings, bookId: '__global__' })
    vi.mocked(api.getProgress).mockRejectedValue(new Error('offline'))
    vi.mocked(api.getSettings).mockRejectedValue(new Error('offline'))
    vi.mocked(api.listBooks).mockRejectedValue(new Error('offline'))

    renderReaderPage()

    await waitFor(() => {
      expect(screen.getByText('離線段落')).toBeTruthy()
      expect(screen.getByText('離線書')).toBeTruthy()
    })
  })

  it('displays book title in header', async () => {
    mockStreamContent('段落')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([
      { id: 'book-1', title: '三體', charCount: 100, fileSize: 200, createdAt: '2026-01-01T00:00:00Z' },
    ])
    renderReaderPage()
    await waitFor(() => {
      expect(screen.getByText('三體')).toBeTruthy()
    })
  })

  it('shows book and formatted chapter title in the header and chapter list', async () => {
    mockStreamContent('第五百零十三章硬骨頭\n章節內容')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue({ ...defaultSettings, hardWrapMode: 'preserve' })
    vi.mocked(api.listBooks).mockResolvedValue([
      { id: 'book-1', title: '網遊之全球在線', charCount: 100, fileSize: 200, createdAt: '2026-01-01T00:00:00Z' },
    ])

    renderReaderPage()

    await waitFor(() => {
      expect(screen.getByText('網遊之全球在線 第五百零十三章 硬骨頭')).toBeTruthy()
      expect(screen.getAllByText('第五百零十三章 硬骨頭').length).toBeGreaterThan(0)
    })
  })

  it('shows current chapter count and title in mobile header', async () => {
    mockStreamContent('序\n第一章 開始\n內文\n第二章 轉折')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue({ ...defaultSettings, hardWrapMode: 'preserve' })
    vi.mocked(api.listBooks).mockResolvedValue([
      { id: 'book-1', title: '三體', charCount: 100, fileSize: 200, createdAt: '2026-01-01T00:00:00Z' },
    ])
    renderReaderPage()

    await waitFor(() => {
      expect(screen.getByText('1/2 第一章 開始')).toBeTruthy()
    })
  })

  it('restores saved paragraph position after content loads', async () => {
    mockStreamContent('第一段\n\n第二段\n\n第三段')
    vi.mocked(api.getProgress).mockResolvedValue({
      positionType: 'paragraph_index',
      positionValue: 2,
      updatedAt: '2026-01-01T00:00:00Z',
    })
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])

    renderReaderPage()

    await waitFor(() => {
      expect(mockScrollToIndex).toHaveBeenCalledWith(2, { align: 'start' })
    })
  })

  it('restores saved chapter position after content loads', async () => {
    mockStreamContent('序\n第一章 開始\n內文\n第二章 轉折')
    vi.mocked(api.getProgress).mockResolvedValue({
      positionType: 'chapter_index',
      positionValue: 1,
      updatedAt: '2026-01-01T00:00:00Z',
    })
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])

    renderReaderPage()

    await waitFor(() => {
      expect(mockScrollToIndex).toHaveBeenCalledWith(3, { align: 'start' })
    })
  })

  it('auto-merges close progress by using the later chapter', async () => {
    mockStreamContent(
      Array.from({ length: 20 }, (_, index) => `第${index + 1}章 標題\n內容`).join('\n'),
    )
    vi.mocked(api.getProgress).mockResolvedValue({
      positionType: 'chapter_index',
      positionValue: 1,
      updatedAt: '2026-01-01T00:00:00Z',
    })
    vi.mocked(dbModule.db.progress.get).mockResolvedValue({
      bookId: 'book-1',
      positionType: 'chapter_index',
      positionValue: 2,
      updatedAt: '2026-01-02T00:00:00Z',
    })
    vi.mocked(api.getSettings).mockResolvedValue({ ...defaultSettings, hardWrapMode: 'preserve' })
    vi.mocked(api.listBooks).mockResolvedValue([])

    renderReaderPage()

    await waitFor(() => {
      expect(mockScrollToIndex).toHaveBeenCalledWith(4, { align: 'start' })
    })
    expect(api.saveProgress).toHaveBeenCalledWith('book-1', { positionType: 'chapter_index', positionValue: 2 })
  })

  it('asks the user when local and cloud progress differ by at least ten percent', async () => {
    mockStreamContent(
      Array.from({ length: 6 }, (_, index) => `第${index + 1}章 標題\n內容`).join('\n'),
    )
    vi.mocked(api.getProgress).mockResolvedValue({
      positionType: 'chapter_index',
      positionValue: 5,
      updatedAt: '2026-01-02T00:00:00Z',
    })
    vi.mocked(dbModule.db.progress.get).mockResolvedValue({
      bookId: 'book-1',
      positionType: 'chapter_index',
      positionValue: 0,
      updatedAt: '2026-01-01T00:00:00Z',
    })
    vi.mocked(api.getSettings).mockResolvedValue({ ...defaultSettings, hardWrapMode: 'preserve' })
    vi.mocked(api.listBooks).mockResolvedValue([])

    renderReaderPage()

    await waitFor(() => {
      expect(screen.getByTestId('progress-conflict')).toBeTruthy()
      expect(screen.getByText('使用此裝置：第 1 章')).toBeTruthy()
      expect(screen.getByText('使用雲端：第 6 章')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('使用雲端：第 6 章'))

    await waitFor(() => {
      expect(mockScrollToIndex).toHaveBeenCalledWith(10, { align: 'start' })
    })
    expect(api.saveProgress).toHaveBeenCalledWith('book-1', { positionType: 'chapter_index', positionValue: 5 })
  })

  it('shows settings panel when settings button clicked', async () => {
    mockStreamContent('段落')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => screen.getByText('段落'))
    fireEvent.click(screen.getByText('設定'))
    expect(screen.getByTestId('settings-panel')).toBeTruthy()
  })

  it('closes settings panel when content is clicked', async () => {
    mockStreamContent('段落')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => screen.getByText('段落'))

    fireEvent.click(screen.getByText('設定'))
    expect(screen.getByTestId('settings-panel')).toBeTruthy()
    fireEvent.click(screen.getByText('段落'))

    await waitFor(() => {
      expect(screen.queryByTestId('settings-panel')).toBeNull()
    })
  })

  it('loads settings from global key (__global__) in IndexedDB', async () => {
    mockStreamContent('段落')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => screen.getByText('段落'))
    expect(dbModule.db.settings.get).toHaveBeenCalledWith('__global__')
    expect(dbModule.db.settings.get).not.toHaveBeenCalledWith('book-1')
  })

  it('saves settings globally (null bookId) not per-book', async () => {
    mockStreamContent('段落')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => screen.getByText('段落'))

    fireEvent.click(screen.getByText('設定'))
    fireEvent.click(screen.getByLabelText('增加字體大小'))

    await waitFor(() => {
      expect(dbModule.db.settings.put).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: '__global__', fontSizePx: 19 }),
      )
    })
    expect(api.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: null }),
    )
  })

  it('saves settings to IndexedDB before best-effort API sync', async () => {
    mockStreamContent('段落')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.saveSettings).mockRejectedValue(new Error('offline'))
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => screen.getByText('段落'))

    fireEvent.click(screen.getByText('設定'))
    fireEvent.click(screen.getByLabelText('增加字體大小'))

    await waitFor(() => {
      expect(dbModule.db.settings.put).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: '__global__', fontSizePx: 19, tapScrollPercent: 90, tapScrollMode: 'allDown', toolbarSide: 'right', hardWrapMode: 'auto' }),
      )
    })
  })

  it('uses local settings before server settings so offline edits survive reload', async () => {
    mockStreamContent('段落')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])
    vi.mocked(dbModule.db.settings.get).mockResolvedValue({
      ...defaultSettings,
      bookId: '__global__',
      fontSizePx: 26,
      tapScrollPercent: 75,
      tapScrollMode: 'vertical',
    })

    renderReaderPage()

    await waitFor(() => {
      expect(screen.getByText('段落').parentElement?.style.fontSize).toBe('26px')
    })
  })

  it('tap-scrolls down from any reader area by default', async () => {
    mockStreamContent('第一段\n\n第二段')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue({ ...defaultSettings, tapScrollPercent: 80 })
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => screen.getByText('第一段'))

    const scroller = screen.getByText('第一段').closest('.overflow-y-auto') as HTMLDivElement
    const scrollBy = vi.fn()
    scroller.scrollBy = scrollBy
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 1000 })
    scroller.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 400, height: 1000, right: 400, bottom: 1000, x: 0, y: 0,
      toJSON: () => ({}),
    })

    fireEvent.click(scroller, { clientX: 300 })
    expect(scrollBy).toHaveBeenCalledWith({ top: 800, behavior: 'smooth' })

    fireEvent.click(scroller, { clientX: 100 })
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 800, behavior: 'smooth' })
  })

  it('supports vertical tap-scroll zones', async () => {
    mockStreamContent('第一段\n\n第二段')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue({ ...defaultSettings, tapScrollPercent: 80, tapScrollMode: 'vertical' })
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => screen.getByText('第一段'))

    const scroller = screen.getByText('第一段').closest('.overflow-y-auto') as HTMLDivElement
    const scrollBy = vi.fn()
    scroller.scrollBy = scrollBy
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 1000 })
    scroller.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 400, height: 1000, right: 400, bottom: 1000, x: 0, y: 0,
      toJSON: () => ({}),
    })

    fireEvent.click(scroller, { clientY: 750 })
    expect(scrollBy).toHaveBeenCalledWith({ top: 800, behavior: 'smooth' })

    fireEvent.click(scroller, { clientY: 250 })
    expect(scrollBy).toHaveBeenLastCalledWith({ top: -800, behavior: 'smooth' })
  })

  it('supports horizontal tap-scroll zones', async () => {
    mockStreamContent('第一段\n\n第二段')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue({ ...defaultSettings, tapScrollPercent: 80, tapScrollMode: 'horizontal' })
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => screen.getByText('第一段'))

    const scroller = screen.getByText('第一段').closest('.overflow-y-auto') as HTMLDivElement
    const scrollBy = vi.fn()
    scroller.scrollBy = scrollBy
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 1000 })
    scroller.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 400, height: 1000, right: 400, bottom: 1000, x: 0, y: 0,
      toJSON: () => ({}),
    })

    fireEvent.click(scroller, { clientX: 300 })
    expect(scrollBy).toHaveBeenCalledWith({ top: 800, behavior: 'smooth' })

    fireEvent.click(scroller, { clientX: 100 })
    expect(scrollBy).toHaveBeenLastCalledWith({ top: -800, behavior: 'smooth' })
  })

  it('saves reading progress by chapter index', async () => {
    mockStreamContent('序\n第一章 開始\n內文\n鋪陳\n第二章 轉折\n更多內容\n延伸\n尾聲')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue({ ...defaultSettings, hardWrapMode: 'preserve' })
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => screen.getByText('更多內容'))

    try {
      vi.useFakeTimers()
      const scroller = screen.getByText('更多內容').closest('.overflow-y-auto') as HTMLDivElement
      fireEvent.scroll(scroller)
      await vi.advanceTimersByTimeAsync(2000)
      expect(dbModule.db.progress.put).toHaveBeenCalledWith(expect.objectContaining({
        positionType: 'chapter_index',
        positionValue: 1,
      }))
      expect(api.saveProgress).toHaveBeenCalledWith('book-1', { positionType: 'chapter_index', positionValue: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('jumps to selected chapter via chapter panel', async () => {
    mockStreamContent('序\n第一章 開始\n內文\n第二章 轉折')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => screen.getByText('序'))

    fireEvent.click(screen.getByText('章節'))
    await waitFor(() => screen.getByTestId('chapter-panel'))

    const panel = screen.getByTestId('chapter-panel')
    const chapterBtn = Array.from(panel.querySelectorAll('button')).find(
      b => b.textContent?.includes('第一章 開始'),
    )
    expect(chapterBtn).toBeTruthy()
    fireEvent.click(chapterBtn!)
    expect(mockScrollToIndex).toHaveBeenCalledWith(1, { align: 'start' })
  })

  it('locks reader scrolling while mobile toolbar is open and closes it from content click', async () => {
    mockStreamContent('第一章 開始\n內文')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => screen.getByText('內文'))

    fireEvent.click(screen.getByLabelText('開啟工具列'))
    const scroller = screen.getByText('內文').closest('.flex-1') as HTMLDivElement
    expect(scroller.className).toContain('overflow-hidden')

    const scrollBy = vi.fn()
    scroller.scrollBy = scrollBy
    fireEvent.click(scroller)

    expect(scrollBy).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(scroller.className).toContain('overflow-y-auto')
    })
  })

  it('saves toolbar side from settings panel', async () => {
    mockStreamContent('段落')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => screen.getByText('段落'))

    fireEvent.click(screen.getByText('設定'))
    fireEvent.click(screen.getByText('左側'))

    await waitFor(() => {
      expect(dbModule.db.settings.put).toHaveBeenCalledWith(expect.objectContaining({ toolbarSide: 'left' }))
    })
  })

  it('settings button opens settings panel with stepper row for 字體大小', async () => {
    mockStreamContent('段落')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => screen.getByText('段落'))

    fireEvent.click(screen.getByText('設定'))

    expect(screen.getByTestId('settings-panel')).toBeTruthy()
    expect(screen.getByText('字體大小')).toBeTruthy()
    expect(screen.getByLabelText('增加字體大小')).toBeTruthy()
    expect(screen.getByLabelText('減少字體大小')).toBeTruthy()
  })

  it('chapter button opens chapter panel with 目錄 heading', async () => {
    mockStreamContent('序\n第一章 開始\n內文\n第二章 轉折')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([
      { id: 'book-1', title: '三體', charCount: 100, fileSize: 200, createdAt: '2026-01-01T00:00:00Z' },
    ])
    renderReaderPage()
    await waitFor(() => screen.getByText('序'))

    expect(screen.getByText('章節')).toBeTruthy()
    fireEvent.click(screen.getByText('章節'))

    await waitFor(() => {
      expect(screen.getByTestId('chapter-panel')).toBeTruthy()
      expect(screen.getByText('目錄')).toBeTruthy()
    })
  })

  it('adds toolbar-width offset to padding-right on desktop when toolbar is on the right', async () => {
    mockStreamContent('段落')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue({ ...defaultSettings, toolbarSide: 'right', marginRight: 16 })
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => screen.getByText('段落'))

    const scroller = screen.getByText('段落').closest('.overflow-y-auto') as HTMLDivElement
    // Desktop viewport (jsdom default): padding-right must clear the 96px (w-24) toolbar
    expect(scroller.style.paddingRight).toBe('112px') // 16px marginRight + 96px toolbar
  })

  it('adds toolbar-width offset to padding-left on desktop when toolbar is on the left', async () => {
    mockStreamContent('段落')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue({ ...defaultSettings, toolbarSide: 'left', marginLeft: 16 })
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => screen.getByText('段落'))

    const scroller = screen.getByText('段落').closest('.overflow-y-auto') as HTMLDivElement
    expect(scroller.style.paddingLeft).toBe('112px') // 16px marginLeft + 96px toolbar
  })

  it('restores chapter position when hard-wrap mode is toggled', async () => {
    // 10 paragraphs in preserve mode: chapters at index 0 (第一章) and 4 (第二章)
    // mock virtualizer center item = items[5] (index 5) → in 第二章 → currentChapterIndex = 1
    const content = '第一章 開始\n段落1\n段落2\n段落3\n第二章 中段\n段落4\n段落5\n段落6\n段落7\n段落8'
    mockStreamContent(content)
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue({ ...defaultSettings, hardWrapMode: 'preserve' })
    vi.mocked(api.listBooks).mockResolvedValue([])

    renderReaderPage()

    // Wait for content to load (no progress → initialScrollDone = true immediately)
    await waitFor(() => screen.getByText('段落4'))
    mockScrollToIndex.mockReset()

    // Simulate user scrolling: mock virtualizer picks center item (index 5) → chapter 1 (第二章)
    const scroller = screen.getByText('段落4').closest('.overflow-y-auto') as HTMLDivElement
    fireEvent.scroll(scroller)

    // Open settings and switch to merge mode
    fireEvent.click(screen.getByText('設定'))
    fireEvent.click(screen.getByText('合併'))

    // In merge mode 第二章 is at paragraph index 2 → should scroll there to preserve position
    await waitFor(() => {
      expect(mockScrollToIndex).toHaveBeenCalledWith(2, { align: 'start' })
    })
  })

  it('saves hard-wrap mode from settings panel', async () => {
    mockStreamContent('第一行\n第二行')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => screen.getByText('第一行第二行'))

    fireEvent.click(screen.getByText('設定'))
    fireEvent.click(screen.getByText('保留'))

    await waitFor(() => {
      expect(dbModule.db.settings.put).toHaveBeenCalledWith(expect.objectContaining({ hardWrapMode: 'preserve' }))
    })
    expect(screen.getByText('第一行')).toBeTruthy()
    expect(screen.getByText('第二行')).toBeTruthy()
  })

  it('ignores left swipe while settings panel is open', async () => {
    mockStreamContent('段落')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => screen.getByText('段落'))

    fireEvent.click(screen.getByText('設定'))
    expect(screen.getByTestId('settings-panel')).toBeTruthy()

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 })
    const outerDiv = document.querySelector('.h-screen') as HTMLElement
    fireEvent.touchStart(outerDiv, { touches: [{ clientX: 300, clientY: 200 }] })
    fireEvent.touchEnd(outerDiv, { changedTouches: [{ clientX: 50, clientY: 200 }] })

    // Toolbar must not have been shown (translate-x-full = hidden state)
    const toolbar = screen.getByTestId('reader-toolbar')
    expect(toolbar.className).toContain('translate-x-full')
  })

  it('detects chapters even when source text has leading fullwidth spaces (preserve mode)', async () => {
    mockStreamContent('　第一章 開始\n內文\n　第二章 轉折')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue({ ...defaultSettings, hardWrapMode: 'preserve' })
    vi.mocked(api.listBooks).mockResolvedValue([
      { id: 'book-1', title: '三體', charCount: 100, fileSize: 200, createdAt: '2026-01-01T00:00:00Z' },
    ])
    renderReaderPage()
    await waitFor(() => {
      expect(screen.getByText('1/2 第一章 開始')).toBeTruthy()
    })
  })

  it('strips leading fullwidth spaces from paragraph display in preserve mode', async () => {
    mockStreamContent('　　縮進段落\n\n普通段落')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue({ ...defaultSettings, hardWrapMode: 'preserve' })
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => {
      // Leading spaces must be stripped; text renders without leading
      expect(screen.getByText('縮進段落')).toBeTruthy()
    })
    expect(screen.queryByText('　　縮進段落')).toBeNull()
  })

  it('does not convert Chinese text by default', async () => {
    mockStreamContent('汉语與繁體')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()

    await waitFor(() => {
      expect(screen.getByText('汉语與繁體')).toBeTruthy()
    })
  })

  it('converts displayed text to traditional or simplified from settings panel', async () => {
    mockStreamContent('汉语與繁體')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getSettings).mockResolvedValue(defaultSettings)
    vi.mocked(api.listBooks).mockResolvedValue([])
    renderReaderPage()
    await waitFor(() => screen.getByText('汉语與繁體'))

    fireEvent.click(screen.getByText('設定'))
    fireEvent.click(screen.getByText('轉繁體'))

    await waitFor(() => {
      expect(dbModule.db.settings.put).toHaveBeenCalledWith(expect.objectContaining({ chineseConversion: 'traditional' }))
      expect(screen.getByText('漢語與繁體')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('轉簡體'))

    await waitFor(() => {
      expect(dbModule.db.settings.put).toHaveBeenCalledWith(expect.objectContaining({ chineseConversion: 'simplified' }))
      expect(screen.getByText('汉语与繁体')).toBeTruthy()
    })
  })
})
