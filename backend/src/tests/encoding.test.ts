import { describe, it, expect } from 'vitest'
import iconv from 'iconv-lite'
import { detectAndConvert } from '../utils/encoding.js'

describe('detectAndConvert', () => {
  it('strips UTF-8 BOM and returns UTF-8 text', () => {
    const text = '你好世界'
    const utf8Bytes = Buffer.from(text, 'utf-8')
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    const withBom = Buffer.concat([bom, utf8Bytes])
    const result = detectAndConvert(withBom)
    expect(result).toBe(text)
  })

  it('returns pure UTF-8 text as-is', () => {
    const text = 'Hello, world! 你好'
    const buf = Buffer.from(text, 'utf-8')
    const result = detectAndConvert(buf)
    expect(result).toBe(text)
  })

  it('correctly decodes Big5 encoded Chinese text', () => {
    const chineseText = '你好世界'
    const big5Buf = iconv.encode(chineseText, 'Big5')
    const result = detectAndConvert(big5Buf)
    // Should decode back to correct Chinese characters
    expect(result).toBe(chineseText)
  })

  it('returns a string without throwing for random bytes (fallback)', () => {
    const randomBytes = Buffer.from([0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0xfe, 0xff])
    expect(() => detectAndConvert(randomBytes)).not.toThrow()
    const result = detectAndConvert(randomBytes)
    expect(typeof result).toBe('string')
  })
})
