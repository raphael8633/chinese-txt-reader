// Standard-named-entity table, scoped to the entities that have actually shown up
// in uploaded raph-reader books plus common HTML defaults. Numeric (`&#NNNN;`, `&#xHHHH;`)
// entities are handled generically. Unknown named entities are intentionally left
// untouched so backfill scans can still surface them for review.

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  emsp: ' ',
  ensp: ' ',
  hellip: '…',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  bdquo: '„',
  prime: '′',
  Prime: '″',
  ndash: '–',
  mdash: '—',
  dash: '-',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  laquo: '«',
  raquo: '»',
  iquest: '¿',
  iexcl: '¡',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  para: '¶',
  sect: '§',
  micro: 'µ',
}

const ENTITY_RE = /&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{0,31});/g
const MAX_CODE_POINT = 0x10FFFF

function safeCodePoint(code: number, match: string): string {
  // String.fromCodePoint throws RangeError for code > 0x10FFFF or non-integers.
  // Also skip surrogate range (0xD800-0xDFFF): valid as code points only inside pairs.
  if (!Number.isInteger(code) || code < 0 || code > MAX_CODE_POINT) return match
  if (code >= 0xD800 && code <= 0xDFFF) return match
  return String.fromCodePoint(code)
}

export function decodeHtmlEntities(input: string): string {
  return input.replace(ENTITY_RE, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return safeCodePoint(code, match)
    }
    if (body.startsWith('#')) {
      const code = Number(body.slice(1))
      return safeCodePoint(code, match)
    }
    const named = NAMED_ENTITIES[body]
    return named ?? match
  })
}
