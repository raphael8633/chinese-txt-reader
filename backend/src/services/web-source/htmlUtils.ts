import { decodeHtmlEntities } from '../../utils/htmlEntities.js'

export function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

export function getFirstAttr(html: string, attrName: string): string | null {
  const pattern = new RegExp(`${attrName}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s>]+))`, 'i')
  const match = pattern.exec(html)
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null
}

export function resolveUrl(baseUrl: string, href: string): string {
  return new URL(href, baseUrl).toString()
}

export function percentEncodeBytes(bytes: Buffer): string {
  return Array.from(bytes)
    .map((byte) => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`)
    .join('')
}

export { decodeHtmlEntities }
