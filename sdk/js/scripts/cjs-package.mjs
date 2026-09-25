// dist/cjs is CommonJS inside a "type": "module" package, so it needs its own
// package.json saying so, or Node reads every file there as ESM.
import { writeFile } from 'node:fs/promises'

await writeFile(new URL('../dist/cjs/package.json', import.meta.url), '{ "type": "commonjs" }\n')
