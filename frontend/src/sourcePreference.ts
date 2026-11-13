import { fetchWebSourceChapters, getSharedProgress, setPreferredSource, type SharedWork } from './api.js'

/**
 * Persists a work's preferred (default) source only after the target proves
 * readable at the shared position. Any failure throws before the preference
 * write, so the stored preference and reading position stay unchanged.
 */
export async function preflightAndSetPreferred(
  current: { workId: string; preferredBookId: string },
  targetBookId: string,
): Promise<SharedWork> {
  const target = await getSharedProgress(targetBookId)
  if (!target || target.workId !== current.workId) throw new Error('書源已變更，請重新整理書庫後再試')
  // An uploaded TXT's text is stored on the server; only web editions can be unreachable.
  const isTxt = target.members.find(member => member.id === targetBookId)?.sourceType === 'txt'
  const center = target.sharedProgress.kind === 'mapped' ? target.sharedProgress.positionValue : 0
  let readable = isTxt
  if (!isTxt) {
    try {
      const window = await fetchWebSourceChapters(targetBookId, { center, before: 0, after: 0 })
      readable = window.chapters.some(chapter => chapter.text.trim().length > 0)
    } catch {
      readable = false
    }
  }
  if (!readable) throw new Error('此書源目前無法讀取，未變更預設書源')
  return setPreferredSource(targetBookId, { preferredBookId: targetBookId, expectedPreferredBookId: current.preferredBookId })
}
