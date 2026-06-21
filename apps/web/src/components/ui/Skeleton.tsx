import React from 'react'
import { colors } from '../../styles.js'

type Props = {
  width?: number | string
  height?: number | string
  radius?: number
  style?: React.CSSProperties
}

// Loading placeholder. The `pulse` keyframe lives in animations.css (bundled, CSP
// `style-src-elem 'self'`) — never an inline <style>.
export function Skeleton({ width = '100%', height = 16, radius = 6, style }: Props) {
  return (
    <div
      role="status"
      aria-label="Loading"
      aria-busy="true"
      style={{ width, height, borderRadius: radius, background: colors.bgElevated, animation: 'pulse 1.4s ease-in-out infinite', ...style }}
    />
  )
}
