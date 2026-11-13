import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const work = {
  workId: 'w1', preferredBookId: 'a', revision: 3,
  members: [{ id: 'a', title: '書', sourceUrl: 'https://a.test/', manifestVersion: 1 }],
  sharedProgress: { kind: 'mapped', positionType: 'chapter_index', positionValue: 2, chapterProgress: 0.5, updatedAt: '2026-10-10T00:00:00Z' },
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('shared progress API', () => {
  beforeEach(() => { vi.resetModules() })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('reads a work state with an encoded physical book ID and returns null for a non-member/foreign book', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(work)).mockResolvedValueOnce(json({ error: 'Not found' }, 404))
    vi.stubGlobal('fetch', fetchMock)
    const { getSharedProgress } = await import('../api.js')
    expect(await getSharedProgress('a/b')).toEqual(work)
    expect(fetchMock.mock.calls[0][0]).toBe('/reader/api/books/a%2Fb/shared-progress')
    expect(await getSharedProgress('foreign')).toBeNull()
  })

  it('posts a CAS save and surfaces a 409 as a stale error carrying the current state, without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: 'Stale revision', current: work }, 409))
    vi.stubGlobal('fetch', fetchMock)
    const { saveSharedProgress } = await import('../api.js')
    const body = { positionType: 'chapter_index' as const, positionValue: 1, manifestVersion: 1, expectedRevision: 2, expectedWorkId: 'w1' }
    const error = await saveSharedProgress('a', body, true).catch((e: unknown) => e) as Error & { current?: unknown }
    expect(error.name).toBe('SharedProgressStaleError')
    expect(error.current).toEqual(work)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', keepalive: true, body: JSON.stringify(body) })
  })

  it('selects an old saved record and changes the preferred source with expected previous ID', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json(work))
    vi.stubGlobal('fetch', fetchMock)
    const { selectSharedProgress, setPreferredSource } = await import('../api.js')
    await selectSharedProgress('a', { selectedProgressBookId: 'b', expectedRevision: 0, expectedWorkId: 'w1' })
    expect(fetchMock.mock.calls[0][0]).toBe('/reader/api/books/a/shared-progress')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ selectedProgressBookId: 'b', expectedRevision: 0, expectedWorkId: 'w1' })
    await setPreferredSource('a', { preferredBookId: 'b', expectedPreferredBookId: 'a' })
    expect(fetchMock.mock.calls[1][0]).toBe('/reader/api/books/a/preferred-source')
    fetchMock.mockResolvedValueOnce(json({ error: 'Stale preference', current: work }, 409))
    const error = await setPreferredSource('a', { preferredBookId: 'b', expectedPreferredBookId: 'x' }).catch((e: unknown) => e) as Error
    expect(error.name).toBe('SharedProgressStaleError')
  })

  it('maps an auth redirect to AuthExpiredError for shared reads', async () => {
    const redirected = new Response('<html>login</html>', { status: 200 })
    Object.defineProperty(redirected, 'redirected', { value: true })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(redirected))
    const { getSharedProgress, AuthExpiredError } = await import('../api.js')
    await expect(getSharedProgress('a')).rejects.toBeInstanceOf(AuthExpiredError)
  })
})
