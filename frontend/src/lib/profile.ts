// Which profile this window belongs to (#99, ADR-0016). The bridge writes it
// into the page as <meta name="oreneta-profile"> before any script runs. The
// webview's storage is shared by every profile on the computer, so what the
// page keeps there is keyed by profile; the default profile keeps the keys it
// always had.

export const DEFAULT_PROFILE = 'default'

export function currentProfile(): string {
  try {
    const meta = document.querySelector('meta[name="oreneta-profile"]')
    const value = meta?.getAttribute('content')?.trim()
    return value && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value) ? value : DEFAULT_PROFILE
  } catch {
    return DEFAULT_PROFILE
  }
}

/** A storage key of this profile. */
export function profileKey(name: string, profile = currentProfile()): string {
  return profile === DEFAULT_PROFILE ? name : `${name}@profile:${profile}`
}
