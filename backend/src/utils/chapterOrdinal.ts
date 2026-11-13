const CHAPTER_ORDINAL_PATTERN = /^第([一二三四五六七八九十百千萬万零〇兩两\d]+)[章回節卷部篇]/

const DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  兩: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

const UNITS: Record<string, number> = {
  十: 10,
  百: 100,
  千: 1000,
  萬: 10000,
  万: 10000,
}

export function parseChapterOrdinal(title: string): number | null {
  const match = title.trim().match(CHAPTER_ORDINAL_PATTERN)
  if (!match) return null

  const token = match[1]
  if (/^\d+$/.test(token)) {
    const ordinal = Number.parseInt(token, 10)
    return Number.isSafeInteger(ordinal) ? ordinal : null
  }

  return parseChineseNumber(token)
}

function parseChineseNumber(token: string): number | null {
  if (![...token].some((character) => character in UNITS)) {
    const digits = [...token].map((character) => DIGITS[character])
    if (digits.some((digit) => digit === undefined)) return null
    return Number.parseInt(digits.join(''), 10)
  }

  let total = 0
  let section = 0
  let digit = 0
  for (const character of token) {
    if (character in DIGITS) {
      digit = DIGITS[character]
      continue
    }

    const unit = UNITS[character]
    if (!unit) return null
    if (unit === 10000) {
      section += digit
      total += (section || 1) * unit
      section = 0
    } else {
      section += (digit || 1) * unit
    }
    digit = 0
  }
  return total + section + digit
}
