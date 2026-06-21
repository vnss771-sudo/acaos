import { describe, test, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Card } from './Card.js'

describe('Card', () => {
  test('renders children', () => {
    render(<Card>hello</Card>)
    expect(screen.getByText('hello')).toBeInTheDocument()
  })

  test('fires onClick', async () => {
    const onClick = vi.fn()
    render(<Card onClick={onClick}>click me</Card>)
    await userEvent.click(screen.getByText('click me'))
    expect(onClick).toHaveBeenCalledOnce()
  })

  test('clickable card highlights on hover and still fires onClick', () => {
    const onClick = vi.fn()
    render(<Card onClick={onClick}>hover me</Card>)
    const card = screen.getByText('hover me')
    fireEvent.mouseEnter(card)
    // Hover applies a token-based border highlight.
    expect(card.style.borderColor).not.toBe('')
    fireEvent.mouseLeave(card)
    fireEvent.click(card)
    expect(onClick).toHaveBeenCalledOnce()
  })

  test('non-clickable card does not gain the pointer affordance on hover', () => {
    render(<Card>static</Card>)
    const card = screen.getByText('static')
    // No onClick → no hover wiring; mouseEnter must be a harmless no-op.
    fireEvent.mouseEnter(card)
    expect(card.style.cursor).not.toBe('pointer')
  })
})
