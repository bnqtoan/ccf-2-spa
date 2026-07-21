import type { ButtonHTMLAttributes } from 'react'
import './components.css'

export type ButtonVariant = 'primary' | 'ghost' | 'danger'
export type ButtonSize = 'md' | 'sm'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

/**
 * Port từ .btn / .btn.ghost / .btn.danger / .btn.sm / :disabled
 * (prototype/index.html dòng 179-194).
 *
 * Vùng chạm tối thiểu --tap (48px) cho size="md".
 * size="sm" cố ý 44px — ngoại lệ có chủ đích của prototype cho nút phụ
 * nằm cạnh nút khác, KHÔNG phải lỗi cần "sửa" lên 48px.
 */
export default function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: ButtonProps) {
  const classes = [
    'ccf-btn',
    variant === 'ghost' && 'ccf-btn--ghost',
    variant === 'danger' && 'ccf-btn--danger',
    size === 'sm' && 'ccf-btn--sm',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return <button className={classes} {...props} />
}
