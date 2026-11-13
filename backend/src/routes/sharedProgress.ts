import type { FastifyPluginAsync } from 'fastify'
import type Database from 'better-sqlite3'
import { authHook } from '../auth.js'
import { chapters, projectWork, readWork, reconcileWorks, type ManifestCache } from '../services/sharedProgress.js'

export const sharedProgressRoutes: FastifyPluginAsync<{db:Database.Database}> = async (app,{db}) => {
  const state = (userId:string,id:string,cache?:ManifestCache) => {
    const work = readWork(db,userId,id)
    return work ? projectWork(db,userId,work,id,cache) : null
  }
  const exists = (userId:string,id:string) => db.prepare(`SELECT manifest_version,source_type FROM books WHERE id=? AND user_id=?
    AND source_type IN ('web','txt')`).get(id,userId) as {manifest_version:number;source_type:string}|undefined
  // A web book whose title normalizes to empty never joins a work: it is unlinked.
  const unlinked = {error:'Not linked'}
  app.get('/api/books/:id/shared-progress',{preHandler:authHook},async (req,reply) => {
    const {id} = req.params as {id:string}
    if (!exists(req.userId,id)) return reply.code(404).send({error:'Not found'})
    const cache: ManifestCache = new Map()
    reconcileWorks(db,req.userId,cache)
    return state(req.userId,id,cache) ?? reply.code(404).send(unlinked)
  })
  app.post('/api/books/:id/preferred-source',{preHandler:authHook},async (req,reply) => {
    const {id} = req.params as {id:string}
    if (!exists(req.userId,id)) return reply.code(404).send({error:'Not found'})
    const body = (req.body ?? {}) as {preferredBookId?:unknown;expectedPreferredBookId?:unknown}
    if (typeof body.preferredBookId !== 'string' || typeof body.expectedPreferredBookId !== 'string') return reply.code(400).send({error:'Invalid preference'})
    reconcileWorks(db,req.userId)
    const work = readWork(db,req.userId,id)
    if (!work) return reply.code(404).send(unlinked)
    const member = db.prepare(`SELECT 1 FROM reading_work_members WHERE user_id=? AND work_id=? AND book_id=?`)
      .get(req.userId,work.id,body.preferredBookId)
    const target = exists(req.userId,body.preferredBookId)
    if (!target) return reply.code(404).send({error:'Not found'})
    if (!member) return reply.code(400).send({error:'Not a member'})
    const updated = db.prepare('UPDATE reading_works SET preferred_book_id=?,preferred_manual=1 WHERE id=? AND user_id=? AND preferred_book_id=?')
      .run(body.preferredBookId,work.id,req.userId,body.expectedPreferredBookId)
    if (updated.changes !== 1) return reply.code(409).send({error:'Stale preference',current:state(req.userId,id)})
    // Choosing a TXT re-ranks 補章's web target; return it already settled.
    reconcileWorks(db,req.userId)
    return state(req.userId,id)
  })
  app.post('/api/books/:id/shared-progress',{preHandler:authHook},async (req,reply) => {
    const {id} = req.params as {id:string}
    const book = exists(req.userId,id)
    if (!book) return reply.code(404).send({error:'Not found'})
    // Reconcile first: a book that just joined may have brought its own position (a new revision).
    reconcileWorks(db,req.userId)
    const body = (req.body ?? {}) as {expectedRevision?:unknown;expectedWorkId?:unknown;manifestVersion?:unknown;
      positionType?:unknown;positionValue?:unknown;chapterProgress?:unknown;chapterOffset?:unknown}
    const work = readWork(db,req.userId,id)
    if (!work) return reply.code(404).send(unlinked)
    if (typeof body.expectedWorkId !== 'string') return reply.code(400).send({error:'expectedWorkId required'})
    if (body.expectedWorkId !== work.id || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision !== work.revision) {
      return reply.code(409).send({error:'Stale revision',current:state(req.userId,id)})
    }
    if (body.positionType !== 'chapter_index' || !Number.isSafeInteger(body.positionValue)
      || (body.positionValue as number) < 0 || !Number.isSafeInteger(body.manifestVersion)
      || (body.chapterProgress !== undefined && (typeof body.chapterProgress !== 'number'
        || !Number.isFinite(body.chapterProgress) || body.chapterProgress < 0 || body.chapterProgress > 1))
      || (body.chapterOffset !== undefined && (!Number.isSafeInteger(body.chapterOffset) || (body.chapterOffset as number) < 0))) {
      return reply.code(400).send({error:'Invalid position'})
    }
    if (book.manifest_version !== body.manifestVersion) return reply.code(409).send({error:'Stale manifest',current:state(req.userId,id)})
    // POST is a deliberate read on this source; it also resolves an unmapped position.
    const chapter = chapters(db,req.userId,id).find(c => c.chapter_index === body.positionValue)
    if (!chapter) return reply.code(400).send({error:'Chapter not in full manifest'})
    const now = new Date().toISOString()
    const changed = db.prepare(`UPDATE reading_works SET anchor_book_id=?,anchor_manifest_version=?,
      chapter_index=?,chapter_title=?,chapter_progress=?,chapter_offset=?,revision=revision+1,updated_at=?
      WHERE id=? AND user_id=? AND revision=? AND EXISTS
        (SELECT 1 FROM books WHERE id=? AND user_id=? AND manifest_version=?)`).run(
      id,body.manifestVersion,body.positionValue,chapter.title,body.chapterProgress ?? null,body.chapterOffset ?? null,now,
      work.id,req.userId,body.expectedRevision,id,req.userId,body.manifestVersion)
    if (changed.changes !== 1) return reply.code(409).send({error:'Stale position',current:state(req.userId,id)})
    return state(req.userId,id)
  })
}
