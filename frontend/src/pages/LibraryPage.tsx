import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  applyWebSourceSupplements,
  createWebSource,
  deleteBook,
  fetchWebSourceChapters,
  getBookContent,
  isAuthExpiredError,
  listWebSourceProviders,
  loginToReader,
  previewWebSource,
  previewWebSourceSupplements,
  refreshWebSource,
  renameBook,
  searchWebSources,
  undoWebSourceSupplements,
  type Book,
  type Chapter,
  type WarningDetail,
  type WebSourcePreview,
  type WebSourceRefreshResult,
  type WebSourceSearchHit,
  type WebSourceSupplementAmbiguity,
  type WebSourceSupplementPreview,
  listBooks,
  uploadBook,
} from '../api.js'
import { db } from '../db.js'
import { listOfflineBooks, removeOfflineBook, saveBookForOffline, syncOfflineWorkIds } from '../offline.js'
import {
  cancelWebBookDownload,
  clearWebBookDownload,
  getSnapshot as getDownloadSnapshot,
  getDownloadState,
  startWebBookDownload,
  subscribe as subscribeDownloads,
  type WebDownloadOptions,
  type WebDownloadState,
} from '../webDownloadManager.js'
import { AppUpdateControl } from '../AppUpdateBanner.js'
import { ConfirmDialog, PromptDialog } from '../components/Dialog.js'
import { remapWebChapterPosition } from '../utils/webSourceUtils.js'
import {
  groupSupplementEntries, type CandidateGap, type GapCell, type GapRow, type SupplementEntry,
} from '../utils/supplementGaps.js'
import { WEB_SOURCE_NAMES, formatSourceLabels, formatSourceName } from '../utils/sourceLabels.js'
import { preflightAndSetPreferred } from '../sourcePreference.js'
import { rekeyWebChapterCache } from '../webChapterCacheRekey.js'

const LIBRARY_LOAD_TIMEOUT_MS = 8_000

class LibraryLoadTimeoutError extends Error {
  constructor() {
    super('網路連線逾時，已顯示離線書籍。')
    this.name = 'LibraryLoadTimeoutError'
  }
}

/** Shared works display the canonical position mapped into this edition, not its old snapshot. */
function withSharedProgress(book: Book): Book {
  const shared = book.sharedProgress
  if (!shared) return book
  if (shared.kind !== 'mapped') return { ...book, progress: null }
  return {
    ...book,
    progress: {
      positionType: shared.positionType,
      positionValue: shared.positionValue,
      ...(shared.chapterProgress === null ? {} : { chapterProgress: shared.chapterProgress }),
      ...(shared.chapterOffset === null || shared.chapterOffset === undefined ? {} : { chapterOffset: shared.chapterOffset }),
      updatedAt: shared.updatedAt ?? '',
    },
  }
}

function formatProgressLabel(book: Book): string {
  if (book.sharedProgress?.kind === 'conflict') return '需選擇進度'
  if (book.sharedProgress?.kind === 'unmapped') return '需選擇章節'
  const progress = book.progress
  if (!progress) return '未開始'
  if (progress.positionType === 'chapter_index') {
    const chapters = book.chapters ?? []
    const fineLabel = progress.chapterProgress === undefined ? '' : ` · ${Math.floor(progress.chapterProgress * 100)}%`
    const chapterIndex = Math.max(0, Math.floor(progress.positionValue))
    if (chapters.length > 0) {
      const chapterNumber = Math.min(chapterIndex, chapters.length - 1) + 1
      return `第 ${chapterNumber.toLocaleString('zh-TW')} 章${fineLabel} / 共 ${chapters.length.toLocaleString('zh-TW')} 章`
    }
    return `第 ${chapterIndex + 1} 章${fineLabel}`
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

// URL-ish: an explicit scheme, or a dotted host plus a path and no whitespace.
function looksLikeWebSourceUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  if (/^https?:\/\//i.test(trimmed)) return true
  return !/\s/.test(trimmed) && trimmed.includes('.') && trimmed.includes('/')
}

function normalizeWebSourceUrl(value: string): string {
  const trimmed = value.trim()
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** A card per work (the server decides membership); a book outside any work is its own card. */
const cardKeyOf = (book: Book) => book.workId ?? book.id

function groupBooksByWork(books: Book[]): Book[][] {
  const groups = new Map<string, Book[]>()
  for (const book of books) {
    const key = cardKeyOf(book)
    const group = groups.get(key)
    if (group) group.push(book)
    else groups.set(key, [book])
  }
  // The persisted preferred edition represents the work, not the most recently read one.
  return [...groups.values()].map(group => {
    const preferredId = group.find(book => book.preferredBookId)?.preferredBookId
    const preferred = group.find(book => book.id === preferredId)
    return preferred ? [preferred, ...group.filter(book => book !== preferred)] : group
  })
}

function hasWebSibling(book: Book, books: Book[]): boolean {
  if (book.sourceType !== 'web' || !book.workId) return false
  return books.some(other => other.id !== book.id && other.sourceType === 'web' && other.workId === book.workId)
}

const SUPPLEMENT_AMBIGUITY_REASONS: Record<string, string> = {
  renamed_or_variant: '本書此處的章節名稱不同，無法確認是否同一章',
  unbracketed: '位於本書目錄頭尾之外，無法確定插入位置',
  name_elsewhere: '本書其他位置已有同名章節，可能只是順序不同',
  mixed_with_supplement: '此處已有先前補入的章節',
  conflicting_donors: '多個來源在此處提供不同章節',
  pending_supplement: '已有尚未放入目錄的補章紀錄',
  no_name: '只有章號沒有章名，無法確認是否與本書其他章節重複',
}

type SupplementPanelState = {
  book: Book
  preview: WebSourceSupplementPreview
  selected: Set<string>
  manualPlacements?: Record<string, number>
  clearedManualPlacements?: boolean
  /** Opened automatically right after a same-title book was added. */
  autoOffered?: boolean
}

type AppliedSupplementBatch = {
  bookId: string
  batchId: string
  count: number
  /** Up to three 「《章名》→ 插在《某章》之後」 lines. */
  lines: string[]
}

const SUPPLEMENT_SUMMARY_LIMIT = 3

function getProgressChapterIndex(book: Book): number | null {
  if (!book.progress || !book.chapters?.length) return null
  if (book.progress.positionType !== 'chapter_index') return null
  const position = Math.min(
    Math.max(0, Math.floor(book.progress.positionValue)),
    book.chapters.length - 1,
  )
  return book.chapters[position].index
}

function WarningItems({ warnings, details }: { warnings: string[]; details?: WarningDetail[] }) {
  const detailBySummary = new Map(details?.map(detail => [detail.summary, detail]))
  return <ul className="list-disc space-y-1 pl-5">
    {warnings.map(warning => {
      const detail = detailBySummary.get(warning)
      return <li key={warning}>{detail
        ? <details><summary className="cursor-pointer">{warning}</summary>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {detail.messages.map((message, index) => <li key={`${index}:${message}`}>{message}</li>)}
            </ul>
          </details>
        : warning}</li>
    })}
  </ul>
}

export function LibraryPage() {
  const [books, setBooks] = useState<Book[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [webSourceQuery, setWebSourceQuery] = useState('')
  const [addingWebSource, setAddingWebSource] = useState(false)
  const [previewingWebSource, setPreviewingWebSource] = useState(false)
  const [webSourcePreview, setWebSourcePreview] = useState<WebSourcePreview | null>(null)
  const [webSourcePreviewUrl, setWebSourcePreviewUrl] = useState('')
  const [providerNames, setProviderNames] = useState<Record<string, string>>({})
  const [webSourceSearchResults, setWebSourceSearchResults] = useState<WebSourceSearchHit[]>([])
  const booksRef = useRef(books)
  const savedWebSourceUrls = useMemo(
    () => new Set(books.filter(book => book.sourceType === 'web').map(book => book.sourceUrl)),
    [books],
  )
  const visibleWebSourceSearchResults = webSourceSearchResults.filter(hit => !savedWebSourceUrls.has(hit.url))
  const [webSourceWarnings, setWebSourceWarnings] = useState<string[]>([])
  const [webSourceWarningDetails, setWebSourceWarningDetails] = useState<WarningDetail[]>([])
  const [searchingWebSources, setSearchingWebSources] = useState(false)
  const [savingBookId, setSavingBookId] = useState<string | null>(null)
  const [offlineBookIds, setOfflineBookIds] = useState<Set<string>>(new Set())
  const [partialWebBookIds, setPartialWebBookIds] = useState<Set<string>>(new Set())
  const [offlineMode, setOfflineMode] = useState(false)
  const [authExpired, setAuthExpired] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [renamingBook, setRenamingBook] = useState<Book | null>(null)
  // 合併到…: a rename into another work's title; the server regroups by title.
  const [mergingBook, setMergingBook] = useState<Book | null>(null)
  const [deletingBook, setDeletingBook] = useState<Book | null>(null)
  const [expandedBookGroups, setExpandedBookGroups] = useState<Set<string>>(new Set())
  const [supplementPanel, setSupplementPanel] = useState<SupplementPanelState | null>(null)
  const [lastSupplementBatch, setLastSupplementBatch] = useState<AppliedSupplementBatch | null>(null)
  // Work card (title group key) whose 補章 menu (preview + undo) is open; the menu itself performs no request.
  const [supplementMenuGroupKey, setSupplementMenuGroupKey] = useState<string | null>(null)
  const downloadStates = useSyncExternalStore(subscribeDownloads, getDownloadSnapshot, getDownloadSnapshot)
  const downloadCacheRevision = useMemo(
    () => [...downloadStates]
      .map(([bookId, state]) => `${bookId}:${state.status}`)
      .sort()
      .join('|'),
    [downloadStates],
  )
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Bumped on every preview/search submit; a resolved request whose generation
  // no longer matches the latest is a stale response and is dropped.
  const requestGenerationRef = useRef(0)
  const loadGenerationRef = useRef(0)
  const loadControllerRef = useRef<AbortController | null>(null)
  // savingBookId is state, so two clicks in one tick both see it unset; this ref
  // serializes manifest-affecting actions (refresh, supplement preview/apply/undo).
  const manifestActionRef = useRef(false)
  const navigate = useNavigate()

  useEffect(() => { booksRef.current = books }, [books])

  // Promote a finished web download into the offline-books set so the UI reflects
  // completion without requiring a manual refresh.
  useEffect(() => {
    let mutated = false
    const next = new Set(offlineBookIds)
    for (const [bookId, state] of downloadStates) {
      if (state.status === 'completed' && !next.has(bookId)) {
        next.add(bookId)
        mutated = true
      }
    }
    if (mutated) setOfflineBookIds(next)
  }, [downloadStates, offlineBookIds])

  useEffect(() => {
    let cancelled = false
    async function inspectPartialCopies() {
      const partial = new Set<string>()
      await Promise.all(books.map(async (book) => {
        if (book.sourceType !== 'web' || !offlineBookIds.has(book.id) || !book.chapters?.length) return
        const cached = await db.webChapterCache.where('bookId').equals(book.id).toArray().catch(() => [])
        const chapterByIndex = new Map(book.chapters.map(chapter => [chapter.index, chapter]))
        const compatible = new Set(cached.flatMap((row) => {
          const chapter = chapterByIndex.get(row.chapterIndex)
          if (!chapter || (chapter.sourceUrl && chapter.sourceUrl !== row.sourceUrl)) return []
          return [row.chapterIndex]
        }))
        if (book.chapters.some(chapter => !compatible.has(chapter.index))) partial.add(book.id)
      }))
      if (!cancelled) setPartialWebBookIds(partial)
    }
    void inspectPartialCopies()
    return () => { cancelled = true }
  }, [books, offlineBookIds, downloadCacheRevision])

  /** Loads the library; resolves to the online list, or null when it fell back or was superseded. */
  async function fetchBooks(): Promise<Book[] | null> {
    const generation = ++loadGenerationRef.current
    loadControllerRef.current?.abort()
    const controller = new AbortController()
    loadControllerRef.current = controller
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const isCurrent = () => loadGenerationRef.current === generation
    try {
      setLoading(true)
      setError(null)
      const nextBooks = await Promise.race([
        listBooks({ signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            controller.abort()
            reject(new LibraryLoadTimeoutError())
          }, LIBRARY_LOAD_TIMEOUT_MS)
        }),
      ])
      if (!isCurrent()) return null
      const booksWithLocalProgress = await Promise.all(nextBooks.map(withSharedProgress).map(async book => {
        const local = await db.progress.get(book.id).catch(() => undefined)
        // For a shared work only an unconfirmed write from this device can be newer than the canonical position.
        if (book.sharedProgress && local?.pendingSync !== true) return book
        return local && (!book.progress || local.updatedAt > book.progress.updatedAt)
          ? { ...book, progress: local }
          : book
      }))
      if (!isCurrent()) return null
      booksRef.current = booksWithLocalProgress
      setBooks(booksWithLocalProgress)
      setOfflineMode(false)
      setAuthExpired(false)
      const localBooks = await listOfflineBooks()
      if (!isCurrent()) return null
      setOfflineBookIds(new Set(localBooks.map(book => book.id)))
      void syncOfflineWorkIds(nextBooks.filter(book => localBooks.some(local => local.id === book.id))).catch(() => undefined)
      return booksWithLocalProgress
    } catch (e) {
      if (!isCurrent()) return null
      const errorMessage = e instanceof Error ? e.message : String(e)
      const connectionFailed = e instanceof TypeError
      const timedOut = e instanceof LibraryLoadTimeoutError
      const sessionExpired = isAuthExpiredError(e)
      if (connectionFailed || sessionExpired || timedOut) {
        const localBooks = await listOfflineBooks()
        if (!isCurrent()) return null
        booksRef.current = localBooks
        setBooks(localBooks)
        setOfflineBookIds(new Set(localBooks.map(book => book.id)))
        setOfflineMode(true)
        setAuthExpired(sessionExpired)
        if (timedOut) setError(errorMessage)
        else if (localBooks.length === 0 && connectionFailed) setError(errorMessage)
      } else {
        setError(errorMessage)
      }
      return null
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
      if (isCurrent()) setLoading(false)
    }
  }

  useEffect(() => {
    void fetchBooks()
    return () => {
      loadGenerationRef.current += 1
      loadControllerRef.current?.abort()
    }
  }, [])

  // Provider display names come from the backend; WEB_SOURCE_NAMES stays as the
  // offline/failure fallback and covers hostnames the endpoint does not list.
  useEffect(() => {
    let cancelled = false
    async function loadProviders() {
      try {
        const providers = await listWebSourceProviders()
        if (cancelled || !providers) return
        const names: Record<string, string> = {}
        for (const provider of providers) {
          if (!provider?.displayName) continue
          names[provider.providerId] = provider.displayName
          if (provider.displayHost) names[provider.displayHost.toLowerCase()] = provider.displayName
        }
        setProviderNames(names)
      } catch {
        /* keep the built-in fallback names */
      }
    }
    loadProviders()
    return () => { cancelled = true }
  }, [])

  const sourceNames = useMemo(
    () => ({ ...WEB_SOURCE_NAMES, ...providerNames }),
    [providerNames],
  )

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

  async function handleWebSourceSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const value = webSourceQuery.trim()
    if (!value) return
    if (looksLikeWebSourceUrl(value)) await runWebSourcePreview(normalizeWebSourceUrl(value))
    else await runWebSourceSearch(value)
  }

  async function runWebSourcePreview(url: string) {
    const generation = ++requestGenerationRef.current
    try {
      setPreviewingWebSource(true)
      setError(null)
      setWebSourceWarnings([])
      setWebSourceWarningDetails([])
      // Drop any preview card still showing for a previous URL/query.
      setWebSourcePreview(null)
      const preview = await previewWebSource(url)
      if (requestGenerationRef.current !== generation) return // superseded by a newer submit
      setWebSourcePreviewUrl(url)
      setWebSourcePreview(preview)
    } catch (e) {
      if (requestGenerationRef.current !== generation) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (requestGenerationRef.current === generation) setPreviewingWebSource(false)
    }
  }

  function dismissWebSourcePreview() {
    setWebSourcePreview(null)
    setWebSourcePreviewUrl('')
  }

  async function handleAddPreviewedWebSource() {
    const preview = webSourcePreview
    if (!preview) return
    try {
      setAddingWebSource(true)
      setError(null)
      setWebSourceWarnings([])
      setWebSourceWarningDetails([])
      const book = await createWebSource(webSourcePreviewUrl, preview.previewToken)
      logWebSourceDiagnostics('create', {
        bookId: book.id,
        chapterCount: book.chapters?.length ?? 0,
        debugMessages: book.debugMessages ?? [],
      })
      setWebSourceWarnings(book.warnings ?? [])
      setWebSourceWarningDetails(book.warningDetails ?? [])
      setWebSourceQuery('')
      setWebSourceSearchResults([])
      dismissWebSourcePreview()
      const library = await fetchBooks()
      if (library) await offerSupplementsAfterAdd(book.id, library)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setAddingWebSource(false)
    }
  }

  /**
   * Only preview missing chapters on the work's 補章 target. Other editions
   * remain donors; this never applies a supplement without confirmation.
   */
  async function offerSupplementsAfterAdd(newBookId: string, library: Book[]) {
    const added = library.find(item => item.id === newBookId)
    if (!added || !hasWebSibling(added, library) || manifestActionRef.current) return
    const target = library.find(other => other.sourceType === 'web' && other.workId === added.workId && other.id === added.supplementBookId)
    if (!target) return
    manifestActionRef.current = true
    try {
      const preview = await previewWebSourceSupplements(target.id)
      // A user may have switched sources while the network preview was pending.
      const current = booksRef.current.find(item => item.id === added.id)
      if (current?.supplementBookId !== target.id) return
      if (preview.candidates.length > 0) {
        setSupplementPanel({ book: target, preview, selected: new Set(preview.candidates.map(candidate => candidate.id)), autoOffered: true })
      } else if (preview.ambiguous.length > 0) {
        setSupplementPanel({ book: target, preview, selected: new Set(), autoOffered: true })
      }
    } catch (e) {
      // An optional prompt: the manual 「補章」 menu still works.
      console.debug('[Raph Reader] supplement auto-preview failed', e)
    } finally {
      manifestActionRef.current = false
    }
  }

  async function runWebSourceSearch(title: string) {
    const generation = ++requestGenerationRef.current
    // A search is also a new submit: drop a preview card left from a previous URL.
    setWebSourceWarnings([])
    setWebSourceWarningDetails([])
    dismissWebSourcePreview()
    try {
      setSearchingWebSources(true)
      setError(null)
      const result = await searchWebSources(title)
      if (requestGenerationRef.current !== generation) return // superseded by a newer submit
      const savedUrls = new Set(booksRef.current.filter(book => book.sourceType === 'web').map(book => book.sourceUrl))
      const available = result.candidates.filter(candidate => !savedUrls.has(candidate.url))
      setWebSourceSearchResults(available)
      if (available.length === 0) {
        setError(result.candidates.length > 0
          ? '搜尋結果都已加入書庫'
          : result.errors.length > 0
            ? '目前支援的線上書源搜尋失敗，請改貼章節列表 URL'
            : '找不到線上書，請改貼章節列表 URL')
      }
    } catch (e) {
      if (requestGenerationRef.current !== generation) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (requestGenerationRef.current === generation) setSearchingWebSources(false)
    }
  }

  async function handlePreviewWebSourceFromSearch(result: WebSourceSearchHit) {
    setWebSourceQuery(result.url)
    await runWebSourcePreview(result.url)
  }

  async function performRename(book: Book, nextTitle: string) {
    setRenamingBook(null)
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
      // The server regroups works by normalized title; reload its membership/preference.
      await fetchBooks()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingBookId(null)
    }
  }

  async function performDelete(book: Book) {
    setDeletingBook(null)
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

  /** 設為預設書源: persists only after the target is proven readable; failures change nothing. */
  async function handleSetPreferred(target: Book) {
    if (!target.workId || !target.preferredBookId || savingBookId) return
    try {
      setSavingBookId(target.id)
      setError(null)
      const result = await preflightAndSetPreferred({ workId: target.workId, preferredBookId: target.preferredBookId }, target.id)
      setSupplementPanel(null)
      const preference = { preferredBookId: result.preferredBookId, supplementBookId: result.supplementBookId }
      booksRef.current = booksRef.current.map(item => (
        item.workId === result.workId ? { ...item, ...preference } : item
      ))
      setBooks(current => current.map(item => (
        item.workId === result.workId ? { ...item, ...preference } : item
      )))
    } catch (e) {
      if (e instanceof Error && e.name === 'SharedProgressStaleError') {
        setError('預設書源已在其他裝置變更，已重新載入書庫')
        await fetchBooks()
        return
      }
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingBookId(null)
    }
  }

  /** Runs one manifest-affecting action at a time; a call while one is in flight is dropped. */
  async function runManifestAction(bookId: string, action: () => Promise<void>) {
    if (manifestActionRef.current) return
    manifestActionRef.current = true
    try {
      setSavingBookId(bookId)
      setError(null)
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      manifestActionRef.current = false
      setSavingBookId(null)
    }
  }

  function handleRefreshWebSource(book: Book) {
    return runManifestAction(book.id, async () => {
      setWebSourceWarnings([])
      setWebSourceWarningDetails([])
      const result = await refreshWebSource(book.id)
      await syncManifestChange(book, result, 'refresh')
      // A refresh can retire the just-applied batch; the card button carries the server's latest batch.
      setLastSupplementBatch(current => (current?.bookId === book.id ? null : current))
    })
  }

  /**
   * Applies a server-side manifest change (refresh, supplement apply/undo) to the
   * card list and to the local Dexie copy, remapping local progress by chapter key
   * and moving offline chapter text to its sourceUrl's new index (M-008).
   */
  async function syncManifestChange(
    book: Book,
    result: WebSourceRefreshResult,
    action: 'refresh' | 'supplement' | 'supplement-undo',
  ): Promise<boolean> {
    logWebSourceDiagnostics(action, {
      bookId: book.id,
      previousChapterCount: result.previousChapterCount,
      newChapterCount: result.newChapterCount,
      debugMessages: result.debugMessages ?? result.book.debugMessages ?? [],
    })
    let displayedProgress = result.book.progress
      ?? (
        book.progress?.positionType === 'chapter_index' && result.progressRemap
          ? { ...book.progress, positionValue: result.progressRemap.newPosition,
            ...(result.progressRemap.matchedBy === 'position' ? { chapterOffset: undefined, chapterProgress: undefined } : {}) }
          : book.progress
      )
    let localSyncError: unknown = null

    try {
      await db.transaction('rw', db.progress, db.books, db.webChapterCache, async () => {
        const localProgress = await db.progress.get(book.id)
        if (
          localProgress?.positionType === 'chapter_index'
          && book.chapters
          && result.book.chapters
        ) {
          const remap = remapWebChapterPosition(
            book.chapters,
            result.book.chapters,
            localProgress.positionValue,
          )
          const nextProgress = {
            ...localProgress,
            positionValue: remap.position,
            ...(remap.matchedBy === 'position' ? { chapterOffset: undefined, chapterProgress: undefined } : {}),
            // A shared member's row may only stay a pending candidate when the same
            // chapter was found by key/URL; an ordinal guess must never compete
            // with (and override) the canonical shared position.
            ...(book.workId && remap.matchedBy === 'position' ? { pendingSync: false } : {}),
          }
          await db.progress.put(nextProgress)
          displayedProgress = {
            positionType: nextProgress.positionType,
            positionValue: nextProgress.positionValue,
            chapterOffset: nextProgress.chapterOffset,
            chapterProgress: nextProgress.chapterProgress,
            pageIndex: nextProgress.pageIndex,
            updatedAt: nextProgress.updatedAt,
          }
        }

        const localBook = await db.books.get(book.id)
        if (localBook) {
          await db.books.put({
            ...localBook,
            title: result.book.title,
            charCount: result.book.charCount,
            fileSize: result.book.fileSize,
            paragraphCount: result.book.paragraphCount,
            chapters: result.book.chapters,
            createdAt: result.book.createdAt,
            updatedAt: result.book.updatedAt,
            sourceType: result.book.sourceType,
            sourceUrl: result.book.sourceUrl,
            manifestVersion: result.book.manifestVersion,
            contentVersion: result.book.updatedAt ?? result.book.createdAt,
          })
        }
        if (result.book.chapters) await rekeyWebChapterCache(book.id, result.book.chapters)
      })
    } catch (localError) {
      localSyncError = localError
    }

    setBooks(current => current.map(item => (
      item.id === book.id
        ? { ...result.book, progress: displayedProgress }
        : item
    )))
    // A shared work's canonical position was remapped server-side with the manifest.
    if (book.workId) void fetchBooks()
    setWebSourceWarnings(result.warnings ?? result.book.warnings ?? [])
    setWebSourceWarningDetails(result.warningDetails ?? result.book.warningDetails ?? [])
    if (localSyncError) {
      setError('章節目錄已更新，但本機離線資料同步失敗；重新開啟書庫後會再載入線上版本。')
    }
    return localSyncError === null
  }

  /** A running download writes its start-time table of contents back when it finishes. */
  function blockedByRunningDownload(book: Book, action: string): boolean {
    if (getDownloadState(book.id)?.status !== 'running') return false
    setError(`離線下載進行中，請等下載完成或取消後再${action}`)
    return true
  }

  function handleOpenSupplements(book: Book) {
    if (book.workId && book.supplementBookId !== book.id) return
    setSupplementMenuGroupKey(null)
    return runManifestAction(book.id, async () => {
      const preview = await previewWebSourceSupplements(book.id)
      setSupplementPanel({ book, preview, selected: new Set(preview.candidates.map(candidate => candidate.id)) })
    })
  }

  function handleApplySupplements() {
    const panel = supplementPanel
    if (!panel || (panel.selected.size === 0 && !Object.keys(panel.manualPlacements ?? {}).length)) return
    const book = panel.book
    const chosen = panel.preview.candidates.filter(candidate => panel.selected.has(candidate.id))
    const manualPlacements = Object.entries(panel.manualPlacements ?? {}).map(([id, insertAfterIndex]) => ({ id, insertAfterIndex }))
    if (blockedByRunningDownload(book, '補章')) return
    const hadOfflineCopy = offlineBookIds.has(book.id)
    return runManifestAction(book.id, async () => {
      setWebSourceWarnings([])
      setWebSourceWarningDetails([])
      let result: Awaited<ReturnType<typeof applyWebSourceSupplements>>
      try {
        result = manualPlacements.length
          ? await applyWebSourceSupplements(book.id, panel.preview.previewToken, chosen.map(candidate => candidate.id), manualPlacements)
          : await applyWebSourceSupplements(book.id, panel.preview.previewToken, chosen.map(candidate => candidate.id))
      } catch (e) {
        if (!(e instanceof Error && e.name === 'SupplementPreviewStaleError')) throw e
        setError(`${e.message}；已重新載入補章預覽，請再確認一次。`)
        await reloadSupplementPreview(panel)
        return
      }
      // On any other failure the panel (and the selection) stays open for a retry.
      setSupplementPanel(null)
      const synced = await syncManifestChange(book, result, 'supplement')
      // The rekeyed offline copy lacks only the inserted chapters: fetch them now.
      if (synced && hadOfflineCopy && !offlineMode) void handleDownload(result.book, { missingOnly: true })
      setLastSupplementBatch({
        bookId: book.id,
        batchId: result.batchId,
        count: result.changedCount,
        lines: [
          ...chosen.map(candidate => `《${candidate.title}》→ ${candidate.atEnd ? '補在書末，接在' : '插在'}《${candidate.insertAfterTitle}》之後`),
          ...manualPlacements.map(placement => {
            const title = panel.preview.ambiguous.flatMap(item => item.manualChapters ?? []).find(item => item.id === placement.id)?.title ?? ''
            return placement.insertAfterIndex === -1
              ? `《${title}》→ 依你的選擇放在書首`
              : `《${title}》→ 依你的選擇插在《${book.chapters?.[placement.insertAfterIndex]?.title ?? ''}》之後`
          }),
        ].slice(0, SUPPLEMENT_SUMMARY_LIMIT),
      })
    })
  }

  /** Re-runs a stale preview against current library chapters, clearing old index choices. */
  async function reloadSupplementPreview(panel: SupplementPanelState) {
    try {
      const library = await fetchBooks()
      const book = library?.find(item => item.id === panel.book.id)
      if (!book?.chapters) throw new Error('無法載入最新章節目錄，請重新開啟書庫後再預覽補章')
      if (book.workId && book.supplementBookId !== book.id) {
        throw new Error('預設書源已變更；原書源的補章預覽已關閉，請到目前預設書源重新預覽')
      }
      const preview = await previewWebSourceSupplements(panel.book.id)
      if (book.manifestVersion !== preview.manifestVersion) {
        throw new Error('章節目錄又有變更，請重新開啟書庫後再預覽補章')
      }
      setSupplementPanel({
        book,
        preview,
        selected: new Set(preview.candidates.filter(candidate => panel.selected.has(candidate.id)).map(candidate => candidate.id)),
        manualPlacements: {},
        clearedManualPlacements: Object.keys(panel.manualPlacements ?? {}).length > 0,
      })
      setError('預覽已過期，請重新載入；已載入最新章節目錄，請重新確認補章。')
    } catch (e) {
      setSupplementPanel(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function handleUndoSupplements(book: Book, batchId: string) {
    if (blockedByRunningDownload(book, '撤銷補章')) return
    return runManifestAction(book.id, async () => {
      setWebSourceWarnings([])
      setWebSourceWarningDetails([])
      const result = await undoWebSourceSupplements(book.id, batchId)
      await syncManifestChange(book, result, 'supplement-undo')
      setLastSupplementBatch(current => (current?.bookId === book.id ? null : current))
    })
  }

  async function handleDownload(book: Book, options?: WebDownloadOptions) {
    if (book.sourceType === 'web') {
      // Fire-and-forget: the manager owns lifecycle so the user can navigate
      // away or open the book to read while remaining chapters download.
      setError(null)
      void startWebBookDownload(book, (chapterIndex) => (
        fetchWebSourceChapters(book.id, {
          center: chapterIndex,
          before: 0,
          after: 7,
          ...(options?.refreshExisting ? { refresh: true } : {}),
        })
      ), options)
      return
    }
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
      <div className="flex flex-wrap items-center justify-between gap-y-2 mb-6">
        <h1 className="text-2xl font-bold">書庫</h1>
        <div className="flex flex-wrap items-center gap-2">
          <AppUpdateControl className="min-h-11 px-3 py-2 border border-neutral-700 rounded text-neutral-300 hover:bg-neutral-800 disabled:opacity-50" />
          <button
            onClick={() => setEditing(value => !value)}
            className="min-h-11 px-3 py-2 border border-neutral-700 rounded text-neutral-100 hover:bg-neutral-800"
          >
            {editing ? '完成' : '編輯'}
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || offlineMode}
            className="min-h-11 px-4 py-2 bg-cyan-500 text-neutral-950 rounded hover:bg-cyan-400 disabled:opacity-50"
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

      <form onSubmit={handleWebSourceSubmit} className="mb-4 flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor="web-source-entry">貼上章節列表 URL，或輸入書名搜尋</label>
        <input
          id="web-source-entry"
          value={webSourceQuery}
          onChange={(event) => {
            const next = event.target.value
            setWebSourceQuery(next)
            // A card that no longer matches the box would add a URL the user cannot see.
            if (webSourcePreview && normalizeWebSourceUrl(next) !== webSourcePreviewUrl) {
              dismissWebSourcePreview()
            }
          }}
          disabled={offlineMode || addingWebSource}
          placeholder="貼上章節列表 URL，或輸入書名搜尋"
          className="min-h-11 min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100 placeholder:text-neutral-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={
            offlineMode
            || addingWebSource
            || previewingWebSource
            || searchingWebSources
            || webSourceQuery.trim().length === 0
          }
          className="min-h-11 rounded bg-emerald-500 px-4 py-2 text-neutral-950 hover:bg-emerald-400 disabled:opacity-50"
        >
          {previewingWebSource ? '預覽中…'
            : searchingWebSources ? '搜尋中…'
            : looksLikeWebSourceUrl(webSourceQuery) ? '預覽線上書'
            : '搜尋線上書'}
        </button>
      </form>

      {webSourcePreview && (
        <div
          data-testid="web-source-preview"
          role="region"
          aria-live="polite"
          aria-label="線上書預覽"
          className="mb-4 rounded border border-emerald-800 bg-neutral-900 p-3"
        >
          <p className="text-base font-medium text-neutral-100">{webSourcePreview.title}</p>
          <p className="mt-1 text-sm text-neutral-400">
            來源：{webSourcePreview.displayName} · 共 {webSourcePreview.chapterCount.toLocaleString('zh-TW')} 章
          </p>
          <div className="mt-2 grid gap-1 text-sm text-neutral-300">
            {webSourcePreview.firstChapters?.[0] && (
              <span>首章：{webSourcePreview.firstChapters[0].title}</span>
            )}
            {webSourcePreview.lastChapters?.length ? (
              <span>末章：{webSourcePreview.lastChapters[webSourcePreview.lastChapters.length - 1].title}</span>
            ) : null}
          </div>
          {(webSourcePreview.warnings ?? []).length > 0 && (
            <div className="mt-2 text-sm text-amber-200">
              <WarningItems warnings={webSourcePreview.warnings} details={webSourcePreview.warningDetails} />
            </div>
          )}
          {!!webSourcePreview.debugMessages?.length && (
            <details className="mt-2 text-sm text-cyan-200">
              <summary className="cursor-pointer">解析診斷紀錄（{webSourcePreview.debugMessages.length} 筆，加入前請核對原始章名及網址）</summary>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {webSourcePreview.debugMessages.map((message, index) => <li key={`${index}:${message}`}>{message}</li>)}
              </ul>
            </details>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleAddPreviewedWebSource}
              disabled={addingWebSource || offlineMode}
              className="min-h-11 rounded bg-emerald-500 px-4 py-2 text-neutral-950 hover:bg-emerald-400 disabled:opacity-50"
            >
              {addingWebSource ? '加入中…' : '加入書庫'}
            </button>
            <button
              type="button"
              onClick={dismissWebSourcePreview}
              disabled={addingWebSource}
              className="min-h-11 rounded border border-neutral-700 px-4 py-2 text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {visibleWebSourceSearchResults.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm text-neutral-400" aria-live="polite">
              搜尋結果 {visibleWebSourceSearchResults.length.toLocaleString('zh-TW')} 筆
            </span>
            <button
              type="button"
              onClick={() => setWebSourceSearchResults([])}
              className="min-h-11 rounded border border-neutral-700 px-3 text-sm text-neutral-300 hover:bg-neutral-800"
            >
              清除
            </button>
          </div>
          <div className="grid max-h-[50vh] gap-2 overflow-y-auto">
            {visibleWebSourceSearchResults.map((result) => (
              <button
                key={`${result.providerId}:${result.url}`}
                type="button"
                onClick={() => handlePreviewWebSourceFromSearch(result)}
                disabled={addingWebSource || previewingWebSource}
                className="flex min-h-11 w-full items-center justify-between gap-3 rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-left hover:bg-neutral-800 disabled:opacity-50"
              >
                <span className="min-w-0 truncate font-medium text-neutral-100">{result.title}</span>
                <span className="shrink-0 text-sm text-neutral-400">
                  {formatSourceName(result.url, result.providerId, sourceNames)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 p-3 bg-red-950 text-red-200 border border-red-800 rounded">
          <span>{error}</span>
          {offlineMode && !authExpired && (
            <button type="button" onClick={() => void fetchBooks()} className="rounded border border-red-600 px-3 py-2 text-sm hover:bg-red-900">
              重試連線
            </button>
          )}
        </div>
      )}
      {webSourceWarnings.length > 0 && (
        <div role="alert" className="mb-4 rounded border border-amber-700 bg-amber-950 p-3 text-amber-100">
          <p className="mb-1 font-medium">線上書來源警告</p>
          <WarningItems warnings={webSourceWarnings} details={webSourceWarningDetails} />
        </div>
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
          <p>尚無書籍，請上傳 .txt 檔案或加入線上書</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {groupBooksByWork(books).map(bookGroup => {
            const book = bookGroup[0]
            const groupKey = cardKeyOf(book)
            const groupExpanded = expandedBookGroups.has(groupKey)
            const downloadState = downloadStates.get(book.id)
            // While a supplement preview is open, other manifest changes would make it stale.
            // Grouped cards show one representative book; a panel or notice for any
            // member of the group belongs on that card.
            const inThisCard = (bookId: string | undefined) => bookGroup.some(member => member.id === bookId)
            const sourceLabels = formatSourceLabels(bookGroup.filter(member => member.sourceType === 'web'), sourceNames)
            const preferredId = book.workId ? book.preferredBookId : undefined
            const supplementPanelOpen = inThisCard(supplementPanel?.book.id)
            const multiSource = bookGroup.length > 1
            const sourceLabel = (member: Book) => (member.sourceType === 'web'
              ? sourceLabels[member.id] ?? formatSourceName(member.sourceUrl, member.providerId, sourceNames)
              : '上傳書籍')
            // 補章 only ever targets the work's 補章 web edition; every other web source is a donor.
            const supplementTarget = bookGroup.find(member => (
              member.sourceType === 'web' && (!member.workId || member.supplementBookId === member.id)
            ))
            const canPreviewSupplements = !!supplementTarget
              && bookGroup.some(member => member.id !== supplementTarget.id && member.sourceType === 'web')
            const undoableMembers = bookGroup.filter(member => (
              member.sourceType === 'web' && (member.supplementBatchCount ?? 0) > 0 && !!member.latestSupplementBatch
            ))
            const showSupplementMenu = canPreviewSupplements || undoableMembers.length > 0
            const supplementButton = (
              <button
                type="button"
                aria-expanded={supplementMenuGroupKey === groupKey}
                aria-controls={`supplement-menu-${book.id}`}
                onClick={() => setSupplementMenuGroupKey(current => (current === groupKey ? null : groupKey))}
                className="inline-flex min-h-11 items-center justify-center rounded border border-emerald-700 px-3 py-1.5 text-sm text-emerald-100 hover:bg-emerald-950 disabled:opacity-50 sm:min-h-9"
              >
                補章
              </button>
            )
            const sourceActions = (b: Book) => {
              const download = downloadStates.get(b.id)
              const progressIndex = getProgressChapterIndex(b)
              return (
                <>
                  <button
                    onClick={() => setRenamingBook(b)}
                    disabled={savingBookId === b.id}
                    className="inline-flex min-h-11 items-center justify-center rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:opacity-50 sm:min-h-9"
                  >
                    重新命名
                  </button>
                  {groupBooksByWork(books).length > 1 && (
                    <button
                      onClick={() => setMergingBook(b)}
                      disabled={savingBookId === b.id}
                      className="inline-flex min-h-11 items-center justify-center rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:opacity-50 sm:min-h-9"
                    >
                      合併到…
                    </button>
                  )}
                  <button
                    onClick={() => setDeletingBook(b)}
                    disabled={savingBookId === b.id}
                    className="inline-flex min-h-11 items-center justify-center rounded border border-red-800 px-3 py-1.5 text-sm text-red-200 hover:bg-red-950 disabled:opacity-50 sm:min-h-9"
                  >
                    刪除
                  </button>
                  {b.sourceType === 'web' && (
                    <button
                      onClick={() => handleRefreshWebSource(b)}
                      disabled={savingBookId === b.id || supplementPanelOpen || offlineMode || download?.status === 'running'}
                      className="inline-flex min-h-11 items-center justify-center rounded border border-emerald-700 px-3 py-1.5 text-sm text-emerald-100 hover:bg-emerald-950 disabled:opacity-50 sm:min-h-9"
                    >
                      {savingBookId === b.id ? '整理中…' : '重新整理章節目錄'}
                    </button>
                  )}
                  {download?.status === 'running' ? (
                    <button
                      onClick={() => cancelWebBookDownload(b.id)}
                      className="inline-flex min-h-11 items-center justify-center rounded border border-amber-700 px-3 py-1.5 text-sm text-amber-100 hover:bg-amber-950 sm:min-h-9"
                    >
                      取消下載
                    </button>
                  ) : offlineBookIds.has(b.id) ? (
                    <>
                      <button
                        onClick={() => handleRemoveOffline(b)}
                        disabled={savingBookId === b.id}
                        className="inline-flex min-h-11 items-center justify-center rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:opacity-50 sm:min-h-9"
                      >
                        移除離線副本
                      </button>
                      {b.sourceType === 'web' && partialWebBookIds.has(b.id) && (
                        <button
                          onClick={() => handleDownload(b, { missingOnly: true })}
                          disabled={savingBookId === b.id || offlineMode}
                          className="inline-flex min-h-11 items-center justify-center rounded border border-cyan-700 px-3 py-1.5 text-sm text-cyan-100 hover:bg-cyan-950 disabled:opacity-50 sm:min-h-9"
                        >補足整本離線</button>
                      )}
                    </>
                  ) : (
                    <button
                      onClick={() => handleDownload(b)}
                      disabled={savingBookId === b.id || offlineMode}
                      className="inline-flex min-h-11 items-center justify-center rounded border border-cyan-700 px-3 py-1.5 text-sm text-cyan-100 hover:bg-cyan-950 disabled:opacity-50 sm:min-h-9"
                    >
                      {b.sourceType === 'web' ? '下載全部' : '下載離線副本'}
                    </button>
                  )}
                  {download?.status !== 'running'
                    && b.sourceType === 'web'
                    && progressIndex !== null && (
                    <button
                      onClick={() => handleDownload(b, {
                        startChapterIndex: progressIndex,
                        refreshExisting: offlineBookIds.has(b.id),
                      })}
                      disabled={savingBookId === b.id || offlineMode}
                      className="inline-flex min-h-11 items-center justify-center rounded border border-cyan-700 px-3 py-1.5 text-sm text-cyan-100 hover:bg-cyan-950 disabled:opacity-50 sm:min-h-9"
                    >
                      {offlineBookIds.has(b.id)
                        ? '從目前章節起重新下載'
                        : '下載後續'}
                    </button>
                  )}
                </>
              )
            }
            return (
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
                  <div className="font-medium">{book.title.trim()}</div>
                  <div className="text-sm text-cyan-300 shrink-0">
                    {formatProgressLabel(book)}
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-neutral-400">
                  {book.sourceType === 'web' && (
                    <span className="text-emerald-300">{sourceLabels[book.id] ?? formatSourceName(book.sourceUrl, book.providerId, sourceNames)}</span>
                  )}
                  <span>{book.progress?.updatedAt
                    ? `上次閱讀 ${new Date(book.progress.updatedAt).toLocaleDateString('zh-TW')}`
                    : `上傳 ${new Date(book.createdAt).toLocaleDateString('zh-TW')}`
                  }</span>
                  {offlineBookIds.has(book.id) && (
                    <span className="text-emerald-300">已下載</span>
                  )}
                </div>
              </button>
              {!editing && bookGroup.length > 1 && (
                <>
                  <button
                    type="button"
                    aria-expanded={groupExpanded}
                    aria-controls={`book-sources-${book.id}`}
                    onClick={() => setExpandedBookGroups(current => {
                      const next = new Set(current)
                      if (next.has(groupKey)) next.delete(groupKey)
                      else next.add(groupKey)
                      return next
                    })}
                    className="mt-3 rounded-full border border-neutral-700 px-3 py-1 text-sm text-neutral-300 hover:bg-neutral-800"
                  >
                    {bookGroup.length} 個書源
                  </button>
                  {groupExpanded && (
                    <div id={`book-sources-${book.id}`} className="mt-2 grid gap-2 border-t border-neutral-800 pt-2">
                      {bookGroup.map((sourceBook, index) => (
                        <div key={sourceBook.id} data-source-id={sourceBook.id} className="flex items-center gap-2">
                          {/* A row click reads this source once; it never changes the preference. */}
                          <button
                            type="button"
                            onClick={() => navigate(`/read/${sourceBook.id}`)}
                            className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded px-3 py-2 text-left hover:bg-neutral-800"
                          >
                            <span className="text-sm text-neutral-100">
                              {sourceBook.sourceType === 'web' ? sourceLabels[sourceBook.id] : '上傳書籍'}
                              {preferredId
                                ? sourceBook.id === preferredId && <span className="ml-2 text-xs text-cyan-300">預設書源</span>
                                : index === 0 && <span className="ml-2 text-xs text-cyan-300">預設</span>}
                            </span>
                            <span className="text-xs text-neutral-400">
                              {formatProgressLabel(sourceBook)}
                              {offlineBookIds.has(sourceBook.id) ? ' · 已下載' : ''}
                            </span>
                          </button>
                          {preferredId && sourceBook.workId === book.workId && sourceBook.id !== preferredId && (
                            <button
                              type="button"
                              onClick={() => void handleSetPreferred(sourceBook)}
                              disabled={savingBookId !== null || offlineMode}
                              className="min-h-11 shrink-0 rounded border border-cyan-700 px-2 py-1 text-xs text-cyan-100 hover:bg-cyan-950 disabled:opacity-50 sm:min-h-9"
                            >
                              設為預設書源
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
              {editing && !multiSource && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {sourceActions(book)}
                  {showSupplementMenu && supplementButton}
                </div>
              )}
              {editing && multiSource && showSupplementMenu && (
                <div className="mt-3 flex flex-wrap items-center gap-2">{supplementButton}</div>
              )}
              {editing && supplementMenuGroupKey === groupKey && (
                <div
                  id={`supplement-menu-${book.id}`}
                  role="group"
                  aria-label="補章選項"
                  className="mt-2 flex flex-wrap gap-2 rounded border border-emerald-900 bg-neutral-950 p-2"
                >
                  {canPreviewSupplements && supplementTarget && (
                    <>
                      {multiSource && (
                        <p className="w-full text-xs text-neutral-400">
                          {`只補入預設書源「${sourceLabel(supplementTarget)}」；其他書源只當補源，不會被改動。`}
                        </p>
                      )}
                      <button
                        type="button"
                        onClick={() => handleOpenSupplements(supplementTarget)}
                        disabled={savingBookId === supplementTarget.id || offlineMode || downloadStates.get(supplementTarget.id)?.status === 'running'}
                        className="inline-flex min-h-11 items-center justify-center rounded border border-emerald-700 px-3 py-1.5 text-sm text-emerald-100 hover:bg-emerald-950 disabled:opacity-50 sm:min-h-9"
                      >
                        預覽可補入章節
                      </button>
                    </>
                  )}
                  {undoableMembers.map(member => (
                    <button
                      key={member.id}
                      type="button"
                      onClick={() => handleUndoSupplements(member, member.latestSupplementBatch!.batchId)}
                      disabled={savingBookId === member.id || supplementPanelOpen || offlineMode || downloadStates.get(member.id)?.status === 'running'}
                      className="inline-flex min-h-11 items-center justify-center rounded border border-amber-700 px-3 py-1.5 text-sm text-amber-100 hover:bg-amber-950 disabled:opacity-50 sm:min-h-9"
                    >
                      {/* Another source's old batch must not read as the default's. */}
                      {multiSource && member.id !== supplementTarget?.id
                        ? `撤銷「${sourceLabel(member)}」上次補章（${member.latestSupplementBatch!.count.toLocaleString('zh-TW')} 章）`
                        : `撤銷上次補章（${member.latestSupplementBatch!.count.toLocaleString('zh-TW')} 章）`}
                    </button>
                  ))}
                </div>
              )}
              {editing && multiSource && (
                <div className="mt-3 grid gap-3 border-t border-neutral-800 pt-3">
                  {bookGroup.map((sourceBook, index) => {
                    const sourceDownload = downloadStates.get(sourceBook.id)
                    return (
                      <div key={sourceBook.id} role="group" aria-label={`書源：${sourceLabel(sourceBook)}`} data-source-id={sourceBook.id}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm text-neutral-100">
                            {sourceLabel(sourceBook)}
                            {preferredId
                              ? sourceBook.id === preferredId && <span className="ml-2 text-xs text-cyan-300">預設書源</span>
                              : index === 0 && <span className="ml-2 text-xs text-cyan-300">預設</span>}
                            <span className="ml-2 text-xs text-neutral-400">
                              {formatProgressLabel(sourceBook)}
                              {offlineBookIds.has(sourceBook.id) ? ' · 已下載' : ''}
                            </span>
                          </span>
                          {preferredId && sourceBook.workId === book.workId && sourceBook.id !== preferredId && (
                            <button
                              type="button"
                              onClick={() => void handleSetPreferred(sourceBook)}
                              disabled={savingBookId !== null || offlineMode}
                              className="min-h-11 shrink-0 rounded border border-cyan-700 px-2 py-1 text-xs text-cyan-100 hover:bg-cyan-950 disabled:opacity-50 sm:min-h-9"
                            >
                              設為預設書源
                            </button>
                          )}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">{sourceActions(sourceBook)}</div>
                        {sourceDownload && (
                          <WebDownloadProgress
                            state={sourceDownload}
                            onDismiss={() => clearWebBookDownload(sourceBook.id)}
                            onRetry={() => handleDownload(sourceBook, {
                              startChapterIndex: sourceDownload.startChapterIndex,
                              refreshExisting: sourceDownload.refreshExisting,
                              missingOnly: sourceDownload.missingOnly,
                            })}
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
              {supplementPanel && supplementPanelOpen && (
                <SupplementPreviewPanel
                  state={supplementPanel}
                  targetLabel={`${supplementPanel.book.title.trim()}（${formatSourceName(
                    supplementPanel.book.sourceUrl, supplementPanel.book.providerId, sourceNames,
                  )}）`}
                  donorChapters={new Map(books.map(member => [member.id, member.chapters]))}
                  busy={savingBookId === book.id}
                  onSetSelection={(ids) => setSupplementPanel(current => (current ? { ...current, selected: new Set(ids) } : current))}
                  onToggle={(id) => setSupplementPanel(current => {
                    if (!current) return current
                    const selected = new Set(current.selected)
                    if (selected.has(id)) selected.delete(id)
                    else selected.add(id)
                    return { ...current, selected }
                  })}
                  onManualPlacement={(id, position) => setSupplementPanel(current => {
                    if (!current) return current
                    const manualPlacements = { ...current.manualPlacements }
                    if (position === null) delete manualPlacements[id]
                    else manualPlacements[id] = position
                    return { ...current, manualPlacements }
                  })}
                  onConfirm={handleApplySupplements}
                  onCancel={() => setSupplementPanel(null)}
                />
              )}
              {lastSupplementBatch && inThisCard(lastSupplementBatch.bookId) && (
                <div role="status" className="mt-3 flex flex-wrap items-center gap-3 rounded border border-emerald-800 bg-neutral-950 p-2 text-sm text-emerald-100">
                  <div>
                    <p>已從其他來源補入 {lastSupplementBatch.count.toLocaleString('zh-TW')} 章：</p>
                    <ul className="list-disc pl-5">
                      {lastSupplementBatch.lines.map(line => <li key={line}>{line}</li>)}
                      {lastSupplementBatch.count > lastSupplementBatch.lines.length && (
                        <li>{`另有 ${(lastSupplementBatch.count - lastSupplementBatch.lines.length).toLocaleString('zh-TW')} 章`}</li>
                      )}
                    </ul>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const target = bookGroup.find(member => member.id === lastSupplementBatch.bookId)
                      if (target) void handleUndoSupplements(target, lastSupplementBatch.batchId)
                    }}
                    disabled={savingBookId === book.id || supplementPanelOpen || offlineMode}
                    className="min-h-11 rounded border border-amber-700 px-3 py-1 text-amber-100 hover:bg-amber-950 disabled:opacity-50 sm:min-h-9"
                  >
                    {`撤銷這次補章（${lastSupplementBatch.count.toLocaleString('zh-TW')} 章）`}
                  </button>
                </div>
              )}
              {downloadState && !(editing && multiSource) && (
                <WebDownloadProgress
                  state={downloadState}
                  onDismiss={() => clearWebBookDownload(book.id)}
                  onRetry={() => handleDownload(book, {
                    startChapterIndex: downloadState.startChapterIndex,
                    refreshExisting: downloadState.refreshExisting,
                    missingOnly: downloadState.missingOnly,
                  })}
                />
              )}
            </div>
            )
          })}
        </div>
      )}
      </div>

      {renamingBook && (
        <PromptDialog
          title="重新命名"
          label="輸入新的書名"
          initialValue={renamingBook.title}
          onCancel={() => setRenamingBook(null)}
          onSubmit={(value) => performRename(renamingBook, value)}
        />
      )}

      {mergingBook && (
        <MergeDialog
          book={mergingBook}
          works={groupBooksByWork(books)
            .map(group => group[0])
            .filter(work => cardKeyOf(work) !== cardKeyOf(mergingBook))}
          onCancel={() => setMergingBook(null)}
          onPick={(target) => {
            setMergingBook(null)
            void performRename(mergingBook, target.title.trim())
          }}
        />
      )}

      {deletingBook && (
        <ConfirmDialog
          title="刪除書籍"
          message={`確定要刪除「${deletingBook.title}」？此操作會同時移除離線副本與進度，無法復原。`}
          confirmLabel="刪除"
          destructive
          onCancel={() => setDeletingBook(null)}
          onConfirm={() => performDelete(deletingBook)}
        />
      )}
    </div>
  )
}

function logWebSourceDiagnostics(
  action: 'create' | 'refresh' | 'supplement' | 'supplement-undo',
  details: Record<string, unknown>,
): void {
  console.debug(`[Raph Reader] web source ${action}`, details)
}

function GapChapter({ cell }: { cell: GapCell }) {
  return (
    <>
      {cell.chapterNumber !== undefined && <><span className="tabular-nums text-neutral-500">{cell.chapterNumber}</span>{' '}</>}
      <span>{cell.title}</span>
    </>
  )
}

function MergeDialog({ book, works, onCancel, onPick }: {
  book: Book
  works: Book[]
  onCancel: () => void
  onPick: (work: Book) => void
}) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const shown = works.filter(work => !needle || work.title.toLowerCase().includes(needle))
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={onCancel}>
      <div role="dialog" aria-modal="true" aria-labelledby="merge-dialog-title" onClick={event => event.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-sm flex-col rounded-lg border border-neutral-700 bg-neutral-900 p-4 text-neutral-100 shadow-xl">
        <h2 id="merge-dialog-title" className="text-base font-semibold">合併到其他作品</h2>
        <p className="mt-1 text-sm text-neutral-400">
          {`「${book.title.trim()}」會改名為所選作品的書名，成為它的書源並共用閱讀進度；兩邊進度不同時，保留較近期讀到的位置。之後改回原名即可拆開。`}
        </p>
        <input type="search" aria-label="搜尋書名" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜尋書名"
          className="mt-3 rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm" />
        <ul className="mt-2 grid gap-1 overflow-y-auto">
          {shown.map(work => (
            <li key={work.id}>
              <button type="button" onClick={() => onPick(work)}
                className="min-h-11 w-full rounded px-3 py-2 text-left text-sm hover:bg-neutral-800">{work.title.trim()}</button>
            </li>
          ))}
          {shown.length === 0 && <li className="px-3 py-2 text-sm text-neutral-400">沒有符合的作品</li>}
        </ul>
        <button type="button" onClick={onCancel} className="mt-3 min-h-11 rounded border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-800">取消</button>
      </div>
    </div>
  )
}

function SupplementPreviewPanel({
  state,
  targetLabel,
  donorChapters,
  busy,
  onToggle,
  onSetSelection,
  onManualPlacement,
  onConfirm,
  onCancel,
}: {
  state: SupplementPanelState
  targetLabel: string
  donorChapters: ReadonlyMap<string, Chapter[] | undefined>
  busy: boolean
  onToggle: (id: string) => void
  onSetSelection: (ids: string[]) => void
  onManualPlacement: (id: string, position: number | null) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const { preview, selected } = state
  const manualCount = Object.keys(state.manualPlacements ?? {}).length
  const targetChapters = state.book.chapters ?? []
  const candidatesById = new Map(preview.candidates.map(candidate => [candidate.id, candidate]))
  const groups = groupSupplementEntries(targetChapters, donorChapters, preview)
  const cellClass = 'break-words px-2 py-1 align-top'
  const gapLabel = (gap: CandidateGap) => `${gap.atEnd ? '書末' : `第 ${(gap.insertAfterIndex + 1).toLocaleString('zh-TW')} 章後`}・待補 ${gap.candidateIds.length} 章`
  const renderGap = (key: string, gap: CandidateGap) => (
    <table
      key={key}
      aria-label={`${gapLabel(gap)}（補源：${gap.donorDisplayName}）`}
      className="w-full table-fixed border-collapse overflow-hidden rounded border border-neutral-800"
    >
      <caption className="bg-neutral-900 px-2 py-1 text-left text-neutral-100">
        {gapLabel(gap)}
      </caption>
      <thead>
        <tr className="text-xs">
          <th scope="col" className="w-1/2 px-2 py-1 text-left font-normal text-cyan-300">本書</th>
          <th scope="col" className="w-1/2 px-2 py-1 text-left font-normal text-emerald-300">{`補源：${gap.donorDisplayName}`}</th>
        </tr>
      </thead>
      <tbody>
        {gap.rows.map((row, index) => {
          const candidate = row.candidateId ? candidatesById.get(row.candidateId) : undefined
          const chosen = !!candidate && selected.has(candidate.id)
          if (row.kind !== 'current') {
            return (
              <tr key={index} className="text-neutral-400">
                <td className={cellClass}>{row.left && <GapChapter cell={row.left} />}</td>
                <td className={cellClass}>{row.right && <GapChapter cell={row.right} />}</td>
              </tr>
            )
          }
          return (
            <tr key={index} className={chosen ? 'bg-emerald-950/60' : ''}>
              <td className={cellClass}>
                {row.left
                  ? <GapChapter cell={row.left} />
                  : <span className={`block rounded border border-dashed px-2 py-1 ${chosen ? 'border-emerald-600 text-emerald-200' : 'border-neutral-700 text-neutral-500'}`}>
                      {chosen ? '＋ 待補' : '不補入'}
                    </span>}
              </td>
              <td className={cellClass}>
                {candidate ? (
                  <label className="flex min-h-11 items-start gap-2 text-emerald-100 sm:min-h-9">
                    <input
                      type="checkbox"
                      className="mt-1"
                      aria-label={`${candidate.title}（來源：${candidate.donorDisplayName}）→ ${candidate.atEnd ? '補在書末，接在' : '插在'}目錄第 ${(candidate.insertAfterIndex + 1).toLocaleString('zh-TW')} 章「${candidate.insertAfterTitle}」之後`}
                      checked={chosen}
                      onChange={() => onToggle(candidate.id)}
                      disabled={busy}
                    />
                    <span>{row.right && <GapChapter cell={row.right} />}</span>
                  </label>
                ) : row.right && <span className="text-neutral-500"><GapChapter cell={row.right} /></span>}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
  const renderAmbiguity = (key: string, item: WebSourceSupplementAmbiguity, rows: GapRow[]) => {
    const reason = SUPPLEMENT_AMBIGUITY_REASONS[item.reason] ?? item.reason
    const pickable = rows.flatMap(row => (row.left?.chapterNumber !== undefined ? [row.left] : []))
    const reachesBookStart = pickable[0]?.chapterNumber === 1
    return (
      <div key={key} className="rounded border border-amber-900">
        <table aria-label={`${reason}（補源：${item.donorDisplayName}）`} className="w-full table-fixed border-collapse">
          <caption className="bg-neutral-900 px-2 py-1 text-left">{reason}</caption>
          <thead>
            <tr className="text-xs">
              <th scope="col" className="w-1/2 px-2 py-1 text-left font-normal text-cyan-300">本書</th>
              <th scope="col" className="w-1/2 px-2 py-1 text-left font-normal text-emerald-300">{`補源：${item.donorDisplayName}`}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className={row.kind === 'current' ? 'bg-amber-950/40 text-amber-100' : 'text-neutral-400'}>
                <td className={cellClass}>
                  {row.left
                    ? <GapChapter cell={row.left} />
                    : row.kind === 'current' && <span className="block rounded border border-dashed border-amber-800 px-2 py-1 text-amber-300">本書沒有對應章節</span>}
                </td>
                <td className={cellClass}>{row.right && <GapChapter cell={row.right} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {item.manualChapters?.map(chapter => {
          const placement = state.manualPlacements?.[chapter.id]
          return (
            <div key={chapter.id} className="border-t border-amber-900 p-2">
              <p>{`「${chapter.title}」要補入的話，插在本書哪一章之後？`}</p>
              <div className="mt-1 flex flex-wrap gap-2">
                {reachesBookStart && (
                  <button type="button" aria-pressed={placement === -1} aria-label={`「${chapter.title}」插在本書書首`}
                    onClick={() => onManualPlacement(chapter.id, -1)} disabled={busy}
                    className="min-h-9 rounded border border-amber-700 px-2 py-0.5 text-xs aria-pressed:bg-amber-800 disabled:opacity-50">書首</button>
                )}
                {pickable.map(cell => (
                  <button key={cell.chapterNumber} type="button" aria-pressed={placement === cell.chapterNumber! - 1}
                    aria-label={`「${chapter.title}」插在本書第 ${cell.chapterNumber} 章「${cell.title}」之後`}
                    onClick={() => onManualPlacement(chapter.id, cell.chapterNumber! - 1)} disabled={busy}
                    className="min-h-9 rounded border border-amber-700 px-2 py-0.5 text-xs aria-pressed:bg-amber-800 disabled:opacity-50">
                    {`第 ${cell.chapterNumber} 章後`}
                  </button>
                ))}
              </div>
              <label className="mt-2 block text-neutral-300">
                或輸入章次（0＝書首；留空則不補）：
                <input type="number" min={0} max={targetChapters.length} step={1}
                  aria-label={`選擇「${chapter.title}」插在本書第幾章之後`}
                  value={placement === undefined ? '' : placement + 1}
                  onChange={event => {
                    const value = event.target.value
                    const number = Number(value)
                    onManualPlacement(chapter.id, value !== '' && Number.isInteger(number)
                      && number >= 0 && number <= targetChapters.length ? number - 1 : null)
                  }}
                  disabled={busy} className="ml-2 w-20 rounded border border-neutral-700 bg-neutral-900 px-2 py-1" />
                {placement !== undefined
                  && (placement === -1
                    ? ' → 書首'
                    : ` → 「${targetChapters[placement]?.title ?? ''}」之後`)}
              </label>
            </div>
          )
        })}
      </div>
    )
  }
  const renderEntry = (entry: SupplementEntry) => (entry.kind === 'gap'
    ? renderGap(entry.key, entry.gap)
    : renderAmbiguity(entry.key, entry.item, entry.rows))
  const renderFolded = (label: string, entries: SupplementEntry[]) => entries.length > 0 && (
    <details className="mt-3 text-amber-200">
      <summary className="cursor-pointer">{`${label}：${entries.length} 處（展開核對）`}</summary>
      <div className="mt-2 grid gap-3">{entries.map(renderEntry)}</div>
    </details>
  )
  return (
    <div
      role="region"
      aria-label="從其他來源補章預覽"
      className="mt-3 rounded border border-emerald-800 bg-neutral-950 p-3 text-sm text-neutral-200"
    >
      <p className="font-medium text-neutral-100">從同書名的其他來源補章</p>
      {state.autoOffered && (
        <p className="mt-1 text-emerald-200">{preview.candidates.length
          ? '剛加入的書與書庫中的同名書比對後，找到可補入的章節；確認前不會寫入。'
          : '剛加入的書與書庫中的同名書有不確定章節；可核對前後文並選擇位置，確認前不會寫入。'}</p>
      )}
      <p className="mt-1 text-neutral-300">{`補到：${targetLabel}`}</p>
      {state.clearedManualPlacements && <p className="mt-1 text-amber-200">目錄已更新，手動位置已清除；請依最新章節重新選擇。</p>}
      <p className="mt-1 text-neutral-400">
        左欄是本書目錄、右欄是補源目錄，數字是各自的章次。依本書章次排列，同一處有多個來源時依序並列；黃框是無法確定位置的章節，預設不補入，可自選位置。章名不同或本書已有的位置收在最下方，預設摺疊。只補正文章節；補入後可在本書卡片的「補章」選單撤銷整批。
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <p className="text-neutral-200">{`安全候選 ${preview.candidates.length} 章／已選 ${selected.size + manualCount} 章／待確認 ${preview.ambiguous.length} 處`}</p>
        {preview.candidates.length > 0 && (
          <>
            <button type="button" onClick={() => onSetSelection(preview.candidates.map(candidate => candidate.id))} disabled={busy}
              className="min-h-9 rounded border border-neutral-700 px-2 py-0.5 text-xs hover:bg-neutral-800 disabled:opacity-50">全選</button>
            <button type="button" onClick={() => onSetSelection([])} disabled={busy}
              className="min-h-9 rounded border border-neutral-700 px-2 py-0.5 text-xs hover:bg-neutral-800 disabled:opacity-50">全不選</button>
          </>
        )}
      </div>
      {preview.candidates.length === 0 && <p className="mt-2 text-neutral-300">沒有可安全補入的章節。</p>}
      {groups.missing.length > 0 && <div className="mt-2 grid gap-3">{groups.missing.map(renderEntry)}</div>}
      {renderFolded('章名不同', groups.renamed)}
      {renderFolded('本書已有或已補過', groups.present)}
      {preview.excludedNotes.length > 0 && (
        <details className="mt-2 text-neutral-400">
          <summary className="cursor-pointer">已略過作者公告等非正文 {preview.excludedNotes.length} 則</summary>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {preview.excludedNotes.map((note, index) => <li key={`${index}:${note.title}`}>{note.title}</li>)}
          </ul>
        </details>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy || selected.size + manualCount === 0}
          className="min-h-11 rounded bg-emerald-500 px-4 py-2 text-neutral-950 hover:bg-emerald-400 disabled:opacity-50"
        >
          {`確認補入 ${selected.size + manualCount} 章`}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="min-h-11 rounded border border-neutral-700 px-4 py-2 text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
        >
          取消
        </button>
      </div>
    </div>
  )
}

function WebDownloadProgress({
  state,
  onDismiss,
  onRetry,
}: {
  state: WebDownloadState
  onDismiss: () => void
  onRetry: () => void
}) {
  const ratio = state.total > 0 ? Math.min(1, state.downloaded / state.total) : 0
  const pct = Math.round(ratio * 100)
  const statusLine =
    state.status === 'running' ? `下載中 ${state.downloaded}/${state.total} 章（${pct}%）`
    : state.status === 'completed' ? `離線下載完成（共 ${state.total} 章）`
    : state.status === 'cancelled' ? `已取消下載（已保留 ${state.downloaded}/${state.total} 章，下次可續傳）`
    : state.status === 'auth-expired' ? `Session 已過期：已保留 ${state.downloaded}/${state.total} 章。登入後可續傳`
    : `下載失敗：${state.errorMessage ?? '未知錯誤'}（已保留 ${state.downloaded}/${state.total} 章）`
  const barColor =
    state.status === 'completed' ? 'bg-emerald-500'
    : state.status === 'error' || state.status === 'auth-expired' ? 'bg-red-500'
    : state.status === 'cancelled' ? 'bg-amber-500'
    : 'bg-cyan-500'
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={`web-download-${state.bookId}`}
      className="mt-3 rounded border border-neutral-800 bg-neutral-950 p-2 text-sm text-neutral-200"
    >
      <div className="flex items-center justify-between gap-2">
        <span>{statusLine}</span>
        {state.status !== 'running' && (
          <div className="flex items-center gap-2">
            {(state.status === 'error' || state.status === 'cancelled' || state.status === 'auth-expired') && (
              <button
                type="button"
                onClick={onRetry}
                className="rounded border border-cyan-700 px-2 py-0.5 text-xs text-cyan-100 hover:bg-cyan-950"
              >
                重試
              </button>
            )}
            <button
              type="button"
              onClick={onDismiss}
              className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:bg-neutral-800"
            >
              關閉
            </button>
          </div>
        )}
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded bg-neutral-800">
        <div
          className={`h-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
