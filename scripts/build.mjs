import { copyFile, mkdir } from 'node:fs/promises'

await mkdir(new URL('../lib/', import.meta.url), { recursive: true })
await copyFile(new URL('../index.js', import.meta.url), new URL('../lib/index.js', import.meta.url))
await copyFile(new URL('../lsp-config.cjs', import.meta.url), new URL('../lib/lsp-config.cjs', import.meta.url))
