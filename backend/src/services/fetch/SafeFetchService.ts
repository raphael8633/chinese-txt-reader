import { AsyncLocalStorage } from 'node:async_hooks'
import { lookup as dnsLookup } from 'node:dns/promises'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { pipeline } from 'node:stream/promises'
import iconv from 'iconv-lite'

const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024
const DEFAULT_MAX_REDIRECTS = 3
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443'])

type LookupResult = {
  address: string
  family: 4 | 6
}

type RequestResult = {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

export type RequesterOptions = {
  timeoutMs: number
  maxBytes: number
  address: LookupResult
  /** Aborted when the absolute deadline passes; the requester must tear the transport down. */
  signal?: AbortSignal
  method?: 'POST'
  body?: string
  headers?: Record<string, string>
}

type Requester = (url: URL, options: RequesterOptions) => Promise<RequestResult>

export type SafeFetchOptions = {
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  encoding?: string
  userId?: string
  method?: 'POST'
  body?: string
  headers?: Record<string, string>
}

export type SafeFetchTextResult = {
  url: string
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  text: string
  bytesRead: number
}

export type SafeFetchBufferOptions = {
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  contentTypes: string[]
  userId?: string
}

export type SafeFetchBufferResult = {
  url: string
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  data: Uint8Array
  bytesRead: number
}

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrfBlockedError'
  }
}

export class RedirectLimitError extends Error {
  constructor(message = 'Redirect limit exceeded') {
    super(message)
    this.name = 'RedirectLimitError'
  }
}

export class ResponseTooLargeError extends Error {
  constructor(message = 'Response is larger than the configured cap') {
    super(message)
    this.name = 'ResponseTooLargeError'
  }
}

export class UnsupportedContentTypeError extends Error {
  constructor(contentType: string) {
    super(`Unsupported content type: ${contentType}`)
    this.name = 'UnsupportedContentTypeError'
  }
}

export class FetchTimeoutError extends Error {
  constructor(message = 'Fetch timed out') {
    super(message)
    this.name = 'FetchTimeoutError'
  }
}

export type FetchBudgetLimitReason = 'fetches' | 'bytes' | 'deadline'

export class FetchBudgetExceededError extends Error {
  readonly reason: FetchBudgetLimitReason

  constructor(reason: FetchBudgetLimitReason) {
    super(FETCH_BUDGET_MESSAGES[reason])
    this.name = 'FetchBudgetExceededError'
    this.reason = reason
  }
}

const FETCH_BUDGET_MESSAGES: Record<FetchBudgetLimitReason, string> = {
  fetches: '本次操作向來源站的請求次數已達上限，請稍後再試或改用章節較少的目錄頁',
  bytes: '本次操作從來源站下載的資料量已達上限，請稍後再試',
  deadline: '本次操作處理來源站的時間已達上限，請稍後再試',
}

export type FetchBudget = {
  maxFetches: number
  maxBytes: number
  deadlineMs: number
}

export type FetchBudgetUsage = {
  fetches: number
  bytes: number
  /** True once a limit was hit, even if a provider swallowed the thrown error. */
  exhausted: boolean
  exhaustedReason: FetchBudgetLimitReason | null
}

/** Paces requests per host so a burst of provider fetches cannot hammer one site. */
export class HostRateLimiter {
  private readonly ratePerSecond: number
  private readonly burst: number
  private readonly now: () => number
  private readonly sleep: (delayMs: number) => Promise<void>
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>()

  constructor(options?: {
    ratePerSecond?: number
    burst?: number
    now?: () => number
    sleep?: (delayMs: number) => Promise<void>
  }) {
    this.ratePerSecond = options?.ratePerSecond ?? 2
    this.burst = options?.burst ?? 4
    this.now = options?.now ?? (() => Date.now())
    this.sleep = options?.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)))
  }

  // Reserve-then-wait: the token is taken synchronously so concurrent callers
  // each compute a distinct wait instead of waking together on a shared timer.
  async acquire(host: string): Promise<void> {
    const key = host.toLowerCase()
    const at = this.now()
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, updatedAt: at }
    const elapsedMs = Math.max(0, at - bucket.updatedAt)
    bucket.tokens = Math.min(this.burst, bucket.tokens + (elapsedMs / 1000) * this.ratePerSecond)
    bucket.updatedAt = at
    bucket.tokens -= 1
    this.buckets.set(key, bucket)
    if (bucket.tokens >= 0) return
    await this.sleep(Math.ceil((-bucket.tokens / this.ratePerSecond) * 1000))
  }
}

type FetchBudgetState = {
  budget: FetchBudget
  usage: FetchBudgetUsage
  startedAt: number
  now: () => number
  limiter: HostRateLimiter | null
}

const fetchBudgetStorage = new AsyncLocalStorage<FetchBudgetState>()

/**
 * Establishes a fetch budget for everything awaited inside `operation`.
 *
 * Providers hold their own SafeFetchService reference (constructor injection at
 * app wiring time), so the caller cannot wrap the instance they use. AsyncLocalStorage
 * is the seam: WebSourceService opens a context, and every SafeFetchService request —
 * whichever instance issues it, however deep in a provider — charges that context.
 */
export async function runWithFetchBudget<T>(
  budget: FetchBudget,
  operation: () => Promise<T>,
  options?: { limiter?: HostRateLimiter; now?: () => number },
): Promise<{ result: T; usage: FetchBudgetUsage }> {
  const now = options?.now ?? (() => Date.now())
  const state: FetchBudgetState = {
    budget,
    usage: { fetches: 0, bytes: 0, exhausted: false, exhaustedReason: null },
    startedAt: now(),
    now,
    limiter: options?.limiter ?? null,
  }
  const result = await fetchBudgetStorage.run(state, operation)
  return { result, usage: state.usage }
}

/** Bytes still spendable under the active budget, or null when unbudgeted. */
export function remainingFetchBudgetBytes(): number | null {
  const state = fetchBudgetStorage.getStore()
  if (!state) return null
  return Math.max(0, state.budget.maxBytes - state.usage.bytes)
}

/**
 * Charges one request against the active budget and waits for the host rate gate.
 * No-op outside a budget context. Exported so a test double (or a provider that
 * does its own transport) can participate in the same accounting.
 */
export async function chargeFetchBudget(host?: string): Promise<void> {
  const state = fetchBudgetStorage.getStore()
  if (!state) return
  const elapsedMs = state.now() - state.startedAt
  if (elapsedMs > state.budget.deadlineMs) throw markExhausted(state, 'deadline')
  if (state.usage.fetches >= state.budget.maxFetches) throw markExhausted(state, 'fetches')
  if (state.usage.bytes >= state.budget.maxBytes) throw markExhausted(state, 'bytes')
  state.usage.fetches += 1
  if (host && state.limiter) await state.limiter.acquire(host)
}

/**
 * Converts a stream abort caused by the clamped byte cap into the budget error.
 * The requester destroys the response with ResponseTooLargeError, so without this
 * the caller would see a size error instead of a budget one, and usage would not
 * record the truncation. Returns null when no budget is active.
 */
export function failFetchBudgetBytes(): FetchBudgetExceededError | null {
  const state = fetchBudgetStorage.getStore()
  if (!state) return null
  return markExhausted(state, 'bytes')
}

/** Records bytes read by a completed request against the active budget. */
export function recordFetchBudgetBytes(bytes: number): void {
  const state = fetchBudgetStorage.getStore()
  if (!state) return
  state.usage.bytes += bytes
  if (state.usage.bytes > state.budget.maxBytes) markExhausted(state, 'bytes')
}

function markExhausted(state: FetchBudgetState, reason: FetchBudgetLimitReason): FetchBudgetExceededError {
  if (!state.usage.exhausted) {
    state.usage.exhausted = true
    state.usage.exhaustedReason = reason
  }
  return new FetchBudgetExceededError(reason)
}

export class SafeFetchService {
  private readonly lookup: (hostname: string) => Promise<LookupResult[]>
  private readonly requester: Requester

  constructor(options?: {
    lookup?: (hostname: string) => Promise<LookupResult[]>
    requester?: Requester
  }) {
    this.lookup = options?.lookup ?? defaultLookup
    this.requester = options?.requester ?? defaultRequester
  }

  async fetchText(inputUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchTextResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS

    let currentUrl = parseHttpUrl(inputUrl)
    // Redirect targets are always refetched with a body-less GET (303-style),
    // so a POST can never be replayed against an unexpected host.
    let requestOverrides: Pick<SafeFetchOptions, 'method' | 'body' | 'headers'> = {
      ...(options.method ? { method: options.method } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    }

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const address = await this.resolveSafeAddress(currentUrl)
      await chargeFetchBudget(currentUrl.hostname)
      const response = await this.requestOnce(currentUrl, maxBytes, {
        timeoutMs,
        address,
        ...requestOverrides,
      })

      if (isRedirect(response.statusCode)) {
        const location = firstHeader(response.headers.location)
        if (!location) {
        return this.toTextResult(currentUrl, response, maxBytes, options.encoding)
        }
        requestOverrides = {}
        if (redirectCount === maxRedirects) {
          throw new RedirectLimitError()
        }
        currentUrl = parseHttpUrl(new URL(location, currentUrl).toString())
        continue
      }

      return this.toTextResult(currentUrl, response, maxBytes, options.encoding)
    }

    throw new RedirectLimitError()
  }

  async fetchBuffer(inputUrl: string, options: SafeFetchBufferOptions): Promise<SafeFetchBufferResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
    const allowedContentTypes = options.contentTypes.map((value) => value.toLowerCase())

    let currentUrl = parseHttpUrl(inputUrl)

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const address = await this.resolveSafeAddress(currentUrl)
      await chargeFetchBudget(currentUrl.hostname)
      const response = await this.requestOnce(currentUrl, maxBytes, { timeoutMs, address })

      if (isRedirect(response.statusCode)) {
        const location = firstHeader(response.headers.location)
        if (!location) {
          return this.toBufferResult(currentUrl, response, maxBytes, allowedContentTypes)
        }
        if (redirectCount === maxRedirects) {
          throw new RedirectLimitError()
        }
        currentUrl = parseHttpUrl(new URL(location, currentUrl).toString())
        continue
      }

      return this.toBufferResult(currentUrl, response, maxBytes, allowedContentTypes)
    }

    throw new RedirectLimitError()
  }

  /**
   * The single budgeted request path shared by fetchText and fetchBuffer: clamps the
   * size cap to the bytes the budget still allows, aborts the transport once the
   * absolute deadline passes, and reports an overrun caused by the clamp (not by the
   * caller's own cap) as a budget failure rather than a size failure.
   */
  private async requestOnce(
    url: URL,
    maxBytes: number,
    request: { timeoutMs: number; address: LookupResult } & Pick<SafeFetchOptions, 'method' | 'body' | 'headers'>,
  ): Promise<RequestResult> {
    const effectiveMaxBytes = clampToFetchBudget(maxBytes)
    let response: RequestResult
    try {
      response = await withTimeout(
        (signal) => this.requester(url, { ...request, maxBytes: effectiveMaxBytes, signal }),
        request.timeoutMs,
      )
    } catch (error) {
      if (error instanceof ResponseTooLargeError && effectiveMaxBytes < maxBytes) {
        throw failFetchBudgetBytes() ?? error
      }
      throw error
    }
    recordFetchBudgetBytes(response.body.byteLength)
    return response
  }

  private toBufferResult(
    url: URL,
    response: RequestResult,
    maxBytes: number,
    allowedContentTypes: string[],
  ): SafeFetchBufferResult {
    const contentType = firstHeader(response.headers['content-type'])
    if (!contentType || !matchesContentType(contentType, allowedContentTypes)) {
      throw new UnsupportedContentTypeError(contentType ?? '<missing>')
    }
    if (response.body.byteLength > maxBytes) {
      throw new ResponseTooLargeError()
    }

    const buffer = response.body
    return {
      url: url.toString(),
      statusCode: response.statusCode,
      headers: response.headers,
      data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      bytesRead: buffer.byteLength,
    }
  }

  private async resolveSafeAddress(url: URL): Promise<LookupResult> {
    const host = stripIpv6Brackets(url.hostname.toLowerCase())
    if (host === 'localhost') {
      throw new SsrfBlockedError('Blocked localhost hostname')
    }

    const literalIpFamily = net.isIP(host)
    if (literalIpFamily) {
      if (isBlockedIp(host)) {
        throw new SsrfBlockedError(`Blocked private or local address for ${host}`)
      }
      return { address: host, family: literalIpFamily as 4 | 6 }
    }

    const addresses = await this.lookup(host)
    const firstSafeAddress = addresses.find((address) => !isBlockedIp(address.address))
    if (!firstSafeAddress || addresses.some((address) => isBlockedIp(address.address))) {
      throw new SsrfBlockedError(`Blocked private or local address for ${host}`)
    }
    return firstSafeAddress
  }

  private toTextResult(url: URL, response: RequestResult, maxBytes: number, encoding?: string): SafeFetchTextResult {
    const contentType = firstHeader(response.headers['content-type'])
    if (contentType && !isSupportedContentType(contentType)) {
      throw new UnsupportedContentTypeError(contentType)
    }
    if (response.body.byteLength > maxBytes) {
      throw new ResponseTooLargeError()
    }

    return {
      url: url.toString(),
      statusCode: response.statusCode,
      headers: response.headers,
      text: encoding ? iconv.decode(response.body, encoding) : response.body.toString('utf8'),
      bytesRead: response.body.byteLength,
    }
  }
}

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1)
  }
  return hostname
}

function clampToFetchBudget(maxBytes: number): number {
  const remaining = remainingFetchBudgetBytes()
  return remaining === null ? maxBytes : Math.min(maxBytes, remaining)
}

function parseHttpUrl(input: string): URL {
  const url = new URL(input)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`Unsupported protocol: ${url.protocol}`)
  }
  // `http://evil.example@127.0.0.1/` reads as a trusted host to a human but
  // resolves to the userinfo-suffixed authority; refuse the ambiguity outright.
  if (url.username || url.password) {
    throw new SsrfBlockedError('Blocked URL containing userinfo')
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new SsrfBlockedError(`Blocked port: ${url.port}`)
  }
  return url
}

async function defaultLookup(hostname: string): Promise<LookupResult[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true })
  return results.map((result) => ({ address: result.address, family: result.family as 4 | 6 }))
}

export function defaultRequester(url: URL, options: RequesterOptions): Promise<RequestResult> {
  const transport = url.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    let response: http.IncomingMessage | null = null
    const abort = () => {
      const reason = options.signal?.reason
      const error = reason instanceof Error ? reason : new FetchTimeoutError()
      // Destroying the request alone can leave the response stream draining into
      // the temp file, so tear both down; pipeline's failure then removes the file.
      response?.destroy(error)
      req.destroy(error)
    }
    const detach = () => options.signal?.removeEventListener('abort', abort)
    const settleWith = <T>(settle: (value: T) => void) => (value: T) => {
      detach()
      settle(value)
    }
    const finish = settleWith(resolve)
    const fail = settleWith(reject)

    const req = transport.request(
      url,
      {
        method: options.method ?? 'GET',
        timeout: options.timeoutMs,
        headers: {
          'user-agent': 'raph-reader-network-import/0.1',
          accept: 'text/html, text/plain, application/xhtml+xml;q=0.9, application/octet-stream;q=0.8, application/x-rar-compressed;q=0.8, */*;q=0.5',
          ...(options.body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...options.headers,
        },
        lookup: (_hostname, lookupOptions, callback) => {
          if (typeof lookupOptions === 'object' && lookupOptions !== null && 'all' in lookupOptions && lookupOptions.all) {
            callback(null, [{ address: options.address.address, family: options.address.family }])
            return
          }
          callback(null, options.address.address, options.address.family)
        },
      },
      async (res) => {
        response = res
        const tempDir = await mkdtemp(join(tmpdir(), 'raph-safe-fetch-'))
        const tempFile = join(tempDir, 'body')
        let bytesRead = 0

        res.on('data', (chunk: Buffer) => {
          bytesRead += chunk.byteLength
          if (bytesRead > options.maxBytes) {
            req.destroy(new ResponseTooLargeError())
          }
        })

        try {
          await pipeline(res, createWriteStream(tempFile))
          const body = await readFile(tempFile)
          finish({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body,
          })
        } catch (error) {
          fail(error)
        } finally {
          await rm(tempDir, { recursive: true, force: true })
        }
      },
    )

    req.on('timeout', () => {
      req.destroy(new FetchTimeoutError())
    })
    req.on('error', fail)
    if (options.signal?.aborted) {
      abort()
    } else {
      options.signal?.addEventListener('abort', abort, { once: true })
    }
    req.end(options.body)
  })
}

/**
 * Bounds a request by wall-clock time. The rejection alone would leave the socket,
 * the response stream and the temp file alive — a server dripping one byte at a time
 * never trips the socket inactivity timeout — so the signal is what actually stops
 * the work; the wrapper only reports it.
 */
function withTimeout<T>(start: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      const error = new FetchTimeoutError()
      controller.abort(error)
      reject(error)
    }, timeoutMs)

    let started: Promise<T>
    try {
      started = start(controller.signal)
    } catch (error) {
      clearTimeout(timeout)
      reject(error)
      return
    }

    started.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

function isRedirect(statusCode: number): boolean {
  return statusCode >= 300 && statusCode < 400
}

function firstHeader(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header[0] : header
}

function isSupportedContentType(contentType: string): boolean {
  const normalized = contentType.split(';', 1)[0].trim().toLowerCase()
  return normalized.startsWith('text/') || normalized === 'application/xhtml+xml'
}

function matchesContentType(contentType: string, allowed: string[]): boolean {
  const normalized = contentType.split(';', 1)[0].trim().toLowerCase()
  return allowed.includes(normalized)
}

function isBlockedIp(address: string): boolean {
  if (net.isIPv4(address)) {
    return isBlockedIpv4(address)
  }

  if (net.isIPv6(address)) {
    return isBlockedIpv6(address)
  }

  return true
}

// Deny-list of IPv4 ranges that are not globally routable unicast. Anything that
// can reach a host inside the deployment (loopback, RFC1918, CGNAT, link-local),
// plus multicast/reserved space and the benchmarking + IETF protocol blocks.
function isBlockedIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part))
  const [a, b] = parts

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  )
}

// Allowlist: only 2000::/3 global unicast is reachable. That single rule rejects
// ::, ::1, fc00::/7 ULA, fe80::/10 link-local, ff00::/8 multicast and the NAT64
// well-known prefix without enumerating them. IPv4-mapped addresses are unwrapped
// first so ::ffff:127.0.0.1 is judged by the IPv4 rules rather than slipping past.
function isBlockedIpv6(address: string): boolean {
  const groups = expandIpv6(address)
  if (!groups) return true

  const isIpv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
  if (isIpv4Mapped) {
    const high = groups[6]
    const low = groups[7]
    return isBlockedIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff].join('.'))
  }

  return (groups[0] & 0xe000) !== 0x2000
}

function expandIpv6(address: string): number[] | null {
  let normalized = address.toLowerCase().split('%', 1)[0]
  const dotted = normalized.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (dotted) {
    const octets = dotted[1].split('.').map((part) => Number(part))
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null
    const high = ((octets[0] << 8) | octets[1]).toString(16)
    const low = ((octets[2] << 8) | octets[3]).toString(16)
    normalized = `${normalized.slice(0, dotted.index)}${high}:${low}`
  }

  const [head, tail, ...extra] = normalized.split('::')
  if (extra.length > 0) return null
  const headGroups = head ? head.split(':') : []
  const tailGroups = tail === undefined ? [] : tail ? tail.split(':') : []
  const fillCount = tail === undefined
    ? 0
    : 8 - headGroups.length - tailGroups.length
  if (tail === undefined ? headGroups.length !== 8 : fillCount < 1) return null

  const groups = [
    ...headGroups,
    ...Array.from({ length: fillCount }, () => '0'),
    ...tailGroups,
  ].map((group) => Number.parseInt(group, 16))
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) {
    return null
  }
  return groups
}
