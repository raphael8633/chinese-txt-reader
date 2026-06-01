import iconv from 'iconv-lite'
import jschardet from 'jschardet'

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

export function detectAndConvert(buffer: Buffer): string {
  // 1. Strip UTF-8 BOM if present
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(UTF8_BOM)) {
    return buffer.subarray(3).toString('utf-8')
  }

  // 2. Try UTF-8; if no replacement chars, return as-is
  const utf8Attempt = buffer.toString('utf-8')
  if (!utf8Attempt.includes('�')) {
    return utf8Attempt
  }

  // 3. Use jschardet to detect encoding
  const detected = jschardet.detect(buffer)
  if (detected && detected.encoding && detected.confidence > 0.5) {
    try {
      return iconv.decode(buffer, detected.encoding)
    } catch {
      // fall through to fallback
    }
  }

  // 4. Fallback: decode as UTF-8
  return buffer.toString('utf-8')
}
