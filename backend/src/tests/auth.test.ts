import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import { buildApp } from '../app.js'
import { authHook } from '../auth.js'

function buildProbeApp() {
  const app = Fastify({ logger: false })
  app.get('/probe', { preHandler: authHook }, async (req) => ({
    userId: req.userId,
  }))
  return app
}

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
    const res = await app.inject({ method: 'GET', url: '/api/me' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ userId: 'dev-user' })
  })

  it('with X-Forwarded-User header, returns that userId', async () => {
    process.env.NODE_ENV = 'production'
    const app = buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { 'x-forwarded-user': 'alice' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ userId: 'alice' })
  })

  it('with Remote-User header, returns that userId', async () => {
    process.env.NODE_ENV = 'production'
    const app = buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { 'remote-user': 'raph' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ userId: 'raph' })
  })

  it('without header in non-dev mode, returns 401', async () => {
    process.env.NODE_ENV = 'production'
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/me' })
    expect(res.statusCode).toBe(401)
  })
})

describe('authHook userId resolution', () => {
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV
  })

  afterEach(() => {
    process.env.NODE_ENV = originalEnv
  })

  it('prefers X-Forwarded-User over Remote-User', async () => {
    process.env.NODE_ENV = 'production'
    const app = buildProbeApp()
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'remote-user': 'raph', 'x-forwarded-user': 'alice' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ userId: 'alice' })
  })

  it('ignores group headers now that admin gating is gone', async () => {
    process.env.NODE_ENV = 'production'
    const app = buildProbeApp()
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'remote-user': 'reader-e2e', 'remote-groups': 'admins,health-manage' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ userId: 'reader-e2e' })
  })

  it('sets dev-user in development mode', async () => {
    process.env.NODE_ENV = 'development'
    const app = buildProbeApp()
    const res = await app.inject({ method: 'GET', url: '/probe' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ userId: 'dev-user' })
  })
})
