import { describe, expect, it } from 'vitest'
import { remapWebChapterPosition } from '../utils/webSourceUtils.js'

describe('remapWebChapterPosition', () => {
  it('keeps the same chapter after an insertion by stable chapter key', () => {
    const oldChapters = [
      { index: 0, title: '第一章', chapterKey: 'fixture:1', sourceUrl: 'https://old.test/1' },
      { index: 1, title: '第二章', chapterKey: 'fixture:2', sourceUrl: 'https://old.test/2' },
    ]
    const newChapters = [
      { index: 0, title: '序章', chapterKey: 'fixture:0', sourceUrl: 'https://new.test/0' },
      { index: 1, title: '第一章', chapterKey: 'fixture:1', sourceUrl: 'https://new.test/1' },
      { index: 2, title: '第二章', chapterKey: 'fixture:2', sourceUrl: 'https://new.test/2' },
    ]

    expect(remapWebChapterPosition(oldChapters, newChapters, 1)).toEqual({
      position: 2,
      matchedBy: 'chapter_key',
    })
  })

  it('falls back to a unique canonical source URL for legacy manifests', () => {
    const oldChapters = [
      { index: 0, title: '第一章', sourceUrl: 'https://example.test/1#old' },
    ]
    const newChapters = [
      { index: 0, title: '序章', chapterKey: 'fixture:0', sourceUrl: 'https://example.test/0' },
      { index: 1, title: '第一章', chapterKey: 'fixture:1', sourceUrl: 'https://example.test/1' },
    ]

    expect(remapWebChapterPosition(oldChapters, newChapters, 0)).toEqual({
      position: 1,
      matchedBy: 'source_url',
    })
  })

  it('does not use an ambiguous duplicate key', () => {
    const oldChapters = [
      { index: 0, title: '第一章', chapterKey: 'duplicate', sourceUrl: 'https://old.test/1' },
      { index: 1, title: '第二章', chapterKey: 'duplicate', sourceUrl: 'https://old.test/2' },
    ]
    const newChapters = [
      { index: 0, title: '第一章', chapterKey: 'duplicate', sourceUrl: 'https://new.test/1' },
      { index: 1, title: '第二章', chapterKey: 'duplicate', sourceUrl: 'https://new.test/2' },
    ]

    expect(remapWebChapterPosition(oldChapters, newChapters, 1)).toEqual({
      position: 1,
      matchedBy: 'position',
    })
  })

  it('clamps position and never guesses from a matching title', () => {
    const oldChapters = [
      { index: 0, title: '第一章', chapterKey: 'old:1', sourceUrl: 'https://old.test/1' },
      { index: 1, title: '第二章', chapterKey: 'old:2', sourceUrl: 'https://old.test/2' },
      { index: 2, title: '相同標題', chapterKey: 'old:3', sourceUrl: 'https://old.test/3' },
    ]
    const newChapters = [
      { index: 0, title: '相同標題', chapterKey: 'new:1', sourceUrl: 'https://new.test/1' },
    ]

    expect(remapWebChapterPosition(oldChapters, newChapters, 2)).toEqual({
      position: 0,
      matchedBy: 'position',
    })
  })
})
