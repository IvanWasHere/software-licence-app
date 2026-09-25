// The size budget (licence plan §7.1): the core entry, minified by nothing but
// gzip, must stay under 4 KB. A licensing check is a small thing to ask a
// customer's page to download.
import { readFile, readdir } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'

const BUDGET = 4 * 1024
const dir = new URL('../dist/esm/', import.meta.url)

let total = 0
for (const file of await readdir(dir)) {
  if (file.endsWith('.js') && file !== 'node.js') {
    total += (await readFile(new URL(file, dir))).length
  }
}

const all = Buffer.concat(
  await Promise.all(
    (await readdir(dir))
      .filter((file) => file.endsWith('.js') && file !== 'node.js')
      .map((file) => readFile(new URL(file, dir)))
  )
)
const gzipped = gzipSync(all, { level: 9 }).length

console.log(`core: ${total} bytes, ${gzipped} bytes gzipped (budget ${BUDGET})`)

if (gzipped > BUDGET) {
  console.error('over the size budget')
  process.exit(1)
}
