import { describe, test, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Drawer } from './Drawer.js'

describe('Drawer', () => {
  test('renders nothing when closed', () => {
    render(<Drawer open={false} onClose={() => {}}>nav</Drawer>)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  test('renders children when open and closes on scrim click', () => {
    const onClose = vi.fn()
    render(<Drawer open onClose={onClose}>nav content</Drawer>)
    expect(screen.getByText('nav content')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement)
    expect(onClose).toHaveBeenCalledOnce()
  })

  // Regression: Drawer had no focus management — Tab could escape to the app
  // shell rendered behind the scrim while the drawer was open.
  test('moves focus into the panel when opened, and Tab wraps within it', () => {
    render(
      <Drawer open onClose={() => {}}>
        <button>First link</button>
        <button>Last link</button>
      </Drawer>
    )
    expect(document.activeElement).toBe(screen.getByText('First link'))
    screen.getByText('Last link').focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByText('First link'))
  })
})
