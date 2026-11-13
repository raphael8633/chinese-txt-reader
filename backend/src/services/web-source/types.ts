export type WebSourceChapter = {
  index: number
  title: string
  url: string
  chapterKey?: string
}

export type ParsedWebSource = {
  title: string
  sourceUrl: string
  providerId: string
  chapters: WebSourceChapter[]
  warnings?: string[]
  debugMessages?: string[]
}

export type WebSourceSearchHit = {
  providerId: string
  title: string
  url: string
}

export interface WebSourceProvider {
  readonly providerId: string
  /** Human-facing site name (zh-Hant); mirrors the frontend's WEB_SOURCE_NAMES map. */
  readonly displayName?: string
  /** Hostname shown in the supported-sites list of error messages. */
  readonly displayHost?: string
  /** A real chapter-list URL shape, shown when the host matches but the path does not. */
  readonly listUrlExample?: string
  canHandle(url: string): boolean
  /** True when the URL's host belongs to this provider even if the path shape is wrong. */
  canHandleHost?(url: string): boolean
  getChapterKey?(url: string): string | null
  search(title: string): Promise<WebSourceSearchHit[]>
  parseChapterList(url: string): Promise<ParsedWebSource>
  fetchChapterText(url: string): Promise<string>
}

export class UnsupportedWebSourceError extends Error {
  constructor(url: string) {
    super(`Unsupported web source URL: ${url}`)
    this.name = 'UnsupportedWebSourceError'
  }
}

export class WebSourceParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebSourceParseError'
  }
}
