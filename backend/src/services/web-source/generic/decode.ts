import iconv from 'iconv-lite'
import jschardet from 'jschardet'

/** jschardet on a full 4 MB buffer costs seconds; the first chunk decides the encoding just as well. */
const DETECTION_SAMPLE_BYTES = 64 * 1024
const CHARSET_SNIFF_BYTES = 4 * 1024

export type DecodedHtml = {
  text: string
  /** The iconv label actually used, for debug output. */
  encoding: string
  source: 'bom' | 'meta' | 'header' | 'detected' | 'default'
}

export function decodeHtml(
  data: Uint8Array,
  contentTypeHeader?: string | string[] | undefined,
): DecodedHtml {
  const buffer = toBuffer(data)

  const bom = decodeByBom(buffer)
  if (bom) return bom

  const head = buffer.subarray(0, CHARSET_SNIFF_BYTES).toString('latin1')
  const metaCharset = normalizeEncoding(sniffMetaCharset(head))
  if (metaCharset) return { text: iconv.decode(buffer, metaCharset), encoding: metaCharset, source: 'meta' }

  const headerCharset = normalizeEncoding(charsetFromContentType(firstHeader(contentTypeHeader)))
  if (headerCharset) return { text: iconv.decode(buffer, headerCharset), encoding: headerCharset, source: 'header' }

  const detected = detectEncoding(buffer)
  if (detected) return { text: iconv.decode(buffer, detected), encoding: detected, source: 'detected' }

  return { text: buffer.toString('utf8'), encoding: 'utf-8', source: 'default' }
}

function decodeByBom(buffer: Buffer): DecodedHtml | null {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf-8', source: 'bom' }
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: iconv.decode(buffer.subarray(2), 'utf-16le'), encoding: 'utf-16le', source: 'bom' }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: iconv.decode(buffer.subarray(2), 'utf-16be'), encoding: 'utf-16be', source: 'bom' }
  }
  return null
}

function sniffMetaCharset(head: string): string | null {
  const charsetAttr = head.match(/<meta\b[^>]*\bcharset\s*=\s*["']?\s*([a-zA-Z0-9_:.-]+)/i)
  if (charsetAttr) return charsetAttr[1]
  const httpEquiv = head.match(/<meta\b[^>]*http-equiv\s*=\s*["']?content-type["']?[^>]*>/i)
  if (httpEquiv) return charsetFromContentType(httpEquiv[0])
  return null
}

function charsetFromContentType(value: string | undefined): string | null {
  if (!value) return null
  return value.match(/charset\s*=\s*["']?\s*([a-zA-Z0-9_:.-]+)/i)?.[1] ?? null
}

function detectEncoding(buffer: Buffer): string | null {
  try {
    const detected = jschardet.detect(buffer.subarray(0, DETECTION_SAMPLE_BYTES))
    if (!detected?.encoding || detected.confidence <= 0.5) return null
    return normalizeEncoding(detected.encoding)
  } catch {
    return null
  }
}

/**
 * Chinese novel sites label the same bytes half a dozen ways; folding the
 * legacy labels onto their superset avoids mojibake on the rarer code points.
 */
function normalizeEncoding(label: string | null): string | null {
  if (!label) return null
  const normalized = label.trim().toLowerCase().replace(/^["']|["']$/g, '')
  if (!normalized) return null
  if (/^(gb2312|gb_2312|gbk|x-gbk|cp936|ms936|gb18030|euc-cn|csgb2312)$/.test(normalized)) return 'gb18030'
  if (/^(big5|big-5|big5-hkscs|bigfive|cp950|csbig5|x-x-big5)$/.test(normalized)) return 'big5'
  if (/^(utf-8|utf8|ascii|us-ascii|iso-8859-1|latin1|windows-1252)$/.test(normalized)) return 'utf-8'
  if (/^(utf-16le|utf-16|ucs-2)$/.test(normalized)) return 'utf-16le'
  if (normalized === 'utf-16be') return 'utf-16be'
  if (/^(euc-jp|shift_jis|sjis|euc-kr)$/.test(normalized)) return normalized
  return iconv.encodingExists(normalized) ? normalized : null
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function toBuffer(data: Uint8Array): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}
