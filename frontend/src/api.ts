export interface WarningDetail {
  summary: string
  messages: string[]
}

export interface Book {
  id: string
  title: string
  charCount: number
  fileSize: number
  paragraphCount?: number
  chapters?: Chapter[]
  createdAt: string
  updatedAt?: string
  progress?: Progress | null
  sourceType?: 'txt' | 'web'
  sourceUrl?: string | null
  providerId?: string
  manifestVersion?: number
  /** Undoable cross-source supplement batches on this web book. */
  supplementBatchCount?: number
  /** The batch an undo button targets; server-authoritative (null after the last undo). */
  latestSupplementBatch?: WebSourceSupplementBatch | null
  /** Present on web editions: same normalized-title editions share one work. */
  workId?: string
  preferredBookId?: string | null
  /** The web edition 補章 writes into: the preferred one, or the best-covered web edition when a TXT is preferred. */
  supplementBookId?: string | null
  members?: SharedWorkMember[]
  revision?: number
  sharedProgress?: SharedProgressState
  warnings?: string[]
  warningDetails?: WarningDetail[]
  debugMessages?: string[]
}

export interface Chapter {
  index: number
  title: string
  sourceUrl?: string
  chapterKey?: string
}

const apiBase = `${import.meta.env.BASE_URL}api`.replace(/\/+$/, '')
const appBase = import.meta.env.BASE_URL

function apiPath(path: string): string {
  return `${apiBase}${path.startsWith('/') ? path : `/${path}`}`
}

export class AuthExpiredError extends Error {
  constructor() {
    super('Session 已過期')
    this.name = 'AuthExpiredError'
  }
}

export function isAuthExpiredError(error: unknown): error is AuthExpiredError {
  return error instanceof AuthExpiredError
}

export function loginToReader(): void {
  const readerUrl = new URL(appBase, window.location.origin)
  const loginUrl = new URL('/auth/', window.location.origin)
  loginUrl.searchParams.set('rd', readerUrl.toString())
  loginUrl.searchParams.set('rm', 'GET')
  window.location.assign(loginUrl.toString())
}

export function checkAuthRedirect(res: Response): void {
  if (res.redirected) {
    // Fetch follows the API auth redirect, so res.url may carry rd=/reader/api/...
    // Surface a typed error and let UI navigate to the app route explicitly.
    throw new AuthExpiredError()
  }
}

export async function listBooks(options: { signal?: AbortSignal } = {}): Promise<Book[]> {
  const res = await fetch(apiPath('/books'), { signal: options.signal })
  checkAuthRedirect(res)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function uploadBook(file: File, title?: string): Promise<Book> {
  const form = new FormData()
  form.append('file', file)
  if (title) form.append('title', title)
  const res = await fetch(apiPath('/books'), { method: 'POST', body: form })
  checkAuthRedirect(res)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

// The backend maps web-source failures to zh-Hant reasons (Cloudflare 阻擋、網域不支援、
// 路徑格式不符…)。Residual generic English messages fall back to the local wording.
const GENERIC_WEB_SOURCE_ERRORS = new Set([
  'Unsupported web source URL',
  'URL is required',
  'Web source creation failed',
  'Web source refresh failed',
  'Web source book not found',
  'previewToken and candidateIds are required',
  'Web source supplement preview failed',
  'Web source supplement apply failed',
  'Web source supplement undo failed',
])

async function readWebSourceErrorReason(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.clone().json() as { error?: unknown }
    if (typeof body.error === 'string' && body.error.trim() && !GENERIC_WEB_SOURCE_ERRORS.has(body.error)) {
      return body.error
    }
  } catch {
    // non-JSON body (gateway error page etc.)
  }
  return fallback
}

export interface WebSourceProvider {
  providerId: string
  displayName: string
  displayHost?: string
  listUrlExample?: string
}

export async function listWebSourceProviders(): Promise<WebSourceProvider[]> {
  const res = await fetch(apiPath('/web-sources/providers'))
  checkAuthRedirect(res)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export interface WebSourcePreviewChapter {
  index: number
  title: string
}

export interface WebSourcePreview {
  previewToken: string
  providerId: string
  displayName: string
  title: string
  chapterCount: number
  firstChapters: WebSourcePreviewChapter[]
  lastChapters: WebSourcePreviewChapter[]
  warnings: string[]
  warningDetails?: WarningDetail[]
  debugMessages?: string[]
  isGeneric: boolean
}

export async function previewWebSource(url: string): Promise<WebSourcePreview> {
  const res = await fetch(apiPath('/web-sources/preview'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  checkAuthRedirect(res)
  if (res.status === 400) throw new Error(await readWebSourceErrorReason(res, '不支援或無法解析此線上書源'))
  // 422/429 carry a zh-Hant budget message; anything else falls back to local wording.
  if (!res.ok) throw new Error(await readWebSourceErrorReason(res, '無法預覽此線上書源'))
  return res.json()
}

export async function createWebSource(url: string, previewToken?: string): Promise<Book> {
  const res = await fetch(apiPath('/web-sources'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(previewToken ? { url, previewToken } : { url }),
  })
  checkAuthRedirect(res)
  if (res.status === 400) throw new Error(await readWebSourceErrorReason(res, '不支援或無法解析此線上書源'))
  if (res.status === 428) throw new Error('此書源需要先預覽再加入')
  if (!res.ok) throw new Error(await readWebSourceErrorReason(res, '無法加入此線上書源'))
  return res.json()
}

export interface WebSourceRefreshResult {
  book: Book
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

export async function refreshWebSource(bookId: string): Promise<WebSourceRefreshResult> {
  const res = await fetch(
    apiPath(`/web-sources/${encodeURIComponent(bookId)}/refresh`),
    { method: 'POST' },
  )
  checkAuthRedirect(res)
  if (res.status === 404) throw new Error('找不到線上書')
  if (res.status === 409) throw new Error('目錄已更新，請重試')
  if (res.status === 400) throw new Error(await readWebSourceErrorReason(res, '此書來源目前不支援重新整理'))
  if (!res.ok) throw new Error(await readWebSourceErrorReason(res, '重新整理章節目錄失敗'))
  return res.json()
}

export interface WebSourceSupplementCandidate {
  id: string
  donorBookId: string
  donorProviderId: string
  donorDisplayName: string
  title: string
  url: string
  insertAfterTitle: string
  insertBeforeTitle: string
  /** 0-based manifest index of the insert-after anchor. */
  insertAfterIndex: number
  /** Appended at the end of the book (trailing 番外); insertBeforeTitle is then ''. */
  atEnd: boolean
}

export interface WebSourceSupplementAmbiguity {
  donorBookId: string
  donorDisplayName: string
  reason: string
  donorTitles: string[]
  primaryTitles: string[]
  afterTitle: string | null
  primaryBefore?: string[]
  primaryAfter?: string[]
  donorBefore?: string[]
  donorAfter?: string[]
  manualChapters?: Array<{ id: string; title: string }>
}

export interface WebSourceSupplementPreview {
  previewToken: string
  manifestVersion: number
  candidateHash: string
  donors: Array<{ bookId: string; providerId: string; displayName: string; chapterCount: number; matchedCount: number }>
  candidates: WebSourceSupplementCandidate[]
  ambiguous: WebSourceSupplementAmbiguity[]
  excludedNotes: Array<{ donorBookId: string; donorDisplayName: string; title: string }>
  batches: WebSourceSupplementBatch[]
}

export interface WebSourceSupplementBatch {
  batchId: string
  createdAt: string
  /** Active (manifest-visible) chapters in the batch. */
  count: number
  titles: string[]
}

export interface WebSourceSupplementResult extends WebSourceRefreshResult {
  batchId: string
  changedCount: number
}

async function postSupplementRoute(
  bookId: string,
  action: 'preview' | 'apply' | 'undo',
  body?: unknown,
): Promise<Response> {
  const res = await fetch(
    apiPath(`/web-sources/${encodeURIComponent(bookId)}/supplements/${action}`),
    body === undefined
      ? { method: 'POST' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  )
  checkAuthRedirect(res)
  if (res.status === 404) throw new Error(await readWebSourceErrorReason(res, '找不到線上書或補章紀錄'))
  if (action === 'apply' && (res.status === 409 || res.status === 410)) {
    // Matched by name in LibraryPage (not an exported class/const: api.ts is
    // auto-mocked in page tests, see M-001), which then re-runs the preview.
    throw Object.assign(new Error('預覽已過期，請重新載入'), { name: 'SupplementPreviewStaleError' })
  }
  if (res.status === 409) throw new Error('目錄已變更，請重新開啟書庫後再撤銷')
  return res
}

export async function previewWebSourceSupplements(bookId: string): Promise<WebSourceSupplementPreview> {
  const res = await postSupplementRoute(bookId, 'preview')
  if (!res.ok) throw new Error(await readWebSourceErrorReason(res, '無法預覽補章'))
  return res.json()
}

export async function applyWebSourceSupplements(
  bookId: string,
  previewToken: string,
  candidateIds: string[],
  manualPlacements?: Array<{ id: string; insertAfterIndex: number }>,
): Promise<WebSourceSupplementResult> {
  const res = await postSupplementRoute(bookId, 'apply', {
    previewToken, candidateIds, ...(manualPlacements?.length ? { manualPlacements } : {}),
  })
  if (!res.ok) throw new Error(await readWebSourceErrorReason(res, '補章失敗'))
  return res.json()
}

export async function undoWebSourceSupplements(bookId: string, batchId?: string): Promise<WebSourceSupplementResult> {
  const res = await postSupplementRoute(bookId, 'undo', batchId ? { batchId } : {})
  if (!res.ok) throw new Error(await readWebSourceErrorReason(res, '撤銷補章失敗'))
  return res.json()
}

export interface WebSourceSearchHit {
  providerId: string
  title: string
  url: string
}

export interface WebSourceProviderError {
  providerId: string
  message: string
}

export interface WebSourceSearchResponse {
  candidates: WebSourceSearchHit[]
  errors: WebSourceProviderError[]
}

export async function searchWebSources(title: string): Promise<WebSourceSearchResponse> {
  const res = await fetch(apiPath('/web-sources/search'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  checkAuthRedirect(res)
  if (res.status === 400) throw new Error('請輸入搜尋書名')
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export interface WebSourceChapterContent {
  index: number
  title: string
  sourceUrl?: string
  sourceTimestamp?: string
  contentHash?: string
  text: string
}

export interface WebSourceChapterWindow {
  chapters: WebSourceChapterContent[]
}

export async function fetchWebSourceChapters(
  bookId: string,
  window: { center: number; before: number; after: number; refresh?: boolean },
): Promise<WebSourceChapterWindow> {
  const params = new URLSearchParams({
    center: String(window.center),
    before: String(window.before),
    after: String(window.after),
  })
  if (window.refresh === true) params.set('refresh', '1')
  const res = await fetch(apiPath(`/web-sources/${encodeURIComponent(bookId)}/chapters?${params.toString()}`))
  checkAuthRedirect(res)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function renameBook(id: string, title: string): Promise<Book> {
  const res = await fetch(apiPath(`/books/${id}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  checkAuthRedirect(res)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function deleteBook(id: string): Promise<void> {
  const res = await fetch(apiPath(`/books/${id}`), { method: 'DELETE' })
  checkAuthRedirect(res)
  if (!res.ok) throw new Error(await res.text())
}

export interface Progress {
  positionType: string
  positionValue: number
  chapterOffset?: number
  chapterProgress?: number
  pageIndex?: number
  updatedAt: string
}

export interface ReaderSettings {
  bookId?: string | null
  fontSizePx: number
  lineHeight: number
  letterSpacingPx: number
  textColor: string
  backgroundColor: string
  readingMode: string
  tapScrollPercent: number
  tapScrollMode: 'allDown' | 'horizontal' | 'vertical'
  toolbarSide: 'left' | 'right'
  hardWrapMode: 'auto' | 'merge' | 'preserve'
  chineseConversion: 'none' | 'traditional' | 'simplified'
  contentFilters: string[]
  paddingTop: number
  paddingBottom: number
  annotationMarginTop: number
  annotationMarginBottom: number
  marginLeft: number
  marginRight: number
  paragraphSpacing: number
  paragraphIndent: number
  fontWeight: number
  justifyText: boolean
}

export async function getBookContent(id: string): Promise<string> {
  const res = await fetch(apiPath(`/books/${id}/content`))
  checkAuthRedirect(res)
  if (!res.ok) throw new Error(await res.text())
  return res.text()
}

export async function* streamBookContent(
  id: string,
): AsyncGenerator<string, void, unknown> {
  const res = await fetch(apiPath(`/books/${id}/content`))
  checkAuthRedirect(res)
  if (!res.ok) {
    const msg = await res.text().catch(() => String(res.status))
    throw new Error(`${res.status}: ${msg}`)
  }
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      yield decoder.decode(value, { stream: true })
    }
    const flush = decoder.decode()
    if (flush) yield flush
  } finally {
    reader.releaseLock()
  }
}


export async function getProgress(id: string): Promise<Progress | null> {
  const res = await fetch(apiPath(`/books/${id}/progress`))
  checkAuthRedirect(res)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function saveProgress(
  id: string,
  data: Pick<Progress, 'positionType' | 'positionValue' | 'chapterOffset' | 'chapterProgress'>,
  keepalive = false,
): Promise<void> {
  const res = await fetch(apiPath(`/books/${id}/progress`), {
    method: 'POST',
    keepalive,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  checkAuthRedirect(res)
  if (!res.ok) throw new Error(await res.text())
}

// ── Shared progress (same normalized-title web editions form one work) ────────

export interface SharedProgressChoice {
  bookId: string
  title: string
  positionValue: number
  chapterProgress: number | null
  chapterOffset: number | null
  manifestVersion: number
  updatedAt: string
}

export type SharedProgressState =
  | {
      kind: 'mapped'
      positionType: 'chapter_index'
      positionValue: number
      chapterProgress: number | null
      chapterOffset?: number | null
      updatedAt: string | null
    }
  | { kind: 'unmapped'; reason: string; anchorTitle: string | null; anchorBookId: string | null
      // reason 'legacy-missing-chapter': an old per-book record whose chapter is not in its edition's current list.
      legacyPositionValue?: number | null; chapterCount?: number }
  | { kind: 'empty' }
  | { kind: 'conflict'; choices: SharedProgressChoice[] }

export interface SharedWorkMember {
  id: string
  title: string
  /** 'txt' for an uploaded edition: preferred only when chosen by hand, never a 補章 target. */
  sourceType?: 'web' | 'txt'
  sourceUrl: string | null
  providerId?: string | null
  manifestVersion: number
}

export interface SharedWork {
  workId: string
  preferredBookId: string | null
  supplementBookId?: string | null
  members: SharedWorkMember[]
  revision: number
  /** Canonical position resolved into the requested physical book's manifest. */
  sharedProgress: SharedProgressState
}

export interface SharedProgressSave {
  positionType: 'chapter_index'
  positionValue: number
  chapterProgress?: number
  chapterOffset?: number
  manifestVersion: number
  expectedRevision: number
  expectedWorkId: string
}

// Matched by name, not class (page tests auto-mock api.ts, see M-001).
async function sharedStaleError(res: Response): Promise<Error> {
  let current: SharedWork | null = null
  try {
    current = ((await res.json()) as { current?: SharedWork }).current ?? null
  } catch {
    // non-JSON conflict body
  }
  return Object.assign(new Error('閱讀進度已在其他地方更新'), { name: 'SharedProgressStaleError', current })
}

async function postShared(path: string, body: unknown, keepalive = false): Promise<SharedWork> {
  const res = await fetch(apiPath(path), {
    method: 'POST',
    keepalive,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  checkAuthRedirect(res)
  if (res.status === 409) throw await sharedStaleError(res)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

/** Null when the book is not a web member of the current user's library. */
export async function getSharedProgress(bookId: string): Promise<SharedWork | null> {
  const res = await fetch(apiPath(`/books/${encodeURIComponent(bookId)}/shared-progress`))
  checkAuthRedirect(res)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export function saveSharedProgress(bookId: string, body: SharedProgressSave, keepalive = false): Promise<SharedWork> {
  return postShared(`/books/${encodeURIComponent(bookId)}/shared-progress`, body, keepalive)
}

export function selectSharedProgress(
  bookId: string,
  body: { selectedProgressBookId: string; expectedRevision: number; expectedWorkId: string },
): Promise<SharedWork> {
  return postShared(`/books/${encodeURIComponent(bookId)}/shared-progress`, body)
}

export function setPreferredSource(
  bookId: string,
  body: { preferredBookId: string; expectedPreferredBookId: string },
): Promise<SharedWork> {
  return postShared(`/books/${encodeURIComponent(bookId)}/preferred-source`, body)
}

export async function getSettings(bookId?: string): Promise<ReaderSettings> {
  const url = bookId ? apiPath(`/settings?bookId=${encodeURIComponent(bookId)}`) : apiPath('/settings')
  const res = await fetch(url)
  checkAuthRedirect(res)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function saveSettings(
  settings: Omit<ReaderSettings, 'bookId'> & { bookId?: string | null },
): Promise<void> {
  const res = await fetch(apiPath('/settings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
  checkAuthRedirect(res)
  if (!res.ok) throw new Error(await res.text())
}
