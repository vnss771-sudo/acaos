import { describe, test, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { useEscapeKey } from './useEscapeKey.js'

function Probe({ handler, active }: { handler: () => void; active?: boolean }) {
  useEscapeKey(handler, active)
  return <div>probe</div>
}

describe('useEscapeKey', () => {
  test('calls the handler when Escape is pressed', () => {
    const handler = vi.fn()
    render(<Probe handler={handler} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  test('does nothing for other keys', () => {
    const handler = vi.fn()
    render(<Probe handler={handler} />)
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(handler).not.toHaveBeenCalled()
  })

  test('is inert when not active', () => {
    const handler = vi.fn()
    render(<Probe handler={handler} active={false} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(handler).not.toHaveBeenCalled()
  })
})
