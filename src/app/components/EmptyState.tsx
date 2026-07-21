import type { HTMLAttributes } from 'react'
import './components.css'

export interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  icon: string
  text: string
}

/**
 * Port từ .empty (prototype/index.html dòng 335-336).
 */
export default function EmptyState({ icon, text, className, ...props }: EmptyStateProps) {
  const classes = ['ccf-empty', className].filter(Boolean).join(' ')

  return (
    <div className={classes} {...props}>
      <div className="ccf-empty-icon">{icon}</div>
      <div>{text}</div>
    </div>
  )
}
