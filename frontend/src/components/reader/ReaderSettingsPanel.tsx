import { useState } from 'react'
import type { CSSProperties } from 'react'
import type { ReaderSettings } from '../../api.js'
import { PanelOverlay, StepperRow } from './PanelOverlay.js'
import { getRememberedSettingsSection, rememberSettingsSection } from './settingsSectionMemory.js'
import type { SettingsSectionKey } from './settingsSectionMemory.js'

type SectionKey = SettingsSectionKey

const SECTION_TABS: Array<{ key: SectionKey; label: string }> = [
  { key: 'font', label: '字型' },
  { key: 'layout', label: '排版' },
  { key: 'theme', label: '主題' },
  { key: 'control', label: '操作' },
  { key: 'filter', label: '過濾' },
]

const THEME_PRESETS = [
  { text: '#333333', bg: '#f5f0e8', label: '米白' },
  { text: '#e8dcc8', bg: '#1a1a2e', label: '暗黑' },
  { text: '#2d5016', bg: '#e8f5e9', label: '護眼' },
] as const

const CONVERSION_OPTIONS = [
  { value: 'none', label: '不轉換' },
  { value: 'traditional', label: '轉繁體' },
  { value: 'simplified', label: '轉簡體' },
] as const

const TAP_MODE_OPTIONS = [
  { value: 'allDown', label: '向下' },
  { value: 'vertical', label: '上下' },
  { value: 'horizontal', label: '左右' },
] as const

const TOOLBAR_SIDE_OPTIONS = [
  { value: 'left', label: '左側' },
  { value: 'right', label: '右側' },
] as const

const HARD_WRAP_OPTIONS = [
  { value: 'auto', label: '自動' },
  { value: 'merge', label: '合併' },
  { value: 'preserve', label: '保留' },
] as const

interface PillGroupProps<T extends string> {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  settings: ReaderSettings
  onChange: (next: T) => void
}

function PillGroup<T extends string>({ label, value, options, settings, onChange }: PillGroupProps<T>) {
  return (
    <div className="flex items-center gap-2 border-b px-4 py-2.5">
      <span className="flex-1 text-sm">{label}</span>
      <div className="flex gap-1">
        {options.map(option => (
          <button
            key={option.value}
            type="button"
            className={`flex min-h-9 items-center rounded-md border px-2.5 py-1 text-xs transition-all ${value === option.value ? 'font-semibold opacity-100' : 'opacity-40'}`}
            style={{ borderColor: settings.textColor, color: settings.textColor }}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function parseFilterText(value: string): string[] {
  return value
    .split('\n')
    .map(item => item.trim())
    .filter(Boolean)
}

interface ReaderSettingsPanelProps {
  settings: ReaderSettings
  onClose: () => void
  onUpdate: (updates: Partial<ReaderSettings>) => void
}

export function ReaderSettingsPanel({ settings, onClose, onUpdate }: ReaderSettingsPanelProps) {
  const [section, setSection] = useState<SectionKey>(getRememberedSettingsSection)

  function selectSection(next: SectionKey) {
    rememberSettingsSection(next)
    setSection(next)
  }

  return (
    <PanelOverlay
      title="閱讀設定"
      onClose={onClose}
      style={{ backgroundColor: settings.backgroundColor, color: settings.textColor }}
      data-testid="settings-panel"
    >
      <div
        className="border-b px-5 py-4"
        style={{
          fontSize: `${settings.fontSizePx}px`,
          lineHeight: settings.lineHeight,
          letterSpacing: `${settings.letterSpacingPx}px`,
          fontWeight: settings.fontWeight,
        }}
      >
        <p style={{
          textIndent: `${settings.paragraphIndent}em`,
          textAlign: settings.justifyText ? 'justify' : 'start',
          margin: 0,
        }}>
          君不見，黃河之水天上來，奔流到海不復回。君不見，高堂明鏡悲白髮，朝如青絲暮成雪。
        </p>
      </div>

      <div
        className="sticky top-0 z-10 flex border-b"
        style={{ backgroundColor: settings.backgroundColor }}
        role="tablist"
        aria-label="設定分組"
      >
        {SECTION_TABS.map(tab => {
          const isActive = section === tab.key
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => selectSection(tab.key)}
              className={`flex min-h-11 flex-1 items-center justify-center py-2.5 text-sm transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-4px] ${isActive ? 'font-semibold' : 'opacity-50 hover:opacity-80'}`}
              style={{
                color: settings.textColor,
                borderBottom: isActive ? `2px solid ${settings.textColor}` : '2px solid transparent',
              }}
              data-testid={`settings-tab-${tab.key}`}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      <div role="tabpanel" data-testid={`settings-section-${section}`}>
        {section === 'font' && (
          <>
            <StepperRow
              label="字體大小" value={settings.fontSizePx} min={12} max={32}
              display={`${settings.fontSizePx}px`}
              onDecrease={() => onUpdate({ fontSizePx: settings.fontSizePx - 1 })}
              onIncrease={() => onUpdate({ fontSizePx: settings.fontSizePx + 1 })}
            />
            <StepperRow
              label="行距" value={settings.lineHeight} min={1.2} max={4.0}
              display={settings.lineHeight.toFixed(1)}
              onDecrease={() => onUpdate({ lineHeight: Math.round((settings.lineHeight - 0.1) * 10) / 10 })}
              onIncrease={() => onUpdate({ lineHeight: Math.round((settings.lineHeight + 0.1) * 10) / 10 })}
            />
            <StepperRow
              label="字距" value={settings.letterSpacingPx} min={0} max={20}
              display={`${settings.letterSpacingPx.toFixed(1)}px`}
              onDecrease={() => onUpdate({ letterSpacingPx: Math.round((settings.letterSpacingPx - 0.5) * 10) / 10 })}
              onIncrease={() => onUpdate({ letterSpacingPx: Math.round((settings.letterSpacingPx + 0.5) * 10) / 10 })}
            />
            <StepperRow
              label="字重" value={settings.fontWeight} min={100} max={900}
              onDecrease={() => onUpdate({ fontWeight: settings.fontWeight - 100 })}
              onIncrease={() => onUpdate({ fontWeight: settings.fontWeight + 100 })}
            />
            <div className="flex items-center border-b px-4 py-2.5">
              <span className="flex-1 text-sm">兩端對齊</span>
              <button
                type="button"
                onClick={() => onUpdate({ justifyText: !settings.justifyText })}
                className={`relative inline-flex flex-shrink-0 h-6 w-11 rounded-full transition-colors ${settings.justifyText ? 'bg-teal-500' : 'bg-black/20'}`}
                aria-label="兩端對齊"
                aria-pressed={settings.justifyText}
              >
                <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${settings.justifyText ? 'translate-x-5' : 'translate-x-0'}`} />
              </button>
            </div>
          </>
        )}

        {section === 'layout' && (
          <>
            <PillGroup
              label="繁簡轉換"
              value={settings.chineseConversion}
              options={CONVERSION_OPTIONS}
              settings={settings}
              onChange={value => onUpdate({ chineseConversion: value })}
            />
            <PillGroup
              label="換行"
              value={settings.hardWrapMode}
              options={HARD_WRAP_OPTIONS}
              settings={settings}
              onChange={value => onUpdate({ hardWrapMode: value })}
            />
            <StepperRow
              label="段首縮進" value={settings.paragraphIndent} min={-3} max={6}
              display={`${settings.paragraphIndent.toFixed(1)}em`}
              onDecrease={() => onUpdate({ paragraphIndent: Math.round((settings.paragraphIndent - 0.5) * 10) / 10 })}
              onIncrease={() => onUpdate({ paragraphIndent: Math.round((settings.paragraphIndent + 0.5) * 10) / 10 })}
            />
            <StepperRow
              label="段落間距" value={settings.paragraphSpacing} min={0} max={50}
              display={`${settings.paragraphSpacing}px`}
              onDecrease={() => onUpdate({ paragraphSpacing: settings.paragraphSpacing - 1 })}
              onIncrease={() => onUpdate({ paragraphSpacing: settings.paragraphSpacing + 1 })}
            />
            <StepperRow
              label="左邊距" value={settings.marginLeft} min={0} max={80}
              display={`${settings.marginLeft}px`}
              onDecrease={() => onUpdate({ marginLeft: settings.marginLeft - 1 })}
              onIncrease={() => onUpdate({ marginLeft: settings.marginLeft + 1 })}
            />
            <StepperRow
              label="右邊距" value={settings.marginRight} min={0} max={80}
              display={`${settings.marginRight}px`}
              onDecrease={() => onUpdate({ marginRight: settings.marginRight - 1 })}
              onIncrease={() => onUpdate({ marginRight: settings.marginRight + 1 })}
            />
            <StepperRow
              label="正文上邊距" value={settings.paddingTop} min={0} max={50}
              display={`${settings.paddingTop}px`}
              onDecrease={() => onUpdate({ paddingTop: settings.paddingTop - 1 })}
              onIncrease={() => onUpdate({ paddingTop: settings.paddingTop + 1 })}
            />
            <StepperRow
              label="正文下邊距" value={settings.paddingBottom} min={0} max={50}
              display={`${settings.paddingBottom}px`}
              onDecrease={() => onUpdate({ paddingBottom: settings.paddingBottom - 1 })}
              onIncrease={() => onUpdate({ paddingBottom: settings.paddingBottom + 1 })}
            />
            <StepperRow
              label="章節上邊距" value={settings.annotationMarginTop} min={0} max={50}
              display={`${settings.annotationMarginTop}px`}
              onDecrease={() => onUpdate({ annotationMarginTop: settings.annotationMarginTop - 1 })}
              onIncrease={() => onUpdate({ annotationMarginTop: settings.annotationMarginTop + 1 })}
            />
            <StepperRow
              label="章節下邊距" value={settings.annotationMarginBottom} min={0} max={50}
              display={`${settings.annotationMarginBottom}px`}
              onDecrease={() => onUpdate({ annotationMarginBottom: settings.annotationMarginBottom - 1 })}
              onIncrease={() => onUpdate({ annotationMarginBottom: settings.annotationMarginBottom + 1 })}
            />
          </>
        )}

        {section === 'theme' && (
          <div className="flex items-center gap-3 border-b px-4 py-4">
            {THEME_PRESETS.map(preset => {
              const isActive = settings.textColor === preset.text && settings.backgroundColor === preset.bg
              return (
                <button
                  key={preset.label}
                  type="button"
                  className="flex flex-col items-center gap-1.5"
                  onClick={() => onUpdate({ textColor: preset.text, backgroundColor: preset.bg })}
                  aria-label={`套用主題 ${preset.label}`}
                  aria-pressed={isActive}
                >
                  <div
                    className={`flex h-10 w-16 items-center justify-center rounded-lg text-xs font-medium transition-all ${isActive ? 'ring-2 ring-offset-1' : 'opacity-70 hover:opacity-90'}`}
                    style={{
                      backgroundColor: preset.bg,
                      color: preset.text,
                      border: `1px solid ${preset.text}40`,
                      '--tw-ring-color': preset.text,
                    } as CSSProperties & Record<'--tw-ring-color', string>}
                  >
                    {isActive ? '✓' : '文'}
                  </div>
                  <span className="text-xs opacity-60">{preset.label}</span>
                </button>
              )
            })}
          </div>
        )}

        {section === 'control' && (
          <>
            <PillGroup
              label="點擊模式"
              value={settings.tapScrollMode}
              options={TAP_MODE_OPTIONS}
              settings={settings}
              onChange={value => onUpdate({ tapScrollMode: value })}
            />
            <StepperRow
              label="點擊捲動" value={settings.tapScrollPercent} min={50} max={100}
              display={`${settings.tapScrollPercent}%`}
              onDecrease={() => onUpdate({ tapScrollPercent: settings.tapScrollPercent - 5 })}
              onIncrease={() => onUpdate({ tapScrollPercent: settings.tapScrollPercent + 5 })}
            />
            <PillGroup
              label="工具列"
              value={settings.toolbarSide}
              options={TOOLBAR_SIDE_OPTIONS}
              settings={settings}
              onChange={value => onUpdate({ toolbarSide: value })}
            />
          </>
        )}

        {section === 'filter' && (
          <div className="border-b px-4 py-3">
            <label className="mb-2 block text-sm" htmlFor="content-filters">
              廣告字串
            </label>
            <textarea
              id="content-filters"
              aria-label="廣告字串"
              className="min-h-32 w-full resize-y rounded-md border bg-transparent px-3 py-2 text-sm leading-6 outline-none focus:ring-2"
              style={{
                borderColor: `${settings.textColor}66`,
                color: settings.textColor,
                '--tw-ring-color': settings.textColor,
              } as CSSProperties & Record<'--tw-ring-color', string>}
              value={settings.contentFilters.join('\n')}
              onChange={event => onUpdate({ contentFilters: parseFilterText(event.target.value) })}
            />
          </div>
        )}
      </div>
    </PanelOverlay>
  )
}
