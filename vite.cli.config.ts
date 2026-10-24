import { builtinModules } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build, defineConfig } from 'vite'

const external = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)]

export default defineConfig({
  plugins: [{
    name: 'standalone-file-transfer-mcp',
    apply: 'build',
    async closeBundle() {
      await build({
        configFile: false,
        build: {
          target: 'node24', outDir: 'out/cli', emptyOutDir: false, minify: false,
          lib: {
            entry: fileURLToPath(new URL('./src/main/fileTransferMcp/entry.ts', import.meta.url)),
            formats: ['cjs'], fileName: () => 'taskcontinuum-files-mcp.cjs',
          },
          rollupOptions: { external },
        },
      })
      await build({
        configFile: false,
        define: {
          __TC_MIGRATION_CODE_COMMIT__: JSON.stringify(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()),
          __TC_MIGRATION_BUILD_CLEAN__: JSON.stringify(execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1'], { encoding: 'utf8' }).trim() === ''),
        },
        resolve: { conditions: ['node', 'module'], mainFields: ['module', 'main'] },
        build: {
          target: 'node24', outDir: 'out/cli', emptyOutDir: false, minify: false,
          lib: {
            entry: fileURLToPath(new URL('./src/main/migration/entry.ts', import.meta.url)),
            formats: ['cjs'], fileName: () => 'taskcontinuum-migrate.cjs',
          },
          rollupOptions: { external: [...external, 'electron'] },
        },
      })
    },
  }],
  build: {
    target: 'node24',
    outDir: 'out/cli',
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('./src/main/taskDocuments/entry.ts', import.meta.url)),
      formats: ['cjs'],
      fileName: () => 'task-documents.cjs',
    },
    rollupOptions: {
      external,
    },
  },
})
