import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const API = 'http://127.0.0.1:8090';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The server's CSP forbids inline scripts; the polyfill would inject one.
    modulePreload: { polyfill: false },
    // Never inline assets as data: URIs for scripts/styles.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/skill.md': { target: API, changeOrigin: false },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
