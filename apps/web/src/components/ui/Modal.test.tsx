import { describe, test, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Modal } from './Modal.js'

describe('Modal', () => {
  test('renders nothing when closed', () => {
    render(<Modal open={false} onClose={() => {}} title="Hi">body</Modal>)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  test('renders title and children when open', () => {
    render(<Modal open onClose={() => {}} title="Confirm">are you sure</Modal>)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Confirm')).toBeInTheDocument()
    expect(screen.getByText('are you sure')).toBeInTheDocument()
  })

  test('clicking the scrim calls onClose; clicking the dialog does not', () => {
    const onClose = vi.fn()
    render(<Modal open onClose={onClose} title="X">body</Modal>)
    const dialog = screen.getByRole('dialog')
    fireEvent.click(dialog)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(dialog.parentElement as HTMLElement)
    expect(onClose).toHaveBeenCalledOnce()
  })

  test('Escape closes when open', () => {
    const onClose = vi.fn()
    render(<Modal open onClose={onClose}>body</Modal>)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  // Regression: Modal had no focus management at all — Tab could escape to
  // whatever rendered behind the scrim, and opening it left focus on
  // whatever the trigger button was, with no keyboard route into the dialog.
  test('moves focus into the dialog when opened, and Tab wraps within it', () => {
    render(
      <Modal open onClose={() => {}} title="Are you sure?" footer={<button>Submit</button>}>
        <button>Cancel</button>
      </Modal>
    )
    // First focusable element (DOM order: children, then footer) gets focus.
    expect(document.activeElement).toBe(screen.getByText('Cancel'))
    // Tab from the last element wraps back to the first, never escaping the dialog.
    screen.getByText('Submit').focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByText('Cancel'))
  })
})
