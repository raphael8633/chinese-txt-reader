import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { parseChapterOrdinal } from '../../utils/chapterOrdinal.js'
import { readWork, reconcileWorks, remapSharedManifest } from '../sharedProgress.js'
import { titleKey } from '../../utils/titleKey.js'
import {
  HostRateLimiter,
  runWithFetchBudget,
  type FetchBudget,
  type FetchBudgetUsage,
} from '../fetch/SafeFetchService.js'
import { WebSourceHttpError } from './fetchGuard.js'
import { UnsupportedWebSourceError, type ParsedWebSource, type WebSourceChapter, type WebSourceProvider, type WebSourceSearchHit } from './types.js'
import { summarizeSequenceWarnings, type WarningDetail } from './sequenceWarningSummary.js'
import { analyzeChapterSequence } from './sequenceAnalysis.js'
import {
  END_OF_BOOK_ANCHOR_KEY,
  START_OF_BOOK_ANCHOR_KEY,
  detectSupplementCandidates,
  mergeSupplements,
  normalizeChapterName,
  type AlignChapter,
  type ChapterAnchor,
} from './crossSourceSupplement.js'

const MAX_WEB_SOURCE_CHAPTERS = 5000
type ResolvedWebSourceChapter = WebSourceChapter & { chapterKey: string }
const GENERIC_PROVIDER_ID = 'generic'
const PREVIEW_TOKEN_TTL_MS = 10 * 60 * 1000
/** Per user, so a burst of previews from one account cannot evict another's tokens. */
const MAX_PREVIEW_TOKENS_PER_USER = 20
const PREVIEW_CHAPTER_SAMPLE = 3
/** Fetches a chapter-list parse may use before its cost is worth telling the user about. */
const CHAPTER_LIST_FETCH_WARN_THRESHOLD = 12

const DEFAULT_CHAPTER_LIST_BUDGET: FetchBudget = {
  // site-d gap recovery legitimately issues ~100 requests on a long directory.
  maxFetches: 120,
  maxBytes: 20 * 1024 * 1024,
  deadlineMs: 120_000,
}
const DEFAULT_SEARCH_BUDGET: FetchBudget = {
  maxFetches: 6,
  maxBytes: 8 * 1024 * 1024,
  deadlineMs: 30_000,
}
const DEFAULT_CHAPTER_FETCH_BUDGET: FetchBudget = {
  // In-chapter pagination follows "next page" links; 10 caps a runaway chain.
  maxFetches: 10,
  maxBytes: 8 * 1024 * 1024,
  deadlineMs: 60_000,
}

export { UnsupportedWebSourceError }

export class UnsupportedWebSourceHostError extends UnsupportedWebSourceError {
  constructor(url: string, host: string, supportedHosts: string[]) {
    super(url)
    this.message = supportedHosts.length > 0
      ? `不支援的網域：${host}。目前支援的站點：${supportedHosts.join('、')}`
      : `不支援的網域：${host}`
    this.name = 'UnsupportedWebSourceHostError'
  }
}

export class UnsupportedWebSourcePathError extends UnsupportedWebSourceError {
  constructor(url: string, host: string, listUrlExample: string | undefined) {
    super(url)
    this.message = listUrlExample
      ? `此網址不是 ${host} 的章節目錄格式，請貼形如 ${listUrlExample} 的目錄頁網址`
      : `此網址不是 ${host} 的章節目錄格式，請貼章節目錄頁網址`
    this.name = 'UnsupportedWebSourcePathError'
  }
}

export class WebSourcePreviewRequiredError extends Error {
  constructor() {
    super('此網址需要先預覽確認解析結果，請改用預覽流程')
    this.name = 'WebSourcePreviewRequiredError'
  }
}

export class InvalidWebSourceUrlError extends Error {
  constructor() {
    super('網址格式不正確，請貼完整的章節目錄網址（含 https://）')
    this.name = 'InvalidWebSourceUrlError'
  }
}

export class EmptyWebSourceUrlError extends Error {
  constructor() {
    super('URL must not be empty')
    this.name = 'EmptyWebSourceUrlError'
  }
}

export class WebSourceTooLargeError extends Error {
  constructor() {
    super(`Web source has more than ${MAX_WEB_SOURCE_CHAPTERS} chapters`)
    this.name = 'WebSourceTooLargeError'
  }
}

export class WebSourceNotFoundError extends Error {
  constructor() {
    super('Web source book not found')
    this.name = 'WebSourceNotFoundError'
  }
}

export class WebSourceRefreshConflictError extends Error {
  constructor() {
    super('Web source manifest changed during refresh')
    this.name = 'WebSourceRefreshConflictError'
  }
}

export class WebSourcePreferredSourceConflictError extends Error {
  constructor() {
    super('預設書源已變更；只能替目前預設書源補章')
    this.name = 'WebSourcePreferredSourceConflictError'
  }
}

export class WebSourceSupplementPreviewExpiredError extends Error {
  constructor() {
    super('補章預覽已過期或無效，請重新預覽')
    this.name = 'WebSourceSupplementPreviewExpiredError'
  }
}

export class WebSourceSupplementSelectionError extends Error {
  constructor(message = '選取的補章項目不在本次預覽中，請重新預覽') {
    super(message)
    this.name = 'WebSourceSupplementSelectionError'
  }
}

export class WebSourceSupplementBatchNotFoundError extends Error {
  constructor() {
    super('找不到可撤銷的補章紀錄')
    this.name = 'WebSourceSupplementBatchNotFoundError'
  }
}

export type WebSourceBookView = {
  id: string
  title: string
  charCount: number
  fileSize: number
  paragraphCount: number
  chapters: Array<{ index: number; title: string; sourceUrl: string; chapterKey: string }>
  createdAt: string
  updatedAt: string
  sourceType: 'web'
  sourceUrl: string
  manifestVersion: number
  /** Undoable supplement batches (with at least one active row); set by refresh/apply/undo. */
  supplementBatchCount?: number
  latestSupplementBatch?: WebSourceSupplementBatch | null
  warnings?: string[]
  warningDetails?: WarningDetail[]
  debugMessages?: string[]
}

export type WebSourceChapterWindow = {
  chapters: Array<{
    index: number
    title: string
    sourceUrl: string
    sourceTimestamp: string
    contentHash: string
    text: string
  }>
}

export type WebSourceSearchResponse = {
  candidates: WebSourceSearchHit[]
  errors: Array<{ providerId: string; message: string }>
}

export type WebSourceRefreshResult = {
  book: WebSourceBookView
  previousChapterCount: number
  newChapterCount: number
  progressRemap: {
    previousPosition: number
    newPosition: number
    matchedBy: 'chapter_key' | 'source_url' | 'position'
  } | null
  warnings?: string[]
  warningDetails?: WarningDetail[]
  debugMessages?: string[]
}

export type WebSourceProviderSummary = {
  providerId: string
  displayName: string
  displayHost: string | null
  listUrlExample: string | null
}

export type WebSourcePreview = {
  previewToken: string
  providerId: string
  displayName: string
  title: string
  chapterCount: number
  firstChapters: Array<{ index: number; title: string }>
  lastChapters: Array<{ index: number; title: string }>
  warnings: string[]
  warningDetails?: WarningDetail[]
  debugMessages?: string[]
  isGeneric: boolean
}

type PreviewEntry = {
  userId: string
  url: string
  providerId: string
  parsed: ParsedWebSource
  warnings: string[]
  warningDetails: WarningDetail[]
  createdAtMs: number
}

export type WebSourceSupplementCandidate = {
  id: string
  donorBookId: string
  donorProviderId: string
  donorDisplayName: string
  title: string
  url: string
  insertAfterTitle: string
  insertBeforeTitle: string
  /** 0-based manifest index of the insert-after anchor (disambiguates duplicate titles). */
  insertAfterIndex: number
  /** Appended at the end of the book (trailing 番外); insertBeforeTitle is then ''. */
  atEnd: boolean
}

export type WebSourceSupplementAmbiguity = {
  donorBookId: string
  donorDisplayName: string
  reason: 'renamed_or_variant' | 'unbracketed' | 'mixed_with_supplement' | 'name_elsewhere'
    | 'conflicting_donors' | 'pending_supplement' | 'no_name'
  donorTitles: string[]
  primaryTitles: string[]
  afterTitle: string | null
  primaryBefore: string[]
  primaryAfter: string[]
  donorBefore: string[]
  donorAfter: string[]
  manualChapters: Array<{ id: string; title: string }>
}

export type WebSourceSupplementBatch = {
  batchId: string
  createdAt: string
  count: number
  titles: string[]
}

export type WebSourceSupplementPreview = {
  previewToken: string
  manifestVersion: number
  candidateHash: string
  donors: Array<{
    bookId: string
    providerId: string
    displayName: string
    chapterCount: number
    matchedCount: number
  }>
  candidates: WebSourceSupplementCandidate[]
  ambiguous: WebSourceSupplementAmbiguity[]
  excludedNotes: Array<{ donorBookId: string; donorDisplayName: string; title: string }>
  batches: WebSourceSupplementBatch[]
}

export type WebSourceSupplementResult = WebSourceRefreshResult & {
  batchId: string
  changedCount: number
}

type SupplementCandidateEntry = WebSourceSupplementCandidate & {
  chapterKey: string
  donorIndex: number
  seq: number
  anchorAfter: ChapterAnchor
  /** null = end of the book. */
  anchorBefore: ChapterAnchor | null
}

type SupplementPreviewEntry = {
  userId: string
  bookId: string
  manifestVersion: number
  workId: string
  titleKey: string
  donorVersions: Map<string, number>
  /** Preview-bound candidates; apply sorts selected rows by donor rank/index. */
  candidates: Map<string, SupplementCandidateEntry>
  manual: Map<string, { donorBookId: string; donorProviderId: string; donorIndex: number; title: string; url: string; chapterKey: string }>
  donorRank: Map<string, number>
  primary: AlignChapter[]
  createdAtMs: number
}

type SupplementRow = {
  id: string
  batch_id: string
  seq: number
  donor_book_id: string
  donor_provider_id: string
  url: string
  chapter_key: string
  title: string
  anchor_after_key: string
  anchor_after_title: string
  anchor_before_key: string
  anchor_before_title: string
  created_at: string
}

type ManifestRow = {
  chapter_index: number
  title: string
  url: string
  chapter_key: string | null
}

type WebBookRecord = {
  id: string
  title: string
  file_size: number
  char_count: number
  paragraph_count: number
  source_type: string
  source_url: string | null
  provider_id: string | null
  manifest_version: number
  created_at: string
}

type StoredChapter = {
  text: string
  content_hash: string
  fetched_at: string
}

type WebBookChapterRow = {
  chapter_index: number
  title: string
  url: string
  created_at: string
}

export class WebSourceService {
  private readonly db: Database.Database
  private readonly providers: WebSourceProvider[]
  private readonly createId: () => string
  private readonly now: () => string
  private readonly fetchConcurrency: number
  private readonly sleep: (delayMs: number) => Promise<void>
  private readonly rateLimitRetryBaseMs: number
  private readonly rateLimitMaxRetries: number
  private readonly nowMs: () => number
  private readonly rateLimiter: HostRateLimiter
  private readonly chapterListBudget: FetchBudget
  private readonly searchBudget: FetchBudget
  private readonly chapterFetchBudget: FetchBudget
  private readonly logDebug: (message: string) => void
  private readonly loggedProviderMismatches = new Set<string>()
  private readonly previewCache = new Map<string, PreviewEntry>()
  private readonly supplementPreviewCache = new Map<string, SupplementPreviewEntry>()
  private readonly chapterFetches = new Map<string, Promise<StoredChapter>>()
  private readonly fetchWaiters: Array<() => void> = []
  private readonly activeFetchHosts = new Set<string>()
  private readonly hostFetchWaiters = new Map<string, Array<() => void>>()
  private activeFetches = 0

  constructor(deps: {
    db: Database.Database
    providers: WebSourceProvider[]
    createId?: () => string
    now?: () => string
    fetchConcurrency?: number
    sleep?: (delayMs: number) => Promise<void>
    rateLimitRetryBaseMs?: number
    rateLimitMaxRetries?: number
    nowMs?: () => number
    rateLimiter?: HostRateLimiter
    chapterListBudget?: FetchBudget
    searchBudget?: FetchBudget
    chapterFetchBudget?: FetchBudget
    logDebug?: (message: string) => void
  }) {
    this.db = deps.db
    this.providers = deps.providers
    this.createId = deps.createId ?? (() => randomUUID())
    this.now = deps.now ?? (() => new Date().toISOString())
    const requestedConcurrency = Math.floor(deps.fetchConcurrency ?? 4)
    this.fetchConcurrency = Number.isFinite(requestedConcurrency)
      ? Math.max(1, Math.min(8, requestedConcurrency))
      : 4
    this.sleep = deps.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)))
    const requestedRetryBaseMs = Math.floor(deps.rateLimitRetryBaseMs ?? 15_000)
    this.rateLimitRetryBaseMs = Number.isFinite(requestedRetryBaseMs)
      ? Math.max(1_000, Math.min(5 * 60_000, requestedRetryBaseMs))
      : 15_000
    const requestedMaxRetries = Math.floor(deps.rateLimitMaxRetries ?? 3)
    this.rateLimitMaxRetries = Number.isFinite(requestedMaxRetries)
      ? Math.max(0, Math.min(5, requestedMaxRetries))
      : 3
    this.nowMs = deps.nowMs ?? (() => Date.now())
    this.rateLimiter = deps.rateLimiter
      ?? new HostRateLimiter({ now: this.nowMs, sleep: this.sleep })
    this.chapterListBudget = deps.chapterListBudget ?? DEFAULT_CHAPTER_LIST_BUDGET
    this.searchBudget = deps.searchBudget ?? DEFAULT_SEARCH_BUDGET
    this.chapterFetchBudget = deps.chapterFetchBudget ?? DEFAULT_CHAPTER_FETCH_BUDGET
    this.logDebug = deps.logDebug ?? ((message) => console.debug(message))
  }

  /** Registry metadata for the client's source picker, in registration order. */
  listProviders(): WebSourceProviderSummary[] {
    return this.providers.map((provider) => ({
      providerId: provider.providerId,
      displayName: providerDisplayName(provider),
      displayHost: provider.displayHost ?? null,
      listUrlExample: provider.listUrlExample ?? null,
    }))
  }

  /**
   * Parses a chapter list and hands back a token instead of a book, so the user
   * confirms what was parsed before anything is written. The parse is cached, so
   * create-from-token cannot re-fetch a page that changed in between (TOCTOU).
   */
  async previewChapterListUrl(userId: string, rawUrl: string): Promise<WebSourcePreview> {
    const url = rawUrl.trim()
    if (!url) throw new EmptyWebSourceUrlError()
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      throw new InvalidWebSourceUrlError()
    }
    const provider = this.findProviderForUrl(url)
    if (!provider) throw this.describeUnsupportedUrl(parsedUrl, url)

    const { parsed, warnings: budgetWarnings } = await this.parseChapterListWithBudget(provider, url)
    if (parsed.chapters.length > MAX_WEB_SOURCE_CHAPTERS) {
      throw new WebSourceTooLargeError()
    }
    const sequence = analyzeChapterSequence(parsed.chapters)
    const { warnings, warningDetails } = summarizeSequenceWarnings([
      ...(parsed.warnings ?? []),
      ...budgetWarnings,
      ...sequence.warnings,
    ])

    const previewToken = randomUUID()
    this.storeToken(this.previewCache, previewToken, {
      userId,
      url,
      providerId: provider.providerId,
      parsed,
      warnings,
      warningDetails,
      createdAtMs: this.nowMs(),
    })

    const sample = (chapters: WebSourceChapter[]) =>
      chapters.map((chapter) => ({ index: chapter.index, title: chapter.title }))
    return {
      previewToken,
      providerId: provider.providerId,
      displayName: providerDisplayName(provider),
      title: parsed.title,
      chapterCount: parsed.chapters.length,
      firstChapters: sample(parsed.chapters.slice(0, PREVIEW_CHAPTER_SAMPLE)),
      lastChapters: sample(parsed.chapters.slice(-PREVIEW_CHAPTER_SAMPLE)),
      warnings,
      ...(warningDetails.length ? { warningDetails } : {}),
      ...((parsed.debugMessages?.length || sequence.debugMessages.length)
        ? { debugMessages: [...(parsed.debugMessages ?? []), ...sequence.debugMessages] } : {}),
      isGeneric: provider.providerId === GENERIC_PROVIDER_ID,
    }
  }

  /**
   * Fills provider_id for web books created before the column existed. Only dedicated
   * providers are assigned: pinning a row to the generic provider would freeze a
   * heuristic parse onto a book that a dedicated provider may later claim. Rows no
   * dedicated provider handles stay NULL so URL resolution still applies at read time.
   */
  backfillProviderIds(log?: (message: string) => void): number {
    const rows = this.db.prepare(
      `SELECT id, source_url FROM books
       WHERE source_type = 'web' AND source_url IS NOT NULL AND provider_id IS NULL`,
    ).all() as Array<{ id: string; source_url: string }>
    if (rows.length === 0) return 0

    const update = this.db.prepare('UPDATE books SET provider_id = ? WHERE id = ?')
    let filled = 0
    const apply = this.db.transaction(() => {
      for (const row of rows) {
        const provider = this.findDedicatedProviderForUrl(row.source_url)
        if (!provider) continue
        update.run(provider.providerId, row.id)
        filled += 1
      }
    })
    apply()
    log?.(`Backfilled provider_id for ${filled} of ${rows.length} web books`)
    return filled
  }

  async createFromChapterListUrl(
    userId: string,
    rawUrl: string,
    previewToken?: string,
  ): Promise<WebSourceBookView> {
    const url = rawUrl.trim()
    if (!url) throw new EmptyWebSourceUrlError()
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      throw new InvalidWebSourceUrlError()
    }
    const provider = this.findProviderForUrl(url)
    if (!provider) throw this.describeUnsupportedUrl(parsedUrl, url)

    // A supplied token that no longer resolves — expired, evicted, already used,
    // another user's, or minted for a different URL — is a failed confirmation, not
    // an absent one: re-fetching would create a book from a parse nobody approved.
    // Only an omitted token keeps the direct-create path, and only for dedicated
    // providers.
    let preview: PreviewEntry | null = null
    if (previewToken) {
      preview = this.consumePreview(previewToken, userId, url)
      if (!preview) throw new WebSourcePreviewRequiredError()
    }
    let parsed: ParsedWebSource
    let fetchWarnings: string[]
    if (preview) {
      parsed = preview.parsed
      fetchWarnings = preview.warnings
    } else {
      if (provider.providerId === GENERIC_PROVIDER_ID) throw new WebSourcePreviewRequiredError()
      const parseResult = await this.parseChapterListWithBudget(provider, url)
      parsed = parseResult.parsed
      fetchWarnings = parseResult.warnings
    }
    if (parsed.chapters.length > MAX_WEB_SOURCE_CHAPTERS) {
      throw new WebSourceTooLargeError()
    }
    const chapters = parsed.chapters.map((chapter) => ({
      ...chapter,
      chapterKey: resolveChapterKey(provider, chapter),
    }))

    const bookId = this.createId()
    const now = this.now()
    const chaptersJson = JSON.stringify(toChapterMetadata(chapters))
    const sourceHost = new URL(parsed.sourceUrl).hostname

    const transaction = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO books (
           id, user_id, title, original_filename, file_size, char_count,
           paragraph_count, chapters_json, source_type, source_url, provider_id,
           manifest_version, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, 0, 0, ?, ?, 'web', ?, ?, 1, ?, ?)`,
      ).run(
        bookId,
        userId,
        parsed.title,
        `web:${sourceHost}`,
        chapters.length,
        chaptersJson,
        parsed.sourceUrl,
        provider.providerId,
        now,
        now,
      )

      const insertChapter = this.db.prepare(
        `INSERT INTO web_book_chapters (
           book_id, user_id, chapter_index, title, url, chapter_key, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const chapter of chapters) {
        insertChapter.run(
          bookId,
          userId,
          chapter.index,
          chapter.title,
          chapter.url,
          chapter.chapterKey,
          now,
        )
      }
      reconcileWorks(this.db, userId)
    })
    transaction()
    const sequence = analyzeChapterSequence(chapters)
    const { warnings, warningDetails } = preview
      ? { warnings: [...fetchWarnings], warningDetails: preview.warningDetails }
      : summarizeSequenceWarnings([
          ...(parsed.warnings ?? []),
          ...fetchWarnings,
          ...sequence.warnings,
        ])

    return {
      id: bookId,
      title: parsed.title,
      charCount: 0,
      fileSize: 0,
      paragraphCount: chapters.length,
      chapters: toChapterMetadata(chapters),
      createdAt: now,
      updatedAt: now,
      sourceType: 'web',
      sourceUrl: parsed.sourceUrl,
      manifestVersion: 1,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(warningDetails.length > 0 ? { warningDetails } : {}),
      ...((parsed.debugMessages?.length || sequence.debugMessages.length)
        ? { debugMessages: [...(parsed.debugMessages ?? []), ...sequence.debugMessages] } : {}),
    }
  }

  private describeUnsupportedUrl(parsedUrl: URL, url: string): UnsupportedWebSourceError {
    const host = parsedUrl.hostname
    const hostProvider = this.providers.find((candidate) => candidate.canHandleHost?.(url))
    if (hostProvider) {
      return new UnsupportedWebSourcePathError(url, host, hostProvider.listUrlExample)
    }
    const supportedHosts = this.providers
      .map((candidate) => candidate.displayHost)
      .filter((candidate): candidate is string => Boolean(candidate))
    return new UnsupportedWebSourceHostError(url, host, supportedHosts)
  }

  async refreshFromSource(userId: string, bookId: string): Promise<WebSourceRefreshResult> {
    const book = this.db.prepare(
      `SELECT id, title, file_size, char_count, paragraph_count, source_type,
              source_url, provider_id, manifest_version, created_at
       FROM books
       WHERE id = ? AND user_id = ?`,
    ).get(bookId, userId) as {
      id: string
      title: string
      file_size: number
      char_count: number
      paragraph_count: number
      source_type: string
      source_url: string | null
      provider_id: string | null
      manifest_version: number
      created_at: string
    } | undefined
    if (!book) throw new WebSourceNotFoundError()
    if (book.source_type !== 'web' || !book.source_url) {
      throw new UnsupportedWebSourceError(book.source_url ?? '')
    }

    const provider = this.resolveProvider(book.provider_id, book.source_url, { revalidate: true })
    if (!provider) throw new UnsupportedWebSourceError(book.source_url)

    const previousChapters = this.db.prepare(
      `SELECT chapter_index, title, url, chapter_key
       FROM web_book_chapters
       WHERE book_id = ? AND user_id = ?
       ORDER BY chapter_index`,
    ).all(bookId, userId) as Array<{
      chapter_index: number
      title: string
      url: string
      chapter_key: string | null
    }>
    const supplements = this.loadActiveSupplements(bookId, userId)

    const { parsed, warnings: fetchWarnings } = await this.parseChapterListWithBudget(
      provider,
      book.source_url,
    )
    if (parsed.chapters.length > MAX_WEB_SOURCE_CHAPTERS) {
      throw new WebSourceTooLargeError()
    }
    const primaryChapters = parsed.chapters.map((chapter) => ({
      ...chapter,
      chapterKey: resolveChapterKey(provider, chapter),
    }))
    // Supplement rows are the source of truth: a refresh re-merges them into the
    // fresh primary parse instead of discarding them with the old manifest.
    const merge = describeSupplementMerge(primaryChapters, supplements)
    const chapters = merge.chapters
    const sequence = analyzeChapterSequence(parsed.chapters)
    const debugMessages = [...(parsed.debugMessages ?? []), ...sequence.debugMessages, ...merge.debugMessages]
    const now = this.now()
    const nextVersion = book.manifest_version + 1
    const chaptersJson = JSON.stringify(toChapterMetadata(chapters))

    const replaceManifest = this.db.transaction(() => {
      const current = this.db.prepare(
        `SELECT manifest_version FROM books WHERE id = ? AND user_id = ?`,
      ).get(bookId, userId) as { manifest_version: number } | undefined
      if (!current) throw new WebSourceNotFoundError()
      if (current.manifest_version !== book.manifest_version) {
        throw new WebSourceRefreshConflictError()
      }

      this.replaceManifestRows(bookId, userId, chapters, now)
      const updated = this.db.prepare(
        `UPDATE books
         SET paragraph_count = ?, chapters_json = ?, source_url = ?, provider_id = ?,
             manifest_version = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND manifest_version = ?`,
      ).run(
        chapters.length,
        chaptersJson,
        parsed.sourceUrl,
        provider.providerId,
        nextVersion,
        now,
        bookId,
        userId,
        book.manifest_version,
      )
      if (updated.changes !== 1) throw new WebSourceRefreshConflictError()
      // Progress is read here, after the network parse: a save made while the
      // parse was in flight must be the position that gets remapped (not a stale one).
      const remap = this.remapStoredProgress(bookId, userId, previousChapters, chapters)
      this.applyProgressRemap(bookId, userId, remap)
      remapSharedManifest(this.db, userId, bookId, previousChapters,
        chapters.map(c => ({chapter_index:c.index,title:c.title,url:c.url,chapter_key:c.chapterKey})), nextVersion)
      this.retireSupplements(merge.retired)
      return remap
    })
    const progressRemap = replaceManifest()
    const { warnings, warningDetails } = summarizeSequenceWarnings([
      ...(parsed.warnings ?? []),
      ...fetchWarnings,
      ...sequence.warnings,
      ...merge.warnings,
      ...progressRemapWarnings(progressRemap),
    ])

    return {
      book: {
        id: book.id,
        title: book.title,
        charCount: book.char_count,
        fileSize: book.file_size,
        paragraphCount: chapters.length,
        chapters: toChapterMetadata(chapters),
        createdAt: book.created_at,
        updatedAt: now,
        sourceType: 'web',
        sourceUrl: parsed.sourceUrl,
        manifestVersion: nextVersion,
        ...this.supplementBatchState(bookId, userId),
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(warningDetails.length > 0 ? { warningDetails } : {}),
        ...(debugMessages.length > 0 ? { debugMessages } : {}),
      },
      previousChapterCount: previousChapters.length,
      newChapterCount: chapters.length,
      progressRemap,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(warningDetails.length > 0 ? { warningDetails } : {}),
      ...(debugMessages.length > 0 ? { debugMessages } : {}),
    }
  }

  /**
   * Aligns this book against every other same-title web book in the same user's
   * library and returns what could be supplemented. Writes nothing; the token binds
   * the candidate set to this user, work, eligible donors and manifest version.
   */
  async previewSupplements(userId: string, bookId: string): Promise<WebSourceSupplementPreview> {
    const book = this.loadWebBook(userId, bookId)
    reconcileWorks(this.db, userId)
    const work = readWork(this.db, userId, bookId)
    if (work?.supplement_book_id !== bookId) {
      throw new WebSourcePreferredSourceConflictError()
    }
    const rows = this.loadManifestRows(bookId, userId)
    const activeUrls = new Set(this.loadActiveSupplements(bookId, userId).map((row) => row.url))
    const primary: AlignChapter[] = rows.map((row) => ({
      index: row.chapter_index,
      title: row.title,
      url: row.url,
      chapterKey: row.chapter_key || row.url,
      ...(activeUrls.has(row.url) ? { isSupplement: true } : {}),
    }))
    const primaryIndexByKey = new Map(primary.map((chapter) => [chapter.chapterKey, chapter.index]))

    const key = titleKey(book.title)
    const siblings = (this.db.prepare(
      `SELECT id, title, source_url, provider_id, manifest_version FROM books
       WHERE user_id = ? AND source_type = 'web' AND id != ?
       ORDER BY created_at, id`,
    ).all(userId, bookId) as Array<{ id: string; title: string; source_url: string | null; provider_id: string | null; manifest_version: number }>)
      .filter((sibling) => sibling.source_url && titleKey(sibling.title) === key)

    const donors: WebSourceSupplementPreview['donors'] = []
    const donorVersions = new Map<string, number>()
    const candidates: SupplementCandidateEntry[] = []
    const manual = new Map<string, { donorBookId: string; donorProviderId: string; donorIndex: number; title: string; url: string; chapterKey: string }>()
    const ambiguous: WebSourceSupplementAmbiguity[] = []
    const excludedNotes: WebSourceSupplementPreview['excludedNotes'] = []
    const claimedBrackets = new Map<string, { donorBookId: string; names: Set<string> }>()
    for (const sibling of siblings) {
      const donorProvider = this.resolveProvider(sibling.provider_id, sibling.source_url!)
      // The generic heuristic parser is out of scope as a donor.
      if (!donorProvider || donorProvider.providerId === GENERIC_PROVIDER_ID) continue
      donorVersions.set(sibling.id, sibling.manifest_version)
      const donorDisplayName = providerDisplayName(donorProvider)
      const donorOwnSupplements = new Set(this.loadActiveSupplements(sibling.id, userId).map((row) => row.url))
      const donorChapters: AlignChapter[] = this.loadManifestRows(sibling.id, userId)
        .filter((row) => !donorOwnSupplements.has(row.url))
        .map((row) => ({ index: row.chapter_index, title: row.title, url: row.url, chapterKey: row.chapter_key || row.url }))
      const detection = detectSupplementCandidates(primary, donorChapters)
      donors.push({
        bookId: sibling.id,
        providerId: donorProvider.providerId,
        displayName: donorDisplayName,
        chapterCount: donorChapters.length,
        matchedCount: detection.matchedCount,
      })
      const donorFields = { donorBookId: sibling.id, donorDisplayName }
      for (const item of detection.ambiguous) {
        const { donorUrls, ...publicItem } = item
        const manualChapters = donorUrls.filter(url => !activeUrls.has(url)).map(url => {
          const chapter = donorChapters.find(row => row.url === url)!
          const id = sha256(`${sibling.id}\u0000${url}\u0000manual`).slice(0, 24)
          manual.set(id, { donorBookId: sibling.id, donorProviderId: donorProvider.providerId,
            donorIndex: donorChapters.indexOf(chapter),
            title: chapter.title, url, chapterKey: chapter.chapterKey })
          return { id, title: chapter.title }
        })
        ambiguous.push({ ...donorFields, ...publicItem, manualChapters })
      }
      for (const title of detection.excludedNotes) excludedNotes.push({ ...donorFields, title })
      for (const draft of detection.candidates) {
        const name = normalizeChapterName(draft.title)
        const donorPosition = donorChapters.findIndex(chapter => chapter.url === draft.url)
        const primaryPosition = primaryIndexByKey.get(draft.anchorAfter.chapterKey)!
        const ambiguity = (reason: WebSourceSupplementAmbiguity['reason']) => ambiguous.push({
          ...donorFields, reason, donorTitles: [draft.title], primaryTitles: [], afterTitle: draft.anchorAfter.title,
          primaryBefore: primary.slice(Math.max(0, primaryPosition - 1), primaryPosition + 1).map(chapter => chapter.title),
          primaryAfter: primary.slice(primaryPosition + 1, primaryPosition + 3).map(chapter => chapter.title),
          donorBefore: donorChapters.slice(Math.max(0, donorPosition - 2), donorPosition).map(chapter => chapter.title),
          donorAfter: donorChapters.slice(donorPosition + 1, donorPosition + 3).map(chapter => chapter.title),
          manualChapters: [],
        })
        // Only an active row (kept out of the manifest, e.g. its anchor vanished)
        // blocks the URL; a retired row is replaced when the URL is applied again.
        if (activeUrls.has(draft.url)) {
          ambiguity('pending_supplement')
          continue
        }
        const claimed = claimedBrackets.get(draft.anchorAfter.chapterKey)
        if (claimed && claimed.donorBookId !== sibling.id) {
          if (!claimed.names.has(name)) ambiguity('conflicting_donors')
          continue
        }
        const bracket = claimed ?? { donorBookId: sibling.id, names: new Set<string>() }
        bracket.names.add(name)
        claimedBrackets.set(draft.anchorAfter.chapterKey, bracket)
        candidates.push({
          id: sha256(`${sibling.id}\u0000${draft.url}`).slice(0, 24),
          donorBookId: sibling.id,
          donorProviderId: donorProvider.providerId,
          donorDisplayName,
          title: draft.title,
          url: draft.url,
          insertAfterTitle: draft.anchorAfter.title,
          insertBeforeTitle: draft.anchorBefore?.title ?? '',
          insertAfterIndex: primaryIndexByKey.get(draft.anchorAfter.chapterKey)!,
          atEnd: draft.anchorBefore === null,
          chapterKey: draft.chapterKey,
          donorIndex: donorPosition,
          seq: draft.seq,
          anchorAfter: draft.anchorAfter,
          anchorBefore: draft.anchorBefore,
        })
      }
    }

    const previewToken = randomUUID()
    this.storeToken(this.supplementPreviewCache, previewToken, {
      userId,
      bookId,
      manifestVersion: book.manifest_version,
      workId: work.id,
      titleKey: key,
      donorVersions,
      candidates: new Map(candidates.map((candidate) => [candidate.id, candidate])),
      manual,
      donorRank: new Map(donors.map((donor, rank) => [donor.bookId, rank])),
      primary,
      createdAtMs: this.nowMs(),
    })
    const publicCandidates = candidates.map((candidate) => ({
      id: candidate.id,
      donorBookId: candidate.donorBookId,
      donorProviderId: candidate.donorProviderId,
      donorDisplayName: candidate.donorDisplayName,
      title: candidate.title,
      url: candidate.url,
      insertAfterTitle: candidate.insertAfterTitle,
      insertBeforeTitle: candidate.insertBeforeTitle,
      insertAfterIndex: candidate.insertAfterIndex,
      atEnd: candidate.atEnd,
    }))
    return {
      previewToken,
      manifestVersion: book.manifest_version,
      candidateHash: sha256(JSON.stringify(candidates.map((candidate) => [
        candidate.id, candidate.chapterKey, candidate.anchorAfter.chapterKey,
        candidate.anchorBefore?.chapterKey ?? END_OF_BOOK_ANCHOR_KEY,
      ]))),
      donors,
      candidates: publicCandidates,
      ambiguous,
      excludedNotes,
      batches: this.listSupplementBatches(bookId, userId),
    }
  }

  /** Writes the confirmed candidates and the rebuilt manifest in one transaction. */
  async applySupplements(
    userId: string,
    bookId: string,
    request: { previewToken: string; candidateIds: string[]; manualPlacements?: Array<{ id: string; insertAfterIndex: number }> },
  ): Promise<WebSourceSupplementResult> {
    this.pruneTokens(this.supplementPreviewCache)
    const entry = this.supplementPreviewCache.get(request.previewToken)
    // A mismatch leaves the entry in place: only its rightful owner may spend it.
    if (!entry || entry.userId !== userId || entry.bookId !== bookId) {
      throw new WebSourceSupplementPreviewExpiredError()
    }
    const wanted = new Set(request.candidateIds)
    const placements = request.manualPlacements ?? []
    if ((wanted.size === 0 && placements.length === 0)
      || [...wanted].some((id) => !entry.candidates.has(id))
      || placements.length > 500
      || new Set(placements.map(item => item.id)).size !== placements.length
      || placements.some(item => !entry.manual.has(item.id)
        || !Number.isInteger(item.insertAfterIndex)
        || item.insertAfterIndex < -1
        || item.insertAfterIndex >= entry.primary.length
        || (item.insertAfterIndex >= 0 && entry.primary[item.insertAfterIndex].isSupplement)
        || entry.primary[item.insertAfterIndex + 1]?.isSupplement)) {
      throw new WebSourceSupplementSelectionError()
    }
    const book = this.loadWebBook(userId, bookId)
    if (book.manifest_version !== entry.manifestVersion) throw new WebSourceRefreshConflictError()

    // Merge locates anchors by unique chapter key, not by index. A valid index
    // with a duplicate key would create an active batch but insert no chapter.
    const keyCounts = new Map<string, number>()
    for (const chapter of entry.primary) keyCounts.set(chapter.chapterKey, (keyCounts.get(chapter.chapterKey) ?? 0) + 1)
    const selectedCandidates = [...entry.candidates.values()].filter(candidate => wanted.has(candidate.id))
    const nonuniqueKey = (key: string) => key !== START_OF_BOOK_ANCHOR_KEY
      && key !== END_OF_BOOK_ANCHOR_KEY && keyCounts.get(key) !== 1
    if (placements.some(({ insertAfterIndex }) => [insertAfterIndex, insertAfterIndex + 1]
      .some(index => index >= 0 && index < entry.primary.length
        && nonuniqueKey(entry.primary[index].chapterKey)))
      || selectedCandidates.some(candidate => nonuniqueKey(candidate.anchorAfter.chapterKey)
        || (candidate.anchorBefore !== null && nonuniqueKey(candidate.anchorBefore.chapterKey)))) {
      throw new WebSourceSupplementSelectionError('所選插入位置的章節識別不唯一，無法安全補入；請選擇其他位置或重新整理目錄')
    }

    const now = this.now()
    const batchId = this.createId()
    const selected = [...selectedCandidates]
    for (const placement of placements) {
      const chapter = entry.manual.get(placement.id)!
      const after = entry.primary[placement.insertAfterIndex]
      const before = entry.primary[placement.insertAfterIndex + 1] ?? null
      selected.push({
        id: placement.id, donorBookId: chapter.donorBookId, donorProviderId: chapter.donorProviderId,
        donorDisplayName: '', title: chapter.title, url: chapter.url, chapterKey: chapter.chapterKey,
        insertAfterTitle: after?.title ?? '', insertBeforeTitle: before?.title ?? '',
        insertAfterIndex: placement.insertAfterIndex, atEnd: before === null,
        anchorAfter: after
          ? { chapterKey: after.chapterKey, title: after.title }
          : { chapterKey: START_OF_BOOK_ANCHOR_KEY, title: '' },
        anchorBefore: before && { chapterKey: before.chapterKey, title: before.title },
        donorIndex: chapter.donorIndex, seq: 0,
      })
    }
    if (new Set(selected.map(candidate => candidate.url)).size !== selected.length) throw new WebSourceSupplementSelectionError()
    // The preview's donor order is stable (created_at, id); unlike ambiguity
    // reporting or request order, donor index also interleaves safe and manual
    // chapters in the same bracket. One lexicographic comparator stays transitive.
    selected.sort((a, b) => (entry.donorRank.get(a.donorBookId)! - entry.donorRank.get(b.donorBookId)!)
      || a.donorIndex - b.donorIndex || a.id.localeCompare(b.id))
    const newRows: SupplementRow[] = selected.map((candidate, seq) => ({
      id: this.createId(),
      batch_id: batchId,
      seq,
      donor_book_id: candidate.donorBookId,
      donor_provider_id: candidate.donorProviderId,
      url: candidate.url,
      chapter_key: candidate.chapterKey,
      title: candidate.title,
      anchor_after_key: candidate.anchorAfter.chapterKey,
      anchor_after_title: candidate.anchorAfter.title,
      anchor_before_key: candidate.anchorBefore?.chapterKey ?? END_OF_BOOK_ANCHOR_KEY,
      anchor_before_title: candidate.anchorBefore?.title ?? '',
      created_at: now,
    }))
    const result = this.rebuildManifestWithSupplements(userId, book, now, {
      add: newRows,
      beforeWrite: () => {
        // Guard inside the manifest-writing transaction, not only when issuing
        // the preview token: a manual switch can happen between the two calls.
        reconcileWorks(this.db, userId)
        const work = readWork(this.db, userId, bookId)
        if (work?.supplement_book_id !== bookId) {
          throw new WebSourcePreferredSourceConflictError()
        }
        // Rename/delete does not rebuild the chapter manifest. Verify both
        // work identity and the exact eligible donor group before any insert.
        if (work.id !== entry.workId || titleKey(this.loadWebBook(userId, bookId).title) !== entry.titleKey) {
          throw new WebSourceSupplementPreviewExpiredError()
        }
        const currentDonors = this.db.prepare(`SELECT id, title, source_url, provider_id, manifest_version FROM books
          WHERE user_id = ? AND source_type = 'web' AND id != ?`).all(userId, bookId) as Array<{
            id: string; title: string; source_url: string | null; provider_id: string | null; manifest_version: number
          }>
        const eligible = currentDonors.filter(row => {
          if (!row.source_url || titleKey(row.title) !== entry.titleKey) return false
          const provider = this.resolveProvider(row.provider_id, row.source_url)
          return provider && provider.providerId !== GENERIC_PROVIDER_ID
        })
        if (eligible.length !== entry.donorVersions.size
          || eligible.some(row => entry.donorVersions.get(row.id) !== row.manifest_version)) {
          throw new WebSourceSupplementPreviewExpiredError()
        }
        // A retired row is audit history only; UNIQUE(book_id, url) would otherwise
        // block supplementing the same chapter again after the primary dropped it.
        const dropRetired = this.db.prepare(
          `DELETE FROM web_book_supplements WHERE book_id = ? AND user_id = ? AND url = ? AND status = 'retired'`,
        )
        for (const row of newRows) dropRetired.run(bookId, userId, row.url)
        const insert = this.db.prepare(
          `INSERT INTO web_book_supplements (
             id, book_id, user_id, batch_id, seq, donor_book_id, donor_provider_id, url, chapter_key, title,
             anchor_after_key, anchor_after_title, anchor_before_key, anchor_before_title, status, status_reason,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '', ?)`,
        )
        for (const row of newRows) {
          insert.run(row.id, bookId, userId, row.batch_id, row.seq, row.donor_book_id, row.donor_provider_id,
            row.url, row.chapter_key, row.title, row.anchor_after_key, row.anchor_after_title,
            row.anchor_before_key, row.anchor_before_title, row.created_at)
        }
      },
    })
    this.supplementPreviewCache.delete(request.previewToken)
    return { ...result, batchId, changedCount: newRows.length }
  }

  /**
   * Removes one supplement batch (default: the latest) and rebuilds the manifest.
   * Only a batch with at least one active row is undoable; its retired rows are
   * deleted with it. A batch whose rows are all retired has no manifest effect, so
   * it is not offered and undoing it is "not found" (rows stay as audit history).
   */
  async undoSupplements(userId: string, bookId: string, batchId?: string): Promise<WebSourceSupplementResult> {
    const book = this.loadWebBook(userId, bookId)
    const batches = this.listSupplementBatches(bookId, userId)
    const target = batchId === undefined ? batches[0] : batches.find((batch) => batch.batchId === batchId)
    if (!target) throw new WebSourceSupplementBatchNotFoundError()
    const result = this.rebuildManifestWithSupplements(userId, book, this.now(), {
      removeBatchId: target.batchId,
      beforeWrite: () => {
        this.db.prepare(
          'DELETE FROM web_book_supplements WHERE book_id = ? AND user_id = ? AND batch_id = ?',
        ).run(bookId, userId, target.batchId)
      },
    })
    return { ...result, batchId: target.batchId, changedCount: target.count }
  }

  /**
   * Rebuilds a manifest from its primary rows (current manifest minus active
   * supplements) plus the resulting supplement set, without touching the network.
   */
  private rebuildManifestWithSupplements(
    userId: string,
    book: WebBookRecord,
    now: string,
    change: { add?: SupplementRow[]; removeBatchId?: string; beforeWrite: () => void },
  ): WebSourceRefreshResult {
    const bookId = book.id
    const previousChapters = this.loadManifestRows(bookId, userId)
    const active = this.loadActiveSupplements(bookId, userId)
    const activeUrls = new Set(active.map((row) => row.url))
    const primary = previousChapters
      .filter((row) => !activeUrls.has(row.url))
      .map((row, index) => ({ index, title: row.title, url: row.url, chapterKey: row.chapter_key || row.url }))
    const supplements = [
      ...active.filter((row) => row.batch_id !== change.removeBatchId),
      ...(change.add ?? []),
    ]
    const merge = describeSupplementMerge(primary, supplements)
    const chapters = merge.chapters
    const debugMessages = merge.debugMessages
    const nextVersion = book.manifest_version + 1

    const progressRemap = this.db.transaction(() => {
      const current = this.db.prepare(
        'SELECT manifest_version FROM books WHERE id = ? AND user_id = ?',
      ).get(bookId, userId) as { manifest_version: number } | undefined
      if (!current) throw new WebSourceNotFoundError()
      if (current.manifest_version !== book.manifest_version) throw new WebSourceRefreshConflictError()
      change.beforeWrite()
      this.replaceManifestRows(bookId, userId, chapters, now)
      const updated = this.db.prepare(
        `UPDATE books
         SET paragraph_count = ?, chapters_json = ?, manifest_version = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND manifest_version = ?`,
      ).run(chapters.length, JSON.stringify(toChapterMetadata(chapters)), nextVersion, now, bookId, userId,
        book.manifest_version)
      if (updated.changes !== 1) throw new WebSourceRefreshConflictError()
      const remap = this.remapStoredProgress(bookId, userId, previousChapters, chapters)
      this.applyProgressRemap(bookId, userId, remap)
      remapSharedManifest(this.db, userId, bookId, previousChapters,
        chapters.map(c => ({chapter_index:c.index,title:c.title,url:c.url,chapter_key:c.chapterKey})), nextVersion)
      this.retireSupplements(merge.retired)
      return remap
    })()
    const { warnings, warningDetails } = summarizeSequenceWarnings([
      ...merge.warnings,
      ...progressRemapWarnings(progressRemap),
    ])

    return {
      book: {
        id: book.id,
        title: book.title,
        charCount: book.char_count,
        fileSize: book.file_size,
        paragraphCount: chapters.length,
        chapters: toChapterMetadata(chapters),
        createdAt: book.created_at,
        updatedAt: now,
        sourceType: 'web',
        sourceUrl: book.source_url ?? '',
        manifestVersion: nextVersion,
        ...this.supplementBatchState(bookId, userId),
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(warningDetails.length > 0 ? { warningDetails } : {}),
        ...(debugMessages.length > 0 ? { debugMessages } : {}),
      },
      previousChapterCount: previousChapters.length,
      newChapterCount: chapters.length,
      progressRemap,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(warningDetails.length > 0 ? { warningDetails } : {}),
      ...(debugMessages.length > 0 ? { debugMessages } : {}),
    }
  }

  private loadWebBook(userId: string, bookId: string): WebBookRecord {
    const book = this.db.prepare(
      `SELECT id, title, file_size, char_count, paragraph_count, source_type,
              source_url, provider_id, manifest_version, created_at
       FROM books WHERE id = ? AND user_id = ?`,
    ).get(bookId, userId) as WebBookRecord | undefined
    if (!book) throw new WebSourceNotFoundError()
    if (book.source_type !== 'web' || !book.source_url) throw new UnsupportedWebSourceError(book.source_url ?? '')
    return book
  }

  private loadManifestRows(bookId: string, userId: string): ManifestRow[] {
    return this.db.prepare(
      `SELECT chapter_index, title, url, chapter_key FROM web_book_chapters
       WHERE book_id = ? AND user_id = ? ORDER BY chapter_index`,
    ).all(bookId, userId) as ManifestRow[]
  }

  /** Insertion order: batch creation, then position within the batch. */
  private loadActiveSupplements(bookId: string, userId: string): SupplementRow[] {
    return this.db.prepare(
      `SELECT id, batch_id, seq, donor_book_id, donor_provider_id, url, chapter_key, title,
              anchor_after_key, anchor_after_title, anchor_before_key, anchor_before_title, created_at
       FROM web_book_supplements
       WHERE book_id = ? AND user_id = ? AND status = 'active'
       ORDER BY created_at, batch_id, seq`,
    ).all(bookId, userId) as SupplementRow[]
  }

  /** Undoable batches (at least one active row), most recent first; see listActiveSupplementBatches. */
  private listSupplementBatches(bookId: string, userId: string): WebSourceSupplementBatch[] {
    return listActiveSupplementBatches(this.db, userId, bookId).get(bookId) ?? []
  }

  /** The authoritative undo state a client should display after a manifest change. */
  private supplementBatchState(bookId: string, userId: string): Pick<
    WebSourceBookView, 'supplementBatchCount' | 'latestSupplementBatch'
  > {
    const batches = this.listSupplementBatches(bookId, userId)
    return { supplementBatchCount: batches.length, latestSupplementBatch: batches[0] ?? null }
  }

  /** Must run inside the caller's transaction, so no progress save can interleave. */
  private remapStoredProgress(
    bookId: string,
    userId: string,
    previousChapters: ManifestRow[],
    chapters: ResolvedWebSourceChapter[],
  ): WebSourceRefreshResult['progressRemap'] {
    const progress = this.db.prepare(
      `SELECT position_type, position_value FROM reading_progress WHERE book_id = ? AND user_id = ?`,
    ).get(bookId, userId) as { position_type: string; position_value: number } | undefined
    return progress?.position_type === 'chapter_index'
      ? remapChapterPosition(previousChapters, chapters, progress.position_value)
      : null
  }

  /** Must run inside the caller's transaction. */
  private replaceManifestRows(
    bookId: string,
    userId: string,
    chapters: ResolvedWebSourceChapter[],
    now: string,
  ): void {
    this.db.prepare(
      `DELETE FROM web_book_chapters WHERE book_id = ? AND user_id = ?`,
    ).run(bookId, userId)
    const insertChapter = this.db.prepare(
      `INSERT INTO web_book_chapters (
         book_id, user_id, chapter_index, title, url, chapter_key, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const chapter of chapters) {
      insertChapter.run(bookId, userId, chapter.index, chapter.title, chapter.url, chapter.chapterKey, now)
    }
    this.db.prepare(
      `DELETE FROM web_source_chapter_cache
       WHERE book_id = ? AND user_id = ?
         AND source_url NOT IN (
           SELECT url FROM web_book_chapters WHERE book_id = ? AND user_id = ?
         )`,
    ).run(bookId, userId, bookId, userId)
  }

  /** Must run inside the caller's transaction. */
  private applyProgressRemap(
    bookId: string,
    userId: string,
    progressRemap: WebSourceRefreshResult['progressRemap'],
  ): void {
    if (!progressRemap) return
    const lost = progressRemap.matchedBy === 'position' ? 1 : 0
    this.db.prepare(
      `UPDATE reading_progress
       SET position_value = ?,
           chapter_offset = CASE WHEN ? THEN NULL ELSE chapter_offset END,
           chapter_progress = CASE WHEN ? THEN NULL ELSE chapter_progress END
       WHERE book_id = ? AND user_id = ? AND position_type = 'chapter_index'`,
    ).run(progressRemap.newPosition, lost, lost, bookId, userId)
  }

  /** Must run inside the caller's transaction. */
  private retireSupplements(retired: Array<{ id: string; matchedTitle: string }>): void {
    const update = this.db.prepare(
      `UPDATE web_book_supplements SET status = 'retired', status_reason = ? WHERE id = ?`,
    )
    for (const item of retired) update.run(`primary_contains:${item.matchedTitle}`, item.id)
  }

  async search(userId: string, title: string): Promise<WebSourceSearchResponse> {
    const query = title.trim()
    if (!query) return { candidates: [], errors: [] }

    const ownedUrls = new Set((this.db.prepare(
      "SELECT source_url FROM books WHERE user_id = ? AND source_type = 'web' AND source_url IS NOT NULL",
    ).all(userId) as Array<{ source_url: string }>).map(row => row.source_url))

    const hitsByProvider: WebSourceSearchHit[][] = []
    const errors: WebSourceSearchResponse['errors'] = []
    const seen = new Set<string>()
    for (const provider of this.providers) {
      try {
        const hits: WebSourceSearchHit[] = []
        const { result: providerHits } = await this.runBudgeted(
          this.searchBudget,
          () => provider.search(query),
        )
        for (const hit of providerHits) {
          if (seen.has(hit.url) || ownedUrls.has(hit.url)) continue
          seen.add(hit.url)
          hits.push(hit)
        }
        hitsByProvider.push(hits)
      } catch (error) {
        errors.push({
          providerId: provider.providerId,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    // Interleave round-robin for stable ties before ranking and capping.
    const candidates: WebSourceSearchHit[] = []
    const longest = Math.max(0, ...hitsByProvider.map((hits) => hits.length))
    for (let i = 0; i < longest; i += 1) {
      for (const hits of hitsByProvider) {
        if (i >= hits.length) continue
        candidates.push(hits[i])
      }
    }
    // Stable sorting preserves provider round-robin order among equally close hits.
    candidates.sort((a, b) => searchTitleDistance(query, a.title) - searchTitleDistance(query, b.title))
    return { candidates: candidates.slice(0, 20), errors }
  }

  async readBookText(userId: string, bookId: string): Promise<string> {
    const chapters = this.db
      .prepare(
        `SELECT chapter_index, title, url, created_at
         FROM web_book_chapters
         WHERE user_id = ? AND book_id = ?
         ORDER BY chapter_index ASC`,
      )
      .all(userId, bookId) as WebBookChapterRow[]
    if (chapters.length === 0) {
      return ''
    }

    const parts = await Promise.all(chapters.map(async (chapter) => {
      const stored = await this.readChapterContent(userId, bookId, chapter)
      const text = stripMatchingChapterHeading(chapter.title, stored.text)
      return `${chapter.title}\n\n${text}`
    }))
    return parts.join('\n\n')
  }

  async readChapterWindow(
    userId: string,
    bookId: string,
    window: { center: number; before: number; after: number; refresh?: boolean },
  ): Promise<WebSourceChapterWindow> {
    const center = Math.max(0, Math.floor(window.center))
    const before = Math.max(0, Math.min(20, Math.floor(window.before)))
    const after = Math.max(0, Math.min(20, Math.floor(window.after)))
    const start = Math.max(0, center - before)
    const end = center + after
    const rows = this.db
      .prepare(
        `SELECT chapter_index, title, url, created_at
         FROM web_book_chapters
         WHERE user_id = ? AND book_id = ? AND chapter_index BETWEEN ? AND ?
         ORDER BY chapter_index ASC`,
      )
      .all(userId, bookId, start, end) as WebBookChapterRow[]

    const chapters = await Promise.all(rows.map(async (row) => {
      const stored = await this.readChapterContent(userId, bookId, row, window.refresh === true)
      const text = stripMatchingChapterHeading(row.title, stored.text)
      return {
        index: row.chapter_index,
        title: row.title,
        sourceUrl: row.url,
        sourceTimestamp: stored.fetched_at,
        contentHash: sha256(text),
        text,
      }
    }))
    if (window.refresh === true && chapters.length > 0) {
      this.db.prepare(
        'UPDATE books SET updated_at = ? WHERE id = ? AND user_id = ?',
      ).run(this.now(), bookId, userId)
    }
    return { chapters }
  }

  private async readChapterContent(
    userId: string,
    bookId: string,
    row: WebBookChapterRow,
    refresh = false,
  ): Promise<StoredChapter> {
    const fetchKey = `${userId}\u0000${bookId}\u0000${row.url}`
    const existingFetch = this.chapterFetches.get(fetchKey)
    if (existingFetch) return existingFetch

    if (!refresh) {
      const cached = this.db.prepare(
        `SELECT text, content_hash, fetched_at
         FROM web_source_chapter_cache
         WHERE book_id = ? AND user_id = ? AND source_url = ?`,
      ).get(bookId, userId, row.url) as StoredChapter | undefined
      if (cached) return cached
    }

    const pending = this.fetchAndStoreChapter(userId, bookId, row)
    this.chapterFetches.set(fetchKey, pending)
    try {
      return await pending
    } finally {
      if (this.chapterFetches.get(fetchKey) === pending) {
        this.chapterFetches.delete(fetchKey)
      }
    }
  }

  private async fetchAndStoreChapter(
    userId: string,
    bookId: string,
    row: WebBookChapterRow,
  ): Promise<StoredChapter> {
    const book = this.db.prepare(
      'SELECT provider_id FROM books WHERE id = ? AND user_id = ?',
    ).get(bookId, userId) as { provider_id: string | null } | undefined
    // A supplemented chapter lives on its donor's site: resolve its provider per
    // chapter URL from the supplement row, never from the primary book.
    const supplement = this.db.prepare(
      `SELECT donor_provider_id FROM web_book_supplements
       WHERE book_id = ? AND user_id = ? AND url = ? AND status = 'active'
       LIMIT 1`,
    ).get(bookId, userId, row.url) as { donor_provider_id: string } | undefined
    const provider = supplement
      ? this.resolveSupplementProvider(supplement.donor_provider_id, row.url)
      : this.resolveProvider(book?.provider_id ?? null, row.url)
    if (!provider) throw new UnsupportedWebSourceError(row.url)
    const text = await this.fetchChapterTextWithRateLimit(provider, row.url)
    const stored = {
      text,
      content_hash: sha256(text),
      fetched_at: this.now(),
    }
    const stillCurrent = this.db.prepare(
      `SELECT 1
       FROM web_book_chapters
       WHERE book_id = ? AND user_id = ? AND url = ?
       LIMIT 1`,
    ).get(bookId, userId, row.url)
    if (!stillCurrent) return stored

    this.db.prepare(
      `INSERT INTO web_source_chapter_cache (
         book_id, user_id, source_url, text, content_hash, fetched_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(book_id, source_url) DO UPDATE SET
         user_id = excluded.user_id,
         text = excluded.text,
         content_hash = excluded.content_hash,
         fetched_at = excluded.fetched_at`,
    ).run(
      bookId,
      userId,
      row.url,
      stored.text,
      stored.content_hash,
      stored.fetched_at,
    )
    return stored
  }

  /**
   * Runs one service operation under a fetch budget. Every SafeFetchService request
   * a provider makes inside `operation` — including provider-internal pagination and
   * gap recovery — charges this budget and passes the per-host rate gate.
   */
  private runBudgeted<T>(
    budget: FetchBudget,
    operation: () => Promise<T>,
  ): Promise<{ result: T; usage: FetchBudgetUsage }> {
    return runWithFetchBudget(budget, operation, {
      limiter: this.rateLimiter,
      now: this.nowMs,
    })
  }

  private async parseChapterListWithBudget(
    provider: WebSourceProvider,
    url: string,
  ): Promise<{ parsed: ParsedWebSource; warnings: string[] }> {
    const { result, usage } = await this.runBudgeted(
      this.chapterListBudget,
      () => provider.parseChapterList(url),
    )
    return { parsed: result, warnings: describeFetchBudgetUsage(usage) }
  }

  /**
   * `revalidate` applies to chapter-list URLs only. A stored provider that no longer
   * claims its own list URL cannot parse it, so the URL decides instead of failing the
   * refresh outright. Chapter URLs must never be revalidated: several providers accept
   * only the directory shape, and a chapter page may sit on a different host.
   */
  private resolveProvider(
    providerId: string | null,
    url: string,
    options: { revalidate?: boolean } = {},
  ): WebSourceProvider | undefined {
    if (providerId) {
      const stored = this.providers.find((candidate) => candidate.providerId === providerId)
      if (stored && (!options.revalidate || stored.canHandle(url))) return stored
      if (stored) {
        this.logProviderMismatch(stored.providerId, url)
        // Only a dedicated provider may take over silently; adopting `generic` here
        // would bypass the preview confirmation the generic path requires.
        return this.findDedicatedProviderForUrl(url) ?? stored
      }
    }
    return this.findProviderForUrl(url)
  }

  /**
   * A supplemented chapter is fetched only through the dedicated provider recorded
   * at apply time, and only if it still claims the URL: never generic, never a
   * silent hand-over to another provider.
   */
  private resolveSupplementProvider(providerId: string, url: string): WebSourceProvider | undefined {
    if (providerId === GENERIC_PROVIDER_ID) return undefined
    const stored = this.providers.find((candidate) => candidate.providerId === providerId)
    return stored && stored.canHandle(url) ? stored : undefined
  }

  /** One line per provider/host pair, so a stale row cannot flood the log on every read. */
  private logProviderMismatch(providerId: string, url: string): void {
    const key = `${providerId}\u0000${safeHostname(url)}`
    if (this.loggedProviderMismatches.has(key)) return
    this.loggedProviderMismatches.add(key)
    this.logDebug(`Stored provider ${providerId} no longer handles ${safeHostname(url)}; resolving by URL`)
  }

  /**
   * First dedicated provider whose canHandle matches wins. A host that a dedicated
   * provider owns but whose path shape is wrong must NOT fall through to the
   * generic provider — the user should get the "貼目錄頁網址" hint instead.
   */
  private findProviderForUrl(url: string): WebSourceProvider | undefined {
    const dedicated = this.providers.filter((candidate) => candidate.providerId !== GENERIC_PROVIDER_ID)
    const match = this.findDedicatedProviderForUrl(url)
    if (match) return match
    if (dedicated.some((candidate) => candidate.canHandleHost?.(url))) return undefined
    return this.providers.find((candidate) => candidate.providerId === GENERIC_PROVIDER_ID && candidate.canHandle(url))
  }

  private findDedicatedProviderForUrl(url: string): WebSourceProvider | undefined {
    return this.providers.find(
      (candidate) => candidate.providerId !== GENERIC_PROVIDER_ID && candidate.canHandle(url),
    )
  }

  private storeToken<T extends { userId: string; createdAtMs: number }>(
    cache: Map<string, T>,
    token: string,
    entry: T,
  ): void {
    this.pruneTokens(cache)
    // Evict within the minting user's own tokens only; a global cap would let one
    // account push every other account's pending confirmation out of the cache.
    for (;;) {
      const owned = [...cache].filter(([, cached]) => cached.userId === entry.userId)
      if (owned.length < MAX_PREVIEW_TOKENS_PER_USER) break
      // Map iteration is insertion-ordered, so the first match is the oldest entry.
      cache.delete(owned[0][0])
    }
    cache.set(token, entry)
  }

  private consumePreview(token: string, userId: string, url: string): PreviewEntry | null {
    this.pruneTokens(this.previewCache)
    const entry = this.previewCache.get(token)
    // A mismatch leaves the entry in place: only its rightful owner may spend it.
    if (!entry || entry.userId !== userId || entry.url !== url) return null
    this.previewCache.delete(token)
    return entry
  }

  private pruneTokens<T extends { createdAtMs: number }>(cache: Map<string, T>): void {
    const cutoff = this.nowMs() - PREVIEW_TOKEN_TTL_MS
    for (const [token, entry] of cache) {
      if (entry.createdAtMs <= cutoff) cache.delete(token)
    }
  }

  private async withFetchPermit<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquireFetchPermit()
    try {
      return await operation()
    } finally {
      this.releaseFetchPermit()
    }
  }

  private async fetchChapterTextWithRateLimit(
    provider: WebSourceProvider,
    url: string,
  ): Promise<string> {
    const host = new URL(url).hostname.toLowerCase()
    await this.acquireHostFetchPermit(host)
    try {
      // One budget spans every attempt: a budget per attempt would let a chapter
      // that retries N times spend N+1 times the chapter cap. The retry sleeps run
      // inside it, so the budget deadline also bounds the whole 429 recovery.
      const { result } = await this.runBudgeted(this.chapterFetchBudget, async () => {
        for (let attempt = 0; ; attempt += 1) {
          try {
            return await this.withFetchPermit(() => provider.fetchChapterText(url))
          } catch (error) {
            if (
              !(error instanceof WebSourceHttpError)
              || error.statusCode !== 429
              || attempt >= this.rateLimitMaxRetries
            ) {
              throw error
            }
            const fallbackDelay = this.rateLimitRetryBaseMs * (2 ** attempt)
            await this.sleep(error.retryAfterMs ?? Math.min(5 * 60_000, fallbackDelay))
          }
        }
      })
      return result
    } finally {
      this.releaseHostFetchPermit(host)
    }
  }

  private async acquireHostFetchPermit(host: string): Promise<void> {
    if (!this.activeFetchHosts.has(host)) {
      this.activeFetchHosts.add(host)
      return
    }
    await new Promise<void>((resolve) => {
      const waiters = this.hostFetchWaiters.get(host) ?? []
      waiters.push(resolve)
      this.hostFetchWaiters.set(host, waiters)
    })
  }

  private releaseHostFetchPermit(host: string): void {
    const waiters = this.hostFetchWaiters.get(host)
    const next = waiters?.shift()
    if (next) {
      if (waiters?.length === 0) this.hostFetchWaiters.delete(host)
      next()
      return
    }
    this.hostFetchWaiters.delete(host)
    this.activeFetchHosts.delete(host)
  }

  private async acquireFetchPermit(): Promise<void> {
    if (this.activeFetches < this.fetchConcurrency) {
      this.activeFetches += 1
      return
    }
    await new Promise<void>((resolve) => {
      this.fetchWaiters.push(resolve)
    })
  }

  private releaseFetchPermit(): void {
    const next = this.fetchWaiters.shift()
    if (next) {
      next()
      return
    }
    this.activeFetches -= 1
  }
}

/**
 * Budget usage the user should hear about: a truncated parse, or an unusually
 * expensive one. Providers swallow individual recovery failures, so the request
 * count is the only signal that a directory needed heavy gap recovery.
 */
function providerDisplayName(provider: WebSourceProvider): string {
  const declared = (provider as { displayName?: string }).displayName
  return declared ?? provider.displayHost ?? provider.providerId
}

function searchTitleDistance(query: string, title: string): number {
  const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('zh-TW')
    .replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 120)
  const a = normalize(query)
  const b = normalize(title)
  if (a === b) return 0
  if (b.startsWith(a)) return 1 + (b.length - a.length) / 1000
  if (b.includes(a)) return 2 + (b.length - a.length) / 1000
  // Bounded edit distance ranks misspellings above unrelated provider hits.
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = current
  }
  return 3 + previous[b.length] / Math.max(1, a.length, b.length)
}

/** The reader lost its stable chapter identity and was clamped by position. */
function progressRemapWarnings(progressRemap: WebSourceRefreshResult['progressRemap']): string[] {
  return progressRemap?.matchedBy === 'position'
    ? ['找不到原閱讀章節的穩定識別，已保留原位置並調整至有效範圍。']
    : []
}

/**
 * Undoable supplement batches per book: a batch counts only while it still has an
 * active row (a retired-only batch no longer changes the manifest). Most recent
 * first (created_at, then insertion order); count/titles cover active rows only.
 */
export function listActiveSupplementBatches(
  db: Database.Database,
  userId: string,
  bookId?: string,
): Map<string, WebSourceSupplementBatch[]> {
  const rows = db.prepare(
    `SELECT rowid AS row_id, book_id, batch_id, title, created_at FROM web_book_supplements
     WHERE user_id = ? AND status = 'active' ${bookId === undefined ? '' : 'AND book_id = ?'}
     ORDER BY seq, rowid`,
  ).all(...(bookId === undefined ? [userId] : [userId, bookId])) as Array<{
    row_id: number
    book_id: string
    batch_id: string
    title: string
    created_at: string
  }>
  const byBatch = new Map<string, { bookId: string; lastRowId: number; batch: WebSourceSupplementBatch }>()
  for (const row of rows) {
    const key = `${row.book_id}\u0000${row.batch_id}`
    const entry = byBatch.get(key) ?? {
      bookId: row.book_id,
      lastRowId: row.row_id,
      batch: { batchId: row.batch_id, createdAt: row.created_at, count: 0, titles: [] },
    }
    entry.batch.count += 1
    entry.batch.titles.push(row.title)
    entry.lastRowId = Math.max(entry.lastRowId, row.row_id)
    byBatch.set(key, entry)
  }
  const result = new Map<string, WebSourceSupplementBatch[]>()
  const ordered = [...byBatch.values()].sort((a, b) => (
    b.batch.createdAt.localeCompare(a.batch.createdAt) || b.lastRowId - a.lastRowId
  ))
  for (const entry of ordered) {
    const list = result.get(entry.bookId) ?? []
    list.push(entry.batch)
    result.set(entry.bookId, list)
  }
  return result
}

/**
 * Merges supplement rows into primary chapters and words the outcome: chapters
 * that cannot be placed are active warnings (unresolved post-merge state, M-009);
 * successful placement and auto-retirement are debug-only.
 */
function describeSupplementMerge(
  primary: ResolvedWebSourceChapter[],
  supplements: SupplementRow[],
): {
  chapters: ResolvedWebSourceChapter[]
  retired: Array<{ id: string; matchedTitle: string }>
  warnings: string[]
  debugMessages: string[]
} {
  if (supplements.length === 0) return { chapters: primary, retired: [], warnings: [], debugMessages: [] }
  const merge = mergeSupplements(primary, supplements.map((row) => ({
    id: row.id,
    title: row.title,
    url: row.url,
    chapterKey: row.chapter_key,
    anchorAfterKey: row.anchor_after_key,
    anchorBeforeKey: row.anchor_before_key,
  })))
  const byId = new Map(supplements.map((row) => [row.id, row]))
  const warnings = merge.unresolved.map(({ id, reason }) => {
    const row = byId.get(id)!
    const why = reason === 'anchor_missing'
      ? '來源目錄已找不到原插入位置'
      : row.anchor_before_key === END_OF_BOOK_ANCHOR_KEY
        ? '來源已在原書末之後新增其他章節，無法確定順序'
        : '原插入位置前後已出現其他章節，無法確定順序'
    return `補章「${row.title}」原定插在「${row.anchor_after_title}」之後，但${why}，暫未補入；可撤銷該批補章或待來源修正後再重新整理。`
  })
  const debugMessages = [
    ...(merge.placed.length > 0 ? [`已從其他來源補入 ${merge.placed.length} 章。`] : []),
    ...merge.retired.map(({ id, matchedTitle }) =>
      `補章「${byId.get(id)!.title}」：來源已含此章（「${matchedTitle}」），已自動停用該補章。`),
  ]
  return { chapters: merge.chapters, retired: merge.retired, warnings, debugMessages }
}

function describeFetchBudgetUsage(usage: FetchBudgetUsage): string[] {
  if (usage.exhausted) {
    return [
      `本次解析已達來源站抓取上限（已發出 ${usage.fetches} 次請求），章節清單可能不完整，請稍後重新整理。`,
    ]
  }
  if (usage.fetches > CHAPTER_LIST_FETCH_WARN_THRESHOLD) {
    return [
      `本次解析向來源站發出 ${usage.fetches} 次請求（常態為 ${CHAPTER_LIST_FETCH_WARN_THRESHOLD} 次以內），來源目錄可能缺章而需要額外補抓。`,
    ]
  }
  return []
}

const CHAPTER_HEADING_PATTERN = /^第[一二三四五六七八九十百千萬万零〇兩两\d]+[章回節卷部篇]\s*/

function stripMatchingChapterHeading(metadataTitle: string, fetchedText: string): string {
  const metadataMarker = metadataTitle.trim().match(CHAPTER_HEADING_PATTERN)
  const fetchedMarker = fetchedText.match(CHAPTER_HEADING_PATTERN)
  if (!metadataMarker || !fetchedMarker) return fetchedText
  const metadataOrdinal = parseChapterOrdinal(metadataTitle)
  const fetchedOrdinal = parseChapterOrdinal(fetchedText)
  const metadataName = metadataTitle.trim().slice(metadataMarker[0].length).trim()
  const fetchedName = fetchedText.slice(fetchedMarker[0].length).split(/\r?\n/, 1)[0].trim()
  const ordinalMatches = metadataOrdinal !== null && fetchedOrdinal === metadataOrdinal
  const nameMatches = metadataOrdinal !== null
    && fetchedOrdinal !== null
    && metadataName.length > 0
    && fetchedName === metadataName
  if (!ordinalMatches && !nameMatches) return fetchedText

  let bodyStart = fetchedMarker[0].length
  if (metadataName && fetchedText.slice(bodyStart).startsWith(metadataName)) {
    bodyStart += metadataName.length
  }
  return fetchedText.slice(bodyStart).replace(/^\s+/, '')
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return '<invalid-url>'
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function resolveChapterKey(provider: WebSourceProvider, chapter: WebSourceChapter): string {
  return chapter.chapterKey ?? provider.getChapterKey?.(chapter.url) ?? canonicalizeSourceUrl(chapter.url)
}

function canonicalizeSourceUrl(url: string): string {
  const parsed = new URL(url)
  parsed.hash = ''
  return parsed.toString()
}

function remapChapterPosition(
  previousChapters: Array<{
    chapter_index: number
    url: string
    chapter_key: string | null
  }>,
  nextChapters: ResolvedWebSourceChapter[],
  previousPosition: number,
): WebSourceRefreshResult['progressRemap'] {
  const target = previousChapters.find((chapter) => chapter.chapter_index === previousPosition)
  if (target?.chapter_key) {
    const oldKeyCount = previousChapters.filter(
      (chapter) => chapter.chapter_key === target.chapter_key,
    ).length
    const keyMatches = nextChapters.filter(
      (chapter) => chapter.chapterKey === target.chapter_key,
    )
    if (oldKeyCount === 1 && keyMatches.length === 1) {
      return {
        previousPosition,
        newPosition: keyMatches[0].index,
        matchedBy: 'chapter_key',
      }
    }
  }
  if (target) {
    const targetUrl = canonicalizeSourceUrl(target.url)
    const oldUrlCount = previousChapters.filter(
      (chapter) => canonicalizeSourceUrl(chapter.url) === targetUrl,
    ).length
    const urlMatches = nextChapters.filter(
      (chapter) => canonicalizeSourceUrl(chapter.url) === targetUrl,
    )
    if (oldUrlCount === 1 && urlMatches.length === 1) {
      return {
        previousPosition,
        newPosition: urlMatches[0].index,
        matchedBy: 'source_url',
      }
    }
  }
  const maxPosition = nextChapters.reduce(
    (maximum, chapter) => Math.max(maximum, chapter.index),
    0,
  )
  return {
    previousPosition,
    newPosition: Math.max(0, Math.min(previousPosition, maxPosition)),
    matchedBy: 'position',
  }
}

function toChapterMetadata(
  chapters: ResolvedWebSourceChapter[],
): Array<{ index: number; title: string; sourceUrl: string; chapterKey: string }> {
  return chapters.map((chapter) => ({
    index: chapter.index,
    title: chapter.title,
    sourceUrl: chapter.url,
    chapterKey: chapter.chapterKey,
  }))
}
