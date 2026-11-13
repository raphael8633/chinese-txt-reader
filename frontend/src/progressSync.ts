import { saveProgress, saveSharedProgress, type SharedWork } from './api.js'
import { db, type LocalProgress } from './db.js'
import type { ProgressPosition } from './utils/readerUtils.js'

function payloadOf(progress: ProgressPosition): ProgressPosition {
  return {
    positionType: progress.positionType,
    positionValue: progress.positionValue,
    ...(progress.chapterOffset === undefined ? {} : { chapterOffset: progress.chapterOffset }),
    ...(progress.chapterProgress === undefined ? {} : { chapterProgress: progress.chapterProgress }),
  }
}

function samePosition(a: ProgressPosition, b: ProgressPosition): boolean {
  return a.positionType === b.positionType
    && a.positionValue === b.positionValue
    && a.chapterOffset === b.chapterOffset
    && a.chapterProgress === b.chapterProgress
}

/** The last position the server confirmed for this row; null when this device never learned it. */
export function syncedPositionOf(row: LocalProgress | undefined | null): ProgressPosition | null {
  if (!row) return null
  if (row.pendingSync !== true) return payloadOf(row)
  return row.syncedPosition ? payloadOf(row.syncedPosition) : null
}

// pendingSync=true for positions this device produced (reading, jumps, choices)
// until the server confirms them; false for positions copied from the server.
// A pending write carries the previous row's confirmed position forward.
export function writeLocalProgress(bookId: string, progress: ProgressPosition, pendingSync: boolean): Promise<unknown> {
  return db.transaction('rw', db.progress, async () => {
    const synced = pendingSync ? syncedPositionOf(await db.progress.get(bookId)) : null
    await db.progress.put({
      bookId,
      ...payloadOf(progress),
      pendingSync,
      ...(synced ? { syncedPosition: synced } : {}),
      updatedAt: new Date().toISOString(),
    })
  })
}

// Clears pendingSync only when the row still holds the confirmed position, so a
// newer position written while the save was in flight stays pending.
export async function markProgressSynced(bookId: string, progress: ProgressPosition): Promise<void> {
  const synced = payloadOf(progress)
  await db.transaction('rw', db.progress, async () => {
    const row = await db.progress.get(bookId)
    if (row && row.pendingSync !== false && samePosition(payloadOf(row), synced)) {
      const { syncedPosition: _previous, ...confirmed } = row
      await db.progress.put({ ...confirmed, pendingSync: false })
    }
  })
}

/** 'network' also covers server errors: anything except an expired login, which never heals by retrying. */
export type UploadFailure = 'auth' | 'network'
export type UploadResult = { status: 'saved' } | { status: 'failed'; reason: UploadFailure }

function uploadFailureOf(error: unknown): UploadFailure {
  return error instanceof Error && error.name === 'AuthExpiredError' ? 'auth' : 'network'
}

// The returned promise never rejects. A failed save (offline, auth expired)
// leaves the local row pending for the next merge.
export function syncProgressBestEffort(bookId: string, progress: ProgressPosition, keepalive = false): Promise<UploadResult> {
  const payload = payloadOf(progress)
  return Promise.resolve(keepalive ? saveProgress(bookId, payload, true) : saveProgress(bookId, payload))
    .then(
      () => markProgressSynced(bookId, payload).catch(() => undefined).then((): UploadResult => ({ status: 'saved' })),
      (error: unknown): UploadResult => ({ status: 'failed', reason: uploadFailureOf(error) }),
    )
}

// ── Shared work (same normalized-title web editions) ─────────────────────────

export interface SharedSession {
  bookId: string
  workId: string
  /** The physical book's complete manifest version the positions refer to. */
  manifestVersion: number
  revision: number
  /**
   * 'stale' after a 409 (user must choose); 'choice' while the position is unresolved/conflicting;
   * 'verifying' while a TXT edition's chapter ordinals are not yet proven to match the server's.
   */
  blocked: 'stale' | 'choice' | 'verifying' | null
  onStale?: (current: SharedWork | null) => void
}

export type SharedSyncResult =
  | { status: 'saved'; work: SharedWork }
  | { status: 'stale'; current: SharedWork | null }
  | { status: 'failed'; reason: UploadFailure }
  | { status: 'skipped' }

export function createSharedSession(
  init: Pick<SharedSession, 'bookId' | 'workId' | 'manifestVersion' | 'revision'>,
  onStale?: (current: SharedWork | null) => void,
): SharedSession {
  return { ...init, blocked: null, onStale }
}

// One save in flight per work: each save uses the revision the previous one
// returned, so this device never 409s against its own writes.
//
// A keepalive (pagehide/hidden) save also waits its turn: sending it beside an
// in-flight save with the same revision would make one of them 409 and block the
// session. If the page dies first, the final position is not lost: it was written
// to Dexie as pending before the save and only a save of that exact position
// confirms it, so the next open merges it and retries it through the CAS.
const workQueues = new Map<string, Promise<unknown>>()

/** A position the server rejected (409) must never compete with the canonical one again. */
async function markProgressRejected(bookId: string): Promise<void> {
  await db.transaction('rw', db.progress, async () => {
    const row = await db.progress.get(bookId)
    if (row && row.pendingSync !== false) await db.progress.put({ ...row, pendingSync: false })
  })
}

export function syncSharedProgress(session: SharedSession, progress: ProgressPosition, keepalive = false): Promise<SharedSyncResult> {
  const payload = payloadOf(progress)
  const run = async (): Promise<SharedSyncResult> => {
    if (session.blocked === 'stale') {
      // Written while the rejected save was in flight; it is just as stale.
      await markProgressRejected(session.bookId).catch(() => undefined)
      return { status: 'skipped' }
    }
    if (session.blocked !== null || payload.positionType !== 'chapter_index') return { status: 'skipped' }
    try {
      const work = await saveSharedProgress(session.bookId, {
        positionType: 'chapter_index',
        positionValue: payload.positionValue,
        ...(payload.chapterProgress === undefined ? {} : { chapterProgress: payload.chapterProgress }),
        ...(payload.chapterOffset === undefined ? {} : { chapterOffset: payload.chapterOffset }),
        manifestVersion: session.manifestVersion,
        expectedRevision: session.revision,
        expectedWorkId: session.workId,
      }, keepalive)
      session.revision = work.revision
      await markProgressSynced(session.bookId, payload).catch(() => undefined)
      return { status: 'saved', work }
    } catch (error) {
      if (error instanceof Error && error.name === 'SharedProgressStaleError') {
        // No automatic retry: another device/source moved the canonical position.
        const current = (error as Error & { current?: SharedWork | null }).current ?? null
        session.blocked = 'stale'
        await markProgressRejected(session.bookId).catch(() => undefined)
        session.onStale?.(current)
        return { status: 'stale', current }
      }
      return { status: 'failed', reason: uploadFailureOf(error) }
    }
  }
  const previous = workQueues.get(session.workId) ?? Promise.resolve()
  const next = previous.then(run, run)
  workQueues.set(session.workId, next)
  void next.then(() => {
    if (workQueues.get(session.workId) === next) workQueues.delete(session.workId)
  })
  return next
}

/** Resolves once every queued shared save has settled (used before opening another source). */
export async function waitForSharedSaves(): Promise<void> {
  await Promise.allSettled([...workQueues.values()])
}
