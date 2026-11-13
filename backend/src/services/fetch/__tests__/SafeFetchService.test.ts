import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  FetchBudgetExceededError,
  FetchTimeoutError,
  HostRateLimiter,
  RedirectLimitError,
  ResponseTooLargeError,
  SafeFetchService,
  SsrfBlockedError,
  UnsupportedContentTypeError,
  defaultRequester,
  runWithFetchBudget,
} from '../SafeFetchService.js'

const publicLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }])

function makeResponse(
  body: string,
  options: { statusCode?: number; headers?: Record<string, string | undefined> } = {},
) {
  return {
    statusCode: options.statusCode ?? 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...options.headers,
    },
    body: Buffer.from(body),
  }
}

describe('SafeFetchService', () => {
  it.each([
    ['127.0.0.1'],
    ['::1'],
    ['localhost'],
    ['169.254.1.10'],
    ['10.0.0.5'],
    ['172.16.0.1'],
    ['172.31.255.255'],
    ['192.168.1.3'],
    ['fc00::1'],
  ])('blocks local or private address %s before request', async (address) => {
    const requester = vi.fn()
    const lookup = vi.fn(async () => [{ address, family: address.includes(':') ? (6 as const) : (4 as const) }])
    const service = new SafeFetchService({ lookup, requester })

    await expect(service.fetchText(`http://${address === 'localhost' ? 'localhost' : 'example.test'}/book`)).rejects.toBeInstanceOf(
      SsrfBlockedError,
    )
    expect(requester).not.toHaveBeenCalled()
  })

  it('blocks a hostname if any resolved address is private', async () => {
    const requester = vi.fn()
    const lookup = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 as const },
      { address: '127.0.0.1', family: 4 as const },
    ])
    const service = new SafeFetchService({ lookup, requester })

    await expect(service.fetchText('https://example.test/book')).rejects.toBeInstanceOf(SsrfBlockedError)
    expect(requester).not.toHaveBeenCalled()
  })

  it('blocks bracketed IPv6 literals without DNS lookup', async () => {
    const requester = vi.fn()
    const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }])
    const service = new SafeFetchService({ lookup, requester })

    await expect(service.fetchText('http://[::1]/book')).rejects.toBeInstanceOf(SsrfBlockedError)
    expect(lookup).not.toHaveBeenCalled()
    expect(requester).not.toHaveBeenCalled()
  })

  it('fetches supported text content through the resolved public address', async () => {
    const requester = vi.fn(async () => makeResponse('<html>第一序列</html>'))
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    const result = await service.fetchText('https://example.test/book')

    expect(result.text).toBe('<html>第一序列</html>')
    expect(result.bytesRead).toBe(Buffer.byteLength('<html>第一序列</html>'))
    expect(requester).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        address: { address: '93.184.216.34', family: 4 },
        timeoutMs: 8000,
        maxBytes: 20 * 1024 * 1024,
      }),
    )
  })

  it('follows redirects and checks DNS for every target', async () => {
    const lookup = vi.fn(async (hostname: string) => {
      if (hostname === 'evil.test') {
        return [{ address: '127.0.0.1', family: 4 as const }]
      }
      return [{ address: '93.184.216.34', family: 4 as const }]
    })
    const requester = vi
      .fn()
      .mockResolvedValueOnce(makeResponse('', { statusCode: 302, headers: { location: 'https://evil.test/private' } }))
    const service = new SafeFetchService({ lookup, requester })

    await expect(service.fetchText('https://example.test/book')).rejects.toBeInstanceOf(SsrfBlockedError)
    expect(lookup).toHaveBeenCalledWith('example.test')
    expect(lookup).toHaveBeenCalledWith('evil.test')
  })

  it('throws after the configured redirect limit', async () => {
    const requester = vi.fn(async (url: URL) =>
      makeResponse('', { statusCode: 302, headers: { location: `https://example.test${url.pathname}/next` } }),
    )
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    await expect(service.fetchText('https://example.test/book', { maxRedirects: 3 })).rejects.toBeInstanceOf(
      RedirectLimitError,
    )
    expect(requester).toHaveBeenCalledTimes(4)
  })

  it('rejects responses that exceed the size cap', async () => {
    const requester = vi.fn(async () => makeResponse('abcd'))
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    await expect(service.fetchText('https://example.test/book', { maxBytes: 3 })).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    )
  })

  it('rejects unsupported content types', async () => {
    const requester = vi.fn(async () => makeResponse('%PDF', { headers: { 'content-type': 'application/pdf' } }))
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    await expect(service.fetchText('https://example.test/book')).rejects.toBeInstanceOf(UnsupportedContentTypeError)
  })

  it('fetchBuffer returns raw bytes for binary content types', async () => {
    const rarBytes = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])
    const requester = vi.fn(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: rarBytes,
    }))
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    const result = await service.fetchBuffer('https://example.test/book.rar', {
      contentTypes: ['application/x-rar-compressed', 'application/octet-stream'],
    })

    expect(result.data).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(result.data).equals(rarBytes)).toBe(true)
    expect(result.bytesRead).toBe(rarBytes.byteLength)
  })

  it('fetchBuffer rejects content types not in the allowlist', async () => {
    const requester = vi.fn(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from('<html>'),
    }))
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    await expect(
      service.fetchBuffer('https://example.test/x', {
        contentTypes: ['application/octet-stream'],
      }),
    ).rejects.toBeInstanceOf(UnsupportedContentTypeError)
  })

  it('fetchBuffer enforces the size cap before returning', async () => {
    const requester = vi.fn(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(64),
    }))
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    await expect(
      service.fetchBuffer('https://example.test/x', {
        contentTypes: ['application/octet-stream'],
        maxBytes: 32,
      }),
    ).rejects.toBeInstanceOf(ResponseTooLargeError)
  })

  it('fetchBuffer follows redirects with DNS re-resolution', async () => {
    const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }])
    const requester = vi
      .fn()
      .mockResolvedValueOnce({
        statusCode: 302,
        headers: { location: 'https://example.test/final.rar', 'content-type': 'text/html' },
        body: Buffer.from(''),
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from([1, 2, 3]),
      })
    const service = new SafeFetchService({ lookup, requester })

    const result = await service.fetchBuffer('https://example.test/start.rar', {
      contentTypes: ['application/octet-stream'],
    })

    expect(Buffer.from(result.data).equals(Buffer.from([1, 2, 3]))).toBe(true)
    expect(requester).toHaveBeenCalledTimes(2)
  })

  it('times out slow requests', async () => {
    vi.useFakeTimers()
    const requester = vi.fn(() => new Promise<ReturnType<typeof makeResponse>>(() => undefined))
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    const promise = service.fetchText('https://example.test/book', { timeoutMs: 25 })
    const assertion = expect(promise).rejects.toBeInstanceOf(FetchTimeoutError)
    await vi.advanceTimersByTimeAsync(25)

    await assertion
    vi.useRealTimers()
  })
})

describe('SafeFetchService absolute timeout', () => {
  it('aborts the requester through the signal it hands out', async () => {
    vi.useFakeTimers()
    let reason: unknown
    const requester = vi.fn((_url: URL, options: { signal?: AbortSignal }) => {
      options.signal?.addEventListener('abort', () => {
        reason = options.signal?.reason
      })
      return new Promise<ReturnType<typeof makeResponse>>(() => undefined)
    })
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    const promise = service.fetchText('https://example.test/book', { timeoutMs: 25 })
    const assertion = expect(promise).rejects.toBeInstanceOf(FetchTimeoutError)
    await vi.advanceTimersByTimeAsync(25)

    await assertion
    expect(reason).toBeInstanceOf(FetchTimeoutError)
    vi.useRealTimers()
  })

  it('tears down a slow-drip response instead of leaving it streaming', async () => {
    // One byte every 50 ms keeps the socket busy, so the inactivity timeout never
    // fires: only the absolute deadline can stop this server.
    let drip: ReturnType<typeof setInterval> | undefined
    let markClosed = () => {}
    const responseClosed = new Promise<void>((resolve) => {
      markClosed = resolve
    })
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      drip = setInterval(() => res.write('x'), 50)
      res.on('close', () => {
        clearInterval(drip)
        markClosed()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    // The SSRF checks still run against example.test; only the transport is
    // redirected to the local drip server, which SafeFetch would otherwise block.
    const service = new SafeFetchService({
      lookup: publicLookup,
      requester: (url, options) => defaultRequester(
        new URL(`http://127.0.0.1:${port}${url.pathname}`),
        { ...options, address: { address: '127.0.0.1', family: 4 } },
      ),
    })

    try {
      await expect(service.fetchText('https://example.test/slow', { timeoutMs: 300 }))
        .rejects.toBeInstanceOf(FetchTimeoutError)
      await expect(Promise.race([
        responseClosed,
        new Promise((_resolve, reject) => setTimeout(
          () => reject(new Error('response stream was still streaming 2s after the deadline')),
          2000,
        )),
      ])).resolves.toBeUndefined()
    } finally {
      clearInterval(drip)
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 10_000)
})

describe('SafeFetchService POST support', () => {
  it('passes method, body and extra headers through to the requester', async () => {
    const requester = vi.fn(async () => makeResponse('<li><a href="/read/1/p1.html">第1章</a></li>'))
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    await service.fetchText('https://example.test/novel/html/', {
      method: 'POST',
      body: 'bid=261528',
      headers: {
        'x-requested-with': 'XMLHttpRequest',
        referer: 'https://example.test/read/261528/',
      },
    })

    expect(requester).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        method: 'POST',
        body: 'bid=261528',
        headers: {
          'x-requested-with': 'XMLHttpRequest',
          referer: 'https://example.test/read/261528/',
        },
      }),
    )
  })

  it('follows a redirect after a POST with a body-less GET', async () => {
    const requester = vi
      .fn()
      .mockResolvedValueOnce(makeResponse('', {
        statusCode: 302,
        headers: { location: 'https://example.test/other' },
      }))
      .mockResolvedValueOnce(makeResponse('ok'))
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    const result = await service.fetchText('https://example.test/novel/html/', {
      method: 'POST',
      body: 'bid=1',
    })

    expect(result.text).toBe('ok')
    const secondCall = requester.mock.calls[1]
    expect(secondCall[1].method).toBeUndefined()
    expect(secondCall[1].body).toBeUndefined()
  })
})

describe('SafeFetchService hardening', () => {
  it.each([
    ['0.0.0.0'],
    ['100.64.0.1'],
    ['100.127.255.254'],
    ['192.0.0.1'],
    ['198.18.0.1'],
    ['198.19.255.255'],
    ['224.0.0.1'],
    ['240.0.0.1'],
  ])('blocks non-routable IPv4 address %s', async (address) => {
    const requester = vi.fn()
    const lookup = vi.fn(async () => [{ address, family: 4 as const }])
    const service = new SafeFetchService({ lookup, requester })

    await expect(service.fetchText('http://example.test/book')).rejects.toBeInstanceOf(SsrfBlockedError)
    expect(requester).not.toHaveBeenCalled()
  })

  it.each([
    ['::'],
    ['ff02::1'],
    ['ff00::'],
    ['fe80::1'],
    ['64:ff9b::7f00:1'],
    ['::ffff:127.0.0.1'],
    ['::ffff:10.0.0.1'],
    ['::ffff:169.254.1.1'],
  ])('blocks non-global-unicast IPv6 address %s', async (address) => {
    const requester = vi.fn()
    const lookup = vi.fn(async () => [{ address, family: 6 as const }])
    const service = new SafeFetchService({ lookup, requester })

    await expect(service.fetchText('http://example.test/book')).rejects.toBeInstanceOf(SsrfBlockedError)
    expect(requester).not.toHaveBeenCalled()
  })

  it.each([
    ['2606:4700:4700::1111'],
    ['::ffff:8.8.8.8'],
  ])('allows global unicast IPv6 address %s', async (address) => {
    const requester = vi.fn(async () => makeResponse('<html>ok</html>'))
    const lookup = vi.fn(async () => [{ address, family: 6 as const }])
    const service = new SafeFetchService({ lookup, requester })

    const result = await service.fetchText('http://example.test/book')
    expect(result.statusCode).toBe(200)
    expect(requester).toHaveBeenCalledTimes(1)
  })

  it('rejects URLs carrying userinfo before any lookup', async () => {
    const requester = vi.fn()
    const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }])
    const service = new SafeFetchService({ lookup, requester })

    await expect(service.fetchText('http://example.test@127.0.0.1/book')).rejects.toThrow(
      /userinfo/,
    )
    expect(lookup).not.toHaveBeenCalled()
    expect(requester).not.toHaveBeenCalled()
  })

  it.each([['8081'], ['3306'], ['22']])('rejects non-web port %s', async (port) => {
    const requester = vi.fn()
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    await expect(service.fetchText(`http://example.test:${port}/book`)).rejects.toBeInstanceOf(
      SsrfBlockedError,
    )
    expect(requester).not.toHaveBeenCalled()
  })

  it.each([['80'], ['443'], ['8080'], ['8443']])('allows web port %s', async (port) => {
    const requester = vi.fn(async () => makeResponse('<html>ok</html>'))
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    await expect(service.fetchText(`http://example.test:${port}/book`)).resolves.toMatchObject({
      statusCode: 200,
    })
  })

  it('rejects a redirect target on a disallowed port', async () => {
    const requester = vi.fn(async () => makeResponse('', {
      statusCode: 302,
      headers: { location: 'http://example.test:9000/book' },
    }))
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    await expect(service.fetchText('https://example.test/book')).rejects.toBeInstanceOf(SsrfBlockedError)
    expect(requester).toHaveBeenCalledTimes(1)
  })

  it('honours a caller-supplied maxBytes smaller than the default cap', async () => {
    const requester = vi.fn(async () => makeResponse('x'.repeat(64)))
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    await service.fetchText('https://example.test/book', { maxBytes: 4 * 1024 * 1024 })

    expect(requester).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ maxBytes: 4 * 1024 * 1024 }),
    )
  })

  it('rejects a body larger than the caller-supplied maxBytes', async () => {
    const requester = vi.fn(async () => makeResponse('x'.repeat(100)))
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    await expect(
      service.fetchText('https://example.test/book', { maxBytes: 50 }),
    ).rejects.toBeInstanceOf(ResponseTooLargeError)
  })
})

describe('fetch budget context', () => {
  it('is inert outside a budget context', async () => {
    const requester = vi.fn(async () => makeResponse('<html>ok</html>'))
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    for (let i = 0; i < 5; i += 1) {
      await service.fetchText('https://example.test/book')
    }
    expect(requester).toHaveBeenCalledTimes(5)
  })

  it('stops fetching once the request count is spent and reports usage', async () => {
    const requester = vi.fn(async () => makeResponse('<html>ok</html>'))
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    let caught: unknown
    const { usage } = await runWithFetchBudget(
      { maxFetches: 2, maxBytes: 1_000_000, deadlineMs: 60_000 },
      async () => {
        try {
          for (let i = 0; i < 5; i += 1) {
            await service.fetchText('https://example.test/book')
          }
        } catch (error) {
          caught = error
        }
      },
    )

    expect(caught).toBeInstanceOf(FetchBudgetExceededError)
    expect((caught as FetchBudgetExceededError).reason).toBe('fetches')
    expect(requester).toHaveBeenCalledTimes(2)
    expect(usage).toMatchObject({ fetches: 2, exhausted: true, exhaustedReason: 'fetches' })
  })

  it('records usage as exhausted even when the caller swallows the error', async () => {
    const requester = vi.fn(async () => makeResponse('<html>ok</html>'))
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    const { usage } = await runWithFetchBudget(
      { maxFetches: 1, maxBytes: 1_000_000, deadlineMs: 60_000 },
      async () => {
        await service.fetchText('https://example.test/book')
        // Providers swallow recovery failures; usage must still show the truncation.
        await service.fetchText('https://example.test/book').catch(() => undefined)
      },
    )

    expect(usage.exhausted).toBe(true)
    expect(usage.fetches).toBe(1)
  })

  it('stops fetching once the byte budget is spent', async () => {
    const requester = vi.fn(async () => makeResponse('x'.repeat(600)))
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    const attempt = runWithFetchBudget(
      { maxFetches: 50, maxBytes: 1000, deadlineMs: 60_000 },
      async () => {
        await service.fetchText('https://example.test/a')
        await service.fetchText('https://example.test/b')
        await service.fetchText('https://example.test/c')
      },
    )

    await expect(attempt).rejects.toMatchObject({ name: 'FetchBudgetExceededError', reason: 'bytes' })
    expect(requester).toHaveBeenCalledTimes(2)
  })

  it('clamps a request cap to the bytes still left in the budget', async () => {
    const requester = vi.fn(async () => makeResponse('x'.repeat(400)))
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    await runWithFetchBudget(
      { maxFetches: 10, maxBytes: 1000, deadlineMs: 60_000 },
      async () => {
        await service.fetchText('https://example.test/a', { maxBytes: 5000 })
        await service.fetchText('https://example.test/b', { maxBytes: 5000 })
      },
    )

    expect(requester).toHaveBeenNthCalledWith(
      1,
      expect.any(URL),
      expect.objectContaining({ maxBytes: 1000 }),
    )
    expect(requester).toHaveBeenNthCalledWith(
      2,
      expect.any(URL),
      expect.objectContaining({ maxBytes: 600 }),
    )
  })

  it('reports a stream aborted by the clamped cap as a budget failure', async () => {
    // A real requester destroys the response once maxBytes is passed, so the
    // budget must claim that abort instead of leaking a size error.
    const requester = vi.fn(async (_url: URL, options: { maxBytes: number }) => {
      const body = 'x'.repeat(600)
      if (body.length > options.maxBytes) throw new ResponseTooLargeError()
      return makeResponse(body)
    })
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    let caught: unknown
    const { usage } = await runWithFetchBudget(
      { maxFetches: 10, maxBytes: 1000, deadlineMs: 60_000 },
      async () => {
        await service.fetchText('https://example.test/a')
        try {
          await service.fetchText('https://example.test/b')
        } catch (error) {
          caught = error
        }
      },
    )

    expect(caught).toBeInstanceOf(FetchBudgetExceededError)
    expect((caught as FetchBudgetExceededError).reason).toBe('bytes')
    expect(usage).toMatchObject({ exhausted: true, exhaustedReason: 'bytes' })
  })

  it('still reports an oversized single page as a size error, not a budget error', async () => {
    const requester = vi.fn(async (_url: URL, options: { maxBytes: number }) => {
      const body = 'x'.repeat(600)
      if (body.length > options.maxBytes) throw new ResponseTooLargeError()
      return makeResponse(body)
    })
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    const attempt = runWithFetchBudget(
      { maxFetches: 10, maxBytes: 1_000_000, deadlineMs: 60_000 },
      async () => {
        await service.fetchText('https://example.test/a', { maxBytes: 100 })
      },
    )

    await expect(attempt).rejects.toBeInstanceOf(ResponseTooLargeError)
  })

  it('stops fetching once the deadline passes', async () => {
    const requester = vi.fn(async () => makeResponse('<html>ok</html>'))
    const service = new SafeFetchService({ lookup: publicLookup, requester })
    let clock = 0
    const now = () => {
      clock += 400
      return clock
    }

    const attempt = runWithFetchBudget(
      { maxFetches: 50, maxBytes: 1_000_000, deadlineMs: 1000 },
      async () => {
        for (let i = 0; i < 10; i += 1) {
          await service.fetchText('https://example.test/book')
        }
      },
      { now },
    )

    await expect(attempt).rejects.toMatchObject({ name: 'FetchBudgetExceededError', reason: 'deadline' })
    expect(requester.mock.calls.length).toBeLessThan(10)
  })

  it('clamps a fetchBuffer request cap to the bytes still left in the budget', async () => {
    const requester = vi.fn(async () => makeResponse('x'.repeat(400), {
      headers: { 'content-type': 'application/octet-stream' },
    }))
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    await runWithFetchBudget(
      { maxFetches: 10, maxBytes: 1000, deadlineMs: 60_000 },
      async () => {
        await service.fetchBuffer('https://example.test/a', {
          maxBytes: 5000,
          contentTypes: ['application/octet-stream'],
        })
        await service.fetchBuffer('https://example.test/b', {
          maxBytes: 5000,
          contentTypes: ['application/octet-stream'],
        })
      },
    )

    expect(requester).toHaveBeenNthCalledWith(
      1,
      expect.any(URL),
      expect.objectContaining({ maxBytes: 1000 }),
    )
    expect(requester).toHaveBeenNthCalledWith(
      2,
      expect.any(URL),
      expect.objectContaining({ maxBytes: 600 }),
    )
  })

  it('reports a fetchBuffer stream aborted by the clamped cap as a budget failure', async () => {
    const requester = vi.fn(async (_url: URL, options: { maxBytes: number }) => {
      const body = 'x'.repeat(600)
      if (body.length > options.maxBytes) throw new ResponseTooLargeError()
      return makeResponse(body, { headers: { 'content-type': 'application/octet-stream' } })
    })
    const service = new SafeFetchService({ lookup: publicLookup, requester })
    const download = (path: string) => service.fetchBuffer(`https://example.test/${path}`, {
      contentTypes: ['application/octet-stream'],
    })

    let caught: unknown
    const { usage } = await runWithFetchBudget(
      { maxFetches: 10, maxBytes: 1000, deadlineMs: 60_000 },
      async () => {
        await download('a')
        try {
          await download('b')
        } catch (error) {
          caught = error
        }
      },
    )

    expect(caught).toBeInstanceOf(FetchBudgetExceededError)
    expect((caught as FetchBudgetExceededError).reason).toBe('bytes')
    expect(usage).toMatchObject({ exhausted: true, exhaustedReason: 'bytes' })
  })

  it('still reports an oversized single download as a size error, not a budget error', async () => {
    const requester = vi.fn(async (_url: URL, options: { maxBytes: number }) => {
      const body = 'x'.repeat(600)
      if (body.length > options.maxBytes) throw new ResponseTooLargeError()
      return makeResponse(body, { headers: { 'content-type': 'application/octet-stream' } })
    })
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    const attempt = runWithFetchBudget(
      { maxFetches: 10, maxBytes: 1_000_000, deadlineMs: 60_000 },
      async () => {
        await service.fetchBuffer('https://example.test/a', {
          maxBytes: 100,
          contentTypes: ['application/octet-stream'],
        })
      },
    )

    await expect(attempt).rejects.toBeInstanceOf(ResponseTooLargeError)
  })
})

describe('HostRateLimiter', () => {
  function fakeTimers() {
    let clock = 0
    const sleeps: number[] = []
    return {
      sleeps,
      now: () => clock,
      sleep: async (delayMs: number) => {
        sleeps.push(delayMs)
        clock += delayMs
      },
      advance: (ms: number) => {
        clock += ms
      },
    }
  }

  it('lets the burst through, then paces to the configured rate', async () => {
    const timers = fakeTimers()
    const limiter = new HostRateLimiter({ ratePerSecond: 2, burst: 4, now: timers.now, sleep: timers.sleep })

    for (let i = 0; i < 4; i += 1) {
      await limiter.acquire('example.test')
    }
    expect(timers.sleeps).toEqual([])

    await limiter.acquire('example.test')
    await limiter.acquire('example.test')
    // Each extra request beyond the burst waits 1/rate seconds; the fake sleep
    // advances the clock, so the bucket refills exactly one token per wait.
    expect(timers.sleeps).toEqual([500, 500])
  })

  it('refills over elapsed time', async () => {
    const timers = fakeTimers()
    const limiter = new HostRateLimiter({ ratePerSecond: 2, burst: 4, now: timers.now, sleep: timers.sleep })

    for (let i = 0; i < 4; i += 1) {
      await limiter.acquire('example.test')
    }
    timers.advance(2000)
    for (let i = 0; i < 4; i += 1) {
      await limiter.acquire('example.test')
    }

    expect(timers.sleeps).toEqual([])
  })

  it('keeps separate buckets per host', async () => {
    const timers = fakeTimers()
    const limiter = new HostRateLimiter({ ratePerSecond: 2, burst: 4, now: timers.now, sleep: timers.sleep })

    for (let i = 0; i < 4; i += 1) {
      await limiter.acquire('a.test')
      await limiter.acquire('b.test')
    }

    expect(timers.sleeps).toEqual([])
  })

  it('paces SafeFetchService requests running under a budget', async () => {
    const timers = fakeTimers()
    const limiter = new HostRateLimiter({ ratePerSecond: 2, burst: 4, now: timers.now, sleep: timers.sleep })
    const requester = vi.fn(async () => makeResponse('<html>ok</html>'))
    const service = new SafeFetchService({ lookup: publicLookup, requester })

    await runWithFetchBudget(
      { maxFetches: 10, maxBytes: 1_000_000, deadlineMs: 600_000 },
      async () => {
        for (let i = 0; i < 6; i += 1) {
          await service.fetchText('https://example.test/book')
        }
      },
      { limiter, now: timers.now },
    )

    expect(requester).toHaveBeenCalledTimes(6)
    expect(timers.sleeps).toEqual([500, 500])
  })
})
