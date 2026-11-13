import type { SafeFetchTextResult } from '../fetch/SafeFetchService.js'

export class WebSourceBlockedError extends Error {
  constructor(host: string) {
    super(`${host} 目前以 Cloudflare 阻擋本服務的伺服器，暫時無法從伺服器端讀取（來源站反爬蟲策略，非網址問題）`)
    this.name = 'WebSourceBlockedError'
  }
}

export class WebSourceHttpError extends Error {
  readonly statusCode: number
  readonly retryAfterMs: number | null

  constructor(host: string, statusCode: number, retryAfterMs: number | null = null) {
    super(statusCode === 404
      ? `來源頁面不存在（${host} 回應 HTTP 404），請確認網址`
      : `來源站回應異常（${host} 回應 HTTP ${statusCode}）`)
    this.name = 'WebSourceHttpError'
    this.statusCode = statusCode
    this.retryAfterMs = retryAfterMs
  }
}

const CLOUDFLARE_BODY_MARKERS = ['just a moment', 'attention required! | cloudflare', 'cf-chl', '_cf_chl_opt']

// registration of a web source must tell the user WHY a fetch failed; SafeFetchService
// returns non-2xx bodies as ordinary text, so classification happens here.
export function ensureWebSourceResponse(
  response: Pick<SafeFetchTextResult, 'url' | 'statusCode' | 'headers' | 'text'>,
): void {
  if (response.statusCode < 400) return
  const host = new URL(response.url).hostname
  if (response.statusCode === 403 && isCloudflareChallenge(response)) {
    throw new WebSourceBlockedError(host)
  }
  throw new WebSourceHttpError(
    host,
    response.statusCode,
    response.statusCode === 429 ? parseRetryAfter(response.headers['retry-after']) : null,
  )
}

function isCloudflareChallenge(
  response: Pick<SafeFetchTextResult, 'statusCode' | 'headers' | 'text'>,
): boolean {
  if (firstHeader(response.headers['cf-mitigated'])) return true
  if (firstHeader(response.headers.server)?.toLowerCase() === 'cloudflare') return true
  const body = response.text.slice(0, 4096).toLowerCase()
  return CLOUDFLARE_BODY_MARKERS.some((marker) => body.includes(marker))
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function parseRetryAfter(value: string | string[] | undefined): number | null {
  const raw = firstHeader(value)?.trim()
  if (!raw) return null

  let delayMs: number
  if (/^\d+$/.test(raw)) {
    delayMs = Number.parseInt(raw, 10) * 1000
  } else {
    const retryAt = Date.parse(raw)
    if (!Number.isFinite(retryAt)) return null
    delayMs = retryAt - Date.now()
  }
  if (!Number.isFinite(delayMs)) return null
  return Math.max(1_000, Math.min(5 * 60_000, delayMs))
}
