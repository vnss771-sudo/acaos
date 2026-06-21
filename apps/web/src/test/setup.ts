// Vitest global setup: register jest-dom matchers (toBeInTheDocument, etc.) and
// reset mocks between tests.
import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// jsdom does not implement matchMedia. The responsive layer (useMediaQuery and the
// primitives built on it) calls it, so provide a stub that reports no match — i.e.
// every responsive component renders its DESKTOP branch under test, keeping
// existing snapshots/assertions unchanged. A test that wants the mobile branch can
// override window.matchMedia for its own scope.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

