import { describe, test, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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
})
