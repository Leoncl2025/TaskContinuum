#!/usr/bin/env node
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'

// Node 24 strips types. Only owned imports receive TS resolution, never dependencies.
const source = new URL('../src/', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(source) && specifier.startsWith('.')) {
      const target = new URL(specifier, context.parentURL)
      if (target.href.startsWith(source)) {
        if (specifier.endsWith('.js')) return nextResolve(specifier.slice(0, -3) + '.ts', context)
        if (!extname(target.pathname)) return nextResolve(`${specifier}.ts`, context)
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(source) && url.endsWith('.ts')) {
      return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform', sourceUrl: url }) }
    }
    return nextLoad(url, context)
  },
})

const { run } = await import('../src/main/taskDocuments/cli.ts')
try {
  process.exitCode = run(process.argv.slice(2), process.cwd())
} catch (error) {
  console.error(`ERROR [DOCUMENT_COMMAND_FAILED] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
