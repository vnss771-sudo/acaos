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
})
