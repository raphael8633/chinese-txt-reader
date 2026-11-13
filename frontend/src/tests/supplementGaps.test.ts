import { describe, expect, it } from 'vitest'
import type { Chapter, WebSourceSupplementAmbiguity, WebSourceSupplementCandidate } from '../api.js'
import {
  buildAmbiguityRows, buildCandidateGaps, groupSupplementEntries, type GapRow, type SupplementEntry,
} from '../utils/supplementGaps.js'

const toc = (prefix: string, titles: string[]): Chapter[] =>
  titles.map((title, index) => ({ index, title, sourceUrl: `https://${prefix}.test/${index}` }))

const candidate = (overrides: Partial<WebSourceSupplementCandidate>): WebSourceSupplementCandidate => ({
  id: 'c', donorBookId: 'donor', donorProviderId: 'p', donorDisplayName: '補源站',
  title: '', url: '', insertAfterTitle: '', insertBeforeTitle: '', insertAfterIndex: 0, atEnd: false,
  ...overrides,
})

/** Renders rows as "left | right" with `·` for an empty slot, the way a user reads the panel. */
const view = (rows: GapRow[]) => rows.map(row => (
  `${row.kind}: ${row.left ? `${row.left.chapterNumber ?? '?'} ${row.left.title}` : '·'} | ${row.right ? `${row.right.chapterNumber ?? '?'} ${row.right.title}` : '·'}${row.candidateId ? ` [${row.candidateId}]` : ''}`
))

describe('buildCandidateGaps', () => {
  const target = toc('t', ['29', '30', '31', '33', '34', '35'])
  const donor = toc('d', ['29', '30', '31', '32', '33', '34', '35'])

  it('shows two chapters on each side of the gap and an empty slot where the target lacks the chapter', () => {
    const gaps = buildCandidateGaps(target, new Map([['donor', donor]]), [
      candidate({ id: 'c32', title: '32', url: 'https://d.test/3', insertAfterIndex: 2, insertAfterTitle: '31', insertBeforeTitle: '33' }),
    ])
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ donorBookId: 'donor', insertAfterIndex: 2, atEnd: false, candidateIds: ['c32'] })
    expect(view(gaps[0].rows)).toEqual([
      'before: 2 30 | 2 30',
      'before: 3 31 | 3 31',
      'current: · | 4 32 [c32]',
      'after: 4 33 | 5 33',
      'after: 5 34 | 6 34',
    ])
  })

  it('folds consecutive missing chapters from one donor into one gap and keeps a skipped donor chapter visible', () => {
    const wideDonor = toc('d', ['30', '31', '32', '感言', '32.5', '33', '34'])
    const gaps = buildCandidateGaps(target, new Map([['donor', wideDonor]]), [
      candidate({ id: 'a', title: '32', url: 'https://d.test/2', insertAfterIndex: 2 }),
      candidate({ id: 'b', title: '32.5', url: 'https://d.test/4', insertAfterIndex: 2 }),
    ])
    expect(gaps).toHaveLength(1)
    expect(gaps[0].candidateIds).toEqual(['a', 'b'])
    expect(view(gaps[0].rows).filter(line => line.startsWith('current'))).toEqual([
      'current: · | 3 32 [a]',
      'current: · | 4 感言',
      'current: · | 5 32.5 [b]',
    ])
  })

  it('keeps different insertion points and different donors as separate gaps, in candidate order', () => {
    const gaps = buildCandidateGaps(target, new Map([['donor', donor], ['other', donor]]), [
      candidate({ id: 'x', url: 'https://d.test/3', insertAfterIndex: 2 }),
      candidate({ id: 'y', url: 'https://d.test/3', insertAfterIndex: 2, donorBookId: 'other' }),
      candidate({ id: 'z', url: 'https://d.test/6', insertAfterIndex: 5, atEnd: true }),
    ])
    expect(gaps.map(gap => gap.candidateIds)).toEqual([['x'], ['y'], ['z']])
  })

  it('shows no after-context on the target side for a chapter appended at the end of the book', () => {
    const [gap] = buildCandidateGaps(toc('t', ['33', '34']), new Map([['donor', toc('d', ['33', '34', '番外'])]]), [
      candidate({ id: 'end', title: '番外', url: 'https://d.test/2', insertAfterIndex: 1, atEnd: true }),
    ])
    expect(view(gap.rows)).toEqual([
      'before: 1 33 | 1 33',
      'before: 2 34 | 2 34',
      'current: · | 3 番外 [end]',
    ])
  })

  it('still lists the candidate when the donor table of contents is unavailable', () => {
    const [gap] = buildCandidateGaps(target, new Map(), [
      candidate({ id: 'c32', title: '32', url: 'https://d.test/3', insertAfterIndex: 2 }),
    ])
    expect(view(gap.rows)).toEqual([
      'before: 2 30 | ·',
      'before: 3 31 | ·',
      'current: · | ? 32 [c32]',
      'after: 4 33 | ·',
      'after: 5 34 | ·',
    ])
  })
})

describe('buildAmbiguityRows', () => {
  const item = (overrides: Partial<WebSourceSupplementAmbiguity>): WebSourceSupplementAmbiguity => ({
    donorBookId: 'donor', donorDisplayName: '補源站', reason: 'renamed_or_variant',
    donorTitles: [], primaryTitles: [], afterTitle: null, ...overrides,
  })

  it('puts the target chapter at the uncertain spot next to the donor one, so a rename is visible', () => {
    const target = toc('t', ['29', '30', '31', '第32章 別名', '33', '34'])
    const rows = buildAmbiguityRows(target, item({
      afterTitle: '31', primaryBefore: ['30', '31'], primaryTitles: ['第32章 別名'], primaryAfter: ['33', '34'],
      donorBefore: ['30', '31'], donorTitles: ['第32章 原名'], donorAfter: ['33', '34'],
    }))
    expect(view(rows)).toEqual([
      'before: 2 30 | ? 30',
      'before: 3 31 | ? 31',
      'current: 4 第32章 別名 | ? 第32章 原名',
      'after: 5 33 | ? 33',
      'after: 6 34 | ? 34',
    ])
  })

  it('pads the shorter side so before, current and after rows stay aligned', () => {
    const target = toc('t', ['1', '2'])
    const rows = buildAmbiguityRows(target, item({
      reason: 'no_name', afterTitle: '1', primaryBefore: ['1'], primaryTitles: [], primaryAfter: ['2'],
      donorBefore: ['0', '1'], donorTitles: ['第103章', '第104章'], donorAfter: ['2'],
    }))
    expect(view(rows)).toEqual([
      'before: · | ? 0',
      'before: 1 1 | ? 1',
      'current: · | ? 第103章',
      'current: · | ? 第104章',
      'after: 2 2 | ? 2',
    ])
  })

  it('omits chapter numbers when the context cannot be located in the current table of contents', () => {
    const rows = buildAmbiguityRows(toc('t', ['甲', '乙']), item({
      primaryBefore: ['不在目錄'], primaryTitles: ['某章'], primaryAfter: [], donorTitles: ['某章'],
    }))
    expect(view(rows)).toEqual(['before: ? 不在目錄 | ·', 'current: ? 某章 | ? 某章'])
  })
})

describe('groupSupplementEntries', () => {
  const target = toc('t', ['1', '2', '3', '4', '5'])
  const donors = [
    { bookId: 'hj', providerId: 'site-b', displayName: '站點B', chapterCount: 0, matchedCount: 0 },
    { bookId: 'cz', providerId: 'site-a', displayName: '站點A', chapterCount: 0, matchedCount: 0 },
  ]
  const ambiguity = (overrides: Partial<WebSourceSupplementAmbiguity>): WebSourceSupplementAmbiguity => ({
    donorBookId: 'hj', donorDisplayName: '站點B', reason: 'no_name',
    donorTitles: [], primaryTitles: [], afterTitle: null, ...overrides,
  })
  /** One line per entry, as the panel lists them: where it goes and which source offers it. */
  const label = (entry: SupplementEntry) => entry.kind === 'gap'
    ? `gap ${entry.gap.atEnd ? 'end' : entry.gap.insertAfterIndex + 1} ${entry.gap.donorDisplayName}`
    : `${entry.item.reason} ${entry.item.afterTitle ?? 'start'} ${entry.item.donorDisplayName}`

  it('orders entries by position in this book first and by source second, so sources interleave', () => {
    const groups = groupSupplementEntries(target, new Map(), {
      donors,
      // The server lists one source after another.
      candidates: [
        candidate({ id: 'h1', donorBookId: 'hj', donorDisplayName: '站點B', insertAfterIndex: 0 }),
        candidate({ id: 'h3', donorBookId: 'hj', donorDisplayName: '站點B', insertAfterIndex: 2 }),
        candidate({ id: 'c4', donorBookId: 'cz', donorDisplayName: '站點A', insertAfterIndex: 4, atEnd: true }),
        candidate({ id: 'c2', donorBookId: 'cz', donorDisplayName: '站點A', insertAfterIndex: 1 }),
      ],
      ambiguous: [
        ambiguity({ afterTitle: '4' }),
        ambiguity({ afterTitle: '不在目錄' }),
        ambiguity({ donorBookId: 'cz', donorDisplayName: '站點A', reason: 'conflicting_donors', afterTitle: '1' }),
        ambiguity({ donorBookId: 'cz', donorDisplayName: '站點A', afterTitle: null }),
      ],
    })
    expect(groups.missing.map(label)).toEqual([
      'no_name start 站點A',
      'gap 1 站點B',
      'conflicting_donors 1 站點A',
      'gap 2 站點A',
      'gap 3 站點B',
      'no_name 4 站點B',
      'gap end 站點A',
      'no_name 不在目錄 站點B',
    ])
  })

  it('shows only missing chapters up front and folds renamed and already-present spots apart', () => {
    const groups = groupSupplementEntries(target, new Map(), {
      donors,
      candidates: [],
      ambiguous: [
        ambiguity({ reason: 'renamed_or_variant', afterTitle: '3', primaryTitles: ['4'] }),
        ambiguity({ reason: 'unbracketed', afterTitle: '5' }),
        ambiguity({ reason: 'unbracketed', afterTitle: null, primaryTitles: ['1'] }),
        ambiguity({ reason: 'mixed_with_supplement', afterTitle: '2', primaryTitles: ['補'] }),
        ambiguity({ reason: 'pending_supplement', afterTitle: '1' }),
        ambiguity({ reason: 'name_elsewhere', afterTitle: '4', primaryTitles: ['2'] }),
        ambiguity({ reason: 'no_name', afterTitle: '2', primaryTitles: ['3'] }),
        ambiguity({ reason: 'no_name', afterTitle: '3' }),
        ambiguity({ reason: 'renamed_or_variant', afterTitle: '1', donorBookId: 'cz', donorDisplayName: '站點A', primaryTitles: ['2'] }),
      ],
    })
    expect(groups.missing.map(label)).toEqual(['no_name 3 站點B', 'unbracketed 5 站點B'])
    expect(groups.renamed.map(label)).toEqual([
      'unbracketed start 站點B',
      'renamed_or_variant 1 站點A',
      'renamed_or_variant 3 站點B',
    ])
    expect(groups.present.map(label)).toEqual([
      'pending_supplement 1 站點B',
      'mixed_with_supplement 2 站點B',
      'no_name 2 站點B',
      'name_elsewhere 4 站點B',
    ])
  })
})
