import { parseChapterOrdinal } from '../../utils/chapterOrdinal.js'
import type { WebSourceChapter } from './types.js'

type Entry = { ordinal: number; chapter: WebSourceChapter; sourceIndex: number }

/** Evidence only: never modify, sort or deduplicate the provider's chapter list. */
export function analyzeChapterSequence(chapters: WebSourceChapter[]): {
  warnings: string[]
  debugMessages: string[]
} {
  const warnings: string[] = []
  const debugMessages: string[] = []
  const segments: Entry[][] = [[]]
  const unnumbered: WebSourceChapter[] = []
  for (let index = 0; index < chapters.length; index += 1) {
    const chapter = chapters[index]
    // The shared ordinal parser also accepts volume/part headings. These are
    // not chapter identities and cannot fill a hole in a chapter-number run.
    const ordinal = /^第[一二三四五六七八九十百千萬万零〇兩两\d]+[卷部篇]/.test(chapter.title.trim())
      ? null : parseChapterOrdinal(chapter.title)
    const previous = chapters[index - 1]
    if (previous && /本卷終/.test(previous.title) && ordinal === 1 && segments.at(-1)!.length) {
      segments.push([])
      debugMessages.push(`來源目錄明示卷末後章號重置：${previous.title} → ${chapter.title}（${chapter.url}）`)
    }
    if (ordinal === null) unnumbered.push(chapter)
    else segments.at(-1)!.push({ ordinal, chapter, sourceIndex: index })
  }
  if (unnumbered.length) {
    const examples = unnumbered.slice(0, 3).map(chapter => `${chapter.title}（${chapter.url}）`).join('、')
    warnings.push(`來源目錄有 ${unnumbered.length} 筆標題無法判讀章號（含可能的卷標），相鄰空檔只列待確認；例：${examples}${unnumbered.length > 3 ? '等' : ''}。`)
  }
  for (const [segmentIndex, segment] of segments.entries()) {
    const context = segments.length > 1 ? `（卷段 ${segmentIndex + 1}）` : ''
    const original = segment.map(entry => entry.ordinal)
    const ordinals = [...original]
    for (let i = 2; i < segment.length - 2; i += 1) {
      const before = original[i - 1]
      const after = original[i + 1]
      const inferred = before + 1
      if (after !== inferred + 1 || original[i] === inferred ||
        original[i - 2] !== before - 1 || original[i + 2] !== after + 1 ||
        // A nearby repeat is independent evidence, not a typo to erase.
        original.slice(Math.max(0, i - 4), i).includes(original[i]) ||
        original.slice(i + 1, i + 5).includes(original[i]) ||
        original.includes(inferred) ||
        segment[i - 1].sourceIndex + 1 !== segment[i].sourceIndex ||
        segment[i].sourceIndex + 1 !== segment[i + 1].sourceIndex ||
        (original[i] > before - 1 && original[i] < after + 1)) continue
      ordinals[i] = inferred
      const chapter = segment[i].chapter
      // The inference is only one hypothesis: the chapter may instead be a
      // misplaced real chapter with the inferred ordinal genuinely missing.
      // Keep it as an active pending warning; explain the inference in debug.
      warnings.push(`來源目錄章號待確認${context}：第 ${before} 章與第 ${after} 章之間出現第 ${original[i]} 章；序列推定可能是第 ${inferred} 章誤植，也可能是錯置章節且第 ${inferred} 章缺漏；不判定，請核對原始標題。`)
      debugMessages.push(`來源目錄疑似章號誤植（僅診斷，原標題及網址不變；已列待確認警告）：${chapter.title}（${chapter.url}）；序列推定 ${inferred}`)
    }
    // Every ordinal value seen in this segment, both as written and inferred:
    // a gap whose missing number appears elsewhere may be a displaced chapter.
    const seen = [...new Set([...original, ...ordinals])].sort((a, b) => a - b)
    const seenBetween = (low: number, high: number) => {
      let lo = 0
      let hi = seen.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (seen[mid] <= low) lo = mid + 1
        else hi = mid
      }
      return lo < seen.length && seen[lo] < high
    }
    const isDrop = ordinals.map((ordinal, i) => i > 0 && ordinal < ordinals[i - 1])
    // Only a reversal next to the gap (within two positions) is local evidence
    // of misordering or a typo; a distant reversal does not taint the gap.
    const nearDrop = (i: number) => isDrop.slice(Math.max(0, i - 2), i + 3).includes(true)
    const plausibleSpan = Math.max(1000, chapters.length)
    for (let i = 1; i < ordinals.length; i += 1) {
      const previous = ordinals[i - 1]
      const current = ordinals[i]
      const adjacent = segment[i].sourceIndex === segment[i - 1].sourceIndex + 1
      // Only consecutive positions in an ascending run can establish a gap.
      // A later unmarked run must not fill an earlier run's missing ordinal.
      if (current > previous + 1) {
        const start = previous + 1
        const end = current - 1
        const label = start === end ? `第 ${start} 章` : `第 ${start}–${end} 章`
        const reason = !adjacent ? '兩端在來源目錄不相鄰'
          : end - start + 1 > plausibleSpan ? `空檔 ${end - start + 1} 個章號超過可信範圍（大於目錄章數或 1000），章號可能是日期或誤植`
            : nearDrop(i) ? '卷界或章號解析未明'
              : seenBetween(previous, current) ? '同卷段其他位置出現此範圍章號，可能是錯置' : null
        if (reason) {
          warnings.push(`來源目錄章號待確認${context}：第 ${previous} 章與第 ${current} 章間有空檔${label}，但${reason}；不判定缺章，請核對原始標題。`)
        } else {
          warnings.push(`來源目錄章號不連續${context}：第 ${previous} 章與第 ${current} 章之間缺少${label}。這是來源目錄提供的章節集合。`)
        }
      }
      if (current < previous) {
        warnings.push(`來源目錄章號順序異常${context}：第 ${previous} 章後出現第 ${current} 章。這是來源目錄提供的章節順序。`)
        // Adjacent A,B,A is a repeat inside one local run, unlike an entire
        // implicit volume starting again at 1; show both the repeat and drop.
        if (i >= 2 && current === ordinals[i - 2]) {
          warnings.push(`來源目錄章號重複${context}：第 ${current} 章出現不只一次。這是來源目錄提供的章節順序。`)
        }
      } else if (current === previous) {
        warnings.push(`來源目錄章號重複${context}：第 ${current} 章出現不只一次。這是來源目錄提供的章節順序。`)
      }
    }
  }
  return { warnings, debugMessages }
}
