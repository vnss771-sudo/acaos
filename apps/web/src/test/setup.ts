// Vitest global setup: register jest-dom matchers (toBeInTheDocument, etc.) and
// reset mocks between tests.
import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
