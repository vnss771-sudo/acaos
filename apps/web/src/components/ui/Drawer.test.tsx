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
})
