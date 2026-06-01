import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('checkAuthRedirect', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('throws a typed auth error when response is redirected without navigating to the API redirect URL', async () => {
    const { AuthExpiredError, checkAuthRedirect } = await import('../api.js')

    const redirectedResponse = new Response(null, { status: 200 })
    Object.defineProperty(redirectedResponse, 'redirected', { value: true })
    Object.defineProperty(redirectedResponse, 'url', { value: 'https://auth.example.test/login?rd=%2Freader%2Fapi%2Fbooks' })

    expect(() => checkAuthRedirect(redirectedResponse)).toThrow(AuthExpiredError)
  })

  it('does not reload for a normal non-redirected response', async () => {
    const { checkAuthRedirect } = await import('../api.js')

    const normalResponse = new Response(JSON.stringify([]), { status: 200 })
    Object.defineProperty(normalResponse, 'redirected', { value: false })
    Object.defineProperty(normalResponse, 'url', { value: 'http://localhost/reader/api/books' })

    expect(() => checkAuthRedirect(normalResponse)).not.toThrow()
  })

  it('does not reload for an error response that was not redirected', async () => {
    const { checkAuthRedirect } = await import('../api.js')

    const errorResponse = new Response('Not Found', { status: 404 })
    Object.defineProperty(errorResponse, 'redirected', { value: false })
    Object.defineProperty(errorResponse, 'url', { value: 'http://localhost/reader/api/books/missing' })

    expect(() => checkAuthRedirect(errorResponse)).not.toThrow()
  })
})

describe('listBooks with auth redirect', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('rejects with AuthExpiredError when listBooks receives a redirected response', async () => {
    const redirectedResponse = new Response('<html>login</html>', { status: 200 })
    Object.defineProperty(redirectedResponse, 'redirected', { value: true })
    Object.defineProperty(redirectedResponse, 'url', { value: 'https://auth.example.test/login?rd=%2Freader%2Fapi%2Fbooks' })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(redirectedResponse))

    const { AuthExpiredError, listBooks } = await import('../api.js')

    await expect(listBooks()).rejects.toThrow(AuthExpiredError)
  })

  it('returns books normally when listBooks receives a non-redirected 200 response', async () => {
    const books = [{ id: '1', title: '書', charCount: 100, fileSize: 200, createdAt: '2026-01-01' }]
    const normalResponse = new Response(JSON.stringify(books), { status: 200 })
    Object.defineProperty(normalResponse, 'redirected', { value: false })
    Object.defineProperty(normalResponse, 'url', { value: 'http://localhost/reader/api/books' })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(normalResponse))

    const { listBooks } = await import('../api.js')

    const result = await listBooks()
    expect(result).toEqual(books)
  })

  it('loginToReader navigates through auth with the reader app route as rd, not an API endpoint', async () => {
    const assignMock = vi.fn()
    vi.stubGlobal('location', {
      assign: assignMock,
      origin: 'https://reader.example.test',
    })

    const { loginToReader } = await import('../api.js')

    loginToReader()
    expect(assignMock).toHaveBeenCalledWith('https://reader.example.test/auth/?rd=https%3A%2F%2Freader.example.test%2Freader%2F&rm=GET')
  })
})
