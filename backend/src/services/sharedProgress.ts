import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { isStoryChapterTitle, normalizeChapterName } from './web-source/crossSourceSupplement.js'
import { titleKey } from '../utils/titleKey.js'

export type Chapter = { chapter_index: number; title: string; url: string; chapter_key: string | null }
export type Work = { id: string; user_id: string; title_key: string; preferred_book_id: string | null;
  preferred_manual: number; supplement_book_id: string | null;
  anchor_book_id: string | null; anchor_manifest_version: number | null; chapter_index: number | null;
  chapter_title: string | null; chapter_progress: number | null; chapter_offset: number | null;
  revision: number; updated_at: string | null }
type Book = { id: string; user_id: string; title: string; source_type: string; manifest_version: number; created_at: string }
type Saved = { position_type: string; position_value: number; chapter_progress: number | null;
  chapter_offset: number | null; updated_at: string }

/** Optional per-request memo; only pass one that lives no longer than a single request. */
export type ManifestCache = Map<string, Chapter[]>
/**
 * A book's complete chapter list. A TXT edition's list is its uploaded headings,
 * indexed by array position: the same ordinal the Reader saves for it.
 */
export function chapters(db: Database.Database, userId: string, bookId: string, cache?: ManifestCache): Chapter[] {
  const hit = cache?.get(bookId)
  if (hit) return hit
  const book = db.prepare('SELECT source_type,chapters_json FROM books WHERE id=? AND user_id=?')
    .get(bookId, userId) as { source_type: string; chapters_json: string | null } | undefined
  const rows = book?.source_type === 'txt' ? txtChapters(book.chapters_json)
    : db.prepare(`SELECT chapter_index,title,url,chapter_key FROM web_book_chapters
      WHERE user_id=? AND book_id=? ORDER BY chapter_index`).all(userId, bookId) as Chapter[]
  cache?.set(bookId, rows)
  return rows
}
function txtChapters(json: string | null): Chapter[] {
  try {
    const parsed = JSON.parse(json ?? '[]') as Array<{ title?: unknown }>
    return Array.isArray(parsed)
      ? parsed.map((chapter, i) => ({ chapter_index: i, title: String(chapter?.title ?? ''), url: '', chapter_key: null }))
      : []
  } catch {
    return []
  }
}

// Normalized-name indexes keyed by the manifest array itself. A cached manifest
// array lives exactly as long as its ManifestCache, so each book is normalized
// once per request however many cross-edition mappings use it.
type NameIndex = { names: string[]; groups: Map<string, Chapter[]> }
const nameIndexes = new WeakMap<Chapter[], NameIndex>()
function nameIndex(items: Chapter[]): NameIndex {
  let index = nameIndexes.get(items)
  if (!index) {
    const names = items.map(chapter => normalizeChapterName(chapter.title))
    const groups = new Map<string, Chapter[]>()
    items.forEach((chapter, i) => {
      if (!names[i]) return
      const group = groups.get(names[i])
      if (group) group.push(chapter)
      else groups.set(names[i], [chapter])
    })
    index = { names, groups }
    nameIndexes.set(items, index)
  }
  return index
}
const orderedPairs = new WeakMap<Chapter[], WeakMap<Chapter[], number[][]>>()
/** [sourceIndex, targetIndex] for every chapter name unique in both manifests, in source order. */
function uniquePairs(source: Chapter[], target: Chapter[]): number[][] {
  let byTarget = orderedPairs.get(source)
  if (!byTarget) orderedPairs.set(source, byTarget = new WeakMap())
  let pairs = byTarget.get(target)
  if (!pairs) {
    const from = nameIndex(source), to = nameIndex(target)
    pairs = source.flatMap((c, i) => {
      const name = from.names[i]
      return name && from.groups.get(name)?.length === 1 && to.groups.get(name)?.length === 1
        ? [[c.chapter_index, to.groups.get(name)![0].chapter_index]] : []
    })
    byTarget.set(target, pairs)
  }
  return pairs
}

/** Return no index rather than guess when title or chapter order cannot be proven. */
export function mapAnchor(source: Chapter[], target: Chapter[], index: number, title: string) {
  const at = source.findIndex(c => c.chapter_index === index)
  const key = normalizeChapterName(title)
  const from = nameIndex(source), to = nameIndex(target)
  if (!key || at < 0 || from.names[at] !== key) return { kind: 'unmapped' as const, reason: 'missing' }
  if (from.groups.get(key)?.length !== 1 || to.groups.get(key)?.length !== 1) return { kind: 'unmapped' as const, reason: 'ambiguous' }
  const candidate = to.groups.get(key)![0]
  const ordered = uniquePairs(source, target)
  const preceding = ordered.filter(pair => pair[0] < index)
  const following = ordered.filter(pair => pair[0] > index)
  if ((preceding.length && preceding[preceding.length - 1][1] >= candidate.chapter_index)
    || (following.length && following[0][1] <= candidate.chapter_index)) {
    return { kind: 'unmapped' as const, reason: 'order' }
  }
  return { kind: 'mapped' as const, positionValue: candidate.chapter_index }
}

/**
 * A book's own per-book record (`reading_progress`), valid only when it names a chapter
 * of the book's current manifest. Read only when the book joins a work.
 */
function savedPosition(db: Database.Database, userId: string, bookId: string, cache?: ManifestCache) {
  const row = db.prepare(`SELECT position_type,position_value,chapter_progress,chapter_offset,updated_at FROM reading_progress
    WHERE user_id=? AND book_id=?`).get(userId,bookId) as Saved | undefined
  const book = db.prepare(`SELECT manifest_version FROM books WHERE id=? AND user_id=? AND source_type IN ('web','txt')`)
    .get(bookId,userId) as { manifest_version: number } | undefined
  if (!row || !book || row.position_type !== 'chapter_index' || !Number.isSafeInteger(row.position_value)) return null
  const chapter = chapters(db,userId,bookId,cache).find(c => c.chapter_index === row.position_value)
  if (!chapter) return null
  return { title: chapter.title, positionValue: row.position_value, chapterProgress: row.chapter_progress,
    chapterOffset: row.chapter_offset, manifestVersion: book.manifest_version, updatedAt: row.updated_at }
}
/**
 * A book joining a work brings its own record: it becomes the work's position when
 * the work has none or the record is more recent. After joining, a member's
 * per-book record is never read again; the work row is the only position.
 */
function adoptJoining(db: Database.Database, userId: string, workId: string, bookId: string, cache?: ManifestCache): void {
  const saved = savedPosition(db,userId,bookId,cache)
  if (!saved) return
  const work = db.prepare('SELECT anchor_book_id,updated_at FROM reading_works WHERE id=? AND user_id=?')
    .get(workId,userId) as { anchor_book_id: string | null; updated_at: string | null }
  if (work.anchor_book_id && (work.updated_at ?? '') >= saved.updatedAt) return
  db.prepare(`UPDATE reading_works SET anchor_book_id=?,anchor_manifest_version=?,chapter_index=?,chapter_title=?,
    chapter_progress=?,chapter_offset=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=?`)
    .run(bookId,saved.manifestVersion,saved.positionValue,saved.title,saved.chapterProgress,saved.chapterOffset,saved.updatedAt,workId,userId)
}
export function readWork(db: Database.Database, userId: string, bookId: string): Work | undefined {
  return db.prepare(`SELECT w.* FROM reading_works w JOIN reading_work_members m ON m.work_id=w.id AND m.user_id=w.user_id
    WHERE m.book_id=? AND w.user_id=?`).get(bookId,userId) as Work | undefined
}

/**
 * Authenticated, transactionally idempotent migration. Physical progress is only
 * written when a work loses its last web edition (see releaseWork).
 * Pass the request's ManifestCache so projection reuses the manifests read here.
 */
export function reconcileWorks(db: Database.Database, userId: string, cache: ManifestCache = new Map()): void {
  db.transaction(() => {
    // Web editions first: only they found works. A TXT edition with detected
    // headings joins the existing work of its title; one without headings never joins.
    const owned = db.prepare(`SELECT id,user_id,title,source_type,manifest_version,created_at FROM books
      WHERE user_id=? AND source_type IN ('web','txt') ORDER BY created_at,id`).all(userId) as Book[]
    // Parse a TXT's headings only when a web edition shares its title or it is already a
    // member (a work that just lost its web edition still releases onto it). This runs
    // on every library read.
    const webKeys = new Set(owned.filter(b => b.source_type === 'web').map(b => titleKey(b.title)))
    const memberIds = new Set((db.prepare('SELECT book_id FROM reading_work_members WHERE user_id=?').all(userId) as {book_id:string}[])
      .map(row => row.book_id))
    const books = owned
      .filter(b => b.source_type === 'web'
        || ((webKeys.has(titleKey(b.title)) || memberIds.has(b.id)) && chapters(db,userId,b.id,cache).length > 0))
      .sort((a, b) => Number(b.source_type === 'web') - Number(a.source_type === 'web'))
    const keys = new Map(books.map(b => [b.id, titleKey(b.title)]))
    const members = db.prepare('SELECT book_id,work_id FROM reading_work_members WHERE user_id=?').all(userId) as {book_id:string;work_id:string}[]
    // Keep the work identity (and its canonical anchor/preference) when its only
    // edition changes title. Never rekey into an existing, possibly unrelated work.
    for (const member of members) {
      const work = db.prepare('SELECT title_key FROM reading_works WHERE id=? AND user_id=?')
        .get(member.work_id,userId) as {title_key:string}|undefined
      const key = keys.get(member.book_id)
      if (!work || !key || key === work.title_key) continue
      const count = db.prepare('SELECT COUNT(*) AS n FROM reading_work_members WHERE user_id=? AND work_id=?')
        .get(userId,member.work_id) as {n:number}
      if (count.n !== 1 || db.prepare('SELECT 1 FROM reading_works WHERE user_id=? AND title_key=?').get(userId,key)) continue
      db.prepare('UPDATE reading_works SET title_key=?,revision=revision+1 WHERE id=? AND user_id=?')
        .run(key,member.work_id,userId)
    }
    for (const member of members) {
      const work = db.prepare('SELECT title_key FROM reading_works WHERE id=? AND user_id=?').get(member.work_id,userId) as {title_key:string}|undefined
      if (!work || work.title_key !== keys.get(member.book_id)) db.prepare('DELETE FROM reading_work_members WHERE user_id=? AND book_id=?').run(userId,member.book_id)
    }
    for (const book of books) {
      const key = keys.get(book.id)!
      if (!key) continue
      let work = db.prepare('SELECT * FROM reading_works WHERE user_id=? AND title_key=?').get(userId,key) as Work|undefined
      if (!work && book.source_type !== 'web') continue
      if (!work) {
        const id = randomUUID()
        db.prepare(`INSERT INTO reading_works (id,user_id,title_key,preferred_book_id,preferred_manual,supplement_book_id) VALUES (?,?,?,?,0,?)`)
          .run(id,userId,key,book.id,book.id)
        work = db.prepare('SELECT * FROM reading_works WHERE id=?').get(id) as Work
      }
      const joined = db.prepare(`INSERT OR IGNORE INTO reading_work_members (user_id,work_id,book_id) VALUES (?,?,?)`).run(userId,work.id,book.id)
      if (joined.changes === 1) adoptJoining(db,userId,work.id,book.id,cache)
    }
    const works = db.prepare('SELECT * FROM reading_works WHERE user_id=?').all(userId) as Work[]
    for (const work of works) {
      // 補章's target is always a web edition (the preferred one unless a TXT was
      // chosen by hand); a work without a web edition is not a work.
      const members = db.prepare(`SELECT b.id FROM reading_work_members m
        JOIN books b ON b.id=m.book_id AND b.user_id=m.user_id
        WHERE m.work_id=? AND m.user_id=? AND b.source_type='web' ORDER BY b.created_at,b.id`).all(work.id,userId) as {id:string}[]
      const supplemented = db.prepare(`SELECT s.book_id,s.url FROM web_book_supplements s
        JOIN reading_work_members m ON m.book_id=s.book_id AND m.user_id=s.user_id
        WHERE m.work_id=? AND m.user_id=? AND s.status='active'`).all(work.id,userId) as {book_id:string;url:string}[]
      const supplementUrls = new Map<string, Set<string>>()
      for (const row of supplemented) {
        let urls = supplementUrls.get(row.book_id)
        if (!urls) supplementUrls.set(row.book_id, urls = new Set())
        urls.add(row.url)
      }
      // Reuse the request's manifest and its normalized-name index during
      // projection. Each chapter is normalized at most once per request.
      // Non-body/nameless chapters and active supplements are not evidence of coverage.
      const allNames = new Set<string>()
      const namesByBook = members.map(({id}) => {
        const names = new Set<string>()
        const manifest = chapters(db,userId,id,cache)
        const normalized = nameIndex(manifest).names
        manifest.forEach((chapter, i) => {
          const name = normalized[i]
          if (name && isStoryChapterTitle(chapter.title) && !supplementUrls.get(id)?.has(chapter.url)) {
            names.add(name)
            allNames.add(name)
          }
        })
        return {id,names}
      })
      const owned = namesByBook.map(({id,names}) => ({id,missing:allNames.size - names.size}))
      if (!owned.length) { releaseWork(db,userId,work,undefined,cache); continue }
      // A TXT is never ranked; it stays preferred only while it is a member chosen by hand.
      const txtPreferred = !!work.preferred_manual && !!db.prepare(`SELECT 1 FROM reading_work_members m
        JOIN books b ON b.id=m.book_id AND b.user_id=m.user_id
        WHERE m.work_id=? AND m.user_id=? AND m.book_id=? AND b.source_type='txt'`).get(work.id,userId,work.preferred_book_id)
      const current = owned.find(row => row.id === (txtPreferred ? work.supplement_book_id : work.preferred_book_id))
      const fewest = Math.min(...owned.map(row => row.missing))
      const chosen = current && ((!txtPreferred && work.preferred_manual) || current.missing === fewest)
        ? current : owned.find(row => row.missing === fewest)!
      if (txtPreferred) {
        if (chosen.id !== work.supplement_book_id) db.prepare('UPDATE reading_works SET supplement_book_id=? WHERE id=? AND user_id=?').run(chosen.id,work.id,userId)
      } else if (chosen.id !== work.preferred_book_id || chosen.id !== work.supplement_book_id) {
        db.prepare(`UPDATE reading_works SET preferred_book_id=?,supplement_book_id=?,
          preferred_manual=CASE WHEN preferred_book_id=? THEN preferred_manual ELSE 0 END WHERE id=? AND user_id=?`)
          .run(chosen.id,chosen.id,chosen.id,work.id,userId)
      }
    }
  })()
}
/**
 * A book renamed out of its work into another existing work. Its current shared
 * position is written as its own record, so joining the target compares it with the
 * target's position and keeps the more recent one (adoptJoining). Editions the book
 * leaves behind are re-anchored by chapter name, or left without a position.
 * Call before the rename advances the book's manifest version.
 */
export function prepareMerge(db: Database.Database, userId: string, bookId: string,
  source: Work | undefined, cache: ManifestCache = new Map()): void {
  if (!source?.anchor_book_id) return
  const resolved = resolveAnchor(db,userId,source,bookId,cache)
  if (resolved.kind === 'mapped') {
    db.prepare(`INSERT INTO reading_progress (user_id,book_id,position_type,position_value,chapter_progress,chapter_offset,updated_at)
      VALUES (?,?,'chapter_index',?,?,?,?) ON CONFLICT(user_id,book_id) DO UPDATE SET position_type=excluded.position_type,
      position_value=excluded.position_value,chapter_progress=excluded.chapter_progress,chapter_offset=excluded.chapter_offset,updated_at=excluded.updated_at`)
      .run(userId,bookId,resolved.positionValue,source.chapter_progress,bookId === source.anchor_book_id ? source.chapter_offset : null,
        source.updated_at ?? new Date().toISOString())
  }
  if (source.anchor_book_id !== bookId) return
  const leaving = chapters(db,userId,bookId,cache)
  const others = db.prepare(`SELECT b.id,b.manifest_version FROM reading_work_members m JOIN books b ON b.id=m.book_id AND b.user_id=m.user_id
    WHERE m.work_id=? AND m.user_id=? AND b.id<>? ORDER BY b.created_at,b.id`).all(source.id,userId,bookId) as {id:string;manifest_version:number}[]
  for (const other of others) {
    const manifest = chapters(db,userId,other.id,cache)
    const mapped = mapAnchor(leaving,manifest,source.chapter_index!,source.chapter_title!)
    if (mapped.kind !== 'mapped') continue
    db.prepare(`UPDATE reading_works SET anchor_book_id=?,anchor_manifest_version=?,chapter_index=?,chapter_title=?,chapter_offset=NULL,
      revision=revision+1 WHERE id=? AND user_id=?`)
      .run(other.id,other.manifest_version,mapped.positionValue,manifest.find(c => c.chapter_index === mapped.positionValue)!.title,source.id,userId)
    return
  }
  db.prepare(`UPDATE reading_works SET anchor_book_id=NULL,anchor_manifest_version=NULL,chapter_index=NULL,chapter_title=NULL,
    chapter_progress=NULL,chapter_offset=NULL,revision=revision+1 WHERE id=? AND user_id=?`).run(source.id,userId)
}
/**
 * Deletes a work that no longer has a web edition. Each remaining (TXT) edition
 * first gets the shared position as its own record, mapped by chapter name from
 * the anchor's manifest (the anchor may already have left the work), so reading
 * there does not fall back to an older per-book record. `except` is a book being deleted.
 */
export function releaseWork(db: Database.Database, userId: string, work: Work, except?: string, cache: ManifestCache = new Map()): void {
  const anchor = work.anchor_book_id && work.chapter_index !== null && work.chapter_title !== null
    ? db.prepare('SELECT manifest_version FROM books WHERE id=? AND user_id=?').get(work.anchor_book_id,userId) as {manifest_version:number}|undefined
    : undefined
  if (anchor && anchor.manifest_version === work.anchor_manifest_version) {
    const original = chapters(db,userId,work.anchor_book_id!,cache)
    const members = db.prepare('SELECT book_id FROM reading_work_members WHERE user_id=? AND work_id=?').all(userId,work.id) as {book_id:string}[]
    const snapshot = db.prepare(`INSERT INTO reading_progress (user_id,book_id,position_type,position_value,chapter_progress,chapter_offset,updated_at)
      VALUES (?,?,'chapter_index',?,?,?,?) ON CONFLICT(user_id,book_id) DO UPDATE SET position_type=excluded.position_type,
      position_value=excluded.position_value,chapter_progress=excluded.chapter_progress,chapter_offset=excluded.chapter_offset,updated_at=excluded.updated_at`)
    for (const { book_id: bookId } of members) {
      if (bookId === except) continue
      const sameBook = bookId === work.anchor_book_id
      const position = sameBook
        ? (original.find(c => c.chapter_index === work.chapter_index)?.title === work.chapter_title ? work.chapter_index : null)
        : (() => {
          const mapped = mapAnchor(original,chapters(db,userId,bookId,cache),work.chapter_index!,work.chapter_title!)
          return mapped.kind === 'mapped' ? mapped.positionValue : null
        })()
      if (position === null) continue
      snapshot.run(userId,bookId,position,work.chapter_progress,sameBook ? work.chapter_offset : null,work.updated_at ?? new Date().toISOString())
    }
  }
  db.prepare('DELETE FROM reading_works WHERE id=? AND user_id=?').run(work.id,userId)
}
type Resolution = {kind:'mapped';positionValue:number} | {kind:'unmapped';reason:string}
/** Resolve the canonical anchor into one member's complete stored manifest. */
function resolveAnchor(db: Database.Database, userId: string, work: Work, bookId: string, cache?: ManifestCache): Resolution {
  if (!work.anchor_book_id || work.chapter_index === null || work.chapter_title === null) return {kind:'unmapped',reason:'missing'}
  // A renamed/deleted former member belongs to another work now; its anchor is
  // historical and must not be resolved through that book's manifest.
  const anchorBook = db.prepare(`SELECT b.manifest_version FROM books b JOIN reading_work_members m
    ON m.book_id=b.id AND m.user_id=b.user_id AND m.work_id=?
    WHERE b.id=? AND b.user_id=?`).get(work.id,work.anchor_book_id,userId) as {manifest_version:number}|undefined
  const targetBook = db.prepare('SELECT manifest_version FROM books WHERE id=? AND user_id=?').get(bookId,userId) as {manifest_version:number}|undefined
  if (!anchorBook || !targetBook || anchorBook.manifest_version !== work.anchor_manifest_version) return {kind:'unmapped',reason:'stale-manifest'}
  const original = chapters(db,userId,work.anchor_book_id,cache)
  if (bookId === work.anchor_book_id) {
    return original.find(c => c.chapter_index === work.chapter_index)?.title === work.chapter_title
      ? {kind:'mapped',positionValue:work.chapter_index} : {kind:'unmapped',reason:'changed'}
  }
  return mapAnchor(original,chapters(db,userId,bookId,cache),work.chapter_index,work.chapter_title)
}
export function projectWork(db: Database.Database, userId: string, work: Work, bookId: string, cache: ManifestCache = new Map()) {
  const members = db.prepare(`SELECT b.id,b.title,b.source_type AS sourceType,b.source_url AS sourceUrl,b.provider_id AS providerId,
    b.manifest_version AS manifestVersion
    FROM reading_work_members m JOIN books b ON b.id=m.book_id AND b.user_id=m.user_id
    WHERE m.work_id=? AND m.user_id=? ORDER BY b.created_at,b.id`).all(work.id,userId) as Array<{id:string;title:string;sourceType:string;sourceUrl:string|null;providerId:string|null;manifestVersion:number}>
  let sharedProgress: Record<string, unknown>
  if (work.anchor_book_id === null) sharedProgress = {kind:'empty'}
  else {
    const result = resolveAnchor(db,userId,work,bookId,cache)
    sharedProgress = result.kind === 'mapped' ? {kind:'mapped',positionType:'chapter_index',positionValue:result.positionValue,
      chapterProgress:work.chapter_progress,...(bookId === work.anchor_book_id ? {chapterOffset:work.chapter_offset} : {}),
      updatedAt:work.updated_at}
      : {kind:'unmapped',reason:result.reason,anchorTitle:work.chapter_title,anchorBookId:work.anchor_book_id}
  }
  return {workId:work.id,preferredBookId:work.preferred_book_id,supplementBookId:work.supplement_book_id,members,revision:work.revision,sharedProgress}
}

/** Run inside the same transaction as manifest replacement. Never use ordinal fallback. */
export function remapSharedManifest(db: Database.Database, userId: string, bookId: string,
  previous: Chapter[], next: Chapter[], nextVersion: number): void {
  const work = readWork(db,userId,bookId)
  if (!work || work.anchor_book_id !== bookId || work.chapter_index === null) return
  const old = previous.find(c => c.chapter_index === work.chapter_index)
  const key = old?.chapter_key
  const byKey = key && previous.filter(c => c.chapter_key === key).length === 1
    ? next.filter(c => c.chapter_key === key) : []
  const url = old?.url
  const byUrl = url && previous.filter(c => c.url === url).length === 1
    ? next.filter(c => c.url === url) : []
  const matched = byKey.length === 1 ? byKey[0] : byUrl.length === 1 ? byUrl[0] : null
  // Stale saves must 409 even if the index did not change. On uncertainty retain
  // the historical version/title/index (now explicitly unmapped).
  db.prepare(`UPDATE reading_works SET anchor_manifest_version=?,chapter_index=?,chapter_title=?,
    chapter_offset=?,revision=revision+1 WHERE id=? AND user_id=?`).run(
    matched ? nextVersion : work.anchor_manifest_version,
    matched ? matched.chapter_index : work.chapter_index,
    matched ? matched.title : work.chapter_title,
    !matched || matched.title === work.chapter_title ? work.chapter_offset : null,
    work.id,userId)
}
