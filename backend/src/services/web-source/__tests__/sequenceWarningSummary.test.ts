import { describe, expect, it } from 'vitest'
import { summarizeSequenceWarnings } from '../sequenceWarningSummary.js'

describe('summarizeSequenceWarnings', () => {
  it('groups uncertain gaps separately and names the first pending ranges without counting missing chapters', () => {
    const pending = '來源目錄章號待確認（卷段 2）：第 211 章與第 449 章間有空檔第 212–448 章，但兩端在來源目錄不相鄰；不判定缺章，請核對原始標題。'
    const typo = '來源目錄章號待確認：第 204 章與第 206 章之間出現第 405 章；序列推定可能是第 205 章誤植，也可能是錯置章節且第 205 章缺漏；不判定，請核對原始標題。'
    const result = summarizeSequenceWarnings([pending, typo])
    expect(result.warnings).toEqual(['來源目錄章號待確認：2 處（第 212–448 章、第 405 章（疑似第 205 章））；請展開檢視。'])
    expect(result.warningDetails).toEqual([{ summary: result.warnings[0], messages: [pending, typo] }])
  })
  it('caps each category detail list with an explicit omitted-count note', () => {
    const reversals = Array.from({ length: 150 }, (_, i) =>
      `來源目錄章號順序異常：第 ${5000 - i} 章後出現第 ${4999 - i} 章。這是來源目錄提供的章節順序。`)
    const result = summarizeSequenceWarnings(reversals)
    expect(result.warnings).toEqual(['來源目錄章號順序異常：150 處；請展開檢視。'])
    expect(result.warningDetails[0].messages).toHaveLength(101)
    expect(result.warningDetails[0].messages.slice(0, 100)).toEqual(reversals.slice(0, 100))
    expect(result.warningDetails[0].messages[100]).toContain('另有 50 筆')
  })
  it('retains provider messages verbatim even when they resemble an internal marker', () => {
    const providerWarning = 'SEQUENCE_SUMMARY_PLACEHOLDER'
    const duplicate = '來源目錄章號重複：第 136 章出現不只一次。這是來源目錄提供的章節順序。'
    const input = [providerWarning, duplicate, '目錄分頁超過上限，僅載入前 2 頁（可能不完整）']
    const result = summarizeSequenceWarnings(input)
    expect(result.warnings).toEqual([
      providerWarning,
      '來源目錄章號重複：1 處；請展開檢視。',
      input[2],
    ])
    expect(result.warningDetails).toEqual([{
      summary: result.warnings[1], messages: [duplicate],
    }])
    expect(input).toEqual([providerWarning, duplicate, '目錄分頁超過上限，僅載入前 2 頁（可能不完整）'])
  })
})
