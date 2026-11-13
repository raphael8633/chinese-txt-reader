import { describe, expect, it } from 'vitest'
import { parseChapterOrdinal } from '../chapterOrdinal.js'

describe('parseChapterOrdinal', () => {
  it.each([
    ['第1302章 救人！', 1302],
    ['第一千三百零二章 救人！', 1302],
    ['第一千三百三十八章 驚變！', 1338],
    ['第兩百章', 200],
    ['第两百零三回', 203],
  ])('parses %s as %i', (title, expected) => {
    expect(parseChapterOrdinal(title)).toBe(expected)
  })

  it('does not infer an ordinal from ordinary prose', () => {
    expect(parseChapterOrdinal('今天有兩百個人')).toBeNull()
  })
})
