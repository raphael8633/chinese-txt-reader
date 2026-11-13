import FormData from 'form-data'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDb } from '../db.js'
import { buildApp } from '../app.js'
import type Database from 'better-sqlite3'
import { reconcileWorks } from '../services/sharedProgress.js'

const web = (db: Database.Database, id: string, user = 'dev-user', title = ' Same  Story ', names = ['第一章 開始', '第二章 再會'], time = '2026-01-01') => {
  db.prepare(`INSERT INTO books (id,user_id,title,original_filename,file_size,char_count,source_type,manifest_version,created_at,updated_at)
     VALUES (?,?,?,'web',0,0,'web',1,?,?)`).run(id, user, title, time, time)
  for (const [i, name] of names.entries()) db.prepare(`INSERT INTO web_book_chapters (book_id,user_id,chapter_index,title,url,chapter_key,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(id, user, i, name, `https://${id}.test/${i}`, `${id}:${i}`, time)
}
/** An uploaded TXT edition: chapters_json holds paragraph-indexed headings; its chapter ordinal is the array position. */
const txt = (db: Database.Database, id: string, title = ' Same  Story ', names = ['第1章 開始','第2章 再會'], time = '2026-01-03') => {
  db.prepare(`INSERT INTO books (id,user_id,title,original_filename,file_size,char_count,chapters_json,created_at,updated_at)
     VALUES (?,?,?,'up.txt',0,0,?,?,?)`).run(id, 'dev-user', title, JSON.stringify(names.map((name, i) => ({ index: i * 5 + 1, title: name }))), time, time)
}
const legacy = (db: Database.Database, id: string, position: number, user = 'dev-user', updatedAt = '2026-01-02') => db.prepare(`INSERT INTO reading_progress
 (user_id,book_id,position_type,position_value,chapter_progress,chapter_offset,updated_at) VALUES (?,?,'chapter_index',?,0.25,4,?)`).run(user,id,position,updatedAt)

describe('auto shared reading progress', () => {
  let dir: string
  let db: Database.Database
  let app: ReturnType<typeof buildApp>
  let env: string | undefined
  beforeEach(() => {
    env = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    dir = mkdtempSync(join(tmpdir(), 'shared-progress-'))
    db = initDb(join(dir, 'db.sqlite'))
    app = buildApp(db, join(dir, 'uploads'))
  })
  afterEach(async () => {
    await app.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
    process.env.NODE_ENV = env
  })
  const get = (app: ReturnType<typeof buildApp>, id: string) => app.inject({ method:'GET', url:`/api/books/${id}/shared-progress` })
  it('automatically prefers the edition with the most native chapters and maps progress by title', async () => {
    web(db,'a','dev-user','Same Story',['第一章 開始','第三章 再會'])
    web(db,'b','dev-user','same story',['第一章 開始','第二章 中途','第三章 再會'],'2026-01-03')
    legacy(db,'a',1)
    const before = db.prepare('SELECT * FROM reading_progress').all()
    const state = (await get(app,'b')).json()
    expect(state).toMatchObject({preferredBookId:'b',sharedProgress:{kind:'mapped',positionValue:2,chapterProgress:0.25}})
    expect(db.prepare('SELECT * FROM reading_progress').all()).toEqual(before)
    expect((await app.inject({method:'GET',url:'/api/books'})).json().every((book:{preferredBookId:string}) => book.preferredBookId === 'b')).toBe(true)
  })
  it('keeps the current preference on equally complete directories, including reversed creation order', async () => {
    web(db,'a','dev-user','Same Story',['第一章 開始','第二章 再會'],'2026-01-03')
    web(db,'b','dev-user','same story',['第一章 開始','第二章 再會'],'2026-01-01')
    expect((await get(app,'a')).json().preferredBookId).toBe('b')
    web(db,'c','dev-user','same story',['第一章 開始','第二章 再會'],'2026-01-04')
    expect((await get(app,'c')).json().preferredBookId).toBe('b')
  })
  it('never overwrites a manual source preference when a more complete edition arrives or refreshes', async () => {
    web(db,'a'); web(db,'b'); await get(app,'a')
    const url='/api/books/a/preferred-source'
    expect((await app.inject({method:'POST',url,payload:{preferredBookId:'b',expectedPreferredBookId:'a'}})).statusCode).toBe(200)
    web(db,'c','dev-user','same story',['第一章 開始','第二章 再會','第三章 結局'],'2026-01-04')
    expect((await get(app,'c')).json().preferredBookId).toBe('b')
    db.prepare(`INSERT INTO web_book_chapters (book_id,user_id,chapter_index,title,url,chapter_key,created_at)
      VALUES ('a','dev-user',2,'第四章 以後','https://a.test/2','a:2','2026-01-05')`).run()
    expect((await get(app,'a')).json().preferredBookId).toBe('b')
  })
  it('ignores applied supplement rows when ranking native directory completeness', async () => {
    web(db,'a','dev-user','Same Story',['第一章 開始','第三章 再會'])
    web(db,'b','dev-user','same story',['第一章 開始','第二章 中途','第三章 再會'],'2026-01-03')
    db.prepare(`INSERT INTO web_book_supplements (id,book_id,user_id,batch_id,donor_book_id,donor_provider_id,url,chapter_key,title,anchor_after_key,anchor_after_title,anchor_before_key,anchor_before_title,seq,status,status_reason,created_at)
      VALUES ('s','a','dev-user','batch','b','test','https://b.test/1','b:1','第二章 中途','a:0','第一章 開始','a:1','第三章 再會',0,'active','','2026-01-04')`).run()
    db.prepare(`UPDATE web_book_chapters SET chapter_index=2 WHERE book_id='a' AND chapter_index=1`).run()
    db.prepare(`INSERT INTO web_book_chapters (book_id,user_id,chapter_index,title,url,chapter_key,created_at)
      VALUES ('a','dev-user',1,'第二章 中途','https://b.test/1','b:1','2026-01-04')`).run()
    expect((await get(app,'a')).json().preferredBookId).toBe('b')
  })
  it('prefers fewest missing distinct body names rather than duplicate and author-note directory length', async () => {
    web(db,'a','dev-user','Same Story',['第一章 甲','第二章 乙','第二章 乙','第三章 丙','作者感言','第四章 推書'])
    web(db,'b','dev-user','same story',['第一章 甲','第二章 乙','第三章 丙','第四章 丁'],'2026-01-03')
    expect((await get(app,'a')).json().preferredBookId).toBe('b')
  })
  it('compares distinct body coverage across all editions, retaining current preference on equal gaps', async () => {
    web(db,'a','dev-user','Same Story',['第一章 甲','第二章 乙'])
    web(db,'b','dev-user','same story',['第一章 甲','第三章 丙'],'2026-01-03')
    expect((await get(app,'a')).json().preferredBookId).toBe('a')
    web(db,'c','dev-user','same story',['第一章 甲','第二章 乙','第三章 丙','第三章 丙'],'2026-01-04')
    expect((await get(app,'a')).json().preferredBookId).toBe('c')
    web(db,'d','dev-user','same story',['第一章 甲','第二章 乙','第三章 丙'],'2026-01-05')
    expect((await get(app,'a')).json().preferredBookId).toBe('c')
  })
  it('automatically ranks new works even when the database was upgraded from an old preference schema', async () => {
    db.prepare('ALTER TABLE reading_works DROP COLUMN preferred_manual').run()
    db.prepare('ALTER TABLE reading_works ADD COLUMN preferred_manual INTEGER NOT NULL DEFAULT 1').run()
    web(db,'a','dev-user','Same Story',['第一章 開始'])
    web(db,'b','dev-user','same story',['第一章 開始','第二章 中途'],'2026-01-03')
    expect((await get(app,'a')).json().preferredBookId).toBe('b')
    expect(db.prepare('SELECT preferred_manual FROM reading_works').get()).toEqual({preferred_manual:0})
  })
  it('on upgrade, marks manual only preferences that differ from the former oldest-edition default', async () => {
    web(db,'a','dev-user','First',['第一章 開始'],'2026-01-01'); web(db,'b','dev-user','first',['第一章 開始','第二章 中途'],'2026-01-02')
    web(db,'c','dev-user','Second',['第一章 開始'],'2026-01-01'); web(db,'d','dev-user','second',['第一章 開始','第二章 中途'],'2026-01-02')
    reconcileWorks(db,'dev-user')
    const workOf = (id: string) => (db.prepare('SELECT work_id FROM reading_work_members WHERE book_id=?').get(id) as {work_id:string}).work_id
    // Pre-upgrade state: 'first' kept the oldest-edition default, 'second' was switched to d by hand.
    db.prepare('UPDATE reading_works SET preferred_book_id=? WHERE id=?').run('a',workOf('a'))
    db.prepare('UPDATE reading_works SET preferred_book_id=? WHERE id=?').run('d',workOf('c'))
    db.prepare('ALTER TABLE reading_works DROP COLUMN preferred_manual').run()
    db.close()
    db = initDb(join(dir, 'db.sqlite'))
    const manual = (id: string) => (db.prepare('SELECT preferred_manual FROM reading_works WHERE id=?').get(workOf(id)) as {preferred_manual:number}).preferred_manual
    expect(manual('a')).toBe(0)
    expect(manual('c')).toBe(1)
    reconcileWorks(db,'dev-user')
    expect(db.prepare('SELECT preferred_book_id FROM reading_works WHERE id=?').get(workOf('a'))).toEqual({preferred_book_id:'b'})
    expect(db.prepare('SELECT preferred_book_id FROM reading_works WHERE id=?').get(workOf('c'))).toEqual({preferred_book_id:'d'})
  })
  it('automatically groups same-title web editions and adopts one saved position without changing legacy rows', async () => {
    web(db,'a'); web(db,'b','dev-user','same story',['序言','第一章 開始','第二章 再會'],'2026-01-03'); legacy(db,'a',1)
    const before = db.prepare('SELECT * FROM reading_progress').all()
    const result = await get(app,'b')
    expect(result.statusCode).toBe(200)
    expect(result.json()).toMatchObject({ preferredBookId:'a', sharedProgress:{kind:'mapped',positionValue:2,chapterProgress:0.25} })
    expect(db.prepare('SELECT * FROM reading_progress').all()).toEqual(before)
    expect((await app.inject({method:'GET',url:'/api/books'})).json().map((b: {workId:string}) => b.workId)).toEqual([result.json().workId,result.json().workId])
  })
  it('retains a number-only legacy chapter on its own source but never maps it by ordinal to a sibling', async () => {
    web(db,'a','dev-user','Same',['第一章']); web(db,'b','dev-user','same',['序言','第一章']); legacy(db,'a',0)
    expect((await get(app,'a')).json().sharedProgress).toMatchObject({kind:'mapped',positionValue:0})
    expect((await get(app,'b')).json().sharedProgress).toMatchObject({kind:'unmapped'})
  })
  it('adopts the most recently saved of differing old positions without asking, leaving the snapshots alone', async () => {
    web(db,'a'); web(db,'b'); legacy(db,'a',0,'dev-user','2026-01-05'); legacy(db,'b',1,'dev-user','2026-01-02')
    const before = db.prepare('SELECT * FROM reading_progress ORDER BY book_id').all()
    const result = (await get(app,'b')).json()
    expect(result.sharedProgress).toMatchObject({kind:'mapped',positionValue:0,updatedAt:'2026-01-05'})
    expect(db.prepare('SELECT anchor_book_id FROM reading_works').get()).toEqual({anchor_book_id:'a'})
    expect(db.prepare('SELECT * FROM reading_progress ORDER BY book_id').all()).toEqual(before)
  })
  it('no longer accepts a pick among old per-book records', async () => {
    web(db,'a'); web(db,'b'); legacy(db,'a',0); legacy(db,'b',1)
    const shown = (await get(app,'a')).json()
    const pick = await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload:{selectedProgressBookId:'b',
      expectedRevision:shown.revision,expectedWorkId:shown.workId}})
    expect(pick.statusCode).toBe(400)
    expect((await get(app,'a')).json()).toMatchObject({revision:shown.revision})
  })
  it('rejects delayed revision and stale manifest writes without changing canonical or snapshots', async () => {
    web(db,'a'); web(db,'b'); const before = await get(app,'a')
    const payload = {positionType:'chapter_index',positionValue:1,chapterProgress:0.5,manifestVersion:1,expectedRevision:0,expectedWorkId:before.json().workId}
    const saved = await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload})
    expect(saved.statusCode).toBe(200)
    expect(saved.json().revision).toBe(1)
    expect((await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload})).statusCode).toBe(409)
    expect((await app.inject({method:'POST',url:'/api/books/b/shared-progress',payload:{...payload,expectedRevision:1,manifestVersion:2}})).statusCode).toBe(409)
    expect((await get(app,'a')).json().sharedProgress).toMatchObject({kind:'mapped',positionValue:1,chapterProgress:0.5})
    expect(before.json().workId).toBe(saved.json().workId)
    expect(db.prepare('SELECT * FROM reading_progress').all()).toEqual([])
  })
  it('rejects a delayed save from a work that changed due to rename even when revision happens to match', async () => {
    web(db,'a'); web(db,'b'); const first=(await get(app,'b')).json()
    await app.inject({method:'PATCH',url:'/api/books/b',payload:{title:'New Title'}})
    const newWork=(await get(app,'b')).json()
    expect(newWork.workId).not.toBe(first.workId)
    const stale=await app.inject({method:'POST',url:'/api/books/b/shared-progress',payload:{
      positionType:'chapter_index',positionValue:0,manifestVersion:1,expectedRevision:0,expectedWorkId:first.workId}})
    expect(stale.statusCode).toBe(409)
    expect((await get(app,'b')).json().sharedProgress.kind).toBe('empty')
  })
  it('ignores a later per-book write to a work member: no conflict prompt, no revision bump', async () => {
    web(db,'a'); web(db,'b','dev-user','same story',['第一章 開始','第二章 再會','第三章 結束']); legacy(db,'a',0)
    const shown = (await get(app,'a')).json()
    expect(shown.sharedProgress).toMatchObject({kind:'mapped',positionValue:0})
    // A member's per-book record (left from before it joined, or edited by hand) is not read again.
    legacy(db,'b',2,'dev-user','2099-01-01')
    db.prepare(`UPDATE reading_progress SET position_value=1,updated_at='2099-01-01' WHERE book_id='a'`).run()
    const after = (await get(app,'a')).json()
    expect(after).toMatchObject({revision:shown.revision,sharedProgress:{kind:'mapped',positionValue:0}})
    expect((await get(app,'b')).json().sharedProgress).toMatchObject({kind:'mapped',positionValue:0})
    const save = await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload:{positionType:'chapter_index',positionValue:1,
      manifestVersion:1,expectedRevision:shown.revision,expectedWorkId:shown.workId}})
    expect(save.statusCode).toBe(200)
    expect(save.json().sharedProgress).toMatchObject({kind:'mapped',positionValue:1})
  })
  it('refuses a per-book progress write for a work member, so the device keeps it pending for the shared save', async () => {
    web(db,'a'); await get(app,'a')
    const member = await app.inject({method:'POST',url:'/api/books/a/progress',payload:{positionType:'chapter_index',positionValue:1}})
    expect(member.statusCode).toBe(409)
    expect(db.prepare(`SELECT COUNT(*) n FROM reading_progress WHERE book_id='a'`).get()).toEqual({n:0})
    // A book outside any work keeps its per-book record.
    txt(db,'solo','Only Uploaded')
    expect((await app.inject({method:'POST',url:'/api/books/solo/progress',payload:{positionType:'chapter_index',positionValue:1}})).statusCode).toBe(200)
  })
  it('persists preferred independently and rejects stale/nonmember changes', async () => {
    web(db,'a'); web(db,'b'); web(db,'other','dev-user','Other'); web(db,'foreign','other-user'); await get(app,'a')
    const url='/api/books/a/preferred-source'
    expect((await app.inject({method:'POST',url,payload:{preferredBookId:'foreign',expectedPreferredBookId:'a'}})).statusCode).toBe(404)
    expect((await app.inject({method:'POST',url,payload:{preferredBookId:'other',expectedPreferredBookId:'a'}})).statusCode).toBe(400)
    expect((await app.inject({method:'POST',url,payload:{preferredBookId:'b',expectedPreferredBookId:'a'}})).statusCode).toBe(200)
    expect((await app.inject({method:'POST',url,payload:{preferredBookId:'a',expectedPreferredBookId:'a'}})).statusCode).toBe(409)
    expect((await get(app,'a')).json().preferredBookId).toBe('b')
  })
  it('moves a renamed web edition to the normalized-title work without touching its saved snapshot', async () => {
    web(db,'a'); web(db,'b'); legacy(db,'a',0); await get(app,'a')
    const old= db.prepare('SELECT * FROM reading_progress WHERE book_id=?').get('a')
    const changed=await app.inject({method:'PATCH',url:'/api/books/b',payload:{title:'Other Story'}})
    expect(changed.statusCode).toBe(200)
    expect(db.prepare(`SELECT COUNT(DISTINCT work_id) n FROM reading_work_members WHERE user_id=?`).get('dev-user')).toEqual({n:2})
    expect(db.prepare('SELECT COUNT(*) n FROM reading_work_members WHERE user_id=?').get('dev-user')).toEqual({n:2})
    expect((await get(app,'b')).json().workId).not.toBe((await get(app,'a')).json().workId)
    expect(db.prepare('SELECT * FROM reading_progress WHERE book_id=?').get('a')).toEqual(old)
  })
  it('retains sole-member canonical progress, manual preference and CAS across rename away and back', async () => {
    web(db,'a'); web(db,'foreign','other-user','Same Story')
    const initial=(await get(app,'a')).json()
    expect((await app.inject({method:'POST',url:'/api/books/a/preferred-source',
      payload:{preferredBookId:'a',expectedPreferredBookId:'a'}})).statusCode).toBe(200)
    const saved=await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload:{
      positionType:'chapter_index',positionValue:1,chapterProgress:0.4,chapterOffset:7,
      manifestVersion:1,expectedRevision:initial.revision,expectedWorkId:initial.workId}})
    expect(saved.statusCode).toBe(200)
    const snapshots=db.prepare('SELECT * FROM reading_progress').all()
    for (const [title,version] of [['Other Story',2],['Same Story',3]] as const) {
      expect((await app.inject({method:'PATCH',url:'/api/books/a',payload:{title}})).statusCode).toBe(200)
      const current=(await get(app,'a')).json()
      expect(current).toMatchObject({workId:initial.workId,preferredBookId:'a',
        sharedProgress:{kind:'mapped',positionValue:1,chapterProgress:0.4,chapterOffset:7}})
      expect(db.prepare('SELECT title_key,anchor_manifest_version,preferred_manual FROM reading_works WHERE id=?')
        .get(initial.workId)).toEqual({title_key:title.toLowerCase(),anchor_manifest_version:version,preferred_manual:1})
      expect((await app.inject({method:'GET',url:'/api/books'})).json()
        .find((book:{id:string}) => book.id === 'a').sharedProgress.kind).toBe('mapped')
      expect(db.prepare('SELECT * FROM reading_progress').all()).toEqual(snapshots)
      expect((await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload:{
        positionType:'chapter_index',positionValue:0,manifestVersion:version,expectedRevision:saved.json().revision,
        expectedWorkId:initial.workId}})).statusCode).toBe(409)
    }
    const current=(await get(app,'a')).json()
    expect((await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload:{
      positionType:'chapter_index',positionValue:0,manifestVersion:1,expectedRevision:current.revision,
      expectedWorkId:initial.workId}})).statusCode).toBe(409)
    expect((await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload:{
      positionType:'chapter_index',positionValue:1,manifestVersion:3,expectedRevision:current.revision,
      expectedWorkId:initial.workId}})).statusCode).toBe(200)
    expect((await get(app,'foreign')).statusCode).toBe(404)
  })
  const savePosition=(id: string, work: {workId:string;revision:number}, positionValue: number) => app.inject({method:'POST',
    url:`/api/books/${id}/shared-progress`,payload:{positionType:'chapter_index',positionValue,manifestVersion:1,
      expectedRevision:work.revision,expectedWorkId:work.workId}})
  const stamp = (id: string, updatedAt: string) => db.prepare(`UPDATE reading_works SET updated_at=? WHERE id=?`).run(updatedAt,id)
  it.each([
    {newer:'joining', expected:1},
    {newer:'target', expected:0},
  ])('merges a renamed edition into an existing work, keeping the more recently saved position ($newer)', async ({newer,expected}) => {
    web(db,'a'); web(db,'b','dev-user','Other Story')
    const source=(await get(app,'a')).json(), target=(await get(app,'b')).json()
    expect((await savePosition('a',source,1)).statusCode).toBe(200)
    expect((await savePosition('b',target,0)).statusCode).toBe(200)
    stamp(source.workId, newer === 'joining' ? '2026-03-02T00:00:00.000Z' : '2026-03-01T00:00:00.000Z')
    stamp(target.workId, newer === 'joining' ? '2026-03-01T00:00:00.000Z' : '2026-03-02T00:00:00.000Z')
    const renamed=await app.inject({method:'PATCH',url:'/api/books/a',payload:{title:'  OTHER STORY  '}})
    expect(renamed.statusCode).toBe(200)
    const merged=(await get(app,'a')).json()
    expect(merged).toMatchObject({workId:target.workId,sharedProgress:{kind:'mapped',positionValue:expected}})
    expect((await get(app,'b')).json().sharedProgress).toMatchObject({kind:'mapped',positionValue:expected})
  })
  it('merges without asking when both editions are at the same chapter', async () => {
    web(db,'a'); web(db,'b','dev-user','Other Story')
    const source=(await get(app,'a')).json(), target=(await get(app,'b')).json()
    expect((await savePosition('a',source,1)).statusCode).toBe(200)
    expect((await savePosition('b',target,1)).statusCode).toBe(200)
    expect((await app.inject({method:'PATCH',url:'/api/books/a',payload:{title:'Other Story'}})).statusCode).toBe(200)
    expect((await get(app,'a')).json()).toMatchObject({workId:target.workId,sharedProgress:{kind:'mapped',positionValue:1}})
  })
  it('carries a leaving anchor edition into the new work and re-anchors the editions it leaves behind', async () => {
    web(db,'a'); web(db,'sibling'); web(db,'target','dev-user','Other Story')
    legacy(db,'a',1)
    const source=(await get(app,'a')).json()
    expect(source.sharedProgress).toMatchObject({kind:'mapped',positionValue:1})
    expect((await get(app,'target')).json().sharedProgress.kind).toBe('empty')
    expect((await app.inject({method:'PATCH',url:'/api/books/a',payload:{title:'Other Story'}})).statusCode).toBe(200)
    expect((await get(app,'sibling')).json()).toMatchObject({workId:source.workId,sharedProgress:{kind:'mapped',positionValue:1}})
    // The target had no position, so the joining edition's position is adopted without a choice.
    expect((await get(app,'target')).json().sharedProgress).toMatchObject({kind:'mapped',positionValue:1})
    expect((await get(app,'a')).json().sharedProgress).toMatchObject({kind:'mapped',positionValue:1})
  })
  it('reconciles a sole-member SQL rename into a vacant normalized-title work without losing its anchor', async () => {
    web(db,'a'); legacy(db,'a',1)
    const initial=(await get(app,'a')).json()
    db.prepare("UPDATE books SET title='Other Story' WHERE id='a'").run()
    reconcileWorks(db,'dev-user')
    const moved=(await get(app,'a')).json()
    expect(moved).toMatchObject({workId:initial.workId,sharedProgress:{kind:'mapped',positionValue:1}})
    expect(moved.revision).toBeGreaterThan(initial.revision)
    expect(db.prepare('SELECT * FROM reading_progress WHERE book_id=?').get('a')).toBeDefined()
  })
  it('keeps a canonical anchor mapped after a same-work rename while invalidating stale progress saves', async () => {
    web(db,'a'); web(db,'b','dev-user','same story',['序言','第一章 開始','第二章 再會'])
    const initial=(await get(app,'a')).json()
    const saved=await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload:{
      positionType:'chapter_index',positionValue:1,chapterProgress:0.4,chapterOffset:7,
      manifestVersion:1,expectedRevision:initial.revision,expectedWorkId:initial.workId}})
    expect(saved.statusCode).toBe(200)
    const snapshots=db.prepare('SELECT * FROM reading_progress').all()
    const renamed=await app.inject({method:'PATCH',url:'/api/books/a',payload:{title:'  sAmE   stOrY  '}})
    expect(renamed.statusCode).toBe(200)
    expect((db.prepare('SELECT manifest_version FROM books WHERE id=?').get('a'))).toEqual({manifest_version:2})
    expect(db.prepare('SELECT anchor_manifest_version,revision,chapter_index,chapter_title,chapter_progress,chapter_offset FROM reading_works WHERE id=?')
      .get(initial.workId)).toEqual({anchor_manifest_version:2,revision:saved.json().revision+1,
        chapter_index:1,chapter_title:'第二章 再會',chapter_progress:0.4,chapter_offset:7})
    expect(db.prepare('SELECT * FROM reading_progress').all()).toEqual(snapshots)
    const anchor=(await get(app,'a')).json()
    const sibling=(await get(app,'b')).json()
    expect(anchor).toMatchObject({workId:initial.workId,sharedProgress:{kind:'mapped',positionValue:1,chapterOffset:7,chapterProgress:0.4}})
    expect(sibling).toMatchObject({workId:initial.workId,revision:anchor.revision,
      sharedProgress:{kind:'mapped',positionValue:2,chapterProgress:0.4}})
    expect((await app.inject({method:'GET',url:'/api/books'})).json()
      .find((book:{id:string}) => book.id === 'b').sharedProgress).toMatchObject({kind:'mapped',positionValue:2})
    const stale=await app.inject({method:'POST',url:'/api/books/b/shared-progress',payload:{
      positionType:'chapter_index',positionValue:1,manifestVersion:1,expectedRevision:saved.json().revision,expectedWorkId:initial.workId}})
    expect(stale.statusCode).toBe(409)
    expect(stale.json().current.sharedProgress).toMatchObject({kind:'mapped',positionValue:2})
    const staleManifest=await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload:{
      positionType:'chapter_index',positionValue:0,manifestVersion:1,expectedRevision:anchor.revision,expectedWorkId:initial.workId}})
    expect(staleManifest.statusCode).toBe(409)
    expect(staleManifest.json().current.sharedProgress).toMatchObject({kind:'mapped',positionValue:1})
    expect(db.prepare('SELECT * FROM reading_progress').all()).toEqual(snapshots)
    const fresh=await app.inject({method:'POST',url:'/api/books/b/shared-progress',payload:{
      positionType:'chapter_index',positionValue:2,manifestVersion:1,expectedRevision:anchor.revision,expectedWorkId:initial.workId}})
    expect(fresh.statusCode).toBe(200)
    expect(fresh.json().sharedProgress).toMatchObject({kind:'mapped',positionValue:2})
  })
  it('keeps an adopted legacy anchor mapped after a same-work rename without rewriting the snapshot', async () => {
    web(db,'a'); web(db,'b','dev-user','same story',['序言','第一章 開始','第二章 再會']); legacy(db,'a',1)
    const adopted=(await get(app,'b')).json()
    expect(adopted.sharedProgress).toMatchObject({kind:'mapped',positionValue:2})
    const snapshot=db.prepare('SELECT * FROM reading_progress WHERE book_id=?').get('a')
    expect((await app.inject({method:'PATCH',url:'/api/books/a',payload:{title:'SAME   STORY'}})).statusCode).toBe(200)
    expect((await get(app,'b')).json()).toMatchObject({workId:adopted.workId,revision:adopted.revision+1,
      sharedProgress:{kind:'mapped',positionValue:2,chapterProgress:0.25}})
    expect(db.prepare('SELECT anchor_manifest_version FROM reading_works WHERE id=?').get(adopted.workId))
      .toEqual({anchor_manifest_version:2})
    expect(db.prepare('SELECT * FROM reading_progress WHERE book_id=?').get('a')).toEqual(snapshot)
  })
  it.each([
    {members:1, renamed:'a', label:'sole anchor'},
    {members:2, renamed:'a', label:'multi anchor'},
    {members:2, renamed:'b', label:'multi nonanchor'},
  ])('rename matrix: $label keeps canonical progress on return without adopting another work', async ({members,renamed}) => {
    web(db,'a')
    if (members === 2) web(db,'b','dev-user','same story',['序言','第一章 開始','第二章 再會'])
    web(db,'foreign','other-user','Other Story')
    const initial=(await get(app,'a')).json()
    const preferred=members === 2 && renamed === 'a' ? 'b' : 'a'
    if (members === 2) expect((await app.inject({method:'POST',url:'/api/books/a/preferred-source',
      payload:{preferredBookId:preferred,expectedPreferredBookId:'a'}})).statusCode).toBe(200)
    const save=await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload:{
      positionType:'chapter_index',positionValue:1,chapterProgress:0.4,chapterOffset:7,
      manifestVersion:1,expectedRevision:initial.revision,expectedWorkId:initial.workId}})
    expect(save.statusCode).toBe(200)
    const legacyBefore=db.prepare('SELECT * FROM reading_progress').all()
    const foreignBefore=db.prepare('SELECT * FROM books WHERE id=?').get('foreign')
    const oldRevision=save.json().revision
    const change=async (title:string) => {
      const res=await app.inject({method:'PATCH',url:`/api/books/${renamed}`,payload:{title}})
      expect(res.statusCode).toBe(200)
      return db.prepare('SELECT anchor_manifest_version,revision,chapter_index,chapter_progress,chapter_offset,preferred_manual FROM reading_works WHERE id=?')
        .get(initial.workId) as {anchor_manifest_version:number;revision:number;chapter_index:number;chapter_progress:number;chapter_offset:number;preferred_manual:number}
    }
    const same=await change('  sAmE   stOrY  ')
    expect(same).toMatchObject({anchor_manifest_version:1+(renamed === 'a' ? 1 : 0),
      revision:oldRevision+(renamed === 'a' ? 1 : 0),chapter_index:1,chapter_progress:0.4,chapter_offset:7,
      preferred_manual:members === 2 ? 1 : 0})
    expect((await get(app,members === 2 ? 'b' : 'a')).json()).toMatchObject({workId:initial.workId,
      preferredBookId:preferred,sharedProgress:{kind:'mapped',positionValue:members === 2 ? 2 : 1}})
    const away=await change('Other Story')
    expect(away).toMatchObject({anchor_manifest_version:1+(renamed === 'a' ? 2 : 0),
      revision:oldRevision+(renamed === 'a' ? 2 : 0)+(members === 1 ? 1 : 0)})
    const oldMember=(await get(app,renamed === 'a' && members === 2 ? 'b' : 'a')).json()
    if (renamed === 'a' && members === 2) expect(oldMember.sharedProgress).toMatchObject({kind:'unmapped',anchorBookId:'a'})
    if (renamed === 'b') expect(oldMember.sharedProgress).toMatchObject({kind:'mapped',positionValue:1})
    const returned=await change('same story')
    expect(returned).toMatchObject({anchor_manifest_version:1+(renamed === 'a' ? 3 : 0),
      revision:oldRevision+(renamed === 'a' ? 3 : 0)+(members === 1 ? 2 : 0)})
    const state=(await get(app,members === 2 ? 'b' : 'a')).json()
    expect(state).toMatchObject({workId:initial.workId,preferredBookId:preferred,
      sharedProgress:{kind:'mapped',positionValue:members === 2 ? 2 : 1,chapterProgress:0.4}})
    expect(db.prepare('SELECT * FROM reading_progress').all()).toEqual(legacyBefore)
    expect(db.prepare('SELECT * FROM books WHERE id=?').get('foreign')).toEqual(foreignBefore)
    if (renamed === 'a') {
      const stale=await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload:{
        positionType:'chapter_index',positionValue:0,manifestVersion:1,expectedRevision:oldRevision,expectedWorkId:initial.workId}})
      expect(stale.statusCode).toBe(409)
      expect(stale.json().current.sharedProgress).toMatchObject({kind:'mapped'})
    }
    const manifestStale=await app.inject({method:'POST',url:`/api/books/${renamed}/shared-progress`,payload:{
      positionType:'chapter_index',positionValue:0,manifestVersion:1,expectedRevision:state.revision,expectedWorkId:initial.workId}})
    expect(manifestStale.statusCode).toBe(409)
  })
  it.each([1,2])('never revives a pre-existing stale anchor across rename away/back with %i members', async members => {
    web(db,'a')
    if (members === 2) web(db,'b')
    const initial=(await get(app,'a')).json()
    expect((await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload:{
      positionType:'chapter_index',positionValue:1,manifestVersion:1,expectedRevision:initial.revision,expectedWorkId:initial.workId}})).statusCode).toBe(200)
    db.prepare('UPDATE reading_works SET anchor_manifest_version=0 WHERE id=?').run(initial.workId)
    for (const title of ['sAmE  stOrY','Other Story','Same Story']) {
      expect((await app.inject({method:'PATCH',url:'/api/books/a',payload:{title}})).statusCode).toBe(200)
      expect(db.prepare('SELECT anchor_manifest_version FROM reading_works WHERE id=?').get(initial.workId))
        .toEqual({anchor_manifest_version:0})
    }
    expect((await get(app,'a')).json().sharedProgress).toMatchObject({kind:'unmapped',reason:'stale-manifest'})
  })
  it('a detached anchor brings its own record into the vacant title work and the old position is restored on return', async () => {
    web(db,'a'); web(db,'b','dev-user','Same Story',['序言','第一章 開始','第二章 再會']); legacy(db,'a',1)
    const initial=(await get(app,'b')).json()
    expect(initial.sharedProgress).toMatchObject({kind:'mapped',positionValue:2})
    const snapshot=db.prepare('SELECT * FROM reading_progress WHERE book_id=?').get('a')
    expect((await app.inject({method:'PATCH',url:'/api/books/a',payload:{title:'Vacant Story'}})).statusCode).toBe(200)
    const detached=(await get(app,'a')).json()
    expect(detached.workId).not.toBe(initial.workId)
    // Joining its new work, the book brings its own saved record; the old work keeps its anchor for a return.
    expect(detached.sharedProgress).toMatchObject({kind:'mapped',positionValue:1})
    expect((await get(app,'b')).json().sharedProgress).toMatchObject({kind:'unmapped',anchorBookId:'a'})
    expect((await app.inject({method:'PATCH',url:'/api/books/a',payload:{title:'Same Story'}})).statusCode).toBe(200)
    expect((await get(app,'b')).json()).toMatchObject({workId:initial.workId,
      sharedProgress:{kind:'mapped',positionValue:2,chapterProgress:0.25}})
    expect(db.prepare('SELECT * FROM reading_progress WHERE book_id=?').get('a')).toEqual(snapshot)
  })
  it.each([
    {members:1, renamed:'a', label:'sole anchor'},
    {members:2, renamed:'a', label:'multi anchor'},
    {members:2, renamed:'b', label:'multi nonanchor with legacy'},
  ])('merge matrix: $label carries its position into an existing title and keeps the editions left behind', async ({members,renamed}) => {
    web(db,'a')
    if (members === 2) web(db,'b')
    web(db,'target','dev-user','Other Story')
    web(db,'foreign','other-user','Other Story')
    if (renamed === 'b') legacy(db,'b',1)
    const original=(await get(app,'a')).json()
    const destination=(await get(app,'target')).json()
    if (renamed === 'a') expect((await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload:{
      positionType:'chapter_index',positionValue:1,manifestVersion:1,
      expectedRevision:original.revision,expectedWorkId:original.workId}})).statusCode).toBe(200)
    const foreignBefore=db.prepare('SELECT * FROM books WHERE id=?').get('foreign')
    expect((await app.inject({method:'PATCH',url:`/api/books/${renamed}`,payload:{title:'OTHER STORY'}})).statusCode).toBe(200)
    // The destination had no position, so the joining edition's position is adopted without a choice.
    expect((await get(app,'target')).json()).toMatchObject({workId:destination.workId,sharedProgress:{kind:'mapped',positionValue:1}})
    expect((await get(app,renamed)).json()).toMatchObject({workId:destination.workId,sharedProgress:{kind:'mapped',positionValue:1}})
    if (members === 2) {
      const left=renamed === 'a' ? 'b' : 'a'
      expect((await get(app,left)).json()).toMatchObject({workId:original.workId,sharedProgress:{kind:'mapped',positionValue:1}})
    }
    expect(db.prepare('SELECT * FROM books WHERE id=?').get('foreign')).toEqual(foreignBefore)
  })
  it('does not resolve an old work through a renamed former anchor member', async () => {
    web(db,'a'); web(db,'b'); const current=(await get(app,'a')).json()
    await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload:{
      positionType:'chapter_index',positionValue:1,manifestVersion:1,expectedRevision:0,expectedWorkId:current.workId}})
    await app.inject({method:'PATCH',url:'/api/books/a',payload:{title:'Changed'}})
    expect((await get(app,'b')).json().sharedProgress).toMatchObject({kind:'unmapped',anchorBookId:'a'})
  })
  it('deleting the preferred edition reassigns the survivor without destroying the saved anchor', async () => {
    web(db,'a'); web(db,'b'); const current=(await get(app,'a')).json()
    await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload:{positionType:'chapter_index',positionValue:1,manifestVersion:1,expectedRevision:0,expectedWorkId:current.workId}})
    const deleted = await app.inject({method:'DELETE',url:'/api/books/a'})
    expect(deleted.statusCode).toBe(200)
    expect(db.prepare('SELECT preferred_book_id FROM reading_works').get()).toEqual({preferred_book_id:'b'})
    expect((await get(app,'b')).json()).toMatchObject({preferredBookId:'b',sharedProgress:{kind:'unmapped',anchorBookId:'a'}})
    expect(db.pragma('foreign_key_check')).toEqual([])
  })
  it('an upgrade sets each existing work\'s 補章 target to its preferred edition', () => {
    web(db,'w')
    db.prepare(`INSERT INTO reading_works (id,user_id,title_key,preferred_book_id,preferred_manual) VALUES ('k','dev-user','same story','w',1)`).run()
    db.prepare('ALTER TABLE reading_works DROP COLUMN supplement_book_id').run()
    db.close()
    db = initDb(join(dir, 'db.sqlite'))
    expect(db.prepare('SELECT supplement_book_id FROM reading_works').get()).toEqual({supplement_book_id:'w'})
  })
  it('a manifest replacement remaps a shared anchor by unique within-source key, never index', async () => {
    web(db,'a'); const current=(await get(app,'a')).json()
    await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload:{positionType:'chapter_index',positionValue:1,manifestVersion:1,expectedRevision:0,expectedWorkId:current.workId}})
    const { remapSharedManifest, chapters } = await import('../services/sharedProgress.js')
    const before=chapters(db,'dev-user','a')
    const next=[{chapter_index:0,title:'序言',url:'https://a.test/p',chapter_key:'a:p'}, ...before.map(c=>({...c,chapter_index:c.chapter_index+1}))]
    db.transaction(() => {
      db.prepare('DELETE FROM web_book_chapters WHERE book_id=?').run('a')
      for (const c of next) db.prepare(`INSERT INTO web_book_chapters (book_id,user_id,chapter_index,title,url,chapter_key,created_at) VALUES ('a','dev-user',?,?,?,?, 'now')`).run(c.chapter_index,c.title,c.url,c.chapter_key)
      db.prepare('UPDATE books SET manifest_version=2 WHERE id=?').run('a')
      remapSharedManifest(db,'dev-user','a',before,next,2)
    })()
    expect((await get(app,'a')).json()).toMatchObject({revision:2,sharedProgress:{kind:'mapped',positionValue:2}})
  })
  it('auto-adopts equivalent old positions whose chapter maps uniquely across editions', async () => {
    web(db,'a'); web(db,'b','dev-user','same story',['序言','第一章 開始','第二章 再會']); legacy(db,'a',1); legacy(db,'b',2)
    expect((await get(app,'b')).json().sharedProgress).toMatchObject({kind:'mapped',positionValue:2})
  })
  it('projects the canonical update time for mapped progress', async () => {
    web(db,'a'); const current=(await get(app,'a')).json()
    const saved=await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload:{positionType:'chapter_index',positionValue:1,manifestVersion:1,expectedRevision:0,expectedWorkId:current.workId}})
    expect(saved.json().sharedProgress.updatedAt).toEqual(expect.any(String))
  })
  it('orders the library by the latest shared write, not only per-book snapshots', async () => {
    web(db,'a'); web(db,'z','dev-user','Other'); legacy(db,'z',0)
    const current=(await get(app,'a')).json()
    await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload:{positionType:'chapter_index',positionValue:1,manifestVersion:1,expectedRevision:0,expectedWorkId:current.workId}})
    expect((await app.inject({method:'GET',url:'/api/books'})).json().map((b:{id:string}) => b.id)).toEqual(['a','z'])
  })
  it('keeps an unresolvable same-source anchor as historical data (index/title/offset) after a manifest change', async () => {
    web(db,'a'); const current=(await get(app,'a')).json()
    await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload:{positionType:'chapter_index',positionValue:1,chapterOffset:7,chapterProgress:0.5,manifestVersion:1,expectedRevision:0,expectedWorkId:current.workId}})
    const { remapSharedManifest, chapters } = await import('../services/sharedProgress.js')
    const before=chapters(db,'dev-user','a')
    const next=before.map(c=>({...c,url:`${c.url}?moved`,chapter_key:`${c.chapter_key}:moved`}))
    db.transaction(() => {
      db.prepare('UPDATE web_book_chapters SET url=url||?,chapter_key=chapter_key||? WHERE book_id=?').run('?moved',':moved','a')
      db.prepare('UPDATE books SET manifest_version=2 WHERE id=?').run('a')
      remapSharedManifest(db,'dev-user','a',before,next,2)
    })()
    expect(db.prepare('SELECT anchor_manifest_version,chapter_index,chapter_title,chapter_offset,revision FROM reading_works').get())
      .toEqual({anchor_manifest_version:1,chapter_index:1,chapter_title:'第二章 再會',chapter_offset:7,revision:2})
    expect((await get(app,'a')).json().sharedProgress).toMatchObject({kind:'unmapped',reason:'stale-manifest',anchorTitle:'第二章 再會'})
  })
  it('rejects out-of-range and malformed positions with 400 and no mutation', async () => {
    web(db,'a'); const current=(await get(app,'a')).json()
    const base={positionType:'chapter_index',positionValue:1,manifestVersion:1,expectedRevision:0,expectedWorkId:current.workId}
    for (const payload of [{...base,positionValue:9},{...base,positionValue:-1},{...base,positionValue:0.5},{...base,chapterProgress:1.5},
      {...base,chapterProgress:'x'},{...base,chapterOffset:-2},{...base,positionType:'paragraph_index'}]) {
      expect((await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload})).statusCode).toBe(400)
    }
    expect((await get(app,'a')).json()).toMatchObject({revision:0,sharedProgress:{kind:'empty'}})
  })
  it('returns the current state with a stale 409 so the client can offer a choice', async () => {
    web(db,'a'); const current=(await get(app,'a')).json()
    const payload={positionType:'chapter_index',positionValue:1,manifestVersion:1,expectedRevision:0,expectedWorkId:current.workId}
    await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload})
    const stale=await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload:{...payload,positionValue:0}})
    expect(stale.statusCode).toBe(409)
    expect(stale.json().current).toMatchObject({revision:1,sharedProgress:{kind:'mapped',positionValue:1}})
  })
  it('does not reject a save after an old-client write that is the same canonical position', async () => {
    web(db,'a'); web(db,'b','dev-user','same story',['序言','第一章 開始','第二章 再會'])
    const workId=(await get(app,'a')).json().workId
    const payload={positionType:'chapter_index',positionValue:1,manifestVersion:1,expectedRevision:0,expectedWorkId:workId}
    const first=await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload})
    await app.inject({method:'POST',url:'/api/books/b/progress',payload:{positionType:'chapter_index',positionValue:2}})
    const second=await app.inject({method:'POST',url:'/api/books/a/shared-progress',payload:{...payload,expectedRevision:first.json().revision}})
    expect(second.statusCode).toBe(200)
  })
  describe('a work without a canonical position', () => {
    const oldClient = (id: string, positionValue: number, chapterProgress: number) => app.inject({method:'POST',url:`/api/books/${id}/progress`,
      payload:{positionType:'chapter_index',positionValue,chapterOffset:1,chapterProgress}})
    const save = (id: string, workId: string, expectedRevision: number, positionValue = 0) => app.inject({method:'POST',url:`/api/books/${id}/shared-progress`,
      payload:{positionType:'chapter_index',positionValue,chapterProgress:0.05,manifestVersion:1,expectedRevision,expectedWorkId:workId}})
    const revision = () => (db.prepare('SELECT revision FROM reading_works').get() as {revision:number}).revision
    it('keeps the revision stable across repeated reads after adopting old-client rows', async () => {
      web(db,'a'); web(db,'b'); await oldClient('a',0,0.1); await oldClient('b',1,0.1)
      const first=(await get(app,'a')).json()
      for (let i = 0; i < 3; i++) { await get(app,'b'); await app.inject({method:'GET',url:'/api/books'}) }
      expect(revision()).toBe(first.revision)
      expect((await save('a',first.workId,first.revision)).statusCode).toBe(200)
    })
    it('accepts the first save of a fresh work with zero or one old-client rows', async () => {
      web(db,'a'); web(db,'b')
      const empty=(await get(app,'a')).json()
      expect((await save('a',empty.workId,empty.revision)).statusCode).toBe(200)
      web(db,'x','dev-user','Other'); await oldClient('x',1,0.3)
      const one=(await get(app,'x')).json()
      expect(one.sharedProgress).toMatchObject({kind:'mapped',positionValue:1})
      expect((await save('x',one.workId,one.revision,1)).statusCode).toBe(200)
    })
  })
  describe('a saved record whose chapter is not in its own current manifest', () => {
    it('is not adopted: the work stays empty, repeated reads keep the revision, and nothing is written', async () => {
      web(db,'a'); web(db,'b'); legacy(db,'a',7); legacy(db,'b',9)
      const before = db.prepare('SELECT * FROM reading_progress').all()
      const shown = (await get(app,'a')).json()
      expect(shown.sharedProgress).toEqual({kind:'empty'})
      for (let i = 0; i < 2; i++) { await get(app,'b'); await app.inject({method:'GET',url:'/api/books'}) }
      expect((await get(app,'a')).json().revision).toBe(shown.revision)
      expect(db.prepare('SELECT * FROM reading_progress').all()).toEqual(before)
    })
    it('is skipped beside a valid record, which is adopted', async () => {
      web(db,'a'); web(db,'b'); legacy(db,'a',1); legacy(db,'b',9,'dev-user','2026-01-09')
      expect((await get(app,'a')).json().sharedProgress).toMatchObject({kind:'mapped',positionValue:1})
      expect(db.prepare('SELECT anchor_book_id,chapter_index FROM reading_works').get()).toEqual({anchor_book_id:'a',chapter_index:1})
    })
  })
  it('answers 404 (unlinked) instead of crashing for a web book whose title normalizes to empty', async () => {
    web(db,'blank','dev-user','   ')
    expect.soft((await get(app,'blank')).statusCode).toBe(404)
    expect.soft((await app.inject({method:'POST',url:'/api/books/blank/preferred-source',payload:{preferredBookId:'blank',expectedPreferredBookId:'blank'}})).statusCode).toBe(404)
    expect.soft((await app.inject({method:'POST',url:'/api/books/blank/shared-progress',payload:{
      positionType:'chapter_index',positionValue:0,manifestVersion:1,expectedRevision:0,expectedWorkId:'x'}})).statusCode).toBe(404)
  })
  it('scopes work to user and denies foreign IDs', async () => {
    web(db,'a'); web(db,'foreign','other');
    expect((await get(app,'foreign')).statusCode).toBe(404)
    await get(app,'a')
    expect(db.prepare('SELECT COUNT(*) n FROM reading_work_members').get()).toEqual({n:1})
  })

  describe('TXT editions', () => {
    const save = async (id: string, positionValue: number, manifestVersion: number) => {
      const current = (await get(app,id)).json()
      return app.inject({method:'POST',url:`/api/books/${id}/shared-progress`,payload:{
        positionType:'chapter_index',positionValue,manifestVersion,chapterProgress:0.5,
        expectedRevision:current.revision,expectedWorkId:current.workId}})
    }

    it('joins the web work of the same title and shares progress by chapter name, both ways', async () => {
      web(db,'w','dev-user',' Same  Story ',['序章 楔子','第一章 開始','第二章 再會','第三章 告別'])
      txt(db,'t','same story',['第1章 開始','第2章 再會','第3章 告別'])
      const shared = (await get(app,'t')).json()
      expect(shared.members.map((m: {id:string}) => m.id).sort()).toEqual(['t','w'])
      expect(shared.preferredBookId).toBe('w')
      expect((await save('t',1,0)).statusCode).toBe(200)
      // TXT ordinal 1 is 「再會」, which is index 2 in the web edition (it has a prologue).
      expect((await get(app,'w')).json().sharedProgress).toMatchObject({kind:'mapped',positionValue:2,chapterProgress:0.5})
      expect((await save('w',3,1)).statusCode).toBe(200)
      expect((await get(app,'t')).json().sharedProgress).toMatchObject({kind:'mapped',positionValue:2})
      const listed = (await app.inject({method:'GET',url:'/api/books'})).json().find((b: {id:string}) => b.id === 't')
      expect(listed).toMatchObject({workId:shared.workId,preferredBookId:'w'})
    })

    it('never forms a work of its own, and a work left with only TXT editions is removed', async () => {
      txt(db,'lonely','Lonely')
      expect((await get(app,'lonely')).statusCode).toBe(404)
      web(db,'w'); txt(db,'t')
      expect((await get(app,'t')).statusCode).toBe(200)
      expect((await app.inject({method:'DELETE',url:'/api/books/w'})).statusCode).toBe(200)
      expect((await get(app,'t')).statusCode).toBe(404)
      expect(db.prepare('SELECT COUNT(*) n FROM reading_works').get()).toEqual({n:0})
    })

    it('joins after a real upload through the upload route', async () => {
      web(db,'w','dev-user','上傳合併',['第一章 開始','第二章 再會'])
      const form = new FormData()
      form.append('file', Buffer.from('第1章 開始\n\n正文一。\n\n第2章 再會\n\n正文二。', 'utf-8'), { filename: '上傳合併.txt', contentType: 'text/plain' })
      const uploaded = await app.inject({ method: 'POST', url: '/api/books', headers: form.getHeaders(), payload: form.getBuffer() })
      expect(uploaded.statusCode, uploaded.body).toBe(201)
      const res = await get(app, uploaded.json().id)
      expect(res.statusCode, res.body).toBe(200)
    })

    it('keeps the shared position on the TXT when the last web edition is deleted', async () => {
      web(db,'w','dev-user',' Same  Story ',['序章 楔子','第一章 開始','第二章 再會']); txt(db,'t'); legacy(db,'t',0)
      expect((await save('w',2,1)).statusCode).toBe(200)
      expect((await app.inject({method:'DELETE',url:'/api/books/w'})).statusCode).toBe(200)
      const progress = (await app.inject({method:'GET',url:'/api/books/t/progress'})).json()
      expect(progress).toMatchObject({positionType:'chapter_index',positionValue:1})
    })

    it('keeps the shared position on the TXT when the last web edition is renamed away', async () => {
      web(db,'w','dev-user',' Same  Story ',['第一章 開始','第二章 再會']); txt(db,'t'); legacy(db,'t',0)
      expect((await save('w',1,1)).statusCode).toBe(200)
      expect((await app.inject({method:'PATCH',url:'/api/books/w',payload:{title:'Elsewhere'}})).statusCode).toBe(200)
      await app.inject({method:'GET',url:'/api/books'})
      expect((await app.inject({method:'GET',url:'/api/books/t/progress'})).json()).toMatchObject({positionValue:1})
    })

    it('stays out of a work when no chapter heading was detected in the text', async () => {
      web(db,'w'); txt(db,'t',' Same  Story ',[])
      expect((await get(app,'t')).statusCode).toBe(404)
      expect((await get(app,'w')).json().members.map((m: {id:string}) => m.id)).toEqual(['w'])
    })

    const prefer = (id: string, expected: string) => app.inject({method:'POST',url:`/api/books/${id}/preferred-source`,
      payload:{preferredBookId:id,expectedPreferredBookId:expected}})
    const workRow = () => db.prepare('SELECT preferred_book_id,preferred_manual,supplement_book_id FROM reading_works').get()

    it('is never picked automatically, but can be chosen by hand while 補章 targets the best-covered web edition', async () => {
      web(db,'w1','dev-user',' Same  Story ',['第一章 開始'])
      web(db,'w2','dev-user',' Same  Story ',['第一章 開始','第二章 再會'],'2026-01-02')
      txt(db,'t',' Same  Story ',['第1章 開始','第2章 再會','第3章 告別'])
      expect((await get(app,'t')).json()).toMatchObject({preferredBookId:'w2',supplementBookId:'w2'})
      expect((await prefer('w1','w2')).statusCode).toBe(200)
      const asked = await prefer('t','w1')
      expect(asked.statusCode, asked.body).toBe(200)
      expect(asked.json()).toMatchObject({preferredBookId:'t',supplementBookId:'w2'})
      expect((await get(app,'w1')).json()).toMatchObject({preferredBookId:'t',supplementBookId:'w2'})
      expect(workRow()).toEqual({preferred_book_id:'t',preferred_manual:1,supplement_book_id:'w2'})
    })

    it('keeps the current 補章 target on a coverage tie after a TXT becomes preferred', async () => {
      web(db,'w1'); web(db,'w2','dev-user',' Same  Story ',['第一章 開始','第二章 再會'],'2026-01-02'); txt(db,'t')
      await get(app,'w1')
      expect((await prefer('w2','w1')).statusCode).toBe(200)
      expect((await prefer('t','w2')).statusCode).toBe(200)
      expect((await get(app,'t')).json()).toMatchObject({preferredBookId:'t',supplementBookId:'w2'})
    })

    it('hands the preference back to the web editions when the preferred TXT leaves the work', async () => {
      web(db,'w'); txt(db,'t')
      await get(app,'w')
      expect((await prefer('t','w')).statusCode).toBe(200)
      expect((await app.inject({method:'PATCH',url:'/api/books/t',payload:{title:'Elsewhere'}})).statusCode).toBe(200)
      expect((await get(app,'w')).json()).toMatchObject({preferredBookId:'w',supplementBookId:'w'})
      expect(workRow()).toEqual({preferred_book_id:'w',preferred_manual:0,supplement_book_id:'w'})
    })

    it('hands the preference back to the web editions when the preferred TXT is deleted', async () => {
      web(db,'w'); txt(db,'t')
      await get(app,'w')
      expect((await prefer('t','w')).statusCode).toBe(200)
      expect((await app.inject({method:'DELETE',url:'/api/books/t'})).statusCode).toBe(200)
      expect((await get(app,'w')).json()).toMatchObject({preferredBookId:'w',supplementBookId:'w'})
      expect(workRow()).toEqual({preferred_book_id:'w',preferred_manual:0,supplement_book_id:'w'})
    })

    it('adopts the only saved TXT position when it joins a work without one', async () => {
      web(db,'w','dev-user',' Same  Story ',['序章 楔子','第一章 開始','第二章 再會'])
      txt(db,'t'); legacy(db,'t',1)
      expect((await get(app,'w')).json().sharedProgress).toMatchObject({kind:'mapped',positionValue:2})
    })

    it.each([
      {txtSaved:'2026-01-09', expected:2},
      {txtSaved:'2026-01-01', expected:0},
    ])('merges into a differently titled web work by rename, keeping the more recent position (TXT saved $txtSaved)', async ({txtSaved,expected}) => {
      web(db,'w','dev-user','大奉打更人',['第一章 開始','第二章 再會','第三章 告別']); legacy(db,'w',0)
      txt(db,'t','大奉打更人 精校版',['第1章 開始','第2章 再會','第3章 告別']); legacy(db,'t',2,'dev-user',txtSaved)
      expect((await get(app,'w')).json().sharedProgress).toMatchObject({kind:'mapped',positionValue:0})
      expect((await app.inject({method:'PATCH',url:'/api/books/t',payload:{title:'大奉打更人'}})).statusCode).toBe(200)
      expect((await get(app,'t')).json().sharedProgress).toMatchObject({kind:'mapped',positionValue:expected})
      expect((await get(app,'w')).json().sharedProgress).toMatchObject({kind:'mapped',positionValue:expected})
    })

    it('merges silently by rename when both editions are at the same chapter', async () => {
      web(db,'w','dev-user','大奉打更人',['第一章 開始','第二章 再會']); legacy(db,'w',1)
      txt(db,'t','大奉 txt',['第1章 開始','第2章 再會']); legacy(db,'t',1)
      await get(app,'w')
      expect((await app.inject({method:'PATCH',url:'/api/books/t',payload:{title:'大奉打更人'}})).statusCode).toBe(200)
      expect((await get(app,'t')).json().sharedProgress).toMatchObject({kind:'mapped',positionValue:1})
    })
  })
})
