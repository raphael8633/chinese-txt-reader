// Fallback lookup: /web-sources/providers is the source of truth, but it exposes one
// displayHost per provider while legacy books carry only a sourceUrl hostname.
export const WEB_SOURCE_NAMES: Record<string, string> = {
  generic: '通用解析',
}

export function formatSourceName(
  sourceUrl: string | null | undefined,
  providerId?: string | null,
  names: Record<string, string> = WEB_SOURCE_NAMES,
): string {
  if (providerId && names[providerId]) return names[providerId]
  if (!sourceUrl) return '其他書源'
  try {
    return names[new URL(sourceUrl).hostname.toLowerCase()] ?? '其他書源'
  } catch {
    return '其他書源'
  }
}

function hostOf(sourceUrl: string | null | undefined): string | null {
  if (!sourceUrl) return null
  try {
    return new URL(sourceUrl).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** Display names keyed by book ID; equal names are told apart by host. */
export function formatSourceLabels(
  sources: Array<{ id: string; sourceType?: string; sourceUrl?: string | null; providerId?: string | null }>,
  names: Record<string, string> = WEB_SOURCE_NAMES,
): Record<string, string> {
  const base = sources.map(source => [source.id, source.sourceType === 'txt' ? '上傳書籍'
    : formatSourceName(source.sourceUrl, source.providerId, names), source] as const)
  const counts = new Map<string, number>()
  for (const [, name] of base) counts.set(name, (counts.get(name) ?? 0) + 1)
  return Object.fromEntries(base.map(([id, name, source]) => {
    const host = hostOf(source.sourceUrl)
    return [id, (counts.get(name) ?? 0) > 1 && host ? `${name}（${host}）` : name]
  }))
}
