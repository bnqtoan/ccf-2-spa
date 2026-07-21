import type { ButtonHTMLAttributes, ReactNode } from 'react'
import './components.css'

export interface CardProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  selected?: boolean
  children?: ReactNode
}

/**
 * Port từ .card / .card.sel (prototype/index.html dòng 93-110).
 * Render bằng thẻ button để đảm bảo hành vi bấm được + focusable,
 * giữ đúng layout khối (display:block, width:100%, text-align:left)
 * như prototype.
 */
export default function Card({ selected = false, className, children, ...props }: CardProps) {
  const classes = ['ccf-card', selected && 'ccf-card--selected', className]
    .filter(Boolean)
    .join(' ')

  return (
    <button type="button" className={classes} {...props}>
      {children}
    </button>
  )
}
