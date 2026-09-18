import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Базовий шлях задає лише деплой: на GitHub Pages проектний сайт живе під
// `/<repo>/`, а не в корені домену. Локально й у Vercel-подібному хостингу — `/`.
const base = process.env.PAGES_BASE ?? '/'

export default defineConfig({
  base,
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
