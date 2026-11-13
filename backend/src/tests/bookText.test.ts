import { describe, it, expect } from 'vitest'
import { detectChapters, splitParagraphs } from '../utils/bookText.js'

describe('splitParagraphs', () => {
  it('starts a new paragraph at an indented line, like the reader does', () => {
    const text = '　　第一章 開始\n　　他走了\n進來。\n　　她也來了。'
    expect(splitParagraphs(text)).toEqual(['第一章 開始', '他走了進來。', '她也來了。'])
    expect(detectChapters(splitParagraphs(text))).toHaveLength(1)
  })
})
