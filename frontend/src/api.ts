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
}

export interface Chapter {
  index: number
  title: string
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

export async function listBooks(): Promise<Book[]> {
  const res = await fetch(apiPath('/books'))
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
  data: { positionType: string; positionValue: number },
): Promise<void> {
  const res = await fetch(apiPath(`/books/${id}/progress`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  checkAuthRedirect(res)
  if (!res.ok) throw new Error(await res.text())
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
