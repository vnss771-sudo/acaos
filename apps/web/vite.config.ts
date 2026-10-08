/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
    // Node 25+ enables a built-in Web Storage global that is undefined without
    // --localstorage-file and shadows jsdom's localStorage. Turn it off so tests
    // use the jsdom implementation on every supported Node version.
    execArgv: ['--no-experimental-webstorage'],
    // Deterministic timeouts: a stuck test/hook fails loudly (naming itself)
    // instead of hanging the whole suite under constrained CI/sandbox CPUs.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
