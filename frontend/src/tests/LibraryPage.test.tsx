import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { LibraryPage } from '../pages/LibraryPage.js'
import * as api from '../api.js'
import * as offline from '../offline.js'

vi.mock('../api.js')
vi.mock('../offline.js', () => ({
  listOfflineBooks: vi.fn().mockResolvedValue([]),
  removeOfflineBook: vi.fn().mockResolvedValue(undefined),
  saveBookForOffline: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../db.js', () => ({
  db: {
    progress: { delete: vi.fn().mockResolvedValue(undefined) },
    books: {
      delete: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue('book-1' as never),
    },
    settings: { delete: vi.fn().mockResolvedValue(undefined) },
  },
}))

const mockBooks = [
  { id: 'book-1', title: '三體', charCount: 50000, createdAt: '2026-01-01T00:00:00Z', fileSize: 100000 },
  { id: 'book-2', title: '紅樓夢', charCount: 80000, createdAt: '2026-01-02T00:00:00Z', fileSize: 200000 },
]

describe('LibraryPage', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.isAuthExpiredError).mockImplementation(error => error instanceof Error && error.name === 'AuthExpiredError')
    vi.mocked(api.getProgress).mockResolvedValue(null)
    vi.mocked(api.getBookContent).mockResolvedValue('第一段\n第二段')
    vi.mocked(offline.listOfflineBooks).mockResolvedValue([])
    vi.mocked(offline.removeOfflineBook).mockResolvedValue(undefined)
    vi.mocked(offline.saveBookForOffline).mockResolvedValue(undefined)
  })

  it('renders heading', async () => {
    vi.mocked(api.listBooks).mockResolvedValue([])
    render(<MemoryRouter><LibraryPage /></MemoryRouter>)
    expect(screen.getByText('書庫')).toBeTruthy()
    await waitFor(() => expect(api.listBooks).toHaveBeenCalled())
  })

  it('fetches books on mount and renders card titles', async () => {
    vi.mocked(api.listBooks).mockResolvedValue(mockBooks)
    render(<MemoryRouter><LibraryPage /></MemoryRouter>)
    await waitFor(() => {
      expect(screen.getByText('三體')).toBeTruthy()
      expect(screen.getByText('紅樓夢')).toBeTruthy()
    })
  })

  it('shows offline availability on cards without entering edit mode', async () => {
    vi.mocked(api.listBooks).mockResolvedValue(mockBooks)
    vi.mocked(offline.listOfflineBooks).mockResolvedValue([mockBooks[0]])

    render(<MemoryRouter><LibraryPage /></MemoryRouter>)

    await waitFor(() => {
      expect(screen.getByText('已下載離線副本')).toBeTruthy()
    })
    expect(screen.queryByText('移除離線副本')).toBeNull()
  })

  it('shows lightweight reading progress on book cards without fetching content', async () => {
    vi.mocked(api.listBooks).mockResolvedValue([{
      ...mockBooks[0],
      paragraphCount: 3,
      progress: {
        positionType: 'paragraph_index',
        positionValue: 1,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    }])

    render(<MemoryRouter><LibraryPage /></MemoryRouter>)

    await waitFor(() => {
      expect(screen.getByText('第 2 段 / 共 3 段')).toBeTruthy()
    })
    expect(api.getProgress).not.toHaveBeenCalled()
    expect(api.getBookContent).not.toHaveBeenCalled()
  })

  it('shows chapter progress when chapter metadata exists', async () => {
    vi.mocked(api.listBooks).mockResolvedValue([{
      ...mockBooks[0],
      paragraphCount: 10,
      chapters: [
        { index: 0, title: '第一章' },
        { index: 4, title: '第二章' },
        { index: 8, title: '第三章' },
      ],
      progress: {
        positionType: 'paragraph_index',
        positionValue: 5,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    }])

    render(<MemoryRouter><LibraryPage /></MemoryRouter>)

    await waitFor(() => {
      expect(screen.getByText('第 2 章 / 共 3 章')).toBeTruthy()
    })
  })

  it('shows chapter-index progress when saved by reader', async () => {
    vi.mocked(api.listBooks).mockResolvedValue([{
      ...mockBooks[0],
      chapters: [
        { index: 0, title: '第一章' },
        { index: 4, title: '第二章' },
        { index: 8, title: '第三章' },
      ],
      progress: {
        positionType: 'chapter_index',
        positionValue: 2,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    }])

    render(<MemoryRouter><LibraryPage /></MemoryRouter>)

    await waitFor(() => {
      expect(screen.getByText('第 3 章 / 共 3 章')).toBeTruthy()
    })
  })

  it('shows empty state when no books', async () => {
    vi.mocked(api.listBooks).mockResolvedValue([])
    render(<MemoryRouter><LibraryPage /></MemoryRouter>)
    await waitFor(() => {
      expect(screen.getByText(/尚無書籍/)).toBeTruthy()
    })
  })

  it('shows error message when fetch fails', async () => {
    vi.mocked(api.listBooks).mockRejectedValue(new Error('Network error'))
    render(<MemoryRouter><LibraryPage /></MemoryRouter>)
    await waitFor(() => {
      expect(screen.getByText(/Network error/)).toBeTruthy()
    })
  })

  it('falls back to Dexie books when list API fails offline', async () => {
    vi.mocked(api.listBooks).mockRejectedValue(new TypeError('Failed to fetch'))
    vi.mocked(offline.listOfflineBooks).mockResolvedValue([{ ...mockBooks[0], progress: null }])

    render(<MemoryRouter><LibraryPage /></MemoryRouter>)

    await waitFor(() => {
      expect(screen.getByText('三體')).toBeTruthy()
      expect(screen.getByText('離線模式：顯示已下載書籍')).toBeTruthy()
    })
  })

  it('shows error (not offline mode) when server returns a non-network error', async () => {
    vi.mocked(api.listBooks).mockRejectedValue(new Error('Internal Server Error'))
    vi.mocked(offline.listOfflineBooks).mockResolvedValue([{ ...mockBooks[0], progress: null }])

    render(<MemoryRouter><LibraryPage /></MemoryRouter>)

    await waitFor(() => {
      expect(screen.getByText(/Internal Server Error/)).toBeTruthy()
      expect(screen.queryByText('離線模式：顯示已下載書籍')).toBeNull()
    })
  })

  it('does not redirect to login when truly offline (TypeError)', async () => {
    const hrefSetter = vi.fn()
    vi.stubGlobal('location', {
      get href() { return 'http://localhost/reader/' },
      set href(v: string) { hrefSetter(v) },
    })
    vi.mocked(api.listBooks).mockRejectedValue(new TypeError('Failed to fetch'))
    vi.mocked(offline.listOfflineBooks).mockResolvedValue([])

    render(<MemoryRouter><LibraryPage /></MemoryRouter>)

    await waitFor(() => {
      expect(screen.queryByText('載入中…')).toBeNull()
    })
    expect(hrefSetter).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
  })

  it('enters offline mode with a manual login button when session expires', async () => {
    const authError = Object.assign(new Error('Session 已過期'), { name: 'AuthExpiredError' })
    vi.mocked(api.listBooks).mockRejectedValue(authError)
    vi.mocked(offline.listOfflineBooks).mockResolvedValue([{ ...mockBooks[0], progress: null }])

    render(<MemoryRouter><LibraryPage /></MemoryRouter>)

    await waitFor(() => {
      expect(screen.getByText('三體')).toBeTruthy()
      expect(screen.getByText('Session 已過期：已切換為離線模式')).toBeTruthy()
      expect(screen.getByText('重新登入')).toBeTruthy()
    })
  })

  it('manual login returns through the reader route instead of the books API route', async () => {
    const authError = Object.assign(new Error('Session 已過期'), { name: 'AuthExpiredError' })
    vi.mocked(api.listBooks).mockRejectedValue(authError)
    vi.mocked(offline.listOfflineBooks).mockResolvedValue([])

    render(<MemoryRouter><LibraryPage /></MemoryRouter>)

    await waitFor(() => screen.getByText('重新登入'))
    fireEvent.click(screen.getByText('重新登入'))

    expect(api.loginToReader).toHaveBeenCalled()
  })

  it('uploads a file and re-fetches list', async () => {
    vi.mocked(api.listBooks)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(mockBooks)
    vi.mocked(api.uploadBook).mockResolvedValue(mockBooks[0])

    render(<MemoryRouter><LibraryPage /></MemoryRouter>)
    await waitFor(() => screen.getByText(/尚無書籍/))

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['content'], 'test.txt', { type: 'text/plain' })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => {
      expect(api.uploadBook).toHaveBeenCalledWith(file)
      expect(screen.getByText('三體')).toBeTruthy()
    })
  })

  it('renames a book in edit mode', async () => {
    vi.mocked(api.listBooks).mockResolvedValue(mockBooks)
    vi.mocked(api.renameBook).mockResolvedValue({ ...mockBooks[0], title: '新名稱' })
    vi.spyOn(window, 'prompt').mockReturnValue('新名稱')

    render(<MemoryRouter><LibraryPage /></MemoryRouter>)
    await waitFor(() => screen.getByText('三體'))
    fireEvent.click(screen.getByText('編輯'))
    fireEvent.click(screen.getAllByText('重新命名')[0])

    await waitFor(() => {
      expect(api.renameBook).toHaveBeenCalledWith('book-1', '新名稱')
      expect(screen.getByText('新名稱')).toBeTruthy()
    })
  })

  it('deletes a book in edit mode', async () => {
    vi.mocked(api.listBooks).mockResolvedValue(mockBooks)
    vi.mocked(api.deleteBook).mockResolvedValue(undefined)
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<MemoryRouter><LibraryPage /></MemoryRouter>)
    await waitFor(() => screen.getByText('三體'))
    fireEvent.click(screen.getByText('編輯'))
    fireEvent.click(screen.getAllByText('刪除')[0])

    await waitFor(() => {
      expect(api.deleteBook).toHaveBeenCalledWith('book-1')
      expect(offline.removeOfflineBook).toHaveBeenCalledWith('book-1')
      expect(screen.queryByText('三體')).toBeNull()
    })
  })

  it('downloads a full offline copy before marking it available', async () => {
    vi.mocked(api.listBooks).mockResolvedValue(mockBooks)
    vi.mocked(api.getBookContent).mockResolvedValue('第一段\n第二段')

    render(<MemoryRouter><LibraryPage /></MemoryRouter>)
    await waitFor(() => screen.getByText('三體'))
    fireEvent.click(screen.getByText('編輯'))
    fireEvent.click(screen.getAllByText('下載離線副本')[0])

    await waitFor(() => {
      expect(api.getBookContent).toHaveBeenCalledWith('book-1')
      expect(offline.saveBookForOffline).toHaveBeenCalledWith(mockBooks[0], '第一段\n第二段')
    })
  })

  it('removes an offline copy explicitly', async () => {
    vi.mocked(api.listBooks).mockResolvedValue(mockBooks)
    vi.mocked(offline.listOfflineBooks).mockResolvedValue([mockBooks[0]])

    render(<MemoryRouter><LibraryPage /></MemoryRouter>)
    await waitFor(() => screen.getByText('三體'))
    fireEvent.click(screen.getByText('編輯'))
    fireEvent.click(screen.getByText('移除離線副本'))

    await waitFor(() => {
      expect(offline.removeOfflineBook).toHaveBeenCalledWith('book-1')
    })
  })

  it('shows 上次閱讀 date when book has reading progress', async () => {
    vi.mocked(api.listBooks).mockResolvedValue([{
      ...mockBooks[0],
      progress: {
        positionType: 'chapter_index',
        positionValue: 1,
        updatedAt: '2026-05-17T08:00:00Z',
      },
    }])

    render(<MemoryRouter><LibraryPage /></MemoryRouter>)

    await waitFor(() => {
      expect(screen.getByText(/上次閱讀/)).toBeTruthy()
      expect(screen.queryByText(/上傳 \d/)).toBeNull()
    })
  })

  it('shows 上傳 date when book has no reading progress', async () => {
    vi.mocked(api.listBooks).mockResolvedValue([{ ...mockBooks[0], progress: null }])

    render(<MemoryRouter><LibraryPage /></MemoryRouter>)

    await waitFor(() => {
      expect(screen.getByText(/上傳/)).toBeTruthy()
      expect(screen.queryByText(/上次閱讀/)).toBeNull()
    })
  })

  it('shows error message when upload fails', async () => {
    vi.mocked(api.listBooks).mockResolvedValue([])
    vi.mocked(api.uploadBook).mockRejectedValue(new Error('Upload failed'))

    render(<MemoryRouter><LibraryPage /></MemoryRouter>)
    await waitFor(() => screen.getByText(/尚無書籍/))

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['content'], 'test.txt', { type: 'text/plain' })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => {
      expect(screen.getByText(/Upload failed/)).toBeTruthy()
    })
  })
})
