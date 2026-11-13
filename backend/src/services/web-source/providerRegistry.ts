import type { SafeFetchService } from '../fetch/SafeFetchService.js'
import { GenericWebSourceProvider } from './GenericWebSourceProvider.js'
import type { WebSourceProvider } from './types.js'

/** Public build: no site-specific definitions; the generic provider reads any table-of-contents URL. */
export function createWebSourceProviders(safeFetch: SafeFetchService): WebSourceProvider[] {
  return [new GenericWebSourceProvider(safeFetch)]
}
