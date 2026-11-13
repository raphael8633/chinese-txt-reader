/**
 * The same-title key: trimmed, whitespace collapsed, lower-cased. `reading_works.title_key`
 * stores it, so changing the rule regroups every work.
 */
export const titleKey = (title: string): string => title.trim().replace(/\s+/g, ' ').toLowerCase()
