import type { View } from '../types.js'

// Anchor ids for the Settings sections other screens link into. Settings is one
// long page, so a bare "go to Settings" drops a new user at Profile/Password —
// nowhere near the thing they were asked to fix. Linking to a section instead
// scrolls it into view.
export const SETTINGS_SECTIONS = {
  profile: 'settings-profile',
  workspace: 'settings-workspace',
  team: 'settings-team',
  targeting: 'settings-targeting',
  learning: 'settings-learning',
  email: 'settings-email',
  compliance: 'settings-compliance',
  deliverability: 'settings-deliverability',
  apiKeys: 'settings-api-keys',
} as const

export type SettingsSection = keyof typeof SETTINGS_SECTIONS

// Scroll to a section once it exists. Settings renders some sections only after
// its data loads, so poll briefly rather than assuming it's already mounted.
export function scrollToSettingsSection(section: SettingsSection, attempts = 40): void {
  const el = document.getElementById(SETTINGS_SECTIONS[section])
  if (el) {
    el.scrollIntoView?.({ behavior: 'smooth', block: 'start' }) // absent in jsdom
    return
  }
  if (attempts > 0) setTimeout(() => scrollToSettingsSection(section, attempts - 1), 50)
}

export function openSettingsSection(setView: (v: View) => void, section: SettingsSection): void {
  setView('settings')
  scrollToSettingsSection(section)
}
