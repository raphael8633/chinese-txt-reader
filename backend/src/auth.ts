import type { FastifyReply, FastifyRequest } from 'fastify'

declare module 'fastify' {
  interface FastifyRequest {
    userId: string
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (Array.isArray(value)) return value.find(item => item.length > 0)
  return undefined
}

export async function authHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (process.env.NODE_ENV === 'development') {
    req.userId = 'dev-user'
    return
  }

  const userId = firstHeaderValue(req.headers['x-forwarded-user'])
    ?? firstHeaderValue(req.headers['remote-user'])

  if (userId) {
    req.userId = userId
    return
  }

  reply.code(401).send({ error: 'Unauthorized' })
}
