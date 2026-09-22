import React, { useRef } from 'react'
import { describe, test, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { useFocusTrap } from './useFocusTrap.js'

function Probe({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useFocusTrap(ref, active)
  return (
    <div>
      <button>outside-before</button>
      <div ref={ref} tabIndex={-1} data-testid="trap">
        <button>first</button>
        <button>second</button>
        <button>last</button>
      </div>
      <button>outside-after</button>
    </div>
  )
}

describe('useFocusTrap', () => {
  test('moves focus into the container when activated', () => {
    render(<Probe active />)
    expect(document.activeElement).toBe(screen.getByText('first'))
  })

  test('does nothing when inactive', () => {
    const outsideBtn = document.createElement('button')
    document.body.appendChild(outsideBtn)
    outsideBtn.focus()
    render(<Probe active={false} />)
    expect(document.activeElement).toBe(outsideBtn)
    document.body.removeChild(outsideBtn)
  })

  test('Tab from the last focusable element wraps to the first', () => {
    render(<Probe active />)
    screen.getByText('last').focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByText('first'))
  })

  test('Shift+Tab from the first focusable element wraps to the last', () => {
    render(<Probe active />)
    screen.getByText('first').focus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByText('last'))
  })

  test('Tab in the middle of the trap is left alone (default browser behavior)', () => {
    render(<Probe active />)
    screen.getByText('first').focus()
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    const prevented = !window.dispatchEvent(event)
    expect(prevented).toBe(false)
  })

  test('restores focus to the previously-focused element when deactivated', () => {
    const outsideBtn = document.createElement('button')
    document.body.appendChild(outsideBtn)
    outsideBtn.focus()

    const { rerender } = render(<Probe active={false} />)
    // Activate, then re-render as active=false is what a real dialog does on close.
    rerender(<Probe active />)
    expect(document.activeElement).not.toBe(outsideBtn)
    rerender(<Probe active={false} />)
    expect(document.activeElement).toBe(outsideBtn)

    document.body.removeChild(outsideBtn)
  })

  test('focuses the container itself when it has no focusable descendants', () => {
    function EmptyProbe({ active }: { active: boolean }) {
      const ref = useRef<HTMLDivElement | null>(null)
      useFocusTrap(ref, active)
      return <div ref={ref} tabIndex={-1} data-testid="empty-trap">no interactive children</div>
    }
    render(<EmptyProbe active />)
    expect(document.activeElement).toBe(screen.getByTestId('empty-trap'))
  })
})
