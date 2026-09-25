import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { LicenseStorage } from './types.js'

/**
 * A JSON file on disk, for Node, Electron and CLIs — `@licence-app/sdk/node`,
 * kept out of the main entry so a browser bundle never pulls in `node:fs`.
 *
 * Written whole on every change: the record is a few kilobytes and changes a
 * handful of times a day.
 */
export function fileStorage(path: string): LicenseStorage {
  const read = async (): Promise<Record<string, string>> => {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }

  const write = async (values: Record<string, string>) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(values), { mode: 0o600 })
  }

  return {
    async get(key) {
      return (await read())[key] ?? null
    },
    async set(key, value) {
      await write({ ...(await read()), [key]: value })
    },
    async remove(key) {
      const values = await read()
      delete values[key]

      if (Object.keys(values).length) {
        await write(values)
      } else {
        await rm(path, { force: true })
      }
    },
  }
}
