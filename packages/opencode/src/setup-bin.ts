#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { runClaustrumSetup } from './setup.js'

export { runClaustrumSetup }

let isMain = false
try {
  isMain =
    !!process.argv[1] &&
    import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
} catch {}
if (isMain) {
  try {
    await runClaustrumSetup(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
