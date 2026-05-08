import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Vite config for the admin dashboard SPA.
 *
 * - Dev mode runs at :5173, proxies `/api` and `/webhooks` to the Fastify
 *   server at :3000 so HMR + the real backend work together.
 * - Build emits to `dist/`. The Fastify server statically serves that
 *   directory in production, with an SPA fallback for client-side routes.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/webhooks': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/setup/manifest': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/setup/callback': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/setup/install': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
