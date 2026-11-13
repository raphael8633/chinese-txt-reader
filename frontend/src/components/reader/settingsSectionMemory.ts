export type SettingsSectionKey = 'font' | 'layout' | 'theme' | 'control' | 'filter'

const DEFAULT_SECTION: SettingsSectionKey = 'font'

// Session-only memory: reopening the settings panel returns to the last tab the
// user picked. Deliberately not persisted to IndexedDB/backend.
let rememberedSection: SettingsSectionKey = DEFAULT_SECTION

export function getRememberedSettingsSection(): SettingsSectionKey {
  return rememberedSection
}

export function rememberSettingsSection(section: SettingsSectionKey): void {
  rememberedSection = section
}

export function resetRememberedSettingsSection(): void {
  rememberedSection = DEFAULT_SECTION
}
