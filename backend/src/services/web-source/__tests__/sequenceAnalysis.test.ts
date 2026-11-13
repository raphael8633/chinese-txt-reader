import { describe, expect, it } from 'vitest'
import { analyzeChapterSequence } from '../sequenceAnalysis.js'

const chapters = (numbers: number[]) => numbers.map((n, index) => ({
  index, title: `第${n}章`, url: `https://example.test/${index}`,
}))

describe('sequence evidence (diagnostic-only)', () => {
  it('keeps the first run gap visible even when a later unmarked run supplies its ordinal', () => {
    const input = chapters([...Array.from({ length: 99 }, (_, i) => i + 1),
      ...Array.from({ length: 128 }, (_, i) => i + 101),
      ...Array.from({ length: 228 }, (_, i) => i + 1)])
    const original = JSON.stringify(input)
    const result = analyzeChapterSequence(input)
    expect(result.warnings.join('\n')).toContain('第 99 章與第 101 章')
    expect(result.warnings.join('\n')).toContain('第 228 章後出現第 1 章')
    expect(result.warnings.join('\n')).toContain('待確認')
    expect(result.warnings.join('\n')).not.toContain('之間缺少第 100 章')
    expect(JSON.stringify(input)).toBe(original)
  })

  it('does not call a real duplicate plus gap a typo or suppress either finding', () => {
    const result = analyzeChapterSequence(chapters([215, 216, 217, 216, 219, 220, 221]))
    const warnings = result.warnings.join('\n')
    expect(warnings).toContain('第 217 章後出現第 216 章')
    expect(warnings).toContain('第 216 章出現不只一次')
    expect(warnings).toContain('第 216 章與第 219 章')
    expect(warnings).toContain('待確認')
    expect(warnings).not.toContain('之間缺少第 218 章')
    expect(result.debugMessages.join('\n')).not.toContain('序列推定 218')
  })

  it('treats volume labels as unnumbered evidence rather than chapter ordinals', () => {
    const result = analyzeChapterSequence([
      { index: 0, title: '第一章', url: 'https://example.test/0' },
      { index: 1, title: '第二章', url: 'https://example.test/1' },
      { index: 2, title: '第三卷 新篇', url: 'https://example.test/2' },
      { index: 3, title: '第四章', url: 'https://example.test/3' },
    ])
    expect(result.warnings.join('\n')).toContain('待確認')
    expect(result.warnings.join('\n')).not.toContain('之間缺少第 3 章')
    expect(result.warnings.join('\n')).toContain('無法判讀')
  })

  it('does not confirm a missing number across an unparseable title and collapses coverage', () => {
    const input = [
      { index: 0, title: '第一章', url: 'https://example.test/0' },
      { index: 1, title: '番外 未標章號', url: 'https://example.test/1' },
      { index: 2, title: '第三章', url: 'https://example.test/2' },
    ]
    const result = analyzeChapterSequence(input)
    expect(result.warnings.join('\n')).toContain('第 1 章與第 3 章')
    expect(result.warnings.join('\n')).toContain('待確認')
    expect(result.warnings.join('\n')).not.toContain('之間缺少第 2 章')
    expect(result.warnings.filter(w => w.includes('無法判讀'))).toHaveLength(1)
  })

  it('keeps an isolated inferred typo visible as pending because 405 may be misplaced and 205 missing', () => {
    const input = chapters([202, 203, 204, 405, 206, 207])
    const original = JSON.stringify(input)
    const result = analyzeChapterSequence(input)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('待確認')
    expect(result.warnings[0]).toContain('第 405 章')
    expect(result.warnings[0]).toContain('第 205 章誤植')
    expect(result.warnings[0]).toContain('錯置章節且第 205 章缺漏')
    expect(result.warnings.join('\n')).not.toContain('之間缺少')
    expect(result.debugMessages.join('\n')).toContain('序列推定 205')
    expect(result.debugMessages.join('\n')).toContain('https://example.test/3')
    expect(JSON.stringify(input)).toBe(original)
  })

  it('does not let a distant reversal downgrade an unrelated adjacent gap', () => {
    const numbers = [1, 2, 3, 4, 5, ...Array.from({ length: 34 }, (_, i) => i + 7), 20, 21]
    const warnings = analyzeChapterSequence(chapters(numbers)).warnings.join('\n')
    expect(warnings).toContain('第 5 章與第 7 章之間缺少第 6 章')
    expect(warnings).toContain('第 40 章後出現第 20 章')
  })

  it('keeps a gap pending when its ordinal appears elsewhere in the same segment', () => {
    const numbers = [1, 2, 3, 4, 5, ...Array.from({ length: 34 }, (_, i) => i + 7), 6, 41, 42]
    const warnings = analyzeChapterSequence(chapters(numbers)).warnings.join('\n')
    expect(warnings).toContain('第 5 章與第 7 章間有空檔第 6 章')
    expect(warnings).not.toContain('之間缺少第 6 章')
    expect(warnings).toContain('第 40 章後出現第 6 章')
    expect(warnings).not.toContain('之間缺少第 7–40 章')
  })

  it('flags an implausibly large ordinal gap as pending instead of counting missing chapters', () => {
    const warnings = analyzeChapterSequence(chapters([1, 2, 3, 20240101])).warnings.join('\n')
    expect(warnings).toContain('第 3 章與第 20240101 章間有空檔')
    expect(warnings).toContain('超過可信範圍')
    expect(warnings).not.toContain('之間缺少')
  })
})
