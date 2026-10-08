import React from 'react'
import { transformStyleProps } from './cspStyle'

export const Fragment = React.Fragment

export function jsxDEV(
  type: React.ElementType,
  props: Record<string, unknown> | null,
  key?: React.Key,
) {
  const nextProps = typeof type === 'string' ? transformStyleProps(props) : props
  return React.createElement(type, { ...(nextProps), ...(key == null ? {} : { key }) })
}
