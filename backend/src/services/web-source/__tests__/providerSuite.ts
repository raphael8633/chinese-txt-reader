import type { SafeFetchService } from '../../fetch/SafeFetchService.js'
import type { WebSourceProvider } from '../types.js'

export type SafeFetchLike = Pick<SafeFetchService, 'fetchText'>

/** A provider that implements every optional member of the interface. */
export type ConcreteProvider = WebSourceProvider & {
  readonly displayName: string
  readonly displayHost: string
  readonly listUrlExample: string
  getChapterKey(url: string): string | null
  canHandleHost(url: string): boolean
}

/**
 * Per-site suites take a factory rather than a constructor, so the same fixtures can be
 * replayed against a second implementation.
 */
export type ProviderFactory = (safeFetch: SafeFetchLike) => ConcreteProvider
