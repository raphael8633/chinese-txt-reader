import { useEffect, useRef } from 'react'
import type { Book, Chapter, ReaderSettings } from '../../api.js'
import { PanelOverlay } from './PanelOverlay.js'

interface ChapterPanelProps {
  chapters: Chapter[]
  currentChapterIndex: number
  book: Book | null
  paragraphs: string[]
  onClose: () => void
  onJump: (chapterIndex: number, chapterParagraphIndex: number) => void
  settings: ReaderSettings
}

export function ChapterPanel({
  chapters,
  currentChapterIndex,
  book,
  paragraphs,
  onClose,
  onJump,
  settings,
}: ChapterPanelProps) {
  const currentRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ block: 'center' })
  }, [])

  function getChapterCharCount(i: number): number {
    const startPara = chapters[i].index
    const endPara = i + 1 < chapters.length ? chapters[i + 1].index : paragraphs.length
    return paragraphs.slice(startPara, endPara).reduce((sum, p) => sum + p.length, 0)
  }

  const totalChars = book?.charCount ?? paragraphs.reduce((s, p) => s + p.length, 0)

  return (
    <PanelOverlay
      title="目錄"
      onClose={onClose}
      style={{ backgroundColor: settings.backgroundColor, color: settings.textColor }}
      data-testid="chapter-panel"
    >
      <div className="border-b px-4 py-2 text-xs opacity-60">
        共 {chapters.length} 章，{(totalChars / 10000).toFixed(2)} 萬字
      </div>
      {chapters.map((chapter, i) => {
        const isCurrent = i === currentChapterIndex
        const charCount = getChapterCharCount(i)
        return (
          <button
            key={chapter.index}
            ref={isCurrent ? currentRef : undefined}
            type="button"
            className="flex w-full items-center border-b px-4 py-3 text-left text-sm hover:opacity-80"
            style={{
              color: isCurrent ? '#16a34a' : settings.textColor,
              backgroundColor: settings.backgroundColor,
            }}
            onClick={() => onJump(i, chapter.index)}
          >
            <span className="flex-1 truncate">{chapter.title}</span>
            <span className="ml-2 shrink-0 text-xs opacity-60">{charCount}字</span>
          </button>
        )
      })}
    </PanelOverlay>
  )
}
