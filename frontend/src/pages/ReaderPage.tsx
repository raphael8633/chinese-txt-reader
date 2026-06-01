import { useParams, useNavigate } from 'react-router-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import OpenCCCn2T from 'opencc-js/cn2t'
import OpenCCT2Cn from 'opencc-js/t2cn'
import type { MouseEvent, TouchEvent, CSSProperties } from 'react'
import { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import { db } from '../db.js'
import {
  streamBookContent,
  getProgress, saveProgress, getSettings, saveSettings, listBooks,
  isAuthExpiredError, loginToReader,
  type Book, type Progress, type ReaderSettings, type Chapter,
} from '../api.js'
import { resolveScrollTarget, preserveParagraphs } from '../utils/readerUtils.js'
import {
  getOfflineBook,
  readBookContentChunks,
  settingsToLocal,
} from '../offline.js'
import { AppUpdateControl } from '../AppUpdateBanner.js'

const DEFAULT_SETTINGS: ReaderSettings = {
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

// ── PanelOverlay ─────────────────────────────────────────────────────────────

interface PanelOverlayProps {
  onClose: () => void
  title: string
  children: React.ReactNode
  style?: CSSProperties
  'data-testid'?: string
}

function PanelOverlay({ onClose, title, children, style, 'data-testid': testId }: PanelOverlayProps) {
  return (
    <div
      className="fixed inset-0 z-50 md:flex md:items-center md:justify-center md:bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="flex h-full flex-col md:h-auto md:max-h-[80vh] md:w-full md:max-w-md md:rounded-xl md:shadow-2xl"
        style={style}
        data-testid={testId}
      >
        <div className="relative flex items-center border-b px-4 py-3">
          <button type="button" onClick={onClose} className="text-xl leading-none opacity-60 hover:opacity-100" aria-label="關閉">×</button>
          <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 max-w-[70%] truncate text-base font-semibold">{title}</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  )
}

// ── SectionHeader ────────────────────────────────────────────────────────────

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-4 pb-1 pt-5">
      <span className="text-xs font-semibold uppercase tracking-widest opacity-40">{label}</span>
    </div>
  )
}

// ── StepperRow ───────────────────────────────────────────────────────────────

interface StepperRowProps {
  label: string
  value: number
  min?: number
  max?: number
  onDecrease: () => void
  onIncrease: () => void
  display?: string
}

function StepperRow({ label, value, min, max, onDecrease, onIncrease, display }: StepperRowProps) {
  return (
    <div className="flex items-center border-b px-4 py-2.5">
      <span className="flex-1 text-sm">{label}</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onDecrease}
          disabled={min !== undefined && value <= min}
          className="flex h-8 w-8 items-center justify-center rounded-lg border text-base font-medium disabled:opacity-25 hover:opacity-70 transition-opacity"
          aria-label={`減少${label}`}
        >
          −
        </button>
        <span className="w-16 text-center text-sm tabular-nums">{display ?? value}</span>
        <button
          type="button"
          onClick={onIncrease}
          disabled={max !== undefined && value >= max}
          className="flex h-8 w-8 items-center justify-center rounded-lg border text-base font-medium disabled:opacity-25 hover:opacity-70 transition-opacity"
          aria-label={`增加${label}`}
        >
          +
        </button>
      </div>
    </div>
  )
}

// ── ChapterPanel ─────────────────────────────────────────────────────────────

interface ChapterPanelProps {
  chapters: Chapter[]
  currentChapterIndex: number
  book: Book | null
  paragraphs: string[]
  onClose: () => void
  onJump: (chapterParagraphIndex: number) => void
  settings: ReaderSettings
}

function ChapterPanel({ chapters, currentChapterIndex, book, paragraphs, onClose, onJump, settings }: ChapterPanelProps) {
  const currentRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ block: 'center' })
  }, [])

  function getChapterCharCount(i: number): number {
    const startPara = chapters[i].index
    const endPara = i + 1 < chapters.length ? chapters[i + 1].index : paragraphs.length
    return paragraphs.slice(startPara, endPara).reduce((sum, p) => sum + p.length, 0)
  }

  const totalChars = book?.charCount ?? paragraphs.reduce((s, p) => s + p.length, 0)

  return (
    <PanelOverlay
      title="目錄"
      onClose={onClose}
      style={{ backgroundColor: settings.backgroundColor, color: settings.textColor }}
      data-testid="chapter-panel"
    >
      <div className="border-b px-4 py-2 text-xs opacity-60">
        共 {chapters.length} 章，{(totalChars / 10000).toFixed(2)} 萬字
      </div>
      {chapters.map((chapter, i) => {
        const isCurrent = i === currentChapterIndex
        const charCount = getChapterCharCount(i)
        return (
          <button
            key={chapter.index}
            ref={isCurrent ? currentRef : undefined}
            type="button"
            className="flex w-full items-center border-b px-4 py-3 text-left text-sm hover:opacity-80"
            style={{
              color: isCurrent ? '#16a34a' : settings.textColor,
              backgroundColor: settings.backgroundColor,
            }}
            onClick={() => onJump(chapter.index)}
          >
            <span className="flex-1 truncate">{chapter.title}</span>
            <span className="ml-2 shrink-0 text-xs opacity-60">{charCount}字</span>
          </button>
        )
      })}
    </PanelOverlay>
  )
}

interface PendingProgress {
  positionType: string
  positionValue: number
}

interface ProgressCandidates {
  server: Progress
  local: Progress
}

interface ProgressConflict extends ProgressCandidates {
  serverChapterIndex: number
  localChapterIndex: number
}

const chapterPattern = /^(第[一二三四五六七八九十百千零〇\d]+[章回節卷部篇]|Chapter\s+\d+)/i
const chapterTitlePattern = /^(第[一二三四五六七八九十百千零〇\d]+[章回節卷部篇]|Chapter\s+\d+)\s*(.*)$/i
const dialoguePattern = /^[「『"']/

function mergeHardWrappedParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .flatMap(block => {
      const lines = block.split('\n').map(line => line.trim()).filter(Boolean)
      const paragraphs: string[] = []
      let pending = ''

      for (const line of lines) {
        if (chapterPattern.test(line) || dialoguePattern.test(line)) {
          if (pending) paragraphs.push(pending)
          paragraphs.push(line)
          pending = ''
          continue
        }
        pending = pending ? `${pending}${line}` : line
      }

      if (pending) paragraphs.push(pending)
      return paragraphs
    })
}

function splitParagraphs(text: string, shouldMergeHardWrap: boolean): string[] {
  return shouldMergeHardWrap ? mergeHardWrappedParagraphs(text) : preserveParagraphs(text)
}

function getChapters(paragraphs: string[]): Chapter[] {
  const chapters = paragraphs
    .map((paragraph, index) => ({ index, title: formatChapterTitle(paragraph.trim()).slice(0, 40) }))
    .filter(chapter => chapterPattern.test(chapter.title))

  return chapters.length > 0 ? chapters : [{ index: 0, title: '開頭' }]
}

function formatChapterTitle(text: string): string {
  const match = text.trim().match(chapterTitlePattern)
  if (!match) return text
  const name = match[2]?.trim()
  return name ? `${match[1]} ${name}` : match[1]
}

function formatParagraphForDisplay(text: string): string {
  return chapterPattern.test(text.trim()) ? formatChapterTitle(text) : text
}

function getCurrentChapterIndex(chapters: Chapter[], paragraphIndex: number): number {
  let currentIndex = 0
  for (let index = 0; index < chapters.length; index += 1) {
    if (chapters[index].index <= paragraphIndex) currentIndex = index
  }
  return currentIndex
}

function clampChapterIndex(index: number, chapters: Chapter[]): number {
  return Math.min(Math.max(Math.floor(index), 0), Math.max(chapters.length - 1, 0))
}

function progressToChapterIndex(progress: PendingProgress, chapters: Chapter[], paragraphCount: number): number {
  if (progress.positionType === 'chapter_index') {
    return clampChapterIndex(progress.positionValue, chapters)
  }
  const paragraphIndex = Math.min(Math.max(Math.floor(progress.positionValue), 0), Math.max(paragraphCount - 1, 0))
  return getCurrentChapterIndex(chapters, paragraphIndex)
}

function getChapterProgressRatio(chapterIndex: number, chapters: Chapter[]): number {
  if (chapters.length <= 1) return 0
  return clampChapterIndex(chapterIndex, chapters) / (chapters.length - 1)
}

function normalizeSettings(settings: ReaderSettings): ReaderSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    tapScrollPercent: settings.tapScrollPercent ?? DEFAULT_SETTINGS.tapScrollPercent,
    tapScrollMode: settings.tapScrollMode ?? DEFAULT_SETTINGS.tapScrollMode,
    hardWrapMode: settings.hardWrapMode ?? DEFAULT_SETTINGS.hardWrapMode,
    chineseConversion: settings.chineseConversion ?? DEFAULT_SETTINGS.chineseConversion,
    paddingTop: settings.paddingTop ?? DEFAULT_SETTINGS.paddingTop,
    paddingBottom: settings.paddingBottom ?? DEFAULT_SETTINGS.paddingBottom,
    annotationMarginTop: settings.annotationMarginTop ?? DEFAULT_SETTINGS.annotationMarginTop,
    annotationMarginBottom: settings.annotationMarginBottom ?? DEFAULT_SETTINGS.annotationMarginBottom,
    marginLeft: settings.marginLeft ?? DEFAULT_SETTINGS.marginLeft,
    marginRight: settings.marginRight ?? DEFAULT_SETTINGS.marginRight,
    paragraphSpacing: settings.paragraphSpacing ?? DEFAULT_SETTINGS.paragraphSpacing,
    paragraphIndent: settings.paragraphIndent ?? DEFAULT_SETTINGS.paragraphIndent,
    fontWeight: settings.fontWeight ?? DEFAULT_SETTINGS.fontWeight,
    justifyText: settings.justifyText ?? DEFAULT_SETTINGS.justifyText,
  }
}

function getChineseConverter(mode: ReaderSettings['chineseConversion']): (text: string) => string {
  if (mode === 'traditional') return OpenCCCn2T.Converter({ from: 'cn', to: 'tw' })
  if (mode === 'simplified') return OpenCCT2Cn.Converter({ from: 'tw', to: 'cn' })
  return text => text
}

function shouldMergeHardWrap(settings: ReaderSettings, isMobileViewport: boolean): boolean {
  if (settings.hardWrapMode === 'merge') return true
  if (settings.hardWrapMode === 'preserve') return false
  return !isMobileViewport
}

function getIsMobileViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(max-width: 767px)').matches
}

function getTapScrollDirection(
  event: MouseEvent<HTMLDivElement>,
  rect: DOMRect,
  mode: ReaderSettings['tapScrollMode'],
): 1 | -1 {
  if (mode === 'horizontal') {
    return event.clientX < rect.left + rect.width / 2 ? -1 : 1
  }
  if (mode === 'vertical') {
    return event.clientY < rect.top + rect.height / 2 ? -1 : 1
  }
  return 1
}

function syncProgressBestEffort(bookId: string, progress: PendingProgress): void {
  Promise.resolve(saveProgress(bookId, {
    positionType: progress.positionType,
    positionValue: progress.positionValue,
  })).catch(() => undefined)
}

export function ReaderPage() {
  const { bookId } = useParams<{ bookId: string }>()
  const navigate = useNavigate()
  const [book, setBook] = useState<Book | null>(null)
  const [rawText, setRawText] = useState('')
  const [paragraphs, setParagraphs] = useState<string[]>([])
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS)
  const [isMobileViewport, setIsMobileViewport] = useState(getIsMobileViewport)
  const [showSettings, setShowSettings] = useState(false)
  const [showChapters, setShowChapters] = useState(false)
  const [showToolbar, setShowToolbar] = useState(false)
  const [currentParagraphIndex, setCurrentParagraphIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [authExpired, setAuthExpired] = useState(false)
  const [pendingProgress, setPendingProgress] = useState<PendingProgress | null>(null)
  const [progressCandidates, setProgressCandidates] = useState<ProgressCandidates | null>(null)
  const [progressConflict, setProgressConflict] = useState<ProgressConflict | null>(null)
  const parentRef = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initialScrollDone = useRef(false)
  const touchStart = useRef<{ x: number; y: number } | null>(null)
  const chapters = getChapters(paragraphs)
  const currentChapterIndex = getCurrentChapterIndex(chapters, currentParagraphIndex)
  const currentChapterIndexRef = useRef(0)
  currentChapterIndexRef.current = currentChapterIndex
  const currentChapter = chapters[currentChapterIndex] ?? chapters[0]
  const chapterLabel = currentChapter ? `${currentChapterIndex + 1}/${chapters.length} ${currentChapter.title}` : ''
  const currentChapterTitle = currentChapter && chapterPattern.test(currentChapter.title) ? currentChapter.title : ''
  const headerTitle = [book?.title, currentChapterTitle].filter(Boolean).join(' ')
  const mergeHardWrap = shouldMergeHardWrap(settings, isMobileViewport)
  const convertChinese = useMemo(() => getChineseConverter(settings.chineseConversion), [settings.chineseConversion])

  const virtualizer = useVirtualizer({
    count: paragraphs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
    measureElement: (el: Element) => el.getBoundingClientRect().height,
    overscan: 5,
  })

  useEffect(() => {
    if (!bookId) return
    let cancelled = false

    async function applyMeta(
      progressResult: PromiseSettledResult<Progress | null>,
      settingsResult: PromiseSettledResult<ReaderSettings>,
      booksResult: PromiseSettledResult<Book[]>,
      localProgressResult: PromiseSettledResult<{ bookId: string; positionType: string; positionValue: number; updatedAt: string } | undefined>,
      localSettingsResult: PromiseSettledResult<(ReaderSettings & { bookId: string | null }) | undefined>,
      localBookResult: PromiseSettledResult<Book | undefined>,
    ) {
      if (localSettingsResult.status === 'fulfilled' && localSettingsResult.value) {
        setSettings(normalizeSettings(localSettingsResult.value))
      } else if (settingsResult.status === 'fulfilled') {
        const loadedSettings = normalizeSettings(settingsResult.value)
        setSettings(loadedSettings)
        await db.settings.put(settingsToLocal(loadedSettings, '__global__')).catch(() => undefined)
      }
      if (booksResult.status === 'fulfilled') {
        const found = booksResult.value.find(b => b.id === bookId)
        if (found) setBook(found)
      } else if (localBookResult.status === 'fulfilled' && localBookResult.value) {
        setBook(localBookResult.value)
      }
      const serverProgress = progressResult.status === 'fulfilled' ? progressResult.value : null
      const localProgress = localProgressResult.status === 'fulfilled' ? localProgressResult.value : null
      if (serverProgress && localProgress) {
        setProgressCandidates({ server: serverProgress, local: localProgress })
      } else if (serverProgress) {
        setPendingProgress(serverProgress)
        await db.progress.put({ bookId: bookId!, ...serverProgress }).catch(() => undefined)
      } else if (localProgress) {
        setPendingProgress(localProgress)
        syncProgressBestEffort(bookId!, localProgress)
      } else {
        initialScrollDone.current = true
      }
    }

    async function load() {
      try {
        initialScrollDone.current = false
        setPendingProgress(null)
        setProgressCandidates(null)
        setProgressConflict(null)
        setError(null)
        setAuthExpired(false)

        const cached = await readBookContentChunks(bookId!)
        if (cancelled) return

        if (cached !== null) {
          const results = await Promise.allSettled([
            getProgress(bookId!),
            getSettings(),
            listBooks(),
            db.progress.get(bookId!),
            db.settings.get('__global__'),
            getOfflineBook(bookId!),
          ])
          if (cancelled) return
          setRawText(cached)
          setLoading(false)
          await applyMeta(...(results as Parameters<typeof applyMeta>))
          return
        }

        const metaPromise = Promise.allSettled([
          getProgress(bookId!),
          getSettings(),
          listBooks(),
          db.progress.get(bookId!),
          db.settings.get('__global__'),
          getOfflineBook(bookId!),
        ])

        let accumulated = ''
        let loadingShown = false
        let midPointShown = false

        for await (const chunk of streamBookContent(bookId!)) {
          if (cancelled) return
          accumulated += chunk

          if (!loadingShown) {
            loadingShown = true
            setRawText(accumulated)
            setLoading(false)
            const results = await metaPromise
            if (cancelled) return
            await applyMeta(...(results as Parameters<typeof applyMeta>))
          } else if (!midPointShown && accumulated.length >= 1_000_000) {
            midPointShown = true
            setRawText(accumulated)
          }
        }

        if (!cancelled) {
          setRawText(accumulated)
          if (!loadingShown) setLoading(false)
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
    return () => { cancelled = true }
  }, [bookId])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const query = window.matchMedia('(max-width: 767px)')
    const update = () => setIsMobileViewport(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (initialScrollDone.current) {
      setPendingProgress({ positionType: 'chapter_index', positionValue: currentChapterIndexRef.current })
    }
    setParagraphs(splitParagraphs(convertChinese(rawText), mergeHardWrap))
  }, [convertChinese, mergeHardWrap, rawText])

  useEffect(() => {
    if (!bookId || progressCandidates === null || paragraphs.length === 0) return

    const serverChapterIndex = progressToChapterIndex(progressCandidates.server, chapters, paragraphs.length)
    const localChapterIndex = progressToChapterIndex(progressCandidates.local, chapters, paragraphs.length)
    const serverRatio = getChapterProgressRatio(serverChapterIndex, chapters)
    const localRatio = getChapterProgressRatio(localChapterIndex, chapters)
    const gap = Math.abs(serverRatio - localRatio)

    if (gap >= 0.1) {
      setProgressConflict({
        ...progressCandidates,
        serverChapterIndex,
        localChapterIndex,
      })
      setProgressCandidates(null)
      return
    }

    const normalizedWinner = {
      positionType: 'chapter_index',
      positionValue: Math.max(localChapterIndex, serverChapterIndex),
    }
    setPendingProgress(normalizedWinner)
    setProgressCandidates(null)
    db.progress.put({
      bookId,
      ...normalizedWinner,
      updatedAt: new Date().toISOString(),
    }).catch(() => undefined)
    if (localChapterIndex !== serverChapterIndex) {
      syncProgressBestEffort(bookId, normalizedWinner)
    }
  }, [bookId, chapters, paragraphs.length, progressCandidates])

  useEffect(() => {
    if (pendingProgress === null || paragraphs.length === 0) return
    const index = resolveScrollTarget(pendingProgress, chapters, paragraphs.length)
    if (index === null) return
    requestAnimationFrame(() => {
      virtualizer.scrollToIndex(index, { align: 'start' })
      initialScrollDone.current = true
      setPendingProgress(null)
    })
  }, [chapters, paragraphs.length, pendingProgress, virtualizer])

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [])

  const handleScroll = useCallback(() => {
    if (!initialScrollDone.current || paragraphs.length === 0) return
    const items = virtualizer.getVirtualItems()
    if (items.length === 0) return
    const centerItem = items[Math.floor(items.length / 2)]
    if (!centerItem) return
    const nextChapterIndex = getCurrentChapterIndex(chapters, centerItem.index)
    setCurrentParagraphIndex(centerItem.index)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      if (!bookId) return
      await db.progress.put({
        bookId, positionType: 'chapter_index',
        positionValue: nextChapterIndex, updatedAt: new Date().toISOString(),
      })
      try {
        await saveProgress(bookId, { positionType: 'chapter_index', positionValue: nextChapterIndex })
      } catch { /* ignore network errors */ }
    }, 2000)
  }, [bookId, chapters, paragraphs.length, virtualizer])

  async function updateSettings(updates: Partial<ReaderSettings>) {
    const next = normalizeSettings({ ...settings, ...updates })
    setSettings(next)
    await db.settings.put(settingsToLocal(next, '__global__')).catch(() => undefined)
    try { await saveSettings({ ...next, bookId: null }) } catch { /* ignore */ }
  }

  async function chooseProgress(chapterIndex: number) {
    if (!bookId) return
    const next = { positionType: 'chapter_index', positionValue: clampChapterIndex(chapterIndex, chapters) }
    setProgressConflict(null)
    setPendingProgress(next)
    await db.progress.put({
      bookId,
      ...next,
      updatedAt: new Date().toISOString(),
    }).catch(() => undefined)
    syncProgressBestEffort(bookId, next)
  }

  function jumpToChapter(index: number) {
    const nextChapterIndex = getCurrentChapterIndex(chapters, index)
    virtualizer.scrollToIndex(index, { align: 'start' })
    setCurrentParagraphIndex(index)
    if (bookId) {
      const next = { positionType: 'chapter_index', positionValue: nextChapterIndex }
      db.progress.put({
        bookId,
        ...next,
        updatedAt: new Date().toISOString(),
      }).catch(() => undefined)
      syncProgressBestEffort(bookId, next)
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
    container.scrollBy({
      top: direction * container.clientHeight * (settings.tapScrollPercent / 100),
      behavior: 'smooth',
    })
  }

  function handleTouchStart(event: TouchEvent<HTMLDivElement>) {
    if (showSettings || showChapters) return
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
  const toolbarPositionClass = toolbarOnLeft
    ? 'right-0 border-l md:right-auto md:left-0 md:border-l-0 md:border-r'
    : 'right-0 border-l'
  const mobileToolbarClass = showToolbar ? 'translate-x-0' : 'translate-x-full md:translate-x-0'
  const readerOverflowClass = showToolbar ? 'overflow-hidden md:overflow-y-auto' : 'overflow-y-auto'
  const TOOLBAR_WIDTH_PX = 96 // matches md:w-24
  const contentPaddingLeft = !isMobileViewport && toolbarOnLeft
    ? settings.marginLeft + TOOLBAR_WIDTH_PX
    : settings.marginLeft
  const contentPaddingRight = !isMobileViewport && !toolbarOnLeft
    ? settings.marginRight + TOOLBAR_WIDTH_PX
    : settings.marginRight

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
        <button onClick={() => navigate('/')} className="text-sm opacity-60">← 書庫</button>
        <div className="min-w-0 flex-1 px-3 text-center">
          <div className="truncate text-sm font-medium">{headerTitle}</div>
          <div className="truncate text-xs opacity-60 md:hidden">{chapterLabel}</div>
        </div>
        <button
          type="button"
          onClick={() => setShowToolbar(true)}
          className="text-sm opacity-60 md:invisible"
          aria-label="開啟工具列"
        >
          工具
        </button>
      </div>

      <div
        ref={parentRef}
        onScroll={handleScroll}
        onClick={handleReaderClick}
        className={`flex-1 py-4 ${readerOverflowClass}`}
        style={{
          backgroundColor: settings.backgroundColor,
          paddingLeft: `${contentPaddingLeft}px`,
          paddingRight: `${contentPaddingRight}px`,
        }}
      >
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
          {virtualizer.getVirtualItems().map(item => {
            const text = paragraphs[item.index]
            const isChapter = chapterPattern.test(text?.trim() ?? '')
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

      <aside
        className={`fixed bottom-0 top-0 z-40 flex w-72 max-w-[82vw] flex-col items-stretch gap-3 border-black/10 px-4 py-16 shadow-lg transition-transform md:absolute md:w-24 md:px-2 md:shadow-none ${toolbarPositionClass} ${mobileToolbarClass}`}
        style={{ backgroundColor: settings.backgroundColor, color: settings.textColor }}
        data-testid="reader-toolbar"
      >
        <button
          type="button"
          onClick={() => setShowChapters(s => !s)}
          className="flex h-11 items-center justify-start rounded border px-3 text-sm md:justify-center md:px-1 md:text-xs"
          style={{ borderColor: settings.textColor, color: settings.textColor }}
        >
          章節
        </button>
        <button
          type="button"
          onClick={() => setShowSettings(s => !s)}
          className="flex h-11 items-center justify-start rounded border px-3 text-sm md:justify-center md:px-1 md:text-xs"
          style={{ borderColor: settings.textColor }}
        >
          設定
        </button>
        <AppUpdateControl
          className="min-h-11 rounded border px-3 text-left text-sm disabled:opacity-50 md:px-1 md:text-center md:text-xs"
        />
      </aside>

      {showSettings && (
        <PanelOverlay
          title="閱讀設定"
          onClose={() => setShowSettings(false)}
          style={{ backgroundColor: settings.backgroundColor, color: settings.textColor }}
          data-testid="settings-panel"
        >
          {/* Live text preview */}
          <div
            className="border-b px-5 py-4"
            style={{
              fontSize: `${settings.fontSizePx}px`,
              lineHeight: settings.lineHeight,
              letterSpacing: `${settings.letterSpacingPx}px`,
              fontWeight: settings.fontWeight,
            }}
          >
            <p style={{
              textIndent: `${settings.paragraphIndent}em`,
              textAlign: settings.justifyText ? 'justify' : 'start',
              margin: 0,
            }}>
              君不見，黃河之水天上來，奔流到海不復回。君不見，高堂明鏡悲白髮，朝如青絲暮成雪。
            </p>
          </div>

          <SectionHeader label="字型" />
          <StepperRow
            label="字體大小" value={settings.fontSizePx} min={12} max={32}
            display={`${settings.fontSizePx}px`}
            onDecrease={() => updateSettings({ fontSizePx: settings.fontSizePx - 1 })}
            onIncrease={() => updateSettings({ fontSizePx: settings.fontSizePx + 1 })}
          />
          <StepperRow
            label="行距" value={settings.lineHeight} min={1.2} max={4.0}
            display={settings.lineHeight.toFixed(1)}
            onDecrease={() => updateSettings({ lineHeight: Math.round((settings.lineHeight - 0.1) * 10) / 10 })}
            onIncrease={() => updateSettings({ lineHeight: Math.round((settings.lineHeight + 0.1) * 10) / 10 })}
          />
          <StepperRow
            label="字距" value={settings.letterSpacingPx} min={0} max={20}
            display={`${settings.letterSpacingPx.toFixed(1)}px`}
            onDecrease={() => updateSettings({ letterSpacingPx: Math.round((settings.letterSpacingPx - 0.5) * 10) / 10 })}
            onIncrease={() => updateSettings({ letterSpacingPx: Math.round((settings.letterSpacingPx + 0.5) * 10) / 10 })}
          />
          <StepperRow
            label="字重" value={settings.fontWeight} min={100} max={900}
            onDecrease={() => updateSettings({ fontWeight: settings.fontWeight - 100 })}
            onIncrease={() => updateSettings({ fontWeight: settings.fontWeight + 100 })}
          />
          <div className="flex items-center border-b px-4 py-2.5">
            <span className="flex-1 text-sm">兩端對齊</span>
            <button
              type="button"
              onClick={() => updateSettings({ justifyText: !settings.justifyText })}
              className={`relative inline-flex flex-shrink-0 h-6 w-11 rounded-full transition-colors ${settings.justifyText ? 'bg-teal-500' : 'bg-black/20'}`}
              aria-label="兩端對齊"
            >
              <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${settings.justifyText ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>

          <SectionHeader label="排版" />
          <div className="flex items-center gap-2 border-b px-4 py-2.5">
            <span className="flex-1 text-sm">繁簡轉換</span>
            <div className="flex gap-1">
              {(
                [
                  { value: 'none', label: '不轉換' },
                  { value: 'traditional', label: '轉繁體' },
                  { value: 'simplified', label: '轉簡體' },
                ] as const
              ).map(option => (
                <button
                  key={option.value}
                  className={`rounded-md border px-2.5 py-1 text-xs transition-all ${settings.chineseConversion === option.value ? 'font-semibold opacity-100' : 'opacity-40'}`}
                  style={{ borderColor: settings.textColor, color: settings.textColor }}
                  onClick={() => updateSettings({ chineseConversion: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <StepperRow
            label="段首縮進" value={settings.paragraphIndent} min={-3} max={6}
            display={`${settings.paragraphIndent.toFixed(1)}em`}
            onDecrease={() => updateSettings({ paragraphIndent: Math.round((settings.paragraphIndent - 0.5) * 10) / 10 })}
            onIncrease={() => updateSettings({ paragraphIndent: Math.round((settings.paragraphIndent + 0.5) * 10) / 10 })}
          />
          <StepperRow
            label="段落間距" value={settings.paragraphSpacing} min={0} max={50}
            display={`${settings.paragraphSpacing}px`}
            onDecrease={() => updateSettings({ paragraphSpacing: settings.paragraphSpacing - 1 })}
            onIncrease={() => updateSettings({ paragraphSpacing: settings.paragraphSpacing + 1 })}
          />
          <StepperRow
            label="左邊距" value={settings.marginLeft} min={0} max={80}
            display={`${settings.marginLeft}px`}
            onDecrease={() => updateSettings({ marginLeft: settings.marginLeft - 1 })}
            onIncrease={() => updateSettings({ marginLeft: settings.marginLeft + 1 })}
          />
          <StepperRow
            label="右邊距" value={settings.marginRight} min={0} max={80}
            display={`${settings.marginRight}px`}
            onDecrease={() => updateSettings({ marginRight: settings.marginRight - 1 })}
            onIncrease={() => updateSettings({ marginRight: settings.marginRight + 1 })}
          />
          <StepperRow
            label="正文上邊距" value={settings.paddingTop} min={0} max={50}
            display={`${settings.paddingTop}px`}
            onDecrease={() => updateSettings({ paddingTop: settings.paddingTop - 1 })}
            onIncrease={() => updateSettings({ paddingTop: settings.paddingTop + 1 })}
          />
          <StepperRow
            label="正文下邊距" value={settings.paddingBottom} min={0} max={50}
            display={`${settings.paddingBottom}px`}
            onDecrease={() => updateSettings({ paddingBottom: settings.paddingBottom - 1 })}
            onIncrease={() => updateSettings({ paddingBottom: settings.paddingBottom + 1 })}
          />
          <StepperRow
            label="章節上邊距" value={settings.annotationMarginTop} min={0} max={50}
            display={`${settings.annotationMarginTop}px`}
            onDecrease={() => updateSettings({ annotationMarginTop: settings.annotationMarginTop - 1 })}
            onIncrease={() => updateSettings({ annotationMarginTop: settings.annotationMarginTop + 1 })}
          />
          <StepperRow
            label="章節下邊距" value={settings.annotationMarginBottom} min={0} max={50}
            display={`${settings.annotationMarginBottom}px`}
            onDecrease={() => updateSettings({ annotationMarginBottom: settings.annotationMarginBottom - 1 })}
            onIncrease={() => updateSettings({ annotationMarginBottom: settings.annotationMarginBottom + 1 })}
          />

          <SectionHeader label="主題" />
          <div className="flex items-center gap-3 border-b px-4 py-3">
            {(
              [
                { text: '#333333', bg: '#f5f0e8', label: '米白' },
                { text: '#e8dcc8', bg: '#1a1a2e', label: '暗黑' },
                { text: '#2d5016', bg: '#e8f5e9', label: '護眼' },
              ] as const
            ).map(preset => {
              const isActive = settings.textColor === preset.text && settings.backgroundColor === preset.bg
              return (
                <button
                  key={preset.label}
                  className="flex flex-col items-center gap-1.5"
                  onClick={() => updateSettings({ textColor: preset.text, backgroundColor: preset.bg })}
                >
                  <div
                    className={`flex h-10 w-16 items-center justify-center rounded-lg text-xs font-medium transition-all ${isActive ? 'ring-2 ring-offset-1' : 'opacity-70 hover:opacity-90'}`}
                    style={{
                      backgroundColor: preset.bg,
                      color: preset.text,
                      borderColor: preset.text + '40',
                      border: `1px solid ${preset.text}40`,
                      '--tw-ring-color': preset.text,
                    } as CSSProperties & Record<'--tw-ring-color', string>}
                  >
                    {isActive ? '✓' : '文'}
                  </div>
                  <span className="text-xs opacity-60">{preset.label}</span>
                </button>
              )
            })}
          </div>

          <SectionHeader label="操作" />
          <div className="flex items-center gap-2 border-b px-4 py-2.5">
            <span className="flex-1 text-sm">點擊模式</span>
            <div className="flex gap-1">
              {(
                [
                  { value: 'allDown', label: '向下' },
                  { value: 'vertical', label: '上下' },
                  { value: 'horizontal', label: '左右' },
                ] as const
              ).map(option => (
                <button
                  key={option.value}
                  className={`rounded-md border px-2.5 py-1 text-xs transition-all ${settings.tapScrollMode === option.value ? 'font-semibold opacity-100' : 'opacity-40'}`}
                  style={{ borderColor: settings.textColor, color: settings.textColor }}
                  onClick={() => updateSettings({ tapScrollMode: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <StepperRow
            label="點擊捲動" value={settings.tapScrollPercent} min={50} max={100}
            display={`${settings.tapScrollPercent}%`}
            onDecrease={() => updateSettings({ tapScrollPercent: settings.tapScrollPercent - 5 })}
            onIncrease={() => updateSettings({ tapScrollPercent: settings.tapScrollPercent + 5 })}
          />
          <div className="flex items-center gap-2 border-b px-4 py-2.5">
            <span className="flex-1 text-sm">工具列</span>
            <div className="flex gap-1">
              {(
                [
                  { value: 'left', label: '左側' },
                  { value: 'right', label: '右側' },
                ] as const
              ).map(option => (
                <button
                  key={option.value}
                  className={`rounded-md border px-3 py-1 text-xs transition-all ${settings.toolbarSide === option.value ? 'font-semibold opacity-100' : 'opacity-40'}`}
                  style={{ borderColor: settings.textColor, color: settings.textColor }}
                  onClick={() => updateSettings({ toolbarSide: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 pb-6 px-4 py-2.5">
            <span className="flex-1 text-sm">換行</span>
            <div className="flex gap-1">
              {(
                [
                  { value: 'auto', label: '自動' },
                  { value: 'merge', label: '合併' },
                  { value: 'preserve', label: '保留' },
                ] as const
              ).map(option => (
                <button
                  key={option.value}
                  className={`rounded-md border px-2.5 py-1 text-xs transition-all ${settings.hardWrapMode === option.value ? 'font-semibold opacity-100' : 'opacity-40'}`}
                  style={{ borderColor: settings.textColor, color: settings.textColor }}
                  onClick={() => updateSettings({ hardWrapMode: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </PanelOverlay>
      )}

      {showChapters && (
        <ChapterPanel
          chapters={chapters}
          currentChapterIndex={currentChapterIndex}
          book={book}
          paragraphs={paragraphs}
          onClose={() => setShowChapters(false)}
          onJump={(idx) => { jumpToChapter(idx) }}
          settings={settings}
        />
      )}

      {progressConflict && (
        <div
          className="absolute inset-0 z-[60] flex items-center justify-center bg-black/40 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="progress-conflict-title"
        >
          <div
            className="w-full max-w-sm rounded border p-4 shadow-lg"
            style={{ backgroundColor: settings.backgroundColor, color: settings.textColor, borderColor: settings.textColor }}
            data-testid="progress-conflict"
          >
            <h2 id="progress-conflict-title" className="mb-2 text-base font-semibold">閱讀進度不同步</h2>
            <p className="mb-4 text-sm opacity-75">
              此裝置與雲端進度差距超過 10%，請選擇要繼續的章節。
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className="rounded border px-3 py-2 text-left text-sm"
                style={{ borderColor: settings.textColor }}
                onClick={() => chooseProgress(progressConflict.localChapterIndex)}
              >
                使用此裝置：第 {progressConflict.localChapterIndex + 1} 章
              </button>
              <button
                type="button"
                className="rounded border px-3 py-2 text-left text-sm"
                style={{ borderColor: settings.textColor }}
                onClick={() => chooseProgress(progressConflict.serverChapterIndex)}
              >
                使用雲端：第 {progressConflict.serverChapterIndex + 1} 章
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
