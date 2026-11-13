/** Keep chapter-number findings visible while collapsing repeated rows into summaries.
 * Inputs are the exact post-repair messages produced by analyzeChapterSequence;
 * provider warnings and unrecognised messages remain untouched. Each category's
 * expandable rows are capped with an explicit omitted-count row.
 */
export type WarningDetail = { summary: string; messages: string[] }

const CONTEXT = '(?:（卷段 \\d+）)?'
const GAP = new RegExp(`^來源目錄章號不連續${CONTEXT}：第 \\d+ 章與第 \\d+ 章之間缺少第 (\\d+)(?:–(\\d+))? 章。這是來源目錄提供的章節集合。$`)
const DUPLICATE = new RegExp(`^來源目錄章號重複${CONTEXT}：第 \\d+ 章出現不只一次。這是來源目錄提供的章節順序。$`)
const REVERSAL = new RegExp(`^來源目錄章號順序異常${CONTEXT}：第 \\d+ 章後出現第 \\d+ 章。這是來源目錄提供的章節順序。$`)
const PENDING = new RegExp(`^來源目錄章號待確認${CONTEXT}：第 \\d+ 章與第 \\d+ 章(?:間有空檔第 (\\d+)(?:–(\\d+))? 章，但[^；]+；不判定缺章|之間出現第 (\\d+) 章；序列推定可能是第 (\\d+) 章誤植，也可能是錯置章節且第 \\d+ 章缺漏；不判定)，請核對原始標題。$`)
/** Bound expanded rows per category; the summary still reports the full count. */
const MAX_DETAIL_MESSAGES = 100

function capped(messages: string[]): string[] {
  if (messages.length <= MAX_DETAIL_MESSAGES) return messages
  const omitted = messages.length - MAX_DETAIL_MESSAGES
  return [...messages.slice(0, MAX_DETAIL_MESSAGES),
    `另有 ${omitted} 筆同類訊息未逐筆列出（本類共 ${messages.length} 筆）；請以來源目錄核對。`]
}

export function summarizeSequenceWarnings(messages: string[]): {
  warnings: string[]
  warningDetails: WarningDetail[]
} {
  const groups = { gap: [] as string[], duplicate: [] as string[], reversal: [] as string[], pending: [] as string[] }
  const gaps: Array<{ start: number; end: number }> = []
  const pendingLabels: string[] = []
  const warnings: string[] = []
  let summaryIndex: number | null = null
  for (const message of messages) {
    const gap = GAP.exec(message)
    const pending = gap ? null : PENDING.exec(message)
    const kind = gap ? 'gap' : DUPLICATE.test(message) ? 'duplicate'
      : REVERSAL.test(message) ? 'reversal' : pending ? 'pending' : null
    if (!kind) {
      warnings.push(message)
      continue
    }
    if (summaryIndex === null) {
      // Preserve ordering relative to provider/budget warnings; summaries will
      // occupy the first sequence warning's position.
      summaryIndex = warnings.length
    }
    groups[kind].push(message)
    if (gap) gaps.push({ start: Number(gap[1]), end: Number(gap[2] ?? gap[1]) })
    if (pending) {
      pendingLabels.push(pending[1]
        ? `第 ${pending[1]}${pending[2] ? `–${pending[2]}` : ''} 章`
        : `第 ${pending[3]} 章（疑似第 ${pending[4]} 章）`)
    }
  }
  const warningDetails: WarningDetail[] = []
  if (gaps.length) {
    const count = gaps.reduce((total, range) => total + range.end - range.start + 1, 0)
    const labels = gaps.slice(0, 3).map(({ start, end }) =>
      `第 ${start}${end === start ? '' : `–${end}`} 章`)
    const summary = `來源目錄章號不連續：${gaps.length} 段、疑似缺 ${count} 個章號（${labels.join('、')}${gaps.length > 3 ? '等' : ''}）；請展開檢視。`
    warningDetails.push({ summary, messages: capped(groups.gap) })
  }
  if (groups.duplicate.length) {
    warningDetails.push({
      summary: `來源目錄章號重複：${groups.duplicate.length} 處；請展開檢視。`,
      messages: capped(groups.duplicate),
    })
  }
  if (groups.reversal.length) {
    warningDetails.push({
      summary: `來源目錄章號順序異常：${groups.reversal.length} 處；請展開檢視。`,
      messages: capped(groups.reversal),
    })
  }
  if (groups.pending.length) {
    const labels = pendingLabels.slice(0, 3).join('、')
    warningDetails.push({
      summary: `來源目錄章號待確認：${groups.pending.length} 處（${labels}${groups.pending.length > 3 ? '等' : ''}）；請展開檢視。`,
      messages: capped(groups.pending),
    })
  }
  if (summaryIndex !== null) {
    warnings.splice(summaryIndex, 0, ...warningDetails.map((detail) => detail.summary))
  }
  return { warnings, warningDetails }
}
