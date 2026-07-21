import type { HTMLAttributes } from 'react'
import './components.css'

export interface AvatarProps extends HTMLAttributes<HTMLDivElement> {
  name: string
}

/**
 * Port từ .av (prototype/index.html dòng 322-327).
 * Lấy chữ cái đầu của TỪ CUỐI trong tên, đúng cách prototype làm:
 * name.split(' ').pop()[0] — ví dụ "Chị Lan" -> "L", "Bạn Mai" -> "M".
 */
export default function Avatar({ name, className, ...props }: AvatarProps) {
  const lastWord = name.trim().split(' ').pop() ?? ''
  const initial = lastWord.charAt(0).toUpperCase()
  const classes = ['ccf-av', className].filter(Boolean).join(' ')

  return (
    <div className={classes} aria-label={name} {...props}>
      {initial}
    </div>
  )
}
