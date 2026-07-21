import type { HTMLAttributes } from 'react'
import './components.css'

export type NoticeTone = 'info' | 'warn'

export interface NoticeProps extends HTMLAttributes<HTMLDivElement> {
  tone?: NoticeTone
}

/**
 * Port từ .notice.info / .notice.warn (prototype/index.html dòng 197-203).
 */
export default function Notice({ tone = 'info', className, children, ...props }: NoticeProps) {
  const classes = [
    'ccf-notice',
    tone === 'warn' ? 'ccf-notice--warn' : 'ccf-notice--info',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes} {...props}>
      {children}
    </div>
  )
}
