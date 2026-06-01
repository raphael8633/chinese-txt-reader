import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]))
      } else {
        controller.close()
      }
    },
  })
}

describe('streamBookContent', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('yields all chunks so accumulated text matches full content', async () => {
    const chunks = ['第一章\n\n', '這是第一段\n\n', '第二章\n\n這是第二段']
    const stream = makeStream(chunks)
    const response = new Response(stream, { status: 200 })
    Object.defineProperty(response, 'redirected', { value: false })
    Object.defineProperty(response, 'url', { value: 'http://localhost/reader/api/books/abc/content' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const { streamBookContent } = await import('../api.js')
    const received: string[] = []
    for await (const chunk of streamBookContent('abc')) {
      received.push(chunk)
    }
    expect(received.join('')).toBe(chunks.join(''))
  })

  it('throws AuthExpiredError when response is redirected (auth)', async () => {
    const response = new Response(makeStream([]), { status: 200 })
    Object.defineProperty(response, 'redirected', { value: true })
    Object.defineProperty(response, 'url', { value: 'https://auth.example.test/login?rd=%2Freader%2Fapi%2Fbooks%2Fabc%2Fcontent' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const { AuthExpiredError, streamBookContent } = await import('../api.js')

    async function drain() {
      for await (const _ of streamBookContent('abc')) { /* drain */ }
    }
    await expect(drain()).rejects.toThrow(AuthExpiredError)
  })

  it('throws on non-ok response', async () => {
    const response = new Response('Not Found', { status: 404 })
    Object.defineProperty(response, 'redirected', { value: false })
    Object.defineProperty(response, 'url', { value: 'http://localhost/reader/api/books/missing/content' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const { streamBookContent } = await import('../api.js')

    async function drain() {
      for await (const _ of streamBookContent('missing')) { /* drain */ }
    }
    await expect(drain()).rejects.toThrow('404')
  })
})

describe('resolveScrollTarget', () => {
  it('returns null when target chapter index exceeds loaded chapters', async () => {
    const { resolveScrollTarget } = await import('../utils/readerUtils.js')
    const chapters = [{ index: 0, title: '開頭' }, { index: 100, title: '第一章' }]
    expect(resolveScrollTarget({ positionType: 'chapter_index', positionValue: 5 }, chapters, 200)).toBe(null)
  })

  it('returns the chapter paragraph index when chapter is loaded', async () => {
    const { resolveScrollTarget } = await import('../utils/readerUtils.js')
    const chapters = [{ index: 0, title: '開頭' }, { index: 150, title: '第一章' }]
    expect(resolveScrollTarget({ positionType: 'chapter_index', positionValue: 1 }, chapters, 500)).toBe(150)
  })

  it('clamps paragraph position type to valid range', async () => {
    const { resolveScrollTarget } = await import('../utils/readerUtils.js')
    const chapters = [{ index: 0, title: '開頭' }]
    expect(resolveScrollTarget({ positionType: 'paragraph_index', positionValue: 999 }, chapters, 200)).toBe(199)
    expect(resolveScrollTarget({ positionType: 'paragraph_index', positionValue: -5 }, chapters, 200)).toBe(0)
  })
})
