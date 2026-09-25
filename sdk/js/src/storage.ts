import type { LicenseStorage } from './types.js'

/**
 * Keeps nothing between runs. The default where there is no `localStorage`;
 * right for tests, wrong for anything that should survive a restart.
 */
export function memoryStorage(): LicenseStorage {
  const values = new Map<string, string>()

  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      values.set(key, value)
    },
    remove: (key) => {
      values.delete(key)
    },
  }
}

/**
 * The browser's `localStorage`, or memory where there is none (or where
 * reading it throws, as it does in some private modes).
 *
 * Only in a browser: Node 25 has an experimental global `localStorage` that
 * warns when touched and keeps nothing unless started with a file for it —
 * use `fileStorage` from `@licence-app/sdk/node` there instead.
 */
export function localStorageOrMemory(): LicenseStorage {
  if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
    return memoryStorage()
  }

  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage

    if (storage) {
      const probe = '__licence_app_probe__'
      storage.setItem(probe, '1')
      storage.removeItem(probe)

      return {
        get: (key) => storage.getItem(key),
        set: (key, value) => storage.setItem(key, value),
        remove: (key) => storage.removeItem(key),
      }
    }
  } catch {
    // fall through
  }

  return memoryStorage()
}
