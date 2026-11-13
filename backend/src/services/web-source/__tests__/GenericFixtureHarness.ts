import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import iconv from 'iconv-lite'
import { vi } from 'vitest'
import type { SafeFetchBufferResult } from '../../fetch/SafeFetchService.js'
import {
  GenericWebSourceProvider,
  type GenericWebSourceProviderOptions,
} from '../GenericWebSourceProvider.js'

export type PageSpec = {
  html?: string
  /** Thrown instead of answering, for budget/network failure paths. */
  error?: Error
  /** iconv label used to encode the fixture into response bytes. */
  encoding?: string
  contentType?: string | null
  statusCode?: number
  headers?: Record<string, string | string[] | undefined>
  /** Prepended verbatim, for BOM tests. */
  bom?: number[]
}

export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/generic/${name}`, import.meta.url)), 'utf8')
}

export function stubFetch(pages: Record<string, PageSpec>) {
  return {
    fetchBuffer: vi.fn(async (url: string): Promise<SafeFetchBufferResult> => {
      const page = pages[url]
      if (!page) throw new Error(`unexpected fetch: ${url}`)
      if (page.error) throw page.error
      const encoded = iconv.encode(page.html ?? '', page.encoding ?? 'utf8')
      const body = page.bom ? Buffer.concat([Buffer.from(page.bom), encoded]) : encoded
      const contentType = page.contentType === null ? undefined : page.contentType ?? 'text/html'
      return {
        url,
        statusCode: page.statusCode ?? 200,
        headers: { ...(contentType ? { 'content-type': contentType } : {}), ...page.headers },
        data: new Uint8Array(body),
        bytesRead: body.length,
      }
    }),
  }
}

export function providerFor(
  pages: Record<string, PageSpec>,
  options?: GenericWebSourceProviderOptions,
): {
  provider: GenericWebSourceProvider
  safeFetch: ReturnType<typeof stubFetch>
} {
  const safeFetch = stubFetch(pages)
  return { provider: new GenericWebSourceProvider(safeFetch, options), safeFetch }
}
