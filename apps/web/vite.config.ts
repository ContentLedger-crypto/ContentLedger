import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// Базовий шлях задає лише деплой: на GitHub Pages проектний сайт живе під
// `/<repo>/`, а не в корені домену. Локально й у Vercel-подібному хостингу — `/`.
const base = process.env.PAGES_BASE ?? '/'

// Variables come from the root `.env`, as `.env.example` describes. The page sees only
// `VITE_*`; `GATEWAY_URL` is read by the dev server alone, to proxy `/v1`.
const envDir = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig(({ mode }) => ({
  base,
  envDir,
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: { '/v1': loadEnv(mode, envDir, '').GATEWAY_URL ?? 'http://127.0.0.1:8879' },
  },
}))
