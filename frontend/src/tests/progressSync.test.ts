import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api.js')

import { saveProgress, saveSharedProgress } from '../api.js'
import { db } from '../db.js'
import {
  createSharedSession, markProgressSynced, syncedPositionOf, syncProgressBestEffort, syncSharedProgress, waitForSharedSaves, writeLocalProgress,
} from '../progressSync.js'

const position = { positionType: 'chapter_index', positionValue: 4, chapterOffset: 120, chapterProgress: 0.05 }

describe('local progress sync state', () => {
  afterEach(async () => {
    db.close()
    await Dexie.delete('raph-reader')
    await db.open()
    vi.mocked(saveProgress).mockReset()
  })

  it('marks a reading write as pending until the server accepts that same position', async () => {
    await writeLocalProgress('book-1', position, true)
    expect((await db.progress.get('book-1'))?.pendingSync).toBe(true)
    vi.mocked(saveProgress).mockResolvedValue(undefined)
    await syncProgressBestEffort('book-1', position)
    expect(saveProgress).toHaveBeenLastCalledWith('book-1', position)
    expect((await db.progress.get('book-1'))?.pendingSync).toBe(false)
  })

  it('keeps the row pending when the save fails (offline)', async () => {
    await writeLocalProgress('book-1', position, true)
    vi.mocked(saveProgress).mockRejectedValue(new TypeError('Failed to fetch'))
    await syncProgressBestEffort('book-1', position)
    expect((await db.progress.get('book-1'))?.pendingSync).toBe(true)
  })

  it('does not clear a newer position written while an older save was in flight', async () => {
    await writeLocalProgress('book-1', position, true)
    await writeLocalProgress('book-1', { ...position, chapterOffset: 300, chapterProgress: 0.12 }, true)
    await markProgressSynced('book-1', position)
    const row = await db.progress.get('book-1')
    expect(row).toMatchObject({ chapterOffset: 300, pendingSync: true })
  })

  it('reports whether a save reached the server and why it did not', async () => {
    vi.mocked(saveProgress).mockResolvedValueOnce(undefined)
    expect(await syncProgressBestEffort('book-1', position)).toEqual({ status: 'saved' })
    vi.mocked(saveProgress).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await syncProgressBestEffort('book-1', position)).toEqual({ status: 'failed', reason: 'network' })
    vi.mocked(saveProgress).mockRejectedValueOnce(Object.assign(new Error('Session 已過期'), { name: 'AuthExpiredError' }))
    expect(await syncProgressBestEffort('book-1', position)).toEqual({ status: 'failed', reason: 'auth' })
  })

  it('remembers the last server-confirmed position while newer positions stay pending', async () => {
    const at = (positionValue: number) => ({ positionType: 'chapter_index', positionValue })
    await writeLocalProgress('book-1', at(3), false)
    await writeLocalProgress('book-1', at(7), true)
    await writeLocalProgress('book-1', at(9), true)
    expect(syncedPositionOf(await db.progress.get('book-1'))).toEqual(at(3))
    await markProgressSynced('book-1', at(9))
    expect(syncedPositionOf(await db.progress.get('book-1'))).toEqual(at(9))
  })

  it('has no confirmed position when this device only ever wrote pending positions', async () => {
    await writeLocalProgress('book-1', position, true)
    expect(syncedPositionOf(await db.progress.get('book-1'))).toBeNull()
    expect(syncedPositionOf(undefined)).toBeNull()
  })

  it('forwards fine progress and only requests keepalive for a final save', async () => {
    vi.mocked(saveProgress).mockResolvedValue(undefined)
    await syncProgressBestEffort('book-1', position, true)
    expect(saveProgress).toHaveBeenLastCalledWith('book-1', position, true)
    await syncProgressBestEffort('book-1', { positionType: 'chapter_index', positionValue: 2 })
    expect(saveProgress).toHaveBeenLastCalledWith('book-1', { positionType: 'chapter_index', positionValue: 2 })
  })
})

describe('shared work progress sync', () => {
  const work = (revision: number) => ({
    workId: 'w1', preferredBookId: 'book-1', revision, members: [],
    sharedProgress: { kind: 'empty' as const },
  })
  afterEach(async () => {
    vi.mocked(saveSharedProgress).mockReset()
    db.close()
    await Dexie.delete('raph-reader')
    await db.open()
  })

  it('serializes saves per work and sends the next save with the revision returned by the previous one', async () => {
    let release!: (value: ReturnType<typeof work>) => void
    vi.mocked(saveSharedProgress)
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      .mockResolvedValueOnce(work(5))
    const session = createSharedSession({ bookId: 'book-1', workId: 'w1', manifestVersion: 7, revision: 3 })
    const first = syncSharedProgress(session, position)
    const second = syncSharedProgress(session, { ...position, positionValue: 5 })
    await vi.waitFor(() => expect(saveSharedProgress).toHaveBeenCalledTimes(1))
    expect(saveSharedProgress).toHaveBeenLastCalledWith('book-1', {
      ...position, manifestVersion: 7, expectedRevision: 3, expectedWorkId: 'w1',
    }, false)
    release(work(4))
    expect(await first).toMatchObject({ status: 'saved' })
    expect(await second).toMatchObject({ status: 'saved' })
    expect(vi.mocked(saveSharedProgress).mock.calls[1][1]).toMatchObject({ positionValue: 5, expectedRevision: 4 })
    expect(session.revision).toBe(5)
  })

  it('blocks after a 409, reports the current state once, never retries, and stops the rejected local row from competing', async () => {
    await writeLocalProgress('book-1', position, true)
    vi.mocked(saveSharedProgress).mockRejectedValue(Object.assign(new Error('stale'), { name: 'SharedProgressStaleError', current: work(9) }))
    const onStale = vi.fn()
    const session = createSharedSession({ bookId: 'book-1', workId: 'w1', manifestVersion: 7, revision: 3 }, onStale)
    expect(await syncSharedProgress(session, position)).toMatchObject({ status: 'stale' })
    expect(await syncSharedProgress(session, position, true)).toMatchObject({ status: 'skipped' })
    expect(saveSharedProgress).toHaveBeenCalledTimes(1)
    expect(onStale).toHaveBeenCalledWith(work(9))
    expect(session.blocked).toBe('stale')
    // A rejected position must never auto-override the canonical one on the next open.
    expect((await db.progress.get('book-1'))?.pendingSync).toBe(false)
  })

  it('reports an expired login as an auth failure without blocking the session', async () => {
    vi.mocked(saveSharedProgress).mockRejectedValueOnce(Object.assign(new Error('Session 已過期'), { name: 'AuthExpiredError' }))
    const session = createSharedSession({ bookId: 'book-1', workId: 'w1', manifestVersion: 7, revision: 3 })
    expect(await syncSharedProgress(session, position)).toEqual({ status: 'failed', reason: 'auth' })
    expect(session.blocked).toBeNull()
  })

  it('keeps a final keepalive position pending when it is queued behind an in-flight save that the unload kills', async () => {
    // pagehide: the earlier save is in flight; the final keepalive save queues
    // behind it and never gets sent because the page is gone. The final position
    // must survive as a pending Dexie row so the next open retries it through CAS.
    await writeLocalProgress('book-1', position, true)
    let fail!: (error: Error) => void
    vi.mocked(saveSharedProgress)
      .mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const session = createSharedSession({ bookId: 'book-1', workId: 'w1', manifestVersion: 7, revision: 3 })
    const inFlight = syncSharedProgress(session, position)
    const final = { ...position, positionValue: 6, chapterOffset: 10, chapterProgress: 0.2 }
    await writeLocalProgress('book-1', final, true)
    const keepalive = syncSharedProgress(session, final, true)
    await vi.waitFor(() => expect(saveSharedProgress).toHaveBeenCalledTimes(1))
    fail(new TypeError('Failed to fetch'))
    expect(await inFlight).toEqual({ status: 'failed', reason: 'network' })
    expect(await keepalive).toEqual({ status: 'failed', reason: 'network' })
    expect(session.blocked).toBeNull()
    expect(await db.progress.get('book-1')).toMatchObject({ positionValue: 6, chapterOffset: 10, pendingSync: true })
  })

  it('does not confirm the final queued position when only the earlier in-flight save succeeds', async () => {
    await writeLocalProgress('book-1', position, true)
    let release!: (value: ReturnType<typeof work>) => void
    vi.mocked(saveSharedProgress)
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const session = createSharedSession({ bookId: 'book-1', workId: 'w1', manifestVersion: 7, revision: 3 })
    const inFlight = syncSharedProgress(session, position)
    const final = { ...position, positionValue: 6 }
    await writeLocalProgress('book-1', final, true)
    const keepalive = syncSharedProgress(session, final, true)
    await vi.waitFor(() => expect(saveSharedProgress).toHaveBeenCalledTimes(1))
    release(work(4))
    await inFlight
    await keepalive
    expect(vi.mocked(saveSharedProgress).mock.calls[1]).toEqual(['book-1', expect.objectContaining({ positionValue: 6, expectedRevision: 4 }), true])
    expect(await db.progress.get('book-1')).toMatchObject({ positionValue: 6, pendingSync: true })
  })

  it('confirms only the matching local row and lets callers wait for in-flight saves', async () => {
    await writeLocalProgress('book-1', position, true)
    let release!: (value: ReturnType<typeof work>) => void
    vi.mocked(saveSharedProgress).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const session = createSharedSession({ bookId: 'book-1', workId: 'w1', manifestVersion: 7, revision: 3 })
    void syncSharedProgress(session, position)
    let idle = false
    const waiting = waitForSharedSaves().then(() => { idle = true })
    await vi.waitFor(() => expect(saveSharedProgress).toHaveBeenCalled())
    expect(idle).toBe(false)
    release(work(4))
    await waiting
    expect((await db.progress.get('book-1'))?.pendingSync).toBe(false)
  })

  it('keeps a network failure pending without blocking a later save', async () => {
    vi.mocked(saveSharedProgress).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(work(4))
    const session = createSharedSession({ bookId: 'book-1', workId: 'w1', manifestVersion: 7, revision: 3 })
    expect(await syncSharedProgress(session, position)).toMatchObject({ status: 'failed' })
    expect(await syncSharedProgress(session, position)).toMatchObject({ status: 'saved' })
    expect(session.blocked).toBeNull()
  })
})
