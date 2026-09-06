import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  main: {
    build: {
      lib: { entry: resolve(root, 'src/main/index.ts'), formats: ['cjs'], fileName: () => 'index.cjs' },
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