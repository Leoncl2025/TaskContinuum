import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ['unified', 'remark-parse', 'remark-gfm', 'remark-frontmatter', 'mdast-util-to-string'] },
      lib: { entry: { index: resolve(root, 'src/main/index.ts'), 'shared-host': resolve(root, 'src/main/shared/daemon.ts') }, formats: ['cjs'], fileName: (_format, name) => `${name}.cjs` },
    },
  },
  preload: {
    build: {
      lib: { entry: resolve(root, 'src/preload/index.ts'), formats: ['cjs'], fileName: () => 'index.cjs' },
    },
  },
  renderer: {
    plugins: [react()],
    server: { host: '127.0.0.1', port: 5177, strictPort: true },
    build: { minify: true, reportCompressedSize: true },
  },
})