import { describe, it, expect, vi } from 'vitest'

vi.mock('../api.js')

import {
  resolveScrollTarget,
  buildChapterTextMap,
  getChapterTextTarget,
  makeChapterProgress,
  decideProgressMerge,
  preserveParagraphs,
  mergeHardWrappedParagraphs,
  splitParagraphs,
  stripMatchingChapterHeading,
  formatChapterTitle,
  formatParagraphForDisplay,
  getChapters,
  getCurrentChapterIndex,
  clampChapterIndex,
  progressToChapterIndex,
  getChapterProgressRatio,
  normalizeSettings,
  shouldMergeHardWrap,
  getChineseConverter,
  applyContentFilters,
  DEFAULT_SETTINGS,
  estimateParagraphHeight,
} from '../utils/readerUtils.js'

describe('chapter text anchors', () => {
  it('restores the same non-whitespace character after regrouping', () => {
    const chapters = [{ index: 0, title: '第一章' }]
    const paragraphs = ['第一章', '　甲 乙', '丙丁']
    const map = buildChapterTextMap(chapters, paragraphs)
    const progress = makeChapterProgress(0, 2, 1, map)
    expect(progress).toEqual({ positionType: 'chapter_index', positionValue: 0, chapterOffset: 3, chapterProgress: 0.75 })
    expect(getChapterTextTarget(progress, chapters, ['第一章', '甲乙 丙丁'])).toEqual({ index: 1, characterOffset: 4 })
  })

  it('includes the first paragraph of a book without chapter headings', () => {
    const chapters = [{ index: 0, title: '開頭' }]
    const paragraphs = ['甲乙丙丁', '戊己']
    const map = buildChapterTextMap(chapters, paragraphs)
    expect(makeChapterProgress(0, 0, 2, map).chapterProgress).toBeCloseTo(1 / 3)
    expect(getChapterTextTarget({ positionType: 'chapter_index', positionValue: 0, chapterOffset: 2 }, chapters, paragraphs, map))
      .toEqual({ index: 0, characterOffset: 2 })
  })

  it('excludes arbitrary web chapter headings and clamps an offset inside its chapter', () => {
    const chapters = [{ index: 0, title: '序幕' }, { index: 3, title: '後記' }]
    const paragraphs = ['序幕', '甲乙', '丙丁', '後記', '戊己']
    const map = buildChapterTextMap(chapters, paragraphs)
    expect(makeChapterProgress(0, 2, 0, map).chapterOffset).toBe(2)
    expect(getChapterTextTarget({ positionType: 'chapter_index', positionValue: 0, chapterOffset: 2 }, chapters, paragraphs, map))
      .toEqual({ index: 2, characterOffset: 0 })
    expect(getChapterTextTarget({ positionType: 'chapter_index', positionValue: 0, chapterOffset: 999 }, chapters, paragraphs, map))
      .toEqual({ index: 2, characterOffset: 2 })
    expect(getChapterTextTarget({ positionType: 'chapter_index', positionValue: 0, chapterOffset: 0 }, chapters, paragraphs, map))
      .toEqual({ index: 0, characterOffset: 0 })
  })

  it('uses UTF-16 offsets consistently for supplementary characters', () => {
    const chapters = [{ index: 0, title: '第一章' }]
    const paragraphs = ['第一章', '甲😀乙']
    const map = buildChapterTextMap(chapters, paragraphs)
    const progress = makeChapterProgress(0, 1, 3, map)
    expect(progress.chapterOffset).toBe(3)
    expect(progress.chapterProgress).toBe(0.75)
    expect(getChapterTextTarget(progress, chapters, paragraphs, map)).toEqual({ index: 1, characterOffset: 3 })
  })

  it('supports a ratio-only fallback and an empty chapter body', () => {
    const chapters = [{ index: 0, title: '第一章' }]
    expect(getChapterTextTarget({ positionType: 'chapter_index', positionValue: 0, chapterProgress: 0.5 },
      chapters, ['第一章', '甲乙', '丙丁'])).toEqual({ index: 2, characterOffset: 0 })
    const empty = buildChapterTextMap(chapters, ['第一章'])
    expect(makeChapterProgress(0, 0, 2, empty).chapterProgress).toBe(0)
    expect(getChapterTextTarget({ positionType: 'chapter_index', positionValue: 0, chapterOffset: 10 },
      chapters, ['第一章'], empty)).toEqual({ index: 0, characterOffset: 0 })
  })
})

describe('resolveScrollTarget', () => {
  it('resolves chapter_index to paragraph index', () => {
    const chapters = [{ index: 0, title: '開頭' }, { index: 5, title: '第一章' }]
    expect(resolveScrollTarget({ positionType: 'chapter_index', positionValue: 1 }, chapters, 10)).toBe(5)
  })

  it('resolves a chapter text offset after hard-wrap regrouping', () => {
    const chapters = [{ index: 0, title: '第一章' }, { index: 3, title: '第二章' }]
    const progress = { positionType: 'chapter_index', positionValue: 0, chapterOffset: 5, chapterProgress: 0.625 }
    expect(resolveScrollTarget(progress, chapters, 5, ['第一章', '甲乙丙丁', '戊己庚辛', '第二章', '尾聲'])).toBe(2)
    expect(resolveScrollTarget(progress, [{ index: 0, title: '第一章' }, { index: 2, title: '第二章' }], 4,
      ['第一章', '甲乙丙丁戊己庚辛', '第二章', '尾聲'])).toBe(1)
  })

  it('returns null when chapter_index exceeds chapters length', () => {
    const chapters = [{ index: 0, title: '開頭' }]
    expect(resolveScrollTarget({ positionType: 'chapter_index', positionValue: 5 }, chapters, 10)).toBeNull()
  })

  it('resolves paragraph_index directly', () => {
    const chapters = [{ index: 0, title: '開頭' }]
    expect(resolveScrollTarget({ positionType: 'paragraph_index', positionValue: 3 }, chapters, 10)).toBe(3)
  })
})

describe('preserveParagraphs', () => {
  it('strips up to 2 leading fullwidth spaces (　) from each paragraph', () => {
    const result = preserveParagraphs('　　第一段\n\n　第二段\n\n第三段')
    expect(result).toEqual(['第一段', '第二段', '第三段'])
  })

  it('strips up to 2 leading regular ASCII spaces', () => {
    const result = preserveParagraphs('  第一段\n\n 第二段')
    expect(result).toEqual(['第一段', '第二段'])
  })

  it('strips at most 2 spaces even when 3 or more are present', () => {
    expect(preserveParagraphs('　　　三個全形')).toEqual(['　三個全形'])
    expect(preserveParagraphs('   三個半形')).toEqual([' 三個半形'])
  })

  it('preserves dialogue lines and non-space leading characters unchanged', () => {
    const result = preserveParagraphs('「對話段落」\n\n普通段落')
    expect(result).toEqual(['「對話段落」', '普通段落'])
  })

  it('allows chapter headings with leading spaces to be stripped so chapter detection works', () => {
    const result = preserveParagraphs('　第一章 開始\n\n內文')
    expect(result).toEqual(['第一章 開始', '內文'])
  })

  it('filters out empty/whitespace-only paragraphs', () => {
    expect(preserveParagraphs('段落一\n\n\n\n段落二')).toEqual(['段落一', '段落二'])
    expect(preserveParagraphs('\n\n段落\n\n')).toEqual(['段落'])
  })

  it('handles mixed leading space types', () => {
    const result = preserveParagraphs('　 混合空格段落')
    expect(result).toEqual(['混合空格段落'])
  })
})

describe('mergeHardWrappedParagraphs', () => {
  it('joins consecutive lines within the same block', () => {
    expect(mergeHardWrappedParagraphs('一\n二\n三')).toEqual(['一二三'])
  })

  it('keeps blocks separated by blank lines apart', () => {
    expect(mergeHardWrappedParagraphs('一\n二\n\n三\n四')).toEqual(['一二', '三四'])
  })

  it('keeps chapter headings on their own line even within a block', () => {
    expect(mergeHardWrappedParagraphs('引子\n第一章\n內文一\n內文二'))
      .toEqual(['引子', '第一章', '內文一內文二'])
  })

  it('keeps dialogue lines (「『 etc.) as separate paragraphs', () => {
    expect(mergeHardWrappedParagraphs('「對話」\n旁白一\n旁白二'))
      .toEqual(['「對話」', '旁白一旁白二'])
  })
})

describe('splitParagraphs', () => {
  it('uses preserveParagraphs when merge=false', () => {
    expect(splitParagraphs('一\n二\n三', false)).toEqual(['一', '二', '三'])
  })

  it('uses mergeHardWrappedParagraphs when merge=true', () => {
    expect(splitParagraphs('一\n二\n三', true)).toEqual(['一二三'])
  })

  // Real TXT layout: one paragraph per line, indented, no blank lines in between.
  const linePerParagraph = [
    '　　李妙真笑了笑，指着许七安：“主办官就是他。”',
    '　　原来如此.......赵晋再无半点怀疑，激动的抱拳，压低声音：',
    '　　“许大人，您是赵某最敬佩的人。”',
    '　　这个梗过不去了是吧？',
    '　　许七安险些捂住脸，让许七安无地自容。',
  ].join('\r\n')
  // Hard-wrapped layout: paragraphs broken mid-sentence at a fixed width.
  const hardWrapped = [
    '　　李妙真笑了笑，指着许七安说主办官就是他，为了能暗中',
    '调查案子，他途中脱离使团，秘密潜入北境。赵晋再无半点',
    '怀疑，激动的抱拳。',
    '　　许七安险些捂住脸，因为当事人之一的李妙真，朝他投来',
    '了鄙夷的目光，让许七安无地自容，这人永远喜欢吹嘘，臭',
    '毛病改不掉。',
  ].join('\n')

  it('keeps an indented chapter heading on its own when merging indented paragraphs', () => {
    expect(splitParagraphs('　　第一章 開始\n　　他走了\n進來。', true)).toEqual(['第一章 開始', '他走了進來。'])
  })

  it('keeps one paragraph per line when detecting and the lines are whole paragraphs', () => {
    expect(splitParagraphs(linePerParagraph, 'detect')).toHaveLength(5)
  })

  it('merges hard-wrapped lines when detecting and the lines break mid-sentence', () => {
    expect(splitParagraphs(hardWrapped, 'detect')).toEqual([
      '李妙真笑了笑，指着许七安说主办官就是他，为了能暗中调查案子，他途中脱离使团，秘密潜入北境。赵晋再无半点怀疑，激动的抱拳。',
      '许七安险些捂住脸，因为当事人之一的李妙真，朝他投来了鄙夷的目光，让许七安无地自容，这人永远喜欢吹嘘，臭毛病改不掉。',
    ])
  })
})

describe('stripMatchingChapterHeading', () => {
  it('removes a cached Arabic-numeral heading that matches Chinese-numeral metadata', () => {
    expect(stripMatchingChapterHeading(
      '第一千兩百六十七章 麥斯福特之死',
      '第1267章 麥斯福特之死神秘人告訴麥斯福特死了。',
    )).toBe('神秘人告訴麥斯福特死了。')
  })

  it('preserves a heading whose chapter ordinal does not match the metadata', () => {
    expect(stripMatchingChapterHeading(
      '第一千兩百六十七章 麥斯福特之死',
      '第1268章 疑點重重',
    )).toBe('第1268章 疑點重重')
  })

  it('removes a source heading with ordinal drift when its chapter name still matches', () => {
    expect(stripMatchingChapterHeading(
      '第139章 新年快樂',
      '第140章 新年快樂\n\n趙英珺送上新年祝福。',
    )).toBe('趙英珺送上新年祝福。')
  })

  it('preserves headings when the ordinal is not a safe integer', () => {
    const heading = '第999999999999999999999章 異常資料'
    expect(stripMatchingChapterHeading(heading, heading)).toBe(heading)
  })
})

describe('formatChapterTitle', () => {
  it('separates chapter prefix and name with single space', () => {
    expect(formatChapterTitle('第一章開端')).toBe('第一章 開端')
  })

  it('leaves title alone when prefix-only', () => {
    expect(formatChapterTitle('第一章')).toBe('第一章')
  })

  it('returns text as-is when not a chapter heading', () => {
    expect(formatChapterTitle('普通段落')).toBe('普通段落')
  })
})

describe('formatParagraphForDisplay', () => {
  it('only reformats chapter-pattern paragraphs', () => {
    expect(formatParagraphForDisplay('第二回開始')).toBe('第二回 開始')
    expect(formatParagraphForDisplay('一般文字')).toBe('一般文字')
  })
})

describe('getChapters', () => {
  it('returns 開頭 chapter when no chapter pattern matched', () => {
    expect(getChapters(['你好', '世界'])).toEqual([{ index: 0, title: '開頭' }])
  })

  it('detects chapter headings and their paragraph index', () => {
    const result = getChapters(['第一章 一', '正文', '第二章 二', '更多正文'])
    expect(result.map(c => c.index)).toEqual([0, 2])
  })

  it('detects chapter ordinals written with traditional or simplified two', () => {
    expect(getChapters(['第兩百章 開始', '正文'])).toEqual([
      { index: 0, title: '第兩百章 開始' },
    ])
    expect(getChapters(['第两百零三章 繼續', '正文'])).toEqual([
      { index: 0, title: '第两百零三章 繼續' },
    ])
  })
})

describe('getCurrentChapterIndex / clampChapterIndex', () => {
  const chapters = [
    { index: 0, title: '一' },
    { index: 5, title: '二' },
    { index: 10, title: '三' },
  ]

  it('returns the last chapter whose index ≤ paragraphIndex', () => {
    expect(getCurrentChapterIndex(chapters, 0)).toBe(0)
    expect(getCurrentChapterIndex(chapters, 4)).toBe(0)
    expect(getCurrentChapterIndex(chapters, 5)).toBe(1)
    expect(getCurrentChapterIndex(chapters, 999)).toBe(2)
  })

  it('clamps chapter index into [0, chapters.length-1]', () => {
    expect(clampChapterIndex(-5, chapters)).toBe(0)
    expect(clampChapterIndex(2, chapters)).toBe(2)
    expect(clampChapterIndex(99, chapters)).toBe(2)
  })

  it('handles empty chapter array safely', () => {
    expect(clampChapterIndex(5, [])).toBe(0)
  })
})

describe('progressToChapterIndex', () => {
  const chapters = [
    { index: 0, title: '一' },
    { index: 5, title: '二' },
    { index: 10, title: '三' },
  ]

  it('clamps chapter_index against chapters length', () => {
    expect(progressToChapterIndex({ positionType: 'chapter_index', positionValue: 99 }, chapters, 20)).toBe(2)
  })

  it('resolves paragraph_index to enclosing chapter', () => {
    expect(progressToChapterIndex({ positionType: 'paragraph_index', positionValue: 7 }, chapters, 20)).toBe(1)
  })
})

describe('getChapterProgressRatio', () => {
  it('returns 0 for a single-chapter book', () => {
    expect(getChapterProgressRatio(0, [{ index: 0, title: '開頭' }])).toBe(0)
  })

  it('returns clamped fraction of progress through chapters', () => {
    const chapters = [
      { index: 0, title: '一' }, { index: 1, title: '二' }, { index: 2, title: '三' },
    ]
    expect(getChapterProgressRatio(0, chapters)).toBeCloseTo(0)
    expect(getChapterProgressRatio(1, chapters)).toBeCloseTo(0.5)
    expect(getChapterProgressRatio(2, chapters)).toBeCloseTo(1)
    expect(getChapterProgressRatio(99, chapters)).toBeCloseTo(1)
  })
})

describe('normalizeSettings', () => {
  it('fills in missing fields from DEFAULT_SETTINGS', () => {
    const partial = { fontSizePx: 22 } as unknown as Parameters<typeof normalizeSettings>[0]
    const result = normalizeSettings(partial)
    expect(result.fontSizePx).toBe(22)
    expect(result.lineHeight).toBe(DEFAULT_SETTINGS.lineHeight)
    expect(result.tapScrollPercent).toBe(DEFAULT_SETTINGS.tapScrollPercent)
    expect(result.justifyText).toBe(DEFAULT_SETTINGS.justifyText)
    expect(result.contentFilters).toEqual(DEFAULT_SETTINGS.contentFilters)
  })

  it('preserves explicit non-null overrides', () => {
    const result = normalizeSettings({ ...DEFAULT_SETTINGS, justifyText: false, contentFilters: ['廣告'] })
    expect(result.justifyText).toBe(false)
    expect(result.contentFilters).toEqual(['廣告'])
  })
})

describe('applyContentFilters', () => {
  it('removes each configured literal string before paragraph splitting', () => {
    const result = applyContentFilters('正版內文[廣告]下一段\n請收藏本站正文', ['[廣告]', '請收藏本站'])
    expect(result).toBe('正版內文下一段\n正文')
  })

  it('ignores blank filter entries and treats regex metacharacters literally', () => {
    const result = applyContentFilters('A .* B\nC [ad] D', [' ', '.*', '[ad]'])
    expect(result).toBe('A  B\nC  D')
  })
})

describe('shouldMergeHardWrap', () => {
  const baseSettings = { ...DEFAULT_SETTINGS }

  it('honors explicit merge mode', () => {
    expect(shouldMergeHardWrap({ ...baseSettings, hardWrapMode: 'merge' }, true)).toBe(true)
    expect(shouldMergeHardWrap({ ...baseSettings, hardWrapMode: 'merge' }, false)).toBe(true)
  })

  it('honors explicit preserve mode', () => {
    expect(shouldMergeHardWrap({ ...baseSettings, hardWrapMode: 'preserve' }, true)).toBe(false)
    expect(shouldMergeHardWrap({ ...baseSettings, hardWrapMode: 'preserve' }, false)).toBe(false)
  })

  it('decides from the text on desktop and preserves on mobile in auto mode', () => {
    expect(shouldMergeHardWrap({ ...baseSettings, hardWrapMode: 'auto' }, false)).toBe('detect')
    expect(shouldMergeHardWrap({ ...baseSettings, hardWrapMode: 'auto' }, true)).toBe(false)
  })
})

describe('getChineseConverter', () => {
  it('returns identity function when mode=none', () => {
    const fn = getChineseConverter('none')
    expect(fn('你好')).toBe('你好')
  })

  it('returns a function for traditional / simplified modes', () => {
    const tc = getChineseConverter('traditional')
    const sc = getChineseConverter('simplified')
    expect(typeof tc).toBe('function')
    expect(typeof sc).toBe('function')
  })
})

describe('decideProgressMerge', () => {
  const chapters = Array.from({ length: 40 }, (_, index) => ({ index: index * 10, title: `第${index + 1}章` }))
  const at = (chapterIndex: number, extra: Record<string, unknown> = {}) => ({
    positionType: 'chapter_index', positionValue: chapterIndex, chapterOffset: 100, chapterProgress: 0.1,
    updatedAt: '2026-10-09T00:00:00Z', ...extra,
  })
  const decide = (local: ReturnType<typeof at>, server: ReturnType<typeof at>) => decideProgressMerge({
    local, server, localChapterIndex: local.positionValue, serverChapterIndex: server.positionValue, chapters,
  })

  it('asks when the chapter gap is at least 10%, whatever the sync state', () => {
    expect(decide(at(0), at(10))).toEqual({ kind: 'conflict', reason: 'gap' })
    expect(decide(at(0, { pendingSync: false }), at(10))).toEqual({ kind: 'conflict', reason: 'gap' })
    expect(decide(at(10), at(0))).toEqual({ kind: 'conflict', reason: 'gap' })
  })

  it('asks when unsynced local progress is in an earlier chapter below the gap', () => {
    expect(decide(at(4, { pendingSync: true }), at(6))).toEqual({ kind: 'conflict', reason: 'offline-earlier' })
  })

  it('follows the cloud when the earlier local chapter was already synced or predates the sync flag', () => {
    expect(decide(at(4, { pendingSync: false }), at(6))).toEqual({ kind: 'auto', source: 'server' })
    expect(decide(at(4), at(6))).toEqual({ kind: 'auto', source: 'server' })
  })

  it('keeps a later local chapter below the gap', () => {
    expect(decide(at(6, { pendingSync: true }), at(4))).toEqual({ kind: 'auto', source: 'local' })
    expect(decide(at(6, { pendingSync: false }), at(4))).toEqual({ kind: 'auto', source: 'local' })
  })

  it('keeps this device\'s unsent position when the cloud still holds the position this device last confirmed', () => {
    // Read back a chapter (or far away) on this device; the upload never landed and nobody else wrote since.
    const confirmed = { positionType: 'chapter_index', positionValue: 6, chapterOffset: 100, chapterProgress: 0.1 }
    expect(decide(at(4, { pendingSync: true, syncedPosition: confirmed }), at(6))).toEqual({ kind: 'auto', source: 'local' })
    expect(decide(at(0, { pendingSync: true, syncedPosition: confirmed }), at(6))).toEqual({ kind: 'auto', source: 'local' })
    expect(decide(at(6, { pendingSync: true, chapterProgress: 0.6, syncedPosition: confirmed }), at(6, { updatedAt: '2026-10-10T00:00:00Z' })))
      .toEqual({ kind: 'auto', source: 'local' })
    // A shared position mapped from another edition carries no offset; index and ratio still identify it.
    const { chapterOffset: _offset, ...withoutOffset } = at(6)
    expect(decide(at(4, { pendingSync: true, syncedPosition: confirmed }), withoutOffset as ReturnType<typeof at>))
      .toEqual({ kind: 'auto', source: 'local' })
  })

  it('still asks when the cloud moved since this device last confirmed it', () => {
    const confirmed = { positionType: 'chapter_index', positionValue: 6, chapterOffset: 100, chapterProgress: 0.1 }
    expect(decide(at(4, { pendingSync: true, syncedPosition: confirmed }), at(7))).toEqual({ kind: 'conflict', reason: 'offline-earlier' })
    expect(decide(at(4, { pendingSync: true, syncedPosition: confirmed }), at(6, { chapterOffset: 300, chapterProgress: 0.3 })))
      .toEqual({ kind: 'conflict', reason: 'offline-earlier' })
    expect(decide(at(0, { pendingSync: true, syncedPosition: confirmed }), at(10))).toEqual({ kind: 'conflict', reason: 'gap' })
    // A synced row's own position is not a pending edit.
    expect(decide(at(4, { pendingSync: false, syncedPosition: confirmed }), at(6))).toEqual({ kind: 'auto', source: 'server' })
  })

  it('keeps the newer record within one chapter below the gap', () => {
    const older = '2026-10-08T00:00:00Z'
    expect(decide(at(4, { pendingSync: true, chapterProgress: 0.15 }), at(4, { updatedAt: older })))
      .toEqual({ kind: 'auto', source: 'local' })
    expect(decide(at(4, { pendingSync: true, chapterProgress: 0.05, updatedAt: older }), at(4)))
      .toEqual({ kind: 'auto', source: 'server' })
    expect(decide(at(4, { chapterProgress: 0.5 }), at(4, { chapterProgress: 0.1 })))
      .toEqual({ kind: 'conflict', reason: 'gap' })
  })
})

describe('estimateParagraphHeight', () => {
  // 18px CJK glyphs on a 360px line: 20 full-width characters per line, 32.4px per line.
  const layout = {
    contentWidthPx: 360, fontSizePx: 18, letterSpacingPx: 0, lineHeight: 1.8,
    paddingTopPx: 9, paddingBottomPx: 8, paragraphSpacingPx: 7, indentEm: 1,
  }
  const box = 9 + 8 + 7

  it('counts one line for a short paragraph', () => {
    expect(estimateParagraphHeight('「你還記得那年的事嗎？」他問。', layout)).toBeCloseTo(box + 32.4)
  })

  it('wraps full-width text by the column width, the first-line indent included', () => {
    // 19 glyphs + 1em indent fill one line exactly; the 20th glyph wraps.
    expect(estimateParagraphHeight('字'.repeat(19), layout)).toBeCloseTo(box + 32.4)
    expect(estimateParagraphHeight('字'.repeat(20), layout)).toBeCloseTo(box + 2 * 32.4)
    expect(estimateParagraphHeight('字'.repeat(100), layout)).toBeCloseTo(box + 6 * 32.4)
    expect(estimateParagraphHeight('字'.repeat(100), { ...layout, indentEm: 0 })).toBeCloseTo(box + 5 * 32.4)
  })

  it('treats ASCII as narrower than CJK and adds letter spacing to every glyph', () => {
    expect(estimateParagraphHeight('a'.repeat(60), layout)).toBeLessThan(estimateParagraphHeight('字'.repeat(60), layout))
    expect(estimateParagraphHeight('字'.repeat(19), { ...layout, letterSpacingPx: 2 })).toBeCloseTo(box + 2 * 32.4)
  })

  it('never returns less than one line for empty text or a degenerate width', () => {
    expect(estimateParagraphHeight('', layout)).toBeCloseTo(box + 32.4)
    expect(estimateParagraphHeight('字字', { ...layout, contentWidthPx: 0 })).toBeGreaterThan(box)
  })
})
