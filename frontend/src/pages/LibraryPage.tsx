import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  deleteBook,
  getBookContent,
  isAuthExpiredError,
  loginToReader,
  renameBook,
  type Book,
  listBooks,
  uploadBook,
} from '../api.js'
import { db } from '../db.js'
import { listOfflineBooks, removeOfflineBook, saveBookForOffline } from '../offline.js'
import { AppUpdateControl } from '../AppUpdateBanner.js'

function formatProgressLabel(book: Book): string {
  const progress = book.progress
  if (!progress) return '未開始'
  if (progress.positionType === 'chapter_index') {
    const chapters = book.chapters ?? []
    const chapterIndex = Math.max(0, Math.floor(progress.positionValue))
    if (chapters.length > 0) {
      const chapterNumber = Math.min(chapterIndex, chapters.length - 1) + 1
      return `第 ${chapterNumber.toLocaleString('zh-TW')} 章 / 共 ${chapters.length.toLocaleString('zh-TW')} 章`
    }
    return `第 ${chapterIndex + 1} 章`
  }
  if (progress.positionType === 'paragraph_index') {
    const currentParagraph = Math.max(0, Math.floor(progress.positionValue))
    const chapters = book.chapters ?? []
    if (chapters.length > 0) {
      let currentChapterIndex = 0
      for (let i = 0; i < chapters.length; i += 1) {
        if (chapters[i].index <= currentParagraph) currentChapterIndex = i
      }
      const chapterNumber = currentChapterIndex >= 0 ? currentChapterIndex + 1 : 1
      return `第 ${chapterNumber.toLocaleString('zh-TW')} 章 / 共 ${chapters.length.toLocaleString('zh-TW')} 章`
    }
    const paragraphNumber = currentParagraph + 1
    const totalParagraphs = book.paragraphCount ?? 0
    if (totalParagraphs > 0) {
      return `第 ${paragraphNumber.toLocaleString('zh-TW')} 段 / 共 ${totalParagraphs.toLocaleString('zh-TW')} 段`
    }
    return `第 ${paragraphNumber.toLocaleString('zh-TW')} 段`
  }
  return '已閱讀'
}

export function LibraryPage() {
  const [books, setBooks] = useState<Book[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [savingBookId, setSavingBookId] = useState<string | null>(null)
  const [offlineBookIds, setOfflineBookIds] = useState<Set<string>>(new Set())
  const [offlineMode, setOfflineMode] = useState(false)
  const [authExpired, setAuthExpired] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  async function fetchBooks() {
    try {
      setLoading(true)
      setError(null)
      const nextBooks = await listBooks()
      setBooks(nextBooks)
      setOfflineMode(false)
      setAuthExpired(false)
      const localBooks = await listOfflineBooks()
      setOfflineBookIds(new Set(localBooks.map(book => book.id)))
    } catch (e) {
      const sessionExpired = isAuthExpiredError(e)
      if (e instanceof TypeError || sessionExpired) {
        const localBooks = await listOfflineBooks()
        setBooks(localBooks)
        setOfflineBookIds(new Set(localBooks.map(book => book.id)))
        setOfflineMode(true)
        setAuthExpired(sessionExpired)
        if (localBooks.length === 0 && e instanceof TypeError) setError(e.message)
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchBooks() }, [])

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      setUploading(true)
      setError(null)
      await uploadBook(file)
      await fetchBooks()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  async function handleRename(book: Book) {
    const nextTitle = window.prompt('輸入新的書名', book.title)?.trim()
    if (!nextTitle || nextTitle === book.title) return
    try {
      setSavingBookId(book.id)
      setError(null)
      await renameBook(book.id, nextTitle)
      setBooks(current => current.map(item => (
        item.id === book.id ? { ...item, title: nextTitle } : item
      )))
      const localBook = await db.books.get(book.id)
      if (localBook) await db.books.put({ ...localBook, title: nextTitle })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingBookId(null)
    }
  }

  async function handleDelete(book: Book) {
    if (!window.confirm(`刪除「${book.title}」？`)) return
    try {
      setSavingBookId(book.id)
      setError(null)
      await deleteBook(book.id)
      await Promise.allSettled([
        removeOfflineBook(book.id),
        db.progress.delete(book.id),
        db.settings.delete(book.id),
      ])
      setOfflineBookIds(current => {
        const next = new Set(current)
        next.delete(book.id)
        return next
      })
      setBooks(current => current.filter(item => item.id !== book.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingBookId(null)
    }
  }

  async function handleDownload(book: Book) {
    try {
      setSavingBookId(book.id)
      setError(null)
      const text = await getBookContent(book.id)
      await saveBookForOffline(book, text)
      setOfflineBookIds(current => new Set(current).add(book.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingBookId(null)
    }
  }

  async function handleRemoveOffline(book: Book) {
    try {
      setSavingBookId(book.id)
      setError(null)
      await removeOfflineBook(book.id)
      setOfflineBookIds(current => {
        const next = new Set(current)
        next.delete(book.id)
        return next
      })
      if (offlineMode) setBooks(current => current.filter(item => item.id !== book.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingBookId(null)
    }
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="p-4 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">書庫</h1>
        <div className="flex items-center gap-2">
          <AppUpdateControl className="px-3 py-2 border border-neutral-700 rounded text-neutral-300 hover:bg-neutral-800 disabled:opacity-50" />
          <button
            onClick={() => setEditing(value => !value)}
            className="px-3 py-2 border border-neutral-700 rounded text-neutral-100 hover:bg-neutral-800"
          >
            {editing ? '完成' : '編輯'}
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || offlineMode}
            className="px-4 py-2 bg-cyan-500 text-neutral-950 rounded hover:bg-cyan-400 disabled:opacity-50"
          >
            {uploading ? '上傳中…' : '上傳書籍'}
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".txt"
        className="hidden"
        onChange={handleFileChange}
      />

      {error && (
        <div className="mb-4 p-3 bg-red-950 text-red-200 border border-red-800 rounded">{error}</div>
      )}
      {offlineMode && !error && (
        <div className="mb-4 flex flex-col gap-3 rounded border border-cyan-800 bg-cyan-950 p-3 text-cyan-100 sm:flex-row sm:items-center sm:justify-between">
          <span>{authExpired ? 'Session 已過期：已切換為離線模式' : '離線模式：顯示已下載書籍'}</span>
          {authExpired && (
            <button
              type="button"
              onClick={loginToReader}
              className="rounded border border-cyan-600 px-3 py-1.5 text-sm text-cyan-50 hover:bg-cyan-900"
            >
              重新登入
            </button>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-neutral-400">載入中…</p>
      ) : books.length === 0 ? (
        <div className="text-center py-16 text-neutral-400">
          <p>尚無書籍，請上傳 .txt 檔案</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {books.map(book => (
            <div
              key={book.id}
              className="p-4 border border-neutral-800 rounded-lg bg-neutral-900 transition-colors"
            >
              <button
                onClick={() => { if (!editing) navigate(`/read/${book.id}`) }}
                className="block w-full text-left"
                disabled={editing}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="font-medium">{book.title}</div>
                  <div className="text-sm text-cyan-300 shrink-0">
                    {formatProgressLabel(book)}
                  </div>
                </div>
                <div className="text-sm text-neutral-400 mt-1">
                  <span>{book.charCount.toLocaleString()} 字</span>
                  <span> · </span>
                  <span>{book.progress?.updatedAt
                    ? `上次閱讀 ${new Date(book.progress.updatedAt).toLocaleDateString('zh-TW')}`
                    : `上傳 ${new Date(book.createdAt).toLocaleDateString('zh-TW')}`
                  }</span>
                  {offlineBookIds.has(book.id) && (
                    <>
                      <span> · </span>
                      <span className="text-emerald-300">已下載離線副本</span>
                    </>
                  )}
                </div>
              </button>
              {editing && (
                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={() => handleRename(book)}
                    disabled={savingBookId === book.id}
                    className="px-3 py-1.5 rounded border border-neutral-700 text-sm hover:bg-neutral-800 disabled:opacity-50"
                  >
                    重新命名
                  </button>
                  <button
                    onClick={() => handleDelete(book)}
                    disabled={savingBookId === book.id}
                    className="px-3 py-1.5 rounded border border-red-800 text-sm text-red-200 hover:bg-red-950 disabled:opacity-50"
                  >
                    刪除
                  </button>
                  {offlineBookIds.has(book.id) ? (
                    <button
                      onClick={() => handleRemoveOffline(book)}
                      disabled={savingBookId === book.id}
                      className="px-3 py-1.5 rounded border border-neutral-700 text-sm hover:bg-neutral-800 disabled:opacity-50"
                    >
                      移除離線副本
                    </button>
                  ) : (
                    <button
                      onClick={() => handleDownload(book)}
                      disabled={savingBookId === book.id || offlineMode}
                      className="px-3 py-1.5 rounded border border-cyan-700 text-sm text-cyan-100 hover:bg-cyan-950 disabled:opacity-50"
                    >
                      下載離線副本
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      </div>
    </div>
  )
}
