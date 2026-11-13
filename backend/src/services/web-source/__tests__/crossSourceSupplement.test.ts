import { describe, expect, it } from 'vitest'
import {
  END_OF_BOOK_ANCHOR_KEY,
  detectSupplementCandidates,
  isStoryChapterTitle,
  mergeSupplements,
  normalizeChapterName,
  type AlignChapter,
  type StoredSupplementPlacement,
} from '../crossSourceSupplement.js'

function chapters(prefix: string, titles: string[], extra: Partial<AlignChapter> = {}): AlignChapter[] {
  return titles.map((title, index) => ({
    index,
    title,
    url: `https://${prefix}.test/${index}`,
    chapterKey: `${prefix}:${index}`,
    ...extra,
  }))
}

describe('normalizeChapterName', () => {
  it('unifies variant characters across traditional and simplified-leaning sites', () => {
    const pairs: Array<[string, string]> = [
      ['第40章 爭鬥', '第四十章 爭斗'],
      ['第42章 亞聖和他的妻子', '第四十二章 亞圣和他的妻子'],
      ['第81章 綠光代表著什麽', '第八十一章 綠光代表著什么'],
      ['第84章 天地會終於有儒家學子', '第八十四章 天地會終于有儒家學子'],
      ['第87章 我隻想當一個安靜的美男子', '第八十七章 我只想當一個安靜的美男子'],
      ['第94章 凶殺案', '第九十四章 兇殺案'],
      ['第97章 風雲變色', '第九十七章 風云變色'],
      ['第136章 乾屍', '第一百三十五章 干尸'],
      ['第141章 恆慧現身', '第一百三十九章 恒慧現身'],
    ]
    for (const [a, b] of pairs) {
      expect(normalizeChapterName(a), `${a} vs ${b}`).toBe(normalizeChapterName(b))
    }
  })

  it('strips ordinals, update-count suffixes and sponsor notes but keeps part markers', () => {
    expect(normalizeChapterName('第28章 拍死我這隻螻蟻（第二更）'))
      .toBe(normalizeChapterName('第二十八章 拍死我這只螻蟻'))
    expect(normalizeChapterName('第149章 故事（一）為盟主“NeilLY”加更'))
      .toBe(normalizeChapterName('第一百四十七章 故事(一)為盟主“Neil_LY”'))
    expect(normalizeChapterName('第133章 夜談（為盟主“A狼老師”加更）')).toBe(normalizeChapterName('夜談'))
    expect(normalizeChapterName('第10章 【求月票】 夜談')).toBe(normalizeChapterName('夜談'))
    expect(normalizeChapterName('故事（一）')).not.toBe(normalizeChapterName('故事（二）'))
  })

  it('never treats the chapter ordinal as identity', () => {
    expect(normalizeChapterName('第103章 高於生命的東西'))
      .toBe(normalizeChapterName('第一百零二章 高于生命的東西'))
    expect(normalizeChapterName('第5章 甲')).not.toBe(normalizeChapterName('第5章 乙'))
  })

  it('strips a leading list index before the chapter ordinal and tolerates the 兩邊 typo', () => {
    expect(normalizeChapterName('588.第566章 七情（求月票）')).toBe(normalizeChapterName('第六十六章 七情'))
    expect(normalizeChapterName('765.第738章 晉升二品（二）')).toBe(normalizeChapterName('第九十九章 晉升二品(二)'))
    expect(normalizeChapterName('第兩邊二十一章 朝廷要犯')).toBe(normalizeChapterName('第224章 朝廷要犯'))
  })
})

describe('isStoryChapterTitle', () => {
  it('accepts ordinal story chapters and rejects author notes', () => {
    expect(isStoryChapterTitle('第133章 夜談（為盟主“A狼老師”加更）')).toBe(true)
    expect(isStoryChapterTitle('第一百零二章 高于生命的東西')).toBe(true)
    expect(isStoryChapterTitle('588.第566章 七情（求月票）')).toBe(true)
    for (const note of [
      '第98章 上架感言', '白銀盟感謝信', '寫個總結', '月末總結', '單章推書', '請假一天',
      '八月總結', '更新說明', '白銀盟感謝單章。', '精疲力盡的一天，寫一寫感言', '更新晚點。',
      '第64章 和大家聊聊這本書', '第90章 上架感言和爆更通知',
    ]) {
      expect(isStoryChapterTitle(note), note).toBe(false)
    }
  })
})

describe('detectSupplementCandidates', () => {
  it('offers an unmatched donor story chapter bracketed by name-matched anchors', () => {
    const primary = chapters('site-b', ['第一百三十章 甲', '第一百三十一章 乙', '第一百三十二章 丙'])
    const donor = chapters('site-a', [
      '第132章 甲', '第133章 夜談（為盟主“A狼老師”加更）', '寫個總結', '第134章 乙', '第135章 丙',
    ])
    const result = detectSupplementCandidates(primary, donor)
    expect(result.candidates).toEqual([expect.objectContaining({
      title: '第133章 夜談（為盟主“A狼老師”加更）',
      url: 'https://site-a.test/1',
      chapterKey: 'site-a:1',
      anchorAfter: { chapterKey: 'site-b:0', title: '第一百三十章 甲' },
      anchorBefore: { chapterKey: 'site-b:1', title: '第一百三十一章 乙' },
      seq: 0,
    })])
    expect(result.excludedNotes).toEqual(['寫個總結'])
    expect(result.ambiguous).toEqual([])
    expect(result.matchedCount).toBe(3)
  })

  it('reports renamed/replace blocks as ambiguous instead of supplementing', () => {
    const primary = chapters('site-b', ['第一百四十四章 前', '第一百四十五章 吃了師兄', '第一百四十六章 後'])
    const donor = chapters('site-a', ['第146章 前', '第147章 師弟想求你一件事', '第148章 後'])
    const result = detectSupplementCandidates(primary, donor)
    expect(result.candidates).toEqual([])
    expect(result.ambiguous).toEqual([expect.objectContaining({
      reason: 'renamed_or_variant',
      donorTitles: ['第147章 師弟想求你一件事'],
      primaryTitles: ['第一百四十五章 吃了師兄'],
    })])
  })

  it('provides two surrounding titles on each side of both manifests for uncertain placement', () => {
    const primary = chapters('a', ['第1章 甲', '第2章 乙', '第3章 本站異名', '第4章 丁', '第5章 戊', '第6章 己'])
    const donor = chapters('b', ['第1章 甲', '第2章 乙', '第3章 補源異名', '第4章 丁', '第5章 戊', '第6章 己'])
    expect(detectSupplementCandidates(primary, donor).ambiguous[0]).toMatchObject({
      primaryBefore: ['第1章 甲', '第2章 乙'], primaryAfter: ['第4章 丁', '第5章 戊'],
      donorBefore: ['第1章 甲', '第2章 乙'], donorAfter: ['第4章 丁', '第5章 戊'],
    })
    const edge = detectSupplementCandidates(primary, chapters('b', ['序章 起點', '第1章 甲', '第2章 乙']))
    expect(edge.ambiguous[0]).toMatchObject({ primaryBefore: [], donorBefore: [], donorAfter: ['第1章 甲', '第2章 乙'] })
  })

  it('does not supplement donor chapters outside the anchored range', () => {
    const primary = chapters('a', ['第一章 甲', '第二章 乙'])
    const donor = chapters('b', ['序章 楔子', '第1章 甲', '第2章 乙', '第3章 丙'])
    const result = detectSupplementCandidates(primary, donor)
    expect(result.candidates).toEqual([])
    expect(result.ambiguous.map((item) => [item.reason, item.donorTitles])).toEqual([
      ['unbracketed', ['序章 楔子']],
      ['unbracketed', ['第3章 丙']],
    ])
  })

  it('keeps several consecutive missing chapters in donor order', () => {
    const primary = chapters('a', ['第一章 甲', '第四章 丁'])
    const donor = chapters('b', ['第1章 甲', '第2章 乙', '第3章 丙', '第4章 丁'])
    const result = detectSupplementCandidates(primary, donor)
    expect(result.candidates.map((candidate) => [candidate.title, candidate.seq, candidate.anchorAfter.title]))
      .toEqual([['第2章 乙', 0, '第一章 甲'], ['第3章 丙', 1, '第一章 甲']])
  })

  it('reports a donor chapter whose name sits elsewhere in the primary as ambiguous, never a duplicate', () => {
    // Real 天才俱樂部 pattern: both sites carry 淺嘗輒止 but in crossing positions.
    const primary = chapters('hj', ['第50章 說謊', '第51章 唯一的未來', '第52章 甲', '第40章 淺嘗輒止', '第53章 乙'])
    const donor = chapters('uu', ['第470章 說謊', '第471章 淺嘗輒止（月票加更！）', '第472章 唯一的未來', '第473章 甲', '第474章 乙'])
    const result = detectSupplementCandidates(primary, donor)
    expect(result.candidates).toEqual([])
    expect(result.ambiguous).toEqual(expect.arrayContaining([expect.objectContaining({
      reason: 'name_elsewhere',
      donorTitles: ['第471章 淺嘗輒止（月票加更！）'],
      primaryTitles: ['第40章 淺嘗輒止'],
    })]))
  })

  it('offers a distinct same-name chapter when every primary chapter of that name is already matched', () => {
    // Real 大奉打更人 pattern: site-a has 第133章 夜談 and 第347章 夜談; site-b only the later one.
    const primary = chapters('hj', ['第一百三十一章 一夜致富', '第一百三十三章 蠱族', '第一百一十五章 前', '第一百一十六章 夜談', '第一百一十七章 後'])
    const donor = chapters('cz', ['第132章 一夜致富', '第133章 夜談（為盟主“A狼老師”加更）', '第134章 蠱族', '第346章 前', '第347章 夜談', '第348章 後'])
    const result = detectSupplementCandidates(primary, donor)
    expect(result.candidates.map((candidate) => [candidate.title, candidate.anchorAfter.title]))
      .toEqual([['第133章 夜談（為盟主“A狼老師”加更）', '第一百三十一章 一夜致富']])
  })

  it('treats an intra-donor repost with the same ordinal and name as ambiguous', () => {
    const primary = chapters('hj', ['第一章 甲', '第二章 七情', '第三章 乙', '第四章 丙'])
    const donor = chapters('cz', ['第1章 甲', '第2章 七情', '第3章 乙', '第2章 七情（求月票）', '第4章 丙'])
    const result = detectSupplementCandidates(primary, donor)
    expect(result.candidates).toEqual([])
    expect(result.ambiguous).toEqual([expect.objectContaining({ reason: 'name_elsewhere', donorTitles: ['第2章 七情（求月票）'] })])
  })

  it('never offers an ordinal-only donor chapter, since its empty name cannot be checked for duplicates', () => {
    // '第103章' normalizes to '': the primary's own nameless 第一百零三章 elsewhere
    // could be the same chapter, so offering it risks a duplicate insert.
    const primary = chapters('hj', ['第一章 甲', '第二章 乙', '第一百零三章'])
    const donor = chapters('cz', ['第1章 甲', '第103章', '第2章 乙'])
    const result = detectSupplementCandidates(primary, donor)
    expect(result.candidates).toEqual([])
    expect(result.ambiguous).toEqual([expect.objectContaining({
      reason: 'no_name', donorTitles: ['第103章'], primaryTitles: [], afterTitle: '第一章 甲',
    })])
  })

  it('lists what this book already has at the spot of an ordinal-only donor chapter', () => {
    // Real 大奉打更人 pattern: site-a has a nameless 第32章 and an earlier supplement
    // added site-b's 第三十二章 in the same spot.
    const primary = [
      ...chapters('cz', ['第31章 甲', '第三十二章']).map((chapter, i) => ({ ...chapter, isSupplement: i === 1 })),
      ...chapters('cz2', ['第32章', '第33章 乙']).map((chapter) => ({ ...chapter, index: chapter.index + 2 })),
    ]
    const donor = chapters('uu', ['第三十一章 甲', '第三十二章', '第三十三章 乙'])
    const result = detectSupplementCandidates(primary, donor)
    expect(result.ambiguous).toEqual([expect.objectContaining({
      reason: 'no_name', donorTitles: ['第三十二章'], primaryTitles: ['第三十二章', '第32章'], afterTitle: '第31章 甲',
    })])
  })

  it('does not depend on donor index values matching array positions', () => {
    const primary = chapters('a', ['第一章 甲', '第三章 丙'])
    const donor = chapters('b', ['第1章 甲', '第2章 乙', '第3章 丙']).map((chapter) => ({ ...chapter, index: chapter.index + 1 }))
    expect(detectSupplementCandidates(primary, donor).candidates.map((candidate) => candidate.title)).toEqual(['第2章 乙'])
  })

  describe('trailing extras (番外) after the last anchor', () => {
    // Real 大奉打更人 pattern: site-b ends at 完本感言, site-a continues with three 番外.
    const primary = chapters('hj', ['第一章 甲', '第二章 乙', '完本感言'])

    it('appends them at the end of the book, in donor order', () => {
      const donor = chapters('cz', ['第1章 甲', '第2章 乙', '完本感言', '第916章 番外一：劫後', '番外二：一統天下', '番外三 慶功宴'])
      const result = detectSupplementCandidates(primary, donor)
      expect(result.candidates.map((candidate) => [candidate.title, candidate.seq, candidate.anchorAfter.title, candidate.anchorBefore]))
        .toEqual([
          ['第916章 番外一：劫後', 0, '完本感言', null],
          ['番外二：一統天下', 1, '完本感言', null],
          ['番外三 慶功宴', 2, '完本感言', null],
        ])
      expect(result.ambiguous).toEqual([])
    })

    it('keeps a trailing block unbracketed when it holds a regular chapter (the primary may just be behind)', () => {
      const donor = chapters('cz', ['第1章 甲', '第2章 乙', '完本感言', '第3章 丙', '番外一 劫後'])
      const result = detectSupplementCandidates(primary, donor)
      expect(result.candidates).toEqual([])
      expect(result.ambiguous).toEqual([expect.objectContaining({ reason: 'unbracketed', donorTitles: ['第3章 丙', '番外一 劫後'] })])
    })

    it('keeps them unbracketed when the primary has unmatched chapters after its last anchor', () => {
      const withTail = chapters('hj', ['第一章 甲', '第二章 乙', '完本感言', '番外 另一個故事'])
      const donor = chapters('cz', ['第1章 甲', '第2章 乙', '完本感言', '番外一 劫後'])
      const result = detectSupplementCandidates(withTail, donor)
      expect(result.candidates).toEqual([])
      expect(result.ambiguous).toEqual([expect.objectContaining({
        reason: 'unbracketed', donorTitles: ['番外一 劫後'], primaryTitles: ['番外 另一個故事'],
      })])
    })

    it('never appends extras before the first anchor', () => {
      const donor = chapters('cz', ['番外 前傳', '第1章 甲', '第2章 乙', '完本感言'])
      const result = detectSupplementCandidates(primary, donor)
      expect(result.candidates).toEqual([])
      expect(result.ambiguous).toEqual([expect.objectContaining({ reason: 'unbracketed', donorTitles: ['番外 前傳'] })])
    })
  })

  it('does not re-offer chapters already supplemented or use supplements as anchors', () => {
    const primary = [
      ...chapters('a', ['第一章 甲']),
      { index: 1, title: '第2章 乙', url: 'https://b.test/1', chapterKey: 'b:1', isSupplement: true },
      { index: 2, title: '第三章 丙', url: 'https://a.test/1', chapterKey: 'a:1' },
    ]
    const donor = chapters('b', ['第1章 甲', '第2章 乙', '第3章 丙'])
    const result = detectSupplementCandidates(primary, donor)
    expect(result.candidates).toEqual([])
    expect(result.ambiguous).toEqual([])
  })
})

describe('mergeSupplements', () => {
  const primary = chapters('a', ['第一章 甲', '第二章 乙', '第三章 丙'])
  const supplement = (overrides: Partial<StoredSupplementPlacement> = {}): StoredSupplementPlacement => ({
    id: 's1',
    title: '第2章 夜談',
    url: 'https://b.test/9',
    chapterKey: 'b:9',
    anchorAfterKey: 'a:0',
    anchorBeforeKey: 'a:1',
    ...overrides,
  })

  it('places an explicitly selected preface before the first chapter', () => {
    const result = mergeSupplements(primary, [supplement({
      title: '序章 前傳', anchorAfterKey: '\u0000start', anchorBeforeKey: 'a:0',
    })])
    expect(result.chapters.map(chapter => chapter.title)).toEqual([
      '序章 前傳', '第一章 甲', '第二章 乙', '第三章 丙',
    ])
  })

  it('splices supplements after their anchor and reindexes the manifest', () => {
    const result = mergeSupplements(primary, [supplement()])
    expect(result.chapters.map((chapter) => [chapter.index, chapter.title, chapter.chapterKey])).toEqual([
      [0, '第一章 甲', 'a:0'],
      [1, '第2章 夜談', 'b:9'],
      [2, '第二章 乙', 'a:1'],
      [3, '第三章 丙', 'a:2'],
    ])
    expect(result.placed).toEqual(['s1'])
    expect(result.unresolved).toEqual([])
    expect(result.retired).toEqual([])
  })

  it('keeps supplements out of the manifest but reports them when the anchor vanished', () => {
    const result = mergeSupplements(primary, [supplement({ anchorAfterKey: 'a:gone' })])
    expect(result.chapters).toHaveLength(3)
    expect(result.unresolved).toEqual([{ id: 's1', reason: 'anchor_missing' }])
  })

  it('does not retire by name when the anchor vanished, since same-name chapters can be distinct', () => {
    const other = [...primary, { index: 3, title: '第一百一十六章 夜談', url: 'https://a.test/far', chapterKey: 'a:far' }]
    const result = mergeSupplements(other, [supplement({ title: '第133章 夜談', anchorAfterKey: 'a:gone' })])
    expect(result.retired).toEqual([])
    expect(result.unresolved).toEqual([{ id: 's1', reason: 'anchor_missing' }])
  })

  it('reports a changed gap as unresolved rather than guessing the order', () => {
    const changed = [primary[0], { index: 1, title: '第一章半 新章', url: 'https://a.test/x', chapterKey: 'a:x' }, primary[1], primary[2]]
    const result = mergeSupplements(changed, [supplement()])
    expect(result.unresolved).toEqual([{ id: 's1', reason: 'anchor_gap_changed' }])
  })

  it('retires a supplement once the primary source contains the chapter by name', () => {
    const fixed = [primary[0], { index: 1, title: '第二章 夜談', url: 'https://a.test/n', chapterKey: 'a:n' }, primary[1], primary[2]]
    const result = mergeSupplements(fixed, [supplement()])
    expect(result.chapters.map((chapter) => chapter.chapterKey)).toEqual(['a:0', 'a:n', 'a:1', 'a:2'])
    expect(result.retired).toEqual([{ id: 's1', matchedTitle: '第二章 夜談' }])
  })

  describe('end-of-book supplements (anchorBeforeKey = END_OF_BOOK_ANCHOR_KEY)', () => {
    const tail = (overrides: Partial<StoredSupplementPlacement> = {}) => supplement({
      id: 't1', title: '番外一 劫後', url: 'https://b.test/x1', chapterKey: 'b:x1',
      anchorAfterKey: 'a:2', anchorBeforeKey: END_OF_BOOK_ANCHOR_KEY, ...overrides,
    })

    it('appends after its anchor while that anchor is still the last chapter', () => {
      const result = mergeSupplements(primary, [tail(), tail({ id: 't2', title: '番外二', url: 'https://b.test/x2', chapterKey: 'b:x2' })])
      expect(result.chapters.map((chapter) => [chapter.index, chapter.chapterKey]))
        .toEqual([[0, 'a:0'], [1, 'a:1'], [2, 'a:2'], [3, 'b:x1'], [4, 'b:x2']])
      expect(result.placed).toEqual(['t1', 't2'])
    })

    it('reports it unresolved once the primary grows past the anchor', () => {
      const grown = [...primary, { index: 3, title: '第四章 新', url: 'https://a.test/3', chapterKey: 'a:3' }]
      expect(mergeSupplements(grown, [tail()]).unresolved).toEqual([{ id: 't1', reason: 'anchor_gap_changed' }])
    })

    it('retires it once the primary carries the same extra after the anchor', () => {
      const grown = [...primary, { index: 3, title: '番外一：劫後', url: 'https://a.test/3', chapterKey: 'a:3' }]
      expect(mergeSupplements(grown, [tail()]).retired).toEqual([{ id: 't1', matchedTitle: '番外一：劫後' }])
    })
  })
})
