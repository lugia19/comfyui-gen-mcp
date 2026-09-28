import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

// Built into web/dist (committed: users' builds have no node). The Worker serves it as static
// assets; `npm run dev` proxies the API to a local `pywrangler dev` on :8788.
export default defineConfig({
  plugins: [svelte()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:8788' } },
})
