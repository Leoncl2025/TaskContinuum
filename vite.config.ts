import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
})