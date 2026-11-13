import type {
  Chapter, WebSourceSupplementAmbiguity, WebSourceSupplementCandidate, WebSourceSupplementPreview,
} from '../api.js'

/** One chapter shown in a side-by-side gap view. */
export interface GapCell {
  title: string
  /** 1-based position in that book's current table of contents, when it can be located. */
  chapterNumber?: number
}

/**
 * One aligned row: the target book (left) next to the donor (right).
 * `before`/`after` rows are context; `current` rows are the gap itself, so a
 * missing chapter has `left: null` while a renamed one has both sides.
 */
export interface GapRow {
  kind: 'before' | 'current' | 'after'
  left: GapCell | null
  right: GapCell | null
  /** Set on a current row whose right cell is a supplement candidate. */
  candidateId?: string
}

export interface CandidateGap {
  key: string
  donorBookId: string
  donorDisplayName: string
  insertAfterIndex: number
  atEnd: boolean
  candidateIds: string[]
  rows: GapRow[]
}

interface SideCell {
  cell: GapCell
  candidateId?: string
}

const numbered = (chapters: Chapter[], from: number, to: number): SideCell[] => {
  const cells: SideCell[] = []
  for (let i = Math.max(0, from); i <= Math.min(to, chapters.length - 1); i++) {
    cells.push({ cell: { title: chapters[i].title, chapterNumber: i + 1 } })
  }
  return cells
}

function alignRows(kind: GapRow['kind'], left: SideCell[], right: SideCell[], padStart: boolean): GapRow[] {
  const length = Math.max(left.length, right.length)
  const pad = (cells: SideCell[]): Array<SideCell | null> => {
    const fill = Array<null>(length - cells.length).fill(null)
    return padStart ? [...fill, ...cells] : [...cells, ...fill]
  }
  const paddedLeft = pad(left)
  const paddedRight = pad(right)
  return paddedLeft.map((leftCell, i) => {
    const rightCell = paddedRight[i]
    const row: GapRow = { kind, left: leftCell?.cell ?? null, right: rightCell?.cell ?? null }
    if (rightCell?.candidateId) row.candidateId = rightCell.candidateId
    return row
  })
}

interface Sides {
  before: SideCell[]
  current: SideCell[]
  after: SideCell[]
}

function sectionRows(left: Sides, right: Sides): GapRow[] {
  return [
    ...alignRows('before', left.before, right.before, true),
    ...alignRows('current', left.current, right.current, false),
    ...alignRows('after', left.after, right.after, false),
  ]
}

/** Groups consecutive candidates that share a donor and an insertion point into aligned rows. */
export function buildCandidateGaps(
  targetChapters: Chapter[],
  donorChaptersById: ReadonlyMap<string, Chapter[] | undefined>,
  candidates: WebSourceSupplementCandidate[],
): CandidateGap[] {
  const groups = new Map<string, WebSourceSupplementCandidate[]>()
  for (const candidate of candidates) {
    const key = `${candidate.donorBookId}:${candidate.insertAfterIndex}:${candidate.atEnd}`
    const group = groups.get(key)
    if (group) group.push(candidate)
    else groups.set(key, [candidate])
  }

  return [...groups].map(([key, group]) => {
    const { donorBookId, donorDisplayName, insertAfterIndex, atEnd } = group[0]
    const left: Sides = {
      before: numbered(targetChapters, insertAfterIndex - 1, insertAfterIndex),
      current: [],
      after: atEnd ? [] : numbered(targetChapters, insertAfterIndex + 1, insertAfterIndex + 2),
    }

    const donor = donorChaptersById.get(donorBookId)
    const positions = group.map(candidate => donor?.findIndex(chapter => chapter.sourceUrl === candidate.url) ?? -1)
    let right: Sides
    if (donor && positions.every(position => position >= 0)) {
      const p0 = Math.min(...positions)
      const p1 = Math.max(...positions)
      const idByUrl = new Map(group.map(candidate => [candidate.url, candidate.id]))
      right = {
        before: numbered(donor, p0 - 2, p0 - 1),
        current: numbered(donor, p0, p1).map((cell, i) => {
          const candidateId = idByUrl.get(donor[p0 + i].sourceUrl ?? '')
          return candidateId ? { ...cell, candidateId } : cell
        }),
        after: numbered(donor, p1 + 1, p1 + 2),
      }
    } else {
      right = {
        before: [],
        current: group.map(candidate => ({ cell: { title: candidate.title }, candidateId: candidate.id })),
        after: [],
      }
    }

    return {
      key,
      donorBookId,
      donorDisplayName,
      insertAfterIndex,
      atEnd,
      candidateIds: group.map(candidate => candidate.id),
      rows: sectionRows(left, right),
    }
  })
}

/** Aligned rows for an uncertain spot, from the server-provided context titles. */
export function buildAmbiguityRows(
  targetChapters: Chapter[],
  item: WebSourceSupplementAmbiguity,
): GapRow[] {
  const leftTitles = [item.primaryBefore ?? [], item.primaryTitles, item.primaryAfter ?? []]
  const sequence = leftTitles.flat()
  let start = -1
  if (sequence.length > 0) {
    for (let s = 0; s + sequence.length <= targetChapters.length; s++) {
      if (sequence.every((title, k) => targetChapters[s + k].title === title)) {
        start = s
        break
      }
    }
  }

  let offset = 0
  const [before, current, after] = leftTitles.map(titles => titles.map(title => {
    const cell: GapCell = { title }
    if (start >= 0) cell.chapterNumber = start + offset + 1
    offset++
    return { cell }
  }))
  const plain = (titles: string[] | undefined): SideCell[] => (titles ?? []).map(title => ({ cell: { title } }))

  return sectionRows(
    { before, current, after },
    { before: plain(item.donorBefore), current: plain(item.donorTitles), after: plain(item.donorAfter) },
  )
}

/**
 * Where an entry is listed: `missing` up front; spots where this book has a
 * differently named chapter (`renamed`) or already has / was supplemented with
 * the chapter (`present`) are folded by default.
 */
export type SupplementEntryGroup = 'missing' | 'renamed' | 'present'

export type SupplementEntry =
  | { kind: 'gap'; key: string; gap: CandidateGap }
  | { kind: 'ambiguity'; key: string; item: WebSourceSupplementAmbiguity; rows: GapRow[] }

const AMBIGUITY_GROUPS: Record<string, SupplementEntryGroup> = {
  renamed_or_variant: 'renamed',
  name_elsewhere: 'present',
  mixed_with_supplement: 'present',
  pending_supplement: 'present',
}

function ambiguityGroup(item: WebSourceSupplementAmbiguity): SupplementEntryGroup {
  // Outside the book's first/last matched chapter: renamed only when this book has chapters there.
  if (item.reason === 'unbracketed') return item.primaryTitles.length > 0 ? 'renamed' : 'missing'
  // An ordinal-only donor chapter where this book already has chapters is most likely one of them.
  if (item.reason === 'no_name') return item.primaryTitles.length > 0 ? 'present' : 'missing'
  return AMBIGUITY_GROUPS[item.reason] ?? 'missing'
}

/**
 * Splits the preview into display groups, each ordered by insertion point in
 * this book and then by source rank, so sources interleave chapter by chapter.
 */
export function groupSupplementEntries(
  targetChapters: Chapter[],
  donorChaptersById: ReadonlyMap<string, Chapter[] | undefined>,
  preview: Pick<WebSourceSupplementPreview, 'donors' | 'candidates' | 'ambiguous'>,
): Record<SupplementEntryGroup, SupplementEntry[]> {
  const donorRank = new Map(preview.donors.map((donor, rank) => [donor.bookId, rank]))
  const sorted: Array<{ entry: SupplementEntry; group: SupplementEntryGroup; position: number; rank: number }> = []
  for (const gap of buildCandidateGaps(targetChapters, donorChaptersById, preview.candidates)) {
    sorted.push({
      entry: { kind: 'gap', key: `gap:${gap.key}`, gap },
      group: 'missing',
      position: gap.atEnd ? targetChapters.length : gap.insertAfterIndex,
      rank: donorRank.get(gap.donorBookId) ?? donorRank.size,
    })
  }
  preview.ambiguous.forEach((item, index) => {
    // afterTitle is the insert-after anchor; null means before the book's first chapter.
    const found = item.afterTitle === null ? -1 : targetChapters.findIndex(chapter => chapter.title === item.afterTitle)
    sorted.push({
      entry: { kind: 'ambiguity', key: `ambiguity:${index}`, item, rows: buildAmbiguityRows(targetChapters, item) },
      group: ambiguityGroup(item),
      position: item.afterTitle !== null && found < 0 ? Infinity : found,
      rank: donorRank.get(item.donorBookId) ?? donorRank.size,
    })
  })
  sorted.sort((a, b) => a.position - b.position || a.rank - b.rank)

  const groups: Record<SupplementEntryGroup, SupplementEntry[]> = { missing: [], renamed: [], present: [] }
  for (const { entry, group } of sorted) groups[group].push(entry)
  return groups
}
