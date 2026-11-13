import { describe, it, expect } from 'vitest'
import { decodeHtmlEntities } from '../utils/htmlEntities.js'
import { splitParagraphs, detectChapters } from '../utils/bookText.js'

describe('decodeHtmlEntities', () => {
  it('decodes the small set of always-supported named entities', () => {
    expect(decodeHtmlEntities('Tom &amp; Jerry')).toBe('Tom & Jerry')
    expect(decodeHtmlEntities('&lt;a&gt;')).toBe('<a>')
    expect(decodeHtmlEntities('he said &quot;hi&quot;')).toBe('he said "hi"')
    expect(decodeHtmlEntities('don&#39;t')).toBe("don't")
    expect(decodeHtmlEntities('a&nbsp;b')).toBe('a b')
  })

  it('decodes Chinese-novel-common punctuation entities', () => {
    expect(decodeHtmlEntities('好&hellip;')).toBe('好…')
    expect(decodeHtmlEntities('&ldquo;你好&rdquo;')).toBe('“你好”')
    expect(decodeHtmlEntities('&lsquo;a&rsquo;')).toBe('‘a’')
    expect(decodeHtmlEntities('a&ndash;b&mdash;c')).toBe('a–b—c')
    expect(decodeHtmlEntities('a&middot;b')).toBe('a·b')
  })

  it('decodes decimal and hex numeric entities', () => {
    expect(decodeHtmlEntities('&#20013;')).toBe('中')
    expect(decodeHtmlEntities('&#x4E2D;')).toBe('中')
    expect(decodeHtmlEntities('&#x4e2d;')).toBe('中')
    expect(decodeHtmlEntities('&#119;&#119;&#119;')).toBe('www')
  })

  it('is idempotent: a second pass does not change a fully decoded string', () => {
    const raw = 'Tom &amp; Jerry &hellip; &ldquo;你好&rdquo;'
    const once = decodeHtmlEntities(raw)
    const twice = decodeHtmlEntities(once)
    expect(twice).toBe(once)
  })

  it('leaves bare ampersands and non-entity tokens untouched', () => {
    expect(decodeHtmlEntities('A & B')).toBe('A & B')
    expect(decodeHtmlEntities('see &foo for details')).toBe('see &foo for details')
    expect(decodeHtmlEntities('AT&T')).toBe('AT&T')
  })

  it('does not touch text that contains no entities at all', () => {
    const text = '這是一本測試書。Hello world!'
    expect(decodeHtmlEntities(text)).toBe(text)
  })

  it('handles entities adjacent to CJK and whitespace correctly', () => {
    expect(decodeHtmlEntities('你好&hellip;再見')).toBe('你好…再見')
    expect(decodeHtmlEntities('  &amp;  ')).toBe('  &  ')
  })

  it('decodes mixed numeric + named in the same string', () => {
    expect(decodeHtmlEntities('w=&#119;, amp=&amp;, hellip=&hellip;')).toBe(
      'w=w, amp=&, hellip=…',
    )
  })

  it('does not touch unknown named entities (preserves source faithfully)', () => {
    // Better to leave alone than guess: lets backfill report unknown forms.
    expect(decodeHtmlEntities('&completelyunknown;')).toBe('&completelyunknown;')
  })

  it('decoding then splitParagraphs preserves chapter count for &nbsp;-only separator lines', () => {
    // splitParagraphs trims and filter(Boolean)s lines within a block.
    // A `&nbsp;`-only line decodes to a single space and gets dropped — but the
    // block boundary (\n{2,}) and chapter pattern (第X章) must stay intact.
    const raw = '第一章 開始\n&nbsp;\n內容一\n\n第二章 繼續\n內容二'
    const decoded = decodeHtmlEntities(raw)
    const paragraphs = splitParagraphs(decoded)
    const chapters = detectChapters(paragraphs)
    expect(chapters.length).toBe(2)
    expect(chapters[0].title.startsWith('第一章')).toBe(true)
    expect(chapters[1].title.startsWith('第二章')).toBe(true)
  })

  it('recognizes chapter ordinals written with traditional or simplified two', () => {
    expect(detectChapters(splitParagraphs('第兩百章 開始\n\n內文'))).toHaveLength(1)
    expect(detectChapters(splitParagraphs('第两百零三章 繼續\n\n內文'))).toHaveLength(1)
  })

  it('leaves out-of-range numeric entities untouched without throwing', () => {
    // String.fromCodePoint throws RangeError for code > 0x10FFFF.
    expect(() => decodeHtmlEntities('&#9999999999;')).not.toThrow()
    expect(decodeHtmlEntities('&#9999999999;')).toBe('&#9999999999;')
    expect(() => decodeHtmlEntities('&#xFFFFFFFF;')).not.toThrow()
    expect(decodeHtmlEntities('&#xFFFFFFFF;')).toBe('&#xFFFFFFFF;')
    // Surrogate-range code points are invalid standalone.
    expect(decodeHtmlEntities('&#xD800;')).toBe('&#xD800;')
    expect(decodeHtmlEntities('&#xDFFF;')).toBe('&#xDFFF;')
  })
})
