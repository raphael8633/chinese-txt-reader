import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildApp } from '../app.js'

describe('Auth middleware', () => {
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV
  })

  afterEach(() => {
    process.env.NODE_ENV = originalEnv
  })

  it('in development mode, sets userId to dev-user without header', async () => {
    process.env.NODE_ENV = 'development'
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/me' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ userId: 'dev-user' })
  })

  it('with X-Forwarded-User header, sets userId to header value', async () => {
    process.env.NODE_ENV = 'production'
    const app = buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { 'x-forwarded-user': 'alice' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ userId: 'alice' })
  })

  it('with Remote-User header, sets userId to header value', async () => {
    process.env.NODE_ENV = 'production'
    const app = buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { 'remote-user': 'reader-example' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ userId: 'reader-example' })
  })

  it('without header in non-dev mode, returns 401', async () => {
    process.env.NODE_ENV = 'production'
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/me' })
    expect(res.statusCode).toBe(401)
  })
})
