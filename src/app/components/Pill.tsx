import type { HTMLAttributes } from 'react'
import './components.css'

export type PillTone = 'default' | 'gray' | 'warn' | 'red'

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone
}

/**
 * Port từ .pill / .pill.gray / .pill.warn / .pill.red
 * (prototype/index.html dòng 112-116).
 */
export default function Pill({ tone = 'default', className, children, ...props }: PillProps) {
  const classes = [
    'ccf-pill',
    tone === 'gray' && 'ccf-pill--gray',
    tone === 'warn' && 'ccf-pill--warn',
    tone === 'red' && 'ccf-pill--red',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <span className={classes} {...props}>
      {children}
    </span>
  )
}
