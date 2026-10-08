/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: 'react/jsx-runtime', replacement: fileURLToPath(new URL('./src/csp-jsx-runtime.ts', import.meta.url)) },
      { find: 'react/jsx-dev-runtime', replacement: fileURLToPath(new URL('./src/csp-jsx-dev-runtime.ts', import.meta.url)) },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000'
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    // Deterministic timeouts: a stuck test/hook fails loudly (naming itself)
    // instead of hanging the whole suite under constrained CI/sandbox CPUs.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
