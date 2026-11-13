import { useParams, useNavigate } from 'react-router-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { MouseEvent, TouchEvent } from 'react'
import { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react'
import { db } from '../db.js'
import {
  streamBookContent,
  getProgress, getSettings, saveSettings, listBooks,
  fetchWebSourceChapters,
  getSharedProgress, selectSharedProgress,
  isAuthExpiredError, loginToReader,
  type Book, type Chapter, type Progress, type ReaderSettings,
  type SharedProgressChoice, type SharedProgressState, type SharedWork,
} from '../api.js'
import {
  resolveScrollTarget,
  buildChapterTextMap, getChapterTextTarget, makeChapterProgress,
  type ProgressPosition,
  splitParagraphs,
  getChapters,
  estimateParagraphHeight,
  formatParagraphForDisplay,
  getCurrentChapterIndex,
  clampChapterIndex,
  progressToChapterIndex,
  normalizeSettings,
  applyContentFilters,
  getChineseConverter,
  shouldMergeHardWrap,
  type HardWrapHandling,
  getIsMobileViewport,
  getTapScrollDirection,
  decideProgressMerge,
  stripMatchingChapterHeading,
  DEFAULT_SETTINGS,
} from '../utils/readerUtils.js'
import {
  createSharedSession, syncedPositionOf, syncProgressBestEffort, syncSharedProgress, waitForSharedSaves, writeLocalProgress,
  type SharedSession, type UploadFailure,
} from '../progressSync.js'
import { preflightAndSetPreferred } from '../sourcePreference.js'
import { useScreenWakeLock } from '../wakeLock.js'
import { formatSourceLabels } from '../utils/sourceLabels.js'
import {
  getOfflineBook,
  readBookContentChunks,
  getLocalContentVersion,
  invalidateOfflineCopy,
  saveBookForOffline,
  settingsToLocal,
} from '../offline.js'
import { ChapterPanel } from '../components/reader/ChapterPanel.js'
import { ProgressConflictDialog } from '../components/reader/ProgressConflictDialog.js'
import { ReaderSettingsPanel } from '../components/reader/ReaderSettingsPanel.js'
import { ReaderToolbar } from '../components/reader/ReaderToolbar.js'

type PendingProgress = ProgressPosition

interface ProgressCandidates {
  server: Progress
  local: Progress & { pendingSync?: boolean }
}

interface ProgressConflict extends ProgressCandidates {
  serverChapterIndex: number
  localChapterIndex: number
  reason: 'gap' | 'offline-earlier'
}

type SharedNotice =
  | { kind: 'unmapped'; anchorTitle: string | null; message?: string }
  // keepLocal: offered after a 409 so "保留目前位置" is a visible choice beside the old records.
  | { kind: 'conflict'; choices: SharedProgressChoice[]; error?: string; keepLocal?: ProgressPosition }
  | { kind: 'stale'; current: SharedWork | null; error?: string }

function sharedToProgress(state: Extract<SharedProgressState, { kind: 'mapped' }>): Progress {
  return {
    positionType: 'chapter_index',
    positionValue: state.positionValue,
    ...(state.chapterProgress === null ? {} : { chapterProgress: state.chapterProgress }),
    ...(state.chapterOffset === null || state.chapterOffset === undefined ? {} : { chapterOffset: state.chapterOffset }),
    updatedAt: state.updatedAt ?? '',
  }
}

/**
 * The blocking notice for an unresolved shared state. A record-choice dialog is
 * only meaningful with records to choose; without any, ask for a chapter.
 */
function sharedNoticeFor(state: Extract<SharedProgressState, { kind: 'unmapped' | 'conflict' }>): SharedNotice {
  if (state.kind === 'conflict') {
    return state.choices.length ? { kind: 'conflict', choices: state.choices }
      : { kind: 'unmapped', anchorTitle: null, message: '舊的閱讀紀錄無法對應目前的章節目錄，不會自動跳轉或覆寫進度。請選擇章節。' }
  }
  if (state.reason !== 'legacy-missing-chapter') return { kind: 'unmapped', anchorTitle: state.anchorTitle }
  const { legacyPositionValue: index, chapterCount: count } = state
  // Past the end may just mean the book was finished; never clamp, let the reader choose.
  return { kind: 'unmapped', anchorTitle: null, message: typeof index === 'number' && typeof count === 'number' && index >= count
    ? `舊的閱讀紀錄停在第 ${index + 1} 章，但目前的章節目錄只有 ${count} 章（可能已讀完，或目錄已更新），不會自動跳轉或覆寫進度。請選擇章節。`
    : '舊的閱讀紀錄所在的章節已不在目前的章節目錄中，不會自動跳轉或覆寫進度。請選擇章節。' }
}

const READER_VERTICAL_PADDING_PX = 16
const TOOLBAR_WIDTH_PX = 96 // matches md:w-24

const WEB_CHAPTER_PLACEHOLDER = '（本章尚未載入，捲動到此處時會自動讀取。）'

type WebChapterTexts = Record<number, string>

function synthesizeWebBookText(book: Book, chapterTexts: WebChapterTexts): string {
  return (book.chapters ?? [])
    .map((chapter, index) => {
      const chapterIndex = Number.isFinite(chapter.index) ? chapter.index : index
      const text = chapterTexts[chapterIndex]
      const normalizedText = text === undefined
        ? WEB_CHAPTER_PLACEHOLDER
        : stripMatchingChapterHeading(chapter.title, text)
      return `${chapter.title}\n\n${normalizedText}`
    })
    .join('\n\n')
}

function buildWebBookDocument(
  book: Book,
  chapterTexts: WebChapterTexts,
  transform: (text: string) => string,
  mergeHardWrap: HardWrapHandling,
): { paragraphs: string[]; chapters: Chapter[] } {
  const paragraphs: string[] = []
  const chapters: Chapter[] = []

  for (const [position, chapter] of (book.chapters ?? []).entries()) {
    const chapterIndex = Number.isFinite(chapter.index) ? chapter.index : position
    const title = transform(chapter.title)
    chapters.push({ ...chapter, index: paragraphs.length, title })
    paragraphs.push(title)

    const cachedText = chapterTexts[chapterIndex]
    const body = cachedText === undefined
      ? WEB_CHAPTER_PLACEHOLDER
      : stripMatchingChapterHeading(chapter.title, cachedText)
    paragraphs.push(...splitParagraphs(transform(body), mergeHardWrap))
  }

  return { paragraphs, chapters }
}

function progressToInitialChapter(
  progressResult: PromiseSettledResult<Progress | null>,
  localProgressResult: PromiseSettledResult<{ positionType: string; positionValue: number } | undefined>,
  embeddedProgress?: Progress | null,
): number {
  const serverProgress = progressResult.status === 'fulfilled' && progressResult.value
    ? progressResult.value
    : embeddedProgress
  const server = serverProgress?.positionType === 'chapter_index'
    ? serverProgress.positionValue
    : 0
  const local = localProgressResult.status === 'fulfilled' && localProgressResult.value?.positionType === 'chapter_index'
    ? localProgressResult.value.positionValue
    : 0
  return Math.max(0, Math.floor(Math.max(server, local)))
}

// Paragraph content is one text node; Range keeps the anchor tied to the
// visible text line when font size or viewport width changes.
function characterRect(row: Element, offset: number): DOMRect | null {
  const node = row.querySelector('p')?.firstChild
  if (!node || node.nodeType !== Node.TEXT_NODE || !node.textContent?.length) return null
  const range = document.createRange()
  if (typeof range.getBoundingClientRect !== 'function') return null
  const index = Math.min(Math.max(offset, 0), node.textContent.length - 1)
  range.setStart(node, index)
  range.setEnd(node, index + 1)
  return range.getBoundingClientRect()
}

function topCharacterOffset(scroller: HTMLElement | null, paragraphIndex: number): number {
  if (!scroller) return 0
  const row = scroller.querySelector(`[data-index="${paragraphIndex}"]`)
  const length = row?.querySelector('p')?.textContent?.length ?? 0
  if (!row || length === 0) return 0
  const edge = scroller.getBoundingClientRect().top + 1
  let low = 0
  let high = length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const rect = characterRect(row, middle)
    if (!rect) return 0
    if (rect.bottom <= edge) low = middle + 1
    else high = middle
  }
  return low
}

export function ReaderPage() {
  const { bookId } = useParams<{ bookId: string }>()
  const navigate = useNavigate()
  useScreenWakeLock(true)
  const [book, setBook] = useState<Book | null>(null)
  const [rawText, setRawText] = useState('')
  const [paragraphs, setParagraphs] = useState<string[]>([])
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS)
  const [isMobileViewport, setIsMobileViewport] = useState(getIsMobileViewport)
  const [showSettings, setShowSettings] = useState(false)
  const [showChapters, setShowChapters] = useState(false)
  const [showToolbar, setShowToolbar] = useState(false)
  const [currentParagraphIndex, setCurrentParagraphIndex] = useState(0)
  const [chapterProgress, setChapterProgress] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [authExpired, setAuthExpired] = useState(false)
  const [pendingProgress, setPendingProgress] = useState<PendingProgress | null>(null)
  const [progressCandidates, setProgressCandidates] = useState<ProgressCandidates | null>(null)
  const [progressConflict, setProgressConflict] = useState<ProgressConflict | null>(null)
  const [contentReady, setContentReady] = useState(false)
  const [webAutoFetchReady, setWebAutoFetchReady] = useState(false)
  const [webChapterTexts, setWebChapterTexts] = useState<WebChapterTexts>({})
  const [manifestChapters, setManifestChapters] = useState<Chapter[] | null>(null)
  const [pendingWebChapterJump, setPendingWebChapterJump] = useState<number | null>(null)
  const parentRef = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initialScrollDone = useRef(false)
  const latestPositionRef = useRef<ProgressPosition | null>(null)
  const pendingSaveRef = useRef<{ bookId: string; progress: ProgressPosition } | null>(null)
  const restoreRunRef = useRef<{ progress: PendingProgress; index: number; frame: number } | null>(null)
  // Same normalized-title web editions share one work: saves go through a
  // revision/manifest CAS session; per-book legacy rows stay untouched snapshots.
  const sharedSessionRef = useRef<SharedSession | null>(null)
  const [sharedWork, setSharedWork] = useState<SharedWork | null>(null)
  const [sharedNotice, setSharedNotice] = useState<SharedNotice | null>(null)
  // A TXT edition joins shared progress only once its detected chapters match the
  // server's (content filters or script conversion can drop a heading on this
  // device, shifting every ordinal). Until then the decided restore waits here.
  const txtSharedPendingRef = useRef<{ confirm: () => void; fallBack: () => void } | null>(null)
  // A mismatched TXT's ordinals are wrong for every other device and edition (and a
  // server per-book record would be adopted by the work), so it stays on this device.
  const localOnlyBookIdRef = useRef<string | null>(null)
  const [txtSharedCheck, setTxtSharedCheck] = useState<'pending' | 'matched' | 'mismatched' | null>(null)
  const [showSources, setShowSources] = useState(false)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [sourceBusy, setSourceBusy] = useState(false)
  // Header upload status: a failed save stays visible until a later save succeeds.
  // syncedPosition is the last server-confirmed position, read back on failure.
  const [uploadFailure, setUploadFailure] = useState<UploadFailure | null>(null)
  const [syncedPosition, setSyncedPosition] = useState<ProgressPosition | null>(null)
  const [localOnly, setLocalOnly] = useState(false)
  const bookIdRef = useRef(bookId)
  bookIdRef.current = bookId
  const persistProgress = useCallback((targetBookId: string, progress: ProgressPosition, keepalive = false) => {
    const report = (result: { status: string; reason?: UploadFailure }) => {
      if (bookIdRef.current !== targetBookId) return
      if (result.status === 'saved') setUploadFailure(null)
      if (result.status !== 'failed' || !result.reason) return
      const reason = result.reason
      void db.progress.get(targetBookId).catch(() => undefined).then(row => {
        if (bookIdRef.current !== targetBookId) return
        setSyncedPosition(syncedPositionOf(row))
        setUploadFailure(reason)
      })
    }
    const session = sharedSessionRef.current
    if (session && session.bookId === targetBookId) {
      // A TXT edition not yet verified keeps the position on this device only; the
      // pending row is merged and uploaded once its chapters are confirmed.
      if (session.blocked === 'verifying') {
        writeLocalProgress(targetBookId, progress, true).catch(() => undefined)
        return
      }
      // Unresolved/conflicting/stale shared state: nothing is written until the user chooses.
      if (session.blocked !== null) return
      writeLocalProgress(targetBookId, progress, true).catch(() => undefined)
      void syncSharedProgress(session, progress, keepalive).then(report)
      return
    }
    if (localOnlyBookIdRef.current === targetBookId) {
      writeLocalProgress(targetBookId, progress, false).catch(() => undefined)
      return
    }
    writeLocalProgress(targetBookId, progress, true).catch(() => undefined)
    void syncProgressBestEffort(targetBookId, progress, keepalive).then(report)
  }, [])
  const flushProgress = useCallback((keepalive = false) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    const pending = pendingSaveRef.current
    pendingSaveRef.current = null
    if (!pending) return
    persistProgress(pending.bookId, pending.progress, keepalive)
  }, [persistProgress])
  const fallbackProgressBlocked = useRef(false)
  // State, not a ref: contentReady must re-evaluate when streaming finishes even
  // when the final setRawText is a no-op (e.g. a web chapter window fetch that
  // returns only already-cached, byte-identical text). A ref mutation triggers
  // no render, so the contentReady effect would never re-run and progress
  // restore would deadlock.
  const [streamingDone, setStreamingDone] = useState(false)
  const webRequestedCenters = useRef<Set<number>>(new Set())
  const activeBookIdRef = useRef(bookId)
  activeBookIdRef.current = bookId
  const prevRawTextRef = useRef('')
  const scrollAnchorRef = useRef<{ topItemIndex: number; chapterIndex: number; offsetInChapter: number; progress: ProgressPosition } | null>(null)
  const touchStart = useRef<{ x: number; y: number } | null>(null)
  const chapters = useMemo(
    () => book?.sourceType === 'web' && manifestChapters !== null
      ? manifestChapters
      : getChapters(paragraphs),
    [book?.sourceType, manifestChapters, paragraphs],
  )
  const chapterParagraphIndices = useMemo(
    () => new Set(chapters.map(chapter => chapter.index)),
    [chapters],
  )
  const currentChapterIndex = getCurrentChapterIndex(chapters, currentParagraphIndex)
  const currentChapterIndexRef = useRef(0)
  currentChapterIndexRef.current = currentChapterIndex
  const currentChapter = chapters[currentChapterIndex] ?? chapters[0]
  const chapterLabel = currentChapter ? `${currentChapterIndex + 1}/${chapters.length} ${currentChapter.title} · ${Math.floor(chapterProgress * 100)}%` : ''
  const chapterTextMap = useMemo(() => buildChapterTextMap(chapters, paragraphs), [chapters, paragraphs])
  const headerTitle = book?.title ?? ''
  const unsentChapters = syncedPosition && chapters.length
    ? Math.abs(currentChapterIndex - progressToChapterIndex(syncedPosition, chapters, paragraphs.length))
    : null
  const mergeHardWrap = shouldMergeHardWrap(settings, isMobileViewport)
  const convertChinese = useMemo(() => getChineseConverter(settings.chineseConversion), [settings.chineseConversion])
  const contentFilters = settings.contentFilters

  // Reading column text width: the scroller minus the desktop toolbar inset,
  // capped by the centered column (42rem / md:46rem), minus the 左/右邊距 setting.
  const [scrollerWidth, setScrollerWidth] = useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth))
  const contentWidthPx = Math.min(scrollerWidth - (isMobileViewport ? 0 : TOOLBAR_WIDTH_PX), isMobileViewport ? 672 : 736)
    - settings.marginLeft - settings.marginRight
  const estimateRowHeight = useMemo(() => {
    const estimates = new Map<number, number>()
    const base = {
      contentWidthPx, fontSizePx: settings.fontSizePx, letterSpacingPx: settings.letterSpacingPx,
      lineHeight: settings.lineHeight, paragraphSpacingPx: settings.paragraphSpacing,
    }
    return (index: number) => {
      const cached = estimates.get(index)
      if (cached !== undefined) return cached
      const isChapter = chapterParagraphIndices.has(index)
      const estimate = estimateParagraphHeight(formatParagraphForDisplay(paragraphs[index] ?? ''), {
        ...base,
        paddingTopPx: isChapter ? settings.annotationMarginTop : settings.paddingTop,
        paddingBottomPx: isChapter ? settings.annotationMarginBottom : settings.paddingBottom,
        indentEm: isChapter ? 0 : settings.paragraphIndent,
      })
      estimates.set(index, estimate)
      return estimate
    }
  }, [chapterParagraphIndices, contentWidthPx, paragraphs, settings.annotationMarginBottom, settings.annotationMarginTop,
    settings.fontSizePx, settings.letterSpacingPx, settings.lineHeight, settings.paddingBottom, settings.paddingTop,
    settings.paragraphIndent, settings.paragraphSpacing])

  const virtualizer = useVirtualizer({
    count: paragraphs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: estimateRowHeight,
    measureElement: (el: Element) => el.getBoundingClientRect().height,
    overscan: 5,
    // Vertical breathing room lives inside the virtual space, not as CSS padding
    // on the scroller: CSS padding would offset every row 16px below the scroll
    // origin, so scrollToIndex lands 16px short and a sliver of the previous
    // paragraph sits at the top edge (header/progress then read one chapter low).
    paddingStart: READER_VERTICAL_PADDING_PX,
    paddingEnd: READER_VERTICAL_PADDING_PX,
  })

  const fetchAndCacheWebChapters = useCallback(async (
    targetBookId: string,
    center: number,
    before: number,
    after: number,
  ): Promise<WebChapterTexts> => {
    const response = await fetchWebSourceChapters(targetBookId, { center, before, after })
    const cachedAt = new Date().toISOString()
    const nextTexts: WebChapterTexts = {}
    for (const chapter of response.chapters) {
      nextTexts[chapter.index] = chapter.text
    }
    if (response.chapters.length > 0) {
      await db.webChapterCache.bulkPut(response.chapters.map((chapter) => ({
        bookId: targetBookId,
        chapterIndex: chapter.index,
        title: chapter.title,
        sourceUrl: chapter.sourceUrl,
        sourceTimestamp: chapter.sourceTimestamp,
        contentHash: chapter.contentHash,
        text: chapter.text,
        cachedAt,
      }))).catch(() => undefined)
    }
    if (activeBookIdRef.current === targetBookId) {
      setWebChapterTexts((prev) => ({ ...prev, ...nextTexts }))
    }
    return nextTexts
  }, [])

  useEffect(() => {
    if (!bookId) return
    let cancelled = false
    const isActiveGeneration = () => !cancelled && activeBookIdRef.current === bookId
    let sharedPromise: Promise<PromiseSettledResult<SharedWork | null>> = Promise.resolve({ status: 'fulfilled', value: null })

    type MetaResults = [
      progressResult: PromiseSettledResult<Progress | null>,
      settingsResult: PromiseSettledResult<ReaderSettings>,
      booksResult: PromiseSettledResult<Book[]>,
      localProgressResult: PromiseSettledResult<{ bookId: string; positionType: string; positionValue: number; updatedAt: string } | undefined>,
      localSettingsResult: PromiseSettledResult<(ReaderSettings & { bookId: string | null }) | undefined>,
      localBookResult: PromiseSettledResult<Book | null | undefined>,
    ]

    // Settings and book header must land before the first content render on every
    // path; the web path renders and then awaits a chapter fetch before applyMeta.
    async function applyDisplayMeta(results: MetaResults) {
      const [, settingsResult, booksResult, , localSettingsResult, localBookResult] = results
      if (!isActiveGeneration()) return
      if (localSettingsResult.status === 'fulfilled' && localSettingsResult.value) {
        setSettings(normalizeSettings(localSettingsResult.value))
      } else if (settingsResult.status === 'fulfilled') {
        const loadedSettings = normalizeSettings(settingsResult.value)
        setSettings(loadedSettings)
        await db.settings.put(settingsToLocal(loadedSettings, '__global__')).catch(() => undefined)
        if (!isActiveGeneration()) return
      }
      const serverBook = booksResult.status === 'fulfilled'
        ? booksResult.value.find(b => b.id === bookId)
        : undefined
      if (serverBook) {
        setBook(serverBook)
      } else if (localBookResult.status === 'fulfilled' && localBookResult.value) {
        setBook(localBookResult.value)
      }
    }

    async function applyMeta(
      progressResult: PromiseSettledResult<Progress | null>,
      _settingsResult: PromiseSettledResult<ReaderSettings>,
      booksResult: PromiseSettledResult<Book[]>,
      localProgressResult: PromiseSettledResult<{ bookId: string; positionType: string; positionValue: number; updatedAt: string } | undefined>,
      _localSettingsResult: PromiseSettledResult<(ReaderSettings & { bookId: string | null }) | undefined>,
      localBookResult: PromiseSettledResult<Book | null | undefined>,
      offlineFallbackChapterIndex?: number,
    ) {
      if (!isActiveGeneration()) return
      const serverBook = booksResult.status === 'fulfilled'
        ? booksResult.value.find(b => b.id === bookId)
        : undefined
      const sharedSettled = await sharedPromise
      if (!isActiveGeneration()) return
      // The list carries the same projection; it covers a failed dedicated read.
      const shared = (sharedSettled.status === 'fulfilled' ? sharedSettled.value : null)
        ?? (serverBook?.workId && serverBook.sharedProgress && serverBook.revision !== undefined
          ? { workId: serverBook.workId, preferredBookId: serverBook.preferredBookId ?? null, members: serverBook.members ?? [],
            revision: serverBook.revision, sharedProgress: serverBook.sharedProgress }
          : null)
      const localRow = localProgressResult.status === 'fulfilled' ? localProgressResult.value : undefined
      // A shared work exists only for web members, so the dedicated read alone is
      // enough to use the shared session even when the book list failed; a linked
      // member must never fall back to legacy per-book writes.
      if (shared) {
        const localBook = localBookResult.status === 'fulfilled' ? localBookResult.value ?? undefined : undefined
        // The manifest this reader shows: the server list's, else the offline copy's.
        const shownManifestVersion = serverBook ? serverBook.manifestVersion : localBook?.manifestVersion
        const member = shared.members.find(item => item.id === bookId)
        const session = createSharedSession({
          bookId: bookId!, workId: shared.workId, manifestVersion: shownManifestVersion ?? member?.manifestVersion ?? 0, revision: shared.revision,
        }, current => {
          if (sharedSessionRef.current === session) setSharedNotice({ kind: 'stale', current })
        })
        sharedSessionRef.current = session
        setSharedWork(shared)
        let state = shared.sharedProgress
        // The mapped index refers to the server's manifest; never apply it to a different (or unknown) one.
        if (shownManifestVersion === undefined || (member && member.manifestVersion !== session.manifestVersion)) {
          state = { kind: 'unmapped', reason: 'manifest-changed', anchorTitle: null, anchorBookId: null }
        }
        if (offlineFallbackChapterIndex !== undefined) {
          fallbackProgressBlocked.current = true
          setPendingProgress({ positionType: 'chapter_index', positionValue: offlineFallbackChapterIndex })
          return
        }
        if ((serverBook ?? localBook)?.sourceType === 'txt') {
          session.blocked = 'verifying'
          setTxtSharedCheck('pending')
          // Both continuations re-read this device's row: it may hold a position chosen while verifying.
          const currentLocalRow = () => db.progress.get(bookId!).catch(() => undefined)
          txtSharedPendingRef.current = {
            confirm: () => {
              session.blocked = null
              void currentLocalRow().then(row => isActiveGeneration() ? applyShared(session, state, row) : undefined)
            },
            fallBack: () => {
              localOnlyBookIdRef.current = bookId!
              setLocalOnly(true)
              if (sharedSessionRef.current === session) sharedSessionRef.current = null
              setSharedWork(null)
              setSharedNotice(null)
              void currentLocalRow().then(row => isActiveGeneration() ? applyLegacy(row) : undefined)
            },
          }
          return
        }
        await applyShared(session, state)
        return
      }
      await applyLegacy()

      async function applyShared(session: SharedSession, state: SharedProgressState, row = localRow) {
        // Only this device's unconfirmed writes compete with the canonical position;
        // a confirmed local row is just an older copy of server state.
        const pendingLocal = (row as { pendingSync?: boolean } | undefined)?.pendingSync === true ? row! : null
        if (state.kind === 'mapped') {
          const canonical = sharedToProgress(state)
          if (pendingLocal) {
            setProgressCandidates({ server: canonical, local: pendingLocal })
          } else {
            setPendingProgress(canonical)
            await db.progress.put({ bookId: bookId!, ...canonical, pendingSync: false }).catch(() => undefined)
          }
          return
        }
        if (state.kind === 'empty' && pendingLocal) {
          setPendingProgress(pendingLocal)
          persistProgress(bookId!, pendingLocal)
          return
        }
        if (state.kind === 'unmapped' || state.kind === 'conflict') {
          session.blocked = 'choice'
          setSharedNotice(sharedNoticeFor(state))
        }
        initialScrollDone.current = true
        setWebAutoFetchReady(true)
      }

      async function applyLegacy(row = localRow) {
      const serverProgress = progressResult.status === 'fulfilled' && progressResult.value
        ? progressResult.value
        : serverBook?.progress ?? null
      const localProgress = row ?? null
      if (offlineFallbackChapterIndex !== undefined) {
        // A readable session fallback is not a new reading decision. Do not
        // reconcile or copy it to either store after a transient fetch failure.
        fallbackProgressBlocked.current = true
        setPendingProgress({ positionType: 'chapter_index', positionValue: offlineFallbackChapterIndex })
      } else if (serverProgress && localProgress) {
        setProgressCandidates({ server: serverProgress, local: localProgress })
      } else if (serverProgress) {
        setPendingProgress(serverProgress)
        await db.progress.put({ bookId: bookId!, ...serverProgress, pendingSync: false }).catch(() => undefined)
        if (!isActiveGeneration()) return
      } else if (localProgress) {
        setPendingProgress(localProgress)
        persistProgress(bookId!, localProgress)
      } else {
        initialScrollDone.current = true
        setWebAutoFetchReady(true)
      }
      }
    }

    async function load() {
      try {
        initialScrollDone.current = false
        latestPositionRef.current = null
        pendingSaveRef.current = null
        setChapterProgress(0)
        fallbackProgressBlocked.current = false
        setStreamingDone(false)
        setPendingProgress(null)
        setProgressCandidates(null)
        setProgressConflict(null)
        setError(null)
        setAuthExpired(false)
        setContentReady(false)
        setWebAutoFetchReady(false)
        setWebChapterTexts({})
        setManifestChapters(null)
        setPendingWebChapterJump(null)
        webRequestedCenters.current = new Set()
        sharedSessionRef.current = null
        setSharedWork(null)
        setSharedNotice(null)
        txtSharedPendingRef.current = null
        localOnlyBookIdRef.current = null
        setLocalOnly(false)
        setUploadFailure(null)
        setSyncedPosition(null)
        setTxtSharedCheck(null)
        setShowSources(false)
        setSourceError(null)

        const [cached, localContentVersion] = await Promise.all([
          readBookContentChunks(bookId!),
          getLocalContentVersion(bookId!),
        ])
        if (cancelled) return

        // Kick off metadata once. Both the cached fast-path and the streaming
        // path consume the same results — avoid a second round-trip when the
        // cache turns out to be stale.
        // Let this device's own in-flight shared saves land first so the read is not stale.
        sharedPromise = Promise.allSettled([waitForSharedSaves().then(() => getSharedProgress(bookId!))])
          .then(([result]) => result)
        const metaPromise = Promise.allSettled([
          getProgress(bookId!),
          getSettings(),
          listBooks(),
          db.progress.get(bookId!),
          db.settings.get('__global__'),
          getOfflineBook(bookId!),
        ])

        if (cached !== null) {
          const results = await metaPromise
          if (cancelled) return
          await applyDisplayMeta(results as MetaResults)
          if (!isActiveGeneration()) return

          // Staleness: when the server list resolved and reports a fresher
          // updatedAt than the local contentVersion (or when local contentVersion
          // is missing entirely — pre-v3 IndexedDB shape), fall through to
          // streaming. If listBooks failed (offline), trust the cache.
          const listResult = results[2]
          const stale = listResult.status === 'fulfilled'
            && Array.isArray(listResult.value)
            && (() => {
              const serverBook = listResult.value.find((b) => b.id === bookId)
              if (!serverBook || !serverBook.updatedAt) return false
              if (!localContentVersion) return true
              return serverBook.updatedAt > localContentVersion
            })()

          if (!stale) {
            setStreamingDone(true)
            setRawText(cached)
            setLoading(false)
            await applyMeta(...(results as Parameters<typeof applyMeta>))
            if (!isActiveGeneration()) return
            return
          }
          // Cache is stale — invalidate the offline flag before streaming so a
          // kill-mid-stream doesn't leave stale chunks visible next offline
          // session. saveBookForOffline at end of stream restores it.
          await invalidateOfflineCopy(bookId!)
        }

        const metaResults = await metaPromise
        if (cancelled) return
        // The cached path already applied display meta before deciding it was stale.
        if (cached === null) {
          await applyDisplayMeta(metaResults as MetaResults)
          if (!isActiveGeneration()) return
        }
        const booksResult = metaResults[2]
        const localBookResult = metaResults[5]
        const webBook = booksResult.status === 'fulfilled'
          ? booksResult.value.find((candidate) => candidate.id === bookId && candidate.sourceType === 'web')
          : localBookResult.status === 'fulfilled' && localBookResult.value?.sourceType === 'web'
            ? localBookResult.value
            : undefined

        if (webBook) {
          const cachedChapters = await db.webChapterCache.where('bookId').equals(bookId!).toArray().catch(() => [])
          if (cancelled) return
          const manifestChapters = new Map(
            (webBook.chapters ?? []).map((chapter) => [chapter.index, chapter]),
          )
          const compatibleCachedChapters = cachedChapters.filter((chapter) => {
            const manifestChapter = manifestChapters.get(chapter.chapterIndex)
            return manifestChapter !== undefined
              && (!manifestChapter.sourceUrl || manifestChapter.sourceUrl === chapter.sourceUrl)
          })
          const cachedTexts = Object.fromEntries(
            compatibleCachedChapters.map((chapter) => [chapter.chapterIndex, chapter.text]),
          )
          const chapterCount = webBook.chapters?.length ?? 0
          const hasCompleteOfflineCopy = chapterCount > 0
            && (webBook.chapters ?? []).every((chapter) => cachedTexts[chapter.index] !== undefined)
          const hasAvailableOfflineWebBook = localBookResult.status === 'fulfilled'
            && localBookResult.value?.sourceType === 'web'
          const sharedForCenter = await sharedPromise
          if (cancelled) return
          const sharedState = sharedForCenter.status === 'fulfilled' ? sharedForCenter.value?.sharedProgress : undefined
          const center = Math.min(
            Math.max(0, (chapterCount || 1) - 1),
            sharedState?.kind === 'mapped'
              ? sharedState.positionValue
              : progressToInitialChapter(sharedState ? { status: 'fulfilled', value: null } : metaResults[0], metaResults[3],
                sharedState ? null : webBook.progress),
          )
          if (hasAvailableOfflineWebBook) {
            // Avoid refetching compatible cached rows. Uncached rows remain
            // eligible once initial progress restoration has completed.
            for (const chapter of compatibleCachedChapters) {
              webRequestedCenters.current.add(chapter.chapterIndex)
            }
          }
          setWebChapterTexts(cachedTexts)
          setRawText(synthesizeWebBookText(webBook, cachedTexts))
          setLoading(false)
          if (
            hasAvailableOfflineWebBook
            && (hasCompleteOfflineCopy || cachedTexts[center] !== undefined)
          ) {
            await applyMeta(...metaResults, undefined)
            if (!isActiveGeneration()) return
            setStreamingDone(true)
            return
          }
          webRequestedCenters.current.add(center)
          let fetchedTexts: WebChapterTexts
          try {
            fetchedTexts = await fetchAndCacheWebChapters(bookId!, center, 3, 3)
          } catch (error) {
            if (cancelled) return
            webRequestedCenters.current.delete(center)
            const cachedIndices = compatibleCachedChapters.map(chapter => chapter.chapterIndex)
            if (cachedIndices.length === 0) throw error
            const fallbackChapterIndex = cachedIndices.reduce((nearest, candidate) => (
              Math.abs(candidate - center) < Math.abs(nearest - center) ? candidate : nearest
            ))
            await applyMeta(...metaResults, fallbackChapterIndex)
            if (!isActiveGeneration()) return
            setStreamingDone(true)
            return
          }
          if (cancelled) return
          await applyMeta(...metaResults, undefined)
          if (!isActiveGeneration()) return
          setRawText(synthesizeWebBookText(webBook, { ...cachedTexts, ...fetchedTexts }))
          setStreamingDone(true)
          const prefetchCenter = Math.min(center + 1, Math.max(0, (chapterCount || 1) - 1))
          if (prefetchCenter !== center) {
            webRequestedCenters.current.add(prefetchCenter)
            fetchAndCacheWebChapters(bookId!, prefetchCenter, 0, 2).catch(() => {
              if (activeBookIdRef.current === bookId) {
                webRequestedCenters.current.delete(prefetchCenter)
              }
            })
          }
          return
        }

        let accumulated = ''
        let metaApplied = false
        let midPointShown = false

        for await (const chunk of streamBookContent(bookId!)) {
          if (cancelled) return
          accumulated += chunk

          if (!metaApplied) {
            metaApplied = true
            // Apply local + server meta BEFORE first paint so paragraphs split with the
            // user's hardWrapMode/chineseConversion on the very first render. Otherwise
            // the default-settings render produces a different chapter list and the
            // pendingProgress restore resolves the saved chapter_index against the wrong
            // chapter array — visible as a defaults flash and silently corrupted progress.
            const results = await metaPromise
            if (cancelled) return
            setRawText(accumulated)
            setLoading(false)
            await applyMeta(...(results as Parameters<typeof applyMeta>))
            if (!isActiveGeneration()) return
          } else if (!midPointShown && accumulated.length >= 1_000_000) {
            midPointShown = true
            setRawText(accumulated)
          }
        }

        if (!cancelled) {
          setStreamingDone(true)
          setRawText(accumulated)
          if (!metaApplied) {
            const results = await metaPromise
            if (cancelled) return
            setLoading(false)
            await applyMeta(...(results as Parameters<typeof applyMeta>))
            if (!isActiveGeneration()) return
          }
          // If the user had previously marked this book available offline, the
          // chunks we just bypassed are stale. Refresh the offline snapshot with
          // the freshly-streamed text so the next offline session matches server.
          try {
            // Stale-path invalidateOfflineCopy() flips isAvailableOffline=false
            // before stream — so check the localBook record's chunks via a
            // different signal: did this book ever have offline downloaded? We
            // approximate that with "the cached read returned text" (cached
            // !== null) — exact match for the rescue scenario.
            if (cached !== null && !cancelled) {
              const settled = await metaPromise
              const listBooksResult = settled[2]
              const serverBook = listBooksResult.status === 'fulfilled' && Array.isArray(listBooksResult.value)
                ? listBooksResult.value.find((b) => b.id === bookId)
                : null
              if (serverBook) {
                await saveBookForOffline(serverBook, accumulated)
              }
            }
          } catch {
            // Best-effort — don't fail the reader if offline re-save misbehaves.
          }
        }
      } catch (e) {
        if (!cancelled) {
          const sessionExpired = isAuthExpiredError(e)
          setAuthExpired(sessionExpired)
          setError(sessionExpired ? null : e instanceof Error ? e.message : 'Unknown error')
          setLoading(false)
        }
      }
    }

    load()
    return () => { cancelled = true; flushProgress() }
  }, [bookId, flushProgress, persistProgress])

  useLayoutEffect(() => {
    const scroller = parentRef.current
    if (!scroller || typeof ResizeObserver === 'undefined') return undefined
    const update = () => { if (scroller.clientWidth > 0) setScrollerWidth(scroller.clientWidth) }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [loading])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const query = window.matchMedia('(max-width: 767px)')
    const update = () => setIsMobileViewport(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (book?.sourceType !== 'web') return
    setRawText(synthesizeWebBookText(book, webChapterTexts))
  }, [book, webChapterTexts])

  useEffect(() => {
    const rawTextChanged = rawText !== prevRawTextRef.current
    prevRawTextRef.current = rawText

    if (initialScrollDone.current) {
      const isWebChapterExpand = book?.sourceType === 'web' && rawTextChanged
      if (isWebChapterExpand && pendingWebChapterJump === null) {
        // Web book chapter expansion (background fetch filled a placeholder):
        // capture a viewport anchor instead of snapping to current-chapter start.
        // Snapping yanks the user back whenever they cross a chapter boundary —
        // they were reading mid-chapter, the boundary triggered a fetch, and the
        // re-synthesized rawText would force scroll to the new chapter's top.
        const scrollTop = parentRef.current?.scrollTop ?? 0
        const items = virtualizer.getVirtualItems()
        const topItem = items.find(item => item.start + item.size > scrollTop) ?? items[0]
        if (topItem) {
          const chapterIndex = getCurrentChapterIndex(chapters, topItem.index)
          const baseIndex = chapters[chapterIndex]?.index ?? 0
          scrollAnchorRef.current = {
            topItemIndex: topItem.index,
            chapterIndex,
            offsetInChapter: topItem.index - baseIndex,
            progress: makeChapterProgress(chapterIndex, topItem.index, topCharacterOffset(parentRef.current, topItem.index), chapterTextMap),
          }
        }
      } else if (!isWebChapterExpand) {
        // Preserve the chapter text anchor across display conversion, wrapping,
        // or a TXT streaming update. Legacy positions retain chapter context.
        initialScrollDone.current = false
        setPendingProgress(latestPositionRef.current ?? { positionType: 'chapter_index', positionValue: currentChapterIndexRef.current })
      }
      // Web book with pendingWebChapterJump active: do nothing here — the jump
      // path drives its own scroll via setPendingProgress in pendingWebChapterJump effect.
    }
    const transform = (text: string) => convertChinese(applyContentFilters(text, contentFilters))
    if (book?.sourceType === 'web') {
      const document = buildWebBookDocument(book, webChapterTexts, transform, mergeHardWrap)
      setParagraphs(document.paragraphs)
      setManifestChapters(document.chapters)
    } else {
      setParagraphs(splitParagraphs(transform(rawText), mergeHardWrap))
      setManifestChapters(null)
    }
  }, [book, contentFilters, convertChinese, mergeHardWrap, rawText])

  useEffect(() => {
    if (!scrollAnchorRef.current || paragraphs.length === 0) return
    const anchor = scrollAnchorRef.current
    scrollAnchorRef.current = null
    // Only compensate when content was inserted ABOVE the anchor (anchor's
    // paragraph index shifted forward in the new array). Forward-reading
    // expansions add content below the viewport — virtualizer's scrollTop
    // preserves the view automatically; an extra scrollToIndex would jitter.
    const baseIndex = chapters[anchor.chapterIndex]?.index ?? 0
    const newTopIndex = baseIndex + anchor.offsetInChapter
    if (newTopIndex <= anchor.topItemIndex) return
    if ((anchor.progress.chapterOffset ?? 0) > 0) {
      initialScrollDone.current = false
      setPendingProgress(anchor.progress)
      return
    }
    const target = Math.min(paragraphs.length - 1, newTopIndex)
    requestAnimationFrame(() => {
      virtualizer.scrollToIndex(target, { align: 'start' })
    })
  }, [chapters, paragraphs, virtualizer])

  useEffect(() => {
    // Flip contentReady AFTER paragraphs reflects the final rawText (deferred one render
    // past the streaming-loop's setRawText). Setting it in the same batch as setRawText
    // would race the paragraphs effect: progressCandidates would resolve against the
    // stale partial chapter list before the new split commits.
    if (streamingDone && !contentReady && paragraphs.length > 0) {
      setContentReady(true)
    }
  }, [paragraphs, contentReady, streamingDone])

  useEffect(() => {
    // The full text decides: only identical chapter counts mean this device's
    // ordinals are the server's TXT ordinals that shared positions refer to.
    const pending = txtSharedPendingRef.current
    if (!contentReady || !pending || txtSharedCheck !== 'pending') return
    txtSharedPendingRef.current = null
    const serverCount = book?.chapters?.length
    if (serverCount !== undefined && serverCount === chapters.length) {
      setTxtSharedCheck('matched')
      pending.confirm()
    } else {
      setTxtSharedCheck('mismatched')
      pending.fallBack()
    }
  }, [book, chapters, contentReady, txtSharedCheck])

  useEffect(() => {
    if (!bookId || book?.sourceType !== 'web' || !contentReady || !webAutoFetchReady) return
    if (webRequestedCenters.current.has(currentChapterIndex)) return
    const targetBookId = bookId
    webRequestedCenters.current.add(currentChapterIndex)
    fetchAndCacheWebChapters(targetBookId, currentChapterIndex, 3, 3).catch(() => {
      if (activeBookIdRef.current === targetBookId) {
        webRequestedCenters.current.delete(currentChapterIndex)
      }
    })
  }, [
    bookId,
    book,
    contentReady,
    currentChapterIndex,
    fetchAndCacheWebChapters,
    webAutoFetchReady,
  ])

  useEffect(() => {
    if (pendingWebChapterJump === null || book?.sourceType !== 'web') return
    if (webChapterTexts[pendingWebChapterJump] === undefined) return
    if (paragraphs.length === 0) return
    const targetChapter = chapters[pendingWebChapterJump]
    if (!targetChapter) return
    if (paragraphs[targetChapter.index + 1] === WEB_CHAPTER_PLACEHOLDER) return
    setPendingProgress({ positionType: 'chapter_index', positionValue: pendingWebChapterJump })
    setPendingWebChapterJump(null)
  }, [book, chapters, paragraphs, pendingWebChapterJump, webChapterTexts])

  useEffect(() => {
    if (!bookId || progressCandidates === null || paragraphs.length === 0) return
    // Defer resolution while content is still streaming. progressToChapterIndex uses
    // clampChapterIndex, which would silently truncate a saved chapter_index larger than
    // the current partial chapter list and then db.progress.put the clamped value —
    // corrupting the user's real progress (see MISTAKES M-007).
    if (!contentReady) return

    const serverChapterIndex = progressToChapterIndex(progressCandidates.server, chapters, paragraphs.length)
    const localChapterIndex = progressToChapterIndex(progressCandidates.local, chapters, paragraphs.length)
    const decision = decideProgressMerge({ ...progressCandidates, serverChapterIndex, localChapterIndex, chapters })
    if (decision.kind === 'conflict') {
      setProgressConflict({
        ...progressCandidates,
        serverChapterIndex,
        localChapterIndex,
        reason: decision.reason,
      })
      setProgressCandidates(null)
      return
    }

    const winner = progressCandidates[decision.source]
    const normalizedWinner = winner.positionType === 'chapter_index'
      ? { ...winner, positionValue: clampChapterIndex(winner.positionValue, chapters) }
      : winner
    setPendingProgress(normalizedWinner)
    setProgressCandidates(null)
    const differsFromServer = localChapterIndex !== serverChapterIndex
      || progressCandidates.local.chapterOffset !== progressCandidates.server.chapterOffset
    // A server winner is already in the cloud. A local winner stays pending until
    // the write-back below confirms it.
    if (decision.source === 'local' && differsFromServer) {
      persistProgress(bookId, normalizedWinner)
    } else {
      writeLocalProgress(bookId, normalizedWinner, false).catch(() => undefined)
    }
  }, [bookId, chapters, paragraphs.length, progressCandidates, contentReady, persistProgress])

  useLayoutEffect(() => {
    if (pendingProgress === null || paragraphs.length === 0) return
    const fine = pendingProgress.chapterOffset !== undefined
    if (fine && !contentReady) return
    const chapterIndex = progressToChapterIndex(pendingProgress, chapters, paragraphs.length)
    // A web chapter still showing its placeholder re-splits when its text lands,
    // so a restore there waits until paragraphs holds the text (even for the
    // chapter start) instead of finishing on the placeholder layout.
    if (book?.sourceType === 'web' && (webChapterTexts[chapterIndex] === undefined
      || paragraphs[(chapters[chapterIndex]?.index ?? -2) + 1] === WEB_CHAPTER_PLACEHOLDER)) return
    if (resolveScrollTarget(pendingProgress, chapters, paragraphs.length) === null) return
    const target = getChapterTextTarget(pendingProgress, chapters, paragraphs, chapterTextMap)
    const index = target.index
    const existingRun = restoreRunRef.current
    if (existingRun?.progress === pendingProgress && existingRun.index === index) return
    if (existingRun) cancelAnimationFrame(existingRun.frame)
    initialScrollDone.current = false
    const run = { progress: pendingProgress, index, frame: 0 }
    restoreRunRef.current = run
    const targetBookId = bookId
    const finish = () => {
      if (restoreRunRef.current !== run || activeBookIdRef.current !== targetBookId) return
      restoreRunRef.current = null
      latestPositionRef.current = pendingProgress
      setChapterProgress(pendingProgress.chapterProgress ?? 0)
      initialScrollDone.current = true
      setWebAutoFetchReady(true)
      setPendingProgress(null)
    }
    virtualizer.scrollToIndex(index, { align: 'start' })
    setCurrentParagraphIndex(index)
    currentChapterIndexRef.current = chapterIndex
    // Every restore, chapter starts included, finishes only after the DOM shows
    // the target at the top edge for several frames. scrollToIndex starts from
    // estimated row heights and keeps converging while rows measure; finishing
    // earlier re-enables handleScroll in that window, which reads the previous
    // chapter's tail off the DOM, persists it, and re-anchors the end-of-stream
    // re-restore to it.
    const alignRowTop = target.characterOffset === 0
    const layoutless = typeof document.createRange().getBoundingClientRect !== 'function'
    let attempts = 0
    let settled = 0
    const correct = () => {
      if (restoreRunRef.current !== run || activeBookIdRef.current !== targetBookId) return
      const scroller = parentRef.current
      const row = scroller?.querySelector(`[data-index="${index}"]`)
      if (layoutless) {
        // Component tests have no layout to verify; real browser coverage is required.
        if (!row) virtualizer.scrollToIndex(index, { align: 'start' })
        finish()
        return
      }
      const rect = row && (alignRowTop ? row.getBoundingClientRect() : characterRect(row, target.characterOffset))
      if (rect && scroller) {
        const delta = rect.top - scroller.getBoundingClientRect().top
        if (Math.abs(delta) > 1) {
          const before = scroller.scrollTop
          scroller.scrollTop += delta
          // The last line may not reach the top at the document's bottom.
          settled = Math.abs(scroller.scrollTop - before) < 1 ? settled + 1 : 0
        } else settled += 1
      } else virtualizer.scrollToIndex(index, { align: 'start' })
      attempts += 1
      if (settled >= 3 || attempts >= 60) { finish(); return }
      run.frame = requestAnimationFrame(correct)
    }
    run.frame = requestAnimationFrame(correct)
  }, [book?.sourceType, bookId, chapters, chapterTextMap, paragraphs, pendingProgress, virtualizer, contentReady, webChapterTexts])

  useEffect(() => {
    const flushHidden = () => { if (document.visibilityState === 'hidden') flushProgress(true) }
    const flushLeaving = () => flushProgress(true)
    document.addEventListener('visibilitychange', flushHidden)
    window.addEventListener('pagehide', flushLeaving)
    return () => {
      document.removeEventListener('visibilitychange', flushHidden)
      window.removeEventListener('pagehide', flushLeaving)
      if (restoreRunRef.current) cancelAnimationFrame(restoreRunRef.current.frame)
      restoreRunRef.current = null
      flushProgress(true)
    }
  }, [flushProgress])

  // Paragraph whose rendered box crosses the top edge of the scroller, read from
  // the DOM. Rendered rows carry data-index and are positioned from the same
  // measurement cache the virtualizer uses, so after a re-measure shifts rows
  // under a fixed scrollTop the DOM is the only source that reflects what the
  // reader actually sees. Returns null when nothing is rendered (jsdom, first paint).
  const resolveTopParagraphFromDom = useCallback((): number | null => {
    const scroller = parentRef.current
    if (!scroller) return null
    const edge = scroller.getBoundingClientRect().top + 1
    let best: number | null = null
    for (const el of scroller.querySelectorAll<HTMLElement>('[data-index]')) {
      const rect = el.getBoundingClientRect()
      if (rect.height === 0 || rect.bottom <= edge) continue
      const index = Number(el.dataset.index)
      if (Number.isFinite(index) && (best === null || index < best)) best = index
    }
    return best
  }, [])

  const commitCurrentParagraph = useCallback((paragraphIndex: number) => {
    const nextChapterIndex = getCurrentChapterIndex(chapters, paragraphIndex)
    if (book?.sourceType === 'web' && webChapterTexts[nextChapterIndex] === undefined) {
      setCurrentParagraphIndex(paragraphIndex)
      setChapterProgress(0)
      return
    }
    const next = makeChapterProgress(nextChapterIndex, paragraphIndex, topCharacterOffset(parentRef.current, paragraphIndex), chapterTextMap)
    setCurrentParagraphIndex(paragraphIndex)
    setChapterProgress(next.chapterProgress ?? 0)
    const previous = latestPositionRef.current
    latestPositionRef.current = next
    if (previous?.positionValue === next.positionValue && previous.chapterOffset === next.chapterOffset) return
    if (!bookId) return
    pendingSaveRef.current = { bookId, progress: next }
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => flushProgress(), 2000)
  }, [bookId, book?.sourceType, chapters, chapterTextMap, webChapterTexts, flushProgress])

  const handleScroll = useCallback(() => {
    if (!initialScrollDone.current || fallbackProgressBlocked.current || paragraphs.length === 0) return
    // Prefer the DOM (what the reader sees). Fall back to the measurement cache:
    // getVirtualItems() is the rendered window (viewport + overscan) and lags a
    // programmatic scroll until React re-renders, so its midpoint reports a
    // chapter the reader is not looking at and gets persisted as progress drift.
    // scrollTop is reported as an integer while measured item starts are
    // fractional (e.g. 2114 vs 2114.45 after scrollToIndex), so probe 1px below
    // the top edge — otherwise the paragraph *above* the viewport wins by <1px
    // and the header/progress land one chapter behind the visible one.
    const domIndex = resolveTopParagraphFromDom()
    if (domIndex !== null) {
      commitCurrentParagraph(domIndex)
      return
    }
    const probeOffset = (parentRef.current?.scrollTop ?? 0) + 1
    const topItem = typeof virtualizer.getVirtualItemForOffset === 'function'
      ? virtualizer.getVirtualItemForOffset(probeOffset)
      : virtualizer.getVirtualItems().find(item => item.start + item.size > probeOffset)
    if (!topItem) return
    commitCurrentParagraph(topItem.index)
  }, [commitCurrentParagraph, paragraphs.length, resolveTopParagraphFromDom, virtualizer])

  // A fast wheel scroll lands in rows the virtualizer has only estimated; once
  // they render and get measured, rows shift under the unchanged scrollTop but no
  // scroll event fires, so the header/progress computed at the last scroll event
  // point one chapter off. Re-derive from the DOM whenever the measured total
  // height changes (measurement happens in the same commit as the new rows).
  const totalSize = virtualizer.getTotalSize()
  useEffect(() => {
    if (!initialScrollDone.current || fallbackProgressBlocked.current || paragraphs.length === 0) return
    const domIndex = resolveTopParagraphFromDom()
    if (domIndex === null || domIndex === currentParagraphIndex) return
    commitCurrentParagraph(domIndex)
  }, [commitCurrentParagraph, currentParagraphIndex, paragraphs.length, resolveTopParagraphFromDom, totalSize])

  async function updateSettings(updates: Partial<ReaderSettings>) {
    const next = normalizeSettings({ ...settings, ...updates })
    setSettings(next)
    await db.settings.put(settingsToLocal(next, '__global__')).catch(() => undefined)
    try { await saveSettings({ ...next, bookId: null }) } catch { /* ignore */ }
  }

  async function chooseProgress(source: 'local' | 'server') {
    if (!bookId || !progressConflict) return
    const next = progressConflict[source]
    setProgressConflict(null)
    // Until the chosen place is restored, scrolling must not save the old one.
    initialScrollDone.current = false
    setPendingProgress(next)
    // Either choice is written back; the row stops being pending once the cloud confirms it.
    persistProgress(bookId, next)
    await ensureWebChapterLoaded(progressToChapterIndex(next, chapters, paragraphs.length))
  }

  async function ensureWebChapterLoaded(chapterIndex: number) {
    if (!bookId || book?.sourceType !== 'web' || webChapterTexts[chapterIndex] !== undefined) return
    const targetBookId = bookId
    webRequestedCenters.current.add(chapterIndex)
    try {
      await fetchAndCacheWebChapters(targetBookId, chapterIndex, 3, 3)
    } catch (error) {
      if (activeBookIdRef.current !== targetBookId) return
      webRequestedCenters.current.delete(chapterIndex)
      setError(error instanceof Error ? error.message : 'Unknown error')
    }
  }

  /** Applies a server-resolved shared state after an explicit user choice. */
  async function applySharedResolution(next: SharedWork, session: SharedSession) {
    session.revision = next.revision
    setSharedWork(next)
    const state = next.sharedProgress
    const member = next.members.find(item => item.id === session.bookId)
    if (member && member.manifestVersion !== session.manifestVersion) {
      session.blocked = 'stale'
      setSharedNotice({ kind: 'stale', current: next, error: '此書源目錄已更新，請重新開啟本書後再繼續' })
      return
    }
    if (state.kind === 'mapped') {
      session.blocked = null
      setSharedNotice(null)
      const progress = sharedToProgress(state)
      latestPositionRef.current = progress
      initialScrollDone.current = false
      setPendingProgress(progress)
      await db.progress.put({ bookId: session.bookId, ...progress, pendingSync: false }).catch(() => undefined)
      await ensureWebChapterLoaded(progress.positionValue)
    } else if (state.kind === 'unmapped' || state.kind === 'conflict') {
      session.blocked = 'choice'
      setSharedNotice(sharedNoticeFor(state))
    } else {
      session.blocked = null
      setSharedNotice(null)
    }
  }

  async function chooseSharedRecord(choice: SharedProgressChoice) {
    const session = sharedSessionRef.current
    if (!session || !bookId) return
    try {
      const next = await selectSharedProgress(bookId, {
        selectedProgressBookId: choice.bookId, expectedRevision: session.revision, expectedWorkId: session.workId,
      })
      if (sharedSessionRef.current !== session) return
      await applySharedResolution(next, session)
    } catch (e) {
      if (sharedSessionRef.current !== session) return
      if (e instanceof Error && e.name === 'SharedProgressStaleError') {
        session.blocked = 'stale'
        setSharedNotice({ kind: 'stale', current: (e as Error & { current?: SharedWork | null }).current ?? null })
        return
      }
      setSharedNotice(current => current?.kind === 'conflict'
        ? { ...current, error: e instanceof Error ? e.message : String(e) } : current)
    }
  }

  async function currentSharedState(notice: Extract<SharedNotice, { kind: 'stale' }>): Promise<SharedWork | null> {
    if (notice.current || !bookId) return notice.current
    try { return await getSharedProgress(bookId) } catch { return null }
  }

  /** After a 409: move to the newer canonical position (explicit user choice). */
  async function jumpToLatestShared(notice: Extract<SharedNotice, { kind: 'stale' }>) {
    const session = sharedSessionRef.current
    const current = await currentSharedState(notice)
    if (!session || sharedSessionRef.current !== session) return
    if (!current) {
      setSharedNotice({ ...notice, error: '無法取得最新進度，請檢查網路後再試' })
      return
    }
    await applySharedResolution(current, session)
  }

  /** After a 409: keep reading here and overwrite with this position (explicit user choice). */
  async function keepCurrentShared(notice: Extract<SharedNotice, { kind: 'stale' }>) {
    const session = sharedSessionRef.current
    const current = await currentSharedState(notice)
    if (!session || !bookId || sharedSessionRef.current !== session) return
    if (!current) {
      setSharedNotice({ ...notice, error: '無法取得最新進度，請檢查網路後再試' })
      return
    }
    const member = current.members.find(item => item.id === session.bookId)
    if (member && member.manifestVersion !== session.manifestVersion) {
      setSharedNotice({ ...notice, current, error: '此書源目錄已更新，請重新開啟本書後再繼續' })
      return
    }
    session.revision = current.revision
    setSharedWork(current)
    const position = latestPositionRef.current
    // With no old records to show there is nothing to protect beyond the revision just adopted.
    if (current.sharedProgress.kind === 'conflict' && current.sharedProgress.choices.length) {
      // Old-client records exist: show them, with this place as one of the choices, before overwriting.
      session.blocked = 'choice'
      setSharedNotice({ kind: 'conflict', choices: current.sharedProgress.choices, ...(position ? { keepLocal: position } : {}) })
      return
    }
    session.blocked = null
    setSharedNotice(null)
    if (position) persistProgress(bookId, position)
  }

  /** Conflict dialog choice: overwrite with this device's place at the surfaced revision. */
  function keepLocalShared(position: ProgressPosition) {
    const session = sharedSessionRef.current
    if (!session || !bookId || session.bookId !== bookId) return
    session.blocked = null
    setSharedNotice(null)
    persistProgress(bookId, position)
  }

  async function readOtherSource(targetBookId: string) {
    flushProgress()
    await waitForSharedSaves()
    navigate(`/read/${targetBookId}`)
  }

  async function makePreferredSource(targetBookId: string) {
    if (!sharedWork?.preferredBookId || sourceBusy) return
    setSourceBusy(true)
    setSourceError(null)
    try {
      const result = await preflightAndSetPreferred({ workId: sharedWork.workId, preferredBookId: sharedWork.preferredBookId }, targetBookId)
      setSharedWork(current => current ? { ...current, preferredBookId: result.preferredBookId } : current)
      if (targetBookId !== bookId) {
        setShowSources(false)
        await readOtherSource(targetBookId)
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'SharedProgressStaleError') {
        const current = (e as Error & { current?: SharedWork | null }).current
        if (current) setSharedWork(existing => existing ? { ...existing, preferredBookId: current.preferredBookId } : existing)
        setSourceError('預設書源已在其他裝置變更，請再確認一次')
      } else {
        setSourceError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setSourceBusy(false)
    }
  }

  async function jumpToChapter(chapterIndex: number, paragraphIndex: number) {
    flushProgress()
    // Choosing a chapter is the deliberate decision that resolves an unmapped or
    // conflicting shared position (a 409 still needs its own choice).
    const session = sharedSessionRef.current
    if (session?.blocked === 'choice' && session.bookId === bookId) {
      session.blocked = null
      setSharedNotice(null)
    }
    const nextChapterIndex = book?.sourceType === 'web'
      ? chapterIndex
      : getCurrentChapterIndex(chapters, paragraphIndex)
    if (book?.sourceType === 'web' && bookId && webChapterTexts[nextChapterIndex] === undefined) {
      const targetBookId = bookId
      setPendingWebChapterJump(nextChapterIndex)
      webRequestedCenters.current.add(nextChapterIndex)
      try {
        await fetchAndCacheWebChapters(targetBookId, nextChapterIndex, 3, 3)
      } catch (error) {
        if (activeBookIdRef.current !== targetBookId) return
        webRequestedCenters.current.delete(nextChapterIndex)
        setPendingWebChapterJump(null)
        setError(error instanceof Error ? error.message : 'Unknown error')
      }
      return
    }
    virtualizer.scrollToIndex(paragraphIndex, { align: 'start' })
    setCurrentParagraphIndex(paragraphIndex)
    // While a TXT edition is verified no position has been restored yet, so reading
    // movement is not saved; a chosen chapter is a real position to read on from.
    if (session?.blocked === 'verifying' && session.bookId === bookId && !restoreRunRef.current) initialScrollDone.current = true
    if (bookId) {
      const next = { positionType: 'chapter_index', positionValue: nextChapterIndex, chapterOffset: 0, chapterProgress: 0 }
      latestPositionRef.current = next
      setChapterProgress(0)
      persistProgress(bookId, next)
    }
    setShowSettings(false)
    setShowChapters(false)
    setShowToolbar(false)
  }

  function handleReaderClick(event: MouseEvent<HTMLDivElement>) {
    if (showToolbar) {
      setShowToolbar(false)
      setShowSettings(false)
      setShowChapters(false)
      return
    }
    if (showSettings) {
      setShowSettings(false)
      return
    }
    if (showChapters) {
      setShowChapters(false)
      return
    }
    const container = parentRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const direction = getTapScrollDirection(event, rect, settings.tapScrollMode)
    fallbackProgressBlocked.current = false
    container.scrollBy({
      top: direction * container.clientHeight * (settings.tapScrollPercent / 100),
      behavior: 'smooth',
    })
  }

  function handleTouchStart(event: TouchEvent<HTMLDivElement>) {
    if (showSettings || showChapters) return
    fallbackProgressBlocked.current = false
    const touch = event.touches[0]
    touchStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null
  }

  function handleTouchEnd(event: TouchEvent<HTMLDivElement>) {
    const start = touchStart.current
    const touch = event.changedTouches[0]
    touchStart.current = null
    if (!start || !touch) return
    if (showSettings || showChapters) return

    const deltaX = touch.clientX - start.x
    const deltaY = touch.clientY - start.y
    if (Math.abs(deltaX) < 60 || Math.abs(deltaX) < Math.abs(deltaY) * 1.4) return

    if (deltaX < 0 && start.x > window.innerWidth * 0.55) {
      setShowToolbar(true)
    } else if (deltaX > 0) {
      setShowToolbar(false)
      setShowSettings(false)
    }
  }

  if (loading) {
    return <div className="flex h-screen items-center justify-center bg-neutral-950 text-neutral-300" data-testid="loading">載入中...</div>
  }
  if (authExpired) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-950 px-4 text-neutral-100" data-testid="auth-expired">
        <div className="w-full max-w-sm rounded border border-cyan-800 bg-cyan-950 p-4 text-cyan-100">
          <h1 className="mb-2 text-lg font-semibold">Session 已過期</h1>
          <p className="mb-4 text-sm opacity-80">
            請重新登入後回到書庫，再開啟這本書。登入會回到 Reader，不會跳到 API endpoint。
          </p>
          <button
            type="button"
            onClick={loginToReader}
            className="rounded border border-cyan-600 px-3 py-2 text-sm text-cyan-50 hover:bg-cyan-900"
          >
            重新登入
          </button>
        </div>
      </div>
    )
  }
  if (error) {
    return <div className="flex items-center justify-center h-screen text-red-500" data-testid="error">{error}</div>
  }

  const toolbarOnLeft = settings.toolbarSide === 'left'
  const readerOverflowClass = showToolbar ? 'overflow-hidden md:overflow-y-auto' : 'overflow-y-auto'
  // The scroller only clears the toolbar; the 左/右邊距 settings apply inside the
  // centered reading column, on each paragraph (absolute items ignore column padding).
  const contentPaddingLeft = !isMobileViewport && toolbarOnLeft ? TOOLBAR_WIDTH_PX : 0
  const contentPaddingRight = !isMobileViewport && !toolbarOnLeft ? TOOLBAR_WIDTH_PX : 0

  return (
    <div
      style={{ backgroundColor: settings.backgroundColor }}
      className="h-screen flex flex-col relative overflow-hidden"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <div
        className="flex items-center justify-between px-4 py-2 border-b"
        style={{ backgroundColor: settings.backgroundColor, color: settings.textColor }}
      >
        <button
          onClick={() => navigate('/')}
          className="-mx-2 flex min-h-11 min-w-11 items-center px-2 text-sm opacity-60"
        >← 書庫</button>
        <div className="min-w-0 flex-1 px-3 text-center">
          <div className="truncate text-sm font-medium">{headerTitle}</div>
          <div className="truncate text-xs opacity-60">{chapterLabel}</div>
          {localOnly ? (
            <div data-testid="progress-sync-status" className="truncate text-xs opacity-60"
              title="此 TXT 的章節與伺服器不同，閱讀進度只記在此裝置">進度僅存本機</div>
          ) : uploadFailure === 'auth' ? (
            <button type="button" data-testid="progress-sync-status" className="max-w-full truncate text-xs font-medium text-red-600 underline"
              onClick={() => { flushProgress(); loginToReader() }}>登入已過期，進度未上傳 · 重新登入</button>
          ) : uploadFailure && unsentChapters !== null && unsentChapters > 2 ? (
            <div role="status" data-testid="progress-sync-status" className="truncate text-xs font-medium text-red-600"
              title="上傳到雲端失敗，進度先存在此裝置；連線後繼續閱讀就會重新上傳">{unsentChapters} 章進度未上傳</div>
          ) : uploadFailure ? (
            <div data-testid="progress-sync-status" className="truncate text-xs opacity-60"
              title="上傳到雲端失敗，進度先存在此裝置；連線後繼續閱讀就會重新上傳">進度未上傳</div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setShowToolbar(true)}
          className="-mx-2 flex min-h-11 min-w-11 items-center justify-end px-2 text-sm opacity-60 md:invisible"
          aria-label="開啟工具列"
        >
          工具
        </button>
      </div>

      {sharedNotice?.kind === 'unmapped' && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 border-b py-2 text-sm"
          // Keep the 選擇章節 button clear of the always-visible desktop toolbar.
          style={{ backgroundColor: settings.backgroundColor, color: settings.textColor,
            paddingLeft: `${contentPaddingLeft + 16}px`, paddingRight: `${contentPaddingRight + 16}px` }}
        >
          <span>{sharedNotice.message ?? (sharedNotice.anchorTitle
            ? `此書源找不到上次閱讀的章節「${sharedNotice.anchorTitle}」，不會自動跳轉或覆寫進度。`
            : '此書源無法對應上次閱讀的位置，不會自動跳轉或覆寫進度。')}</span>
          <button
            type="button"
            onClick={() => setShowChapters(true)}
            className="min-h-11 rounded border px-3 py-1"
            style={{ borderColor: settings.textColor }}
          >
            選擇章節
          </button>
        </div>
      )}

      <div
        ref={parentRef}
        onScroll={handleScroll}
        onWheel={() => { fallbackProgressBlocked.current = false }}
        onPointerDown={() => { fallbackProgressBlocked.current = false }}
        onClick={handleReaderClick}
        className={`flex-1 ${readerOverflowClass}`}
        style={{
          backgroundColor: settings.backgroundColor,
          paddingLeft: `${contentPaddingLeft}px`,
          paddingRight: `${contentPaddingRight}px`,
        }}
      >
        {/* Centered reading column: caps line length on wide screens while the
            scroll element stays parentRef so virtualizer measurement is unchanged. */}
        <div
          className="mx-auto w-full max-w-[42rem] md:max-w-[46rem]"
          style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
        >
          {virtualizer.getVirtualItems().map(item => {
            const text = paragraphs[item.index]
            const isChapter = chapterParagraphIndices.has(item.index)
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                style={{
                  position: 'absolute', top: 0, left: 0, width: '100%',
                  transform: `translateY(${item.start}px)`,
                  fontSize: `${settings.fontSizePx}px`,
                  lineHeight: settings.lineHeight,
                  letterSpacing: `${settings.letterSpacingPx}px`,
                  color: settings.textColor,
                  fontWeight: settings.fontWeight,
                  paddingTop: isChapter ? `${settings.annotationMarginTop}px` : `${settings.paddingTop}px`,
                  paddingBottom: isChapter ? `${settings.annotationMarginBottom}px` : `${settings.paddingBottom}px`,
                  paddingLeft: `${settings.marginLeft}px`,
                  paddingRight: `${settings.marginRight}px`,
                  boxSizing: 'border-box',
                }}
              >
                <p style={{
                  marginBottom: `${settings.paragraphSpacing}px`,
                  textIndent: isChapter ? 0 : `${settings.paragraphIndent}em`,
                  textAlign: settings.justifyText ? 'justify' : 'start',
                }}>
                  {formatParagraphForDisplay(text)}
                </p>
              </div>
            )
          })}
        </div>
      </div>

      <ReaderToolbar
        settings={settings}
        showToolbar={showToolbar}
        onToggleChapters={() => setShowChapters(s => !s)}
        onToggleSettings={() => setShowSettings(s => !s)}
        onToggleSources={sharedWork && sharedWork.members.length > 1
          ? () => { setSourceError(null); setShowSources(value => !value) }
          : undefined}
      />

      {showSettings && (
        <ReaderSettingsPanel
          settings={settings}
          onClose={() => setShowSettings(false)}
          onUpdate={updateSettings}
        />
      )}

      {showChapters && (
        <ChapterPanel
          chapters={chapters}
          currentChapterIndex={currentChapterIndex}
          book={book}
          paragraphs={paragraphs}
          onClose={() => setShowChapters(false)}
          onJump={(chapterIndex, paragraphIndex) => { jumpToChapter(chapterIndex, paragraphIndex) }}
          settings={settings}
        />
      )}

      {showSources && sharedWork && (
        <SourceSwitchPanel
          work={sharedWork}
          currentBookId={bookId ?? ''}
          busy={sourceBusy}
          error={sourceError}
          settings={settings}
          onRead={(id) => { setShowSources(false); void readOtherSource(id) }}
          onPrefer={(id) => { void makePreferredSource(id) }}
          onClose={() => setShowSources(false)}
        />
      )}

      {sharedNotice?.kind === 'conflict' && sharedWork && (
        <SharedChoiceDialog
          choices={sharedNotice.choices}
          members={sharedWork.members}
          error={sharedNotice.error}
          settings={settings}
          local={sharedNotice.keepLocal ? {
            title: chapters[progressToChapterIndex(sharedNotice.keepLocal, chapters, paragraphs.length)]?.title ?? null,
            chapterProgress: sharedNotice.keepLocal.chapterProgress ?? null,
          } : undefined}
          onKeepLocal={() => { if (sharedNotice.keepLocal) keepLocalShared(sharedNotice.keepLocal) }}
          onChoose={(choice) => { void chooseSharedRecord(choice) }}
          onPickChapter={() => {
            // Still blocked: only an actual chapter choice resolves the conflict.
            setSharedNotice({ kind: 'unmapped', anchorTitle: null, message: '請選擇要從哪一章繼續；選定前不會儲存進度。' })
            setShowChapters(true)
          }}
        />
      )}

      {txtSharedCheck === 'mismatched' && (
        <div role="status" className="pointer-events-none absolute left-1/2 top-12 z-[55] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded border px-3 py-2 text-sm shadow"
          style={{ backgroundColor: settings.backgroundColor, color: settings.textColor, borderColor: settings.textColor }}>
          <p>此 TXT 偵測到的章節數與伺服器不同（可能受內容過濾或繁簡轉換影響），這次閱讀進度只記在此裝置，不同步到雲端或其他書源。</p>
          <button type="button" className="pointer-events-auto mt-1 min-h-9 text-xs underline" onClick={() => setTxtSharedCheck(null)}>知道了</button>
        </div>
      )}

      {sharedNotice?.kind === 'stale' && (
        <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-modal="true">
          <div
            data-testid="shared-progress-stale"
            className="w-full max-w-sm rounded border p-4 shadow-lg"
            style={{ backgroundColor: settings.backgroundColor, color: settings.textColor, borderColor: settings.textColor }}
          >
            <h2 className="mb-2 text-base font-semibold">閱讀進度已在其他裝置或書源更新</h2>
            <p className="mb-4 text-sm opacity-75">為避免覆蓋較新的進度，已暫停儲存。請選擇要怎麼做。</p>
            {sharedNotice.error && <p className="mb-3 text-sm text-red-600">{sharedNotice.error}</p>}
            <div className="flex flex-col gap-2">
              <button type="button" className="min-h-11 rounded border px-3 py-2 text-left text-sm" style={{ borderColor: settings.textColor }}
                onClick={() => { void jumpToLatestShared(sharedNotice) }}>跳到最新進度</button>
              <button type="button" className="min-h-11 rounded border px-3 py-2 text-left text-sm" style={{ borderColor: settings.textColor }}
                onClick={() => { void keepCurrentShared(sharedNotice) }}>保留目前位置</button>
              {sharedNotice.error && (
                <button type="button" className="min-h-11 rounded border px-3 py-2 text-left text-sm" style={{ borderColor: settings.textColor }}
                  onClick={() => window.location.reload()}>重新開啟本書</button>
              )}
            </div>
          </div>
        </div>
      )}

      {progressConflict && (
        <ProgressConflictDialog
          serverChapterIndex={progressConflict.serverChapterIndex}
          localChapterIndex={progressConflict.localChapterIndex}
          localChapterProgress={progressConflict.local.chapterProgress}
          serverChapterProgress={progressConflict.server.chapterProgress}
          settings={settings}
          reason={progressConflict.reason}
          onChoose={chooseProgress}
        />
      )}
    </div>
  )
}

function formatChoiceTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' })
}

function SharedChoiceDialog({ choices, members, error, settings, local, onKeepLocal, onChoose, onPickChapter }: {
  choices: SharedProgressChoice[]
  members: SharedWork['members']
  error?: string
  settings: ReaderSettings
  local?: { title: string | null; chapterProgress: number | null }
  onKeepLocal?: () => void
  onChoose: (choice: SharedProgressChoice) => void
  onPickChapter: () => void
}) {
  const labels = formatSourceLabels(members)
  return (
    <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-modal="true">
      <div
        data-testid="shared-progress-conflict"
        className="w-full max-w-sm rounded border p-4 shadow-lg"
        style={{ backgroundColor: settings.backgroundColor, color: settings.textColor, borderColor: settings.textColor }}
      >
        <h2 className="mb-2 text-base font-semibold">選擇要繼續的閱讀紀錄</h2>
        <p className="mb-4 text-sm opacity-75">同一本書的不同書源有不同的閱讀紀錄。請選擇要繼續的位置；原有紀錄都會保留。</p>
        {local && <p className="mb-4 text-sm opacity-75">另有不同的舊閱讀紀錄（例如其他裝置上的舊版閱讀器）；選擇「目前位置」會以此處作為共用進度，舊紀錄仍會保留。</p>}
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        <div className="flex flex-col gap-2">
          {local && (
            <button
              type="button"
              className="min-h-11 rounded border px-3 py-2 text-left text-sm"
              style={{ borderColor: settings.textColor }}
              onClick={onKeepLocal}
            >
              {['目前位置', local.title,
                local.chapterProgress === null ? null : `${Math.floor(local.chapterProgress * 100)}%`].filter(Boolean).join(' · ')}
            </button>
          )}
          {choices.map(choice => (
            <button
              key={choice.bookId}
              type="button"
              className="min-h-11 rounded border px-3 py-2 text-left text-sm"
              style={{ borderColor: settings.textColor }}
              onClick={() => onChoose(choice)}
            >
              {[labels[choice.bookId] ?? '其他書源', choice.title,
                choice.chapterProgress === null ? null : `${Math.floor(choice.chapterProgress * 100)}%`,
                formatChoiceTime(choice.updatedAt)].filter(Boolean).join(' · ')}
            </button>
          ))}
          <button
            type="button"
            className="min-h-11 rounded border px-3 py-2 text-left text-sm"
            style={{ borderColor: settings.textColor }}
            onClick={onPickChapter}
          >
            自行選擇章節
          </button>
        </div>
      </div>
    </div>
  )
}

function SourceSwitchPanel({ work, currentBookId, busy, error, settings, onRead, onPrefer, onClose }: {
  work: SharedWork
  currentBookId: string
  busy: boolean
  error: string | null
  settings: ReaderSettings
  onRead: (bookId: string) => void
  onPrefer: (bookId: string) => void
  onClose: () => void
}) {
  const labels = formatSourceLabels(work.members)
  return (
    <div
      data-testid="source-switch-panel"
      role="dialog"
      aria-label="切換書源"
      className="absolute right-2 top-14 z-[55] w-[min(24rem,calc(100%-1rem))] rounded border p-3 text-sm shadow-lg"
      style={{ backgroundColor: settings.backgroundColor, color: settings.textColor, borderColor: settings.textColor }}
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold">切換書源</h2>
        <button type="button" onClick={onClose} className="min-h-11 px-2 opacity-70">關閉</button>
      </div>
      <p className="mb-2 opacity-70">同名的書源（含上傳的 TXT）共用閱讀進度。「閱讀此來源」只開啟這一次；「設為預設書源」會先確認該來源可讀取。</p>
      {error && <p role="alert" className="mb-2 text-red-600">{error}</p>}
      <ul className="flex flex-col gap-2">
        {work.members.map(member => (
          <li key={member.id} className="rounded border p-2" style={{ borderColor: settings.textColor }}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{labels[member.id]}</span>
              {member.id === currentBookId && <span className="text-xs opacity-70">目前</span>}
              {member.id === work.preferredBookId && <span className="text-xs text-cyan-700">預設書源</span>}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {member.id !== currentBookId && (
                <button type="button" disabled={busy} onClick={() => onRead(member.id)}
                  aria-label={`閱讀此來源：${labels[member.id]}`}
                  className="min-h-11 rounded border px-3 py-1 disabled:opacity-50" style={{ borderColor: settings.textColor }}>
                  閱讀此來源
                </button>
              )}
              {member.id !== work.preferredBookId && (
                <button type="button" disabled={busy} onClick={() => onPrefer(member.id)}
                  aria-label={`設為預設書源：${labels[member.id]}`}
                  className="min-h-11 rounded border px-3 py-1 disabled:opacity-50" style={{ borderColor: settings.textColor }}>
                  設為預設書源
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
