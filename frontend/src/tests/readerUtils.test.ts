import { describe, it, expect } from 'vitest'
import { resolveScrollTarget, preserveParagraphs } from '../utils/readerUtils.js'

describe('resolveScrollTarget', () => {
  it('resolves chapter_index to paragraph index', () => {
    const chapters = [{ index: 0, title: '開頭' }, { index: 5, title: '第一章' }]
    expect(resolveScrollTarget({ positionType: 'chapter_index', positionValue: 1 }, chapters, 10)).toBe(5)
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
