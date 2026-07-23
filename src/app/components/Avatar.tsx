import type { HTMLAttributes } from 'react'
import './components.css'

export interface AvatarProps extends HTMLAttributes<HTMLDivElement> {
  name: string
  /** URL ảnh chân dung thật (tuỳ chọn) — revamp: reference dùng avatar TRÒN
   * ảnh thật cho thẻ KTV. Không có thì fallback nguyên vẹn về chữ cái đầu
   * như hành vi gốc (không đổi test nào phụ thuộc initials). */
  src?: string
}

/**
 * Port từ .av (prototype/index.html dòng 322-327).
 * Lấy chữ cái đầu của TỪ CUỐI trong tên, đúng cách prototype làm:
 * name.split(' ').pop()[0] — ví dụ "Chị Lan" -> "L", "Bạn Mai" -> "M".
 */
export default function Avatar({ name, src, className, ...props }: AvatarProps) {
  const lastWord = name.trim().split(' ').pop() ?? ''
  const initial = lastWord.charAt(0).toUpperCase()
  const classes = ['ccf-av', className].filter(Boolean).join(' ')

  if (src) {
    return (
      <div className={classes} {...props}>
        <img className="ccf-av-img" src={src} alt={name} loading="lazy" />
      </div>
    )
  }

  return (
    <div className={classes} aria-label={name} {...props}>
      {initial}
    </div>
  )
}
