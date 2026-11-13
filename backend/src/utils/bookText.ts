export interface ChapterMetadata {
  index: number
  title: string
}

const chapterPattern = /^(第[一二三四五六七八九十百千萬万零〇兩两\d]+[章回節卷部篇]|Chapter\s+\d+)/i
const chapterTitlePattern = /^(第[一二三四五六七八九十百千萬万零〇兩两\d]+[章回節卷部篇]|Chapter\s+\d+)\s*(.*)$/i
const dialoguePattern = /^[「『"']/
const indentPattern = /^(?:　| {2})/

export function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .flatMap((block) => {
      const paragraphs: string[] = []
      let pending = ''

      for (const raw of block.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        if (chapterPattern.test(line) || dialoguePattern.test(line)) {
          if (pending) paragraphs.push(pending)
          paragraphs.push(line)
          pending = ''
          continue
        }
        // An indented line opens a new paragraph in hard-wrapped TXT.
        if (indentPattern.test(raw)) {
          if (pending) paragraphs.push(pending)
          pending = line
          continue
        }
        pending = pending ? `${pending}${line}` : line
      }

      if (pending) paragraphs.push(pending)
      return paragraphs
    })
}

export function detectChapters(paragraphs: string[]): ChapterMetadata[] {
  return paragraphs
    .map((paragraph, index) => ({ index, title: formatChapterTitle(paragraph.trim()).slice(0, 40) }))
    .filter((chapter) => chapterPattern.test(chapter.title))
}

export function parseChaptersJson(json: string): ChapterMetadata[] {
  try {
    const chapters = JSON.parse(json) as unknown
    if (!Array.isArray(chapters)) return []
    return chapters.flatMap((chapter) => {
      if (
        typeof chapter === 'object'
        && chapter !== null
        && typeof (chapter as ChapterMetadata).index === 'number'
        && typeof (chapter as ChapterMetadata).title === 'string'
      ) {
        return [{
          index: (chapter as ChapterMetadata).index,
          title: (chapter as ChapterMetadata).title,
        }]
      }
      return []
    })
  } catch {
    return []
  }
}

function formatChapterTitle(text: string): string {
  const match = text.trim().match(chapterTitlePattern)
  if (!match) return text
  const name = match[2]?.trim()
  return name ? `${match[1]} ${name}` : match[1]
}
