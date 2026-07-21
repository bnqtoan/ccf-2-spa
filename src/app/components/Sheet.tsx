import type { MouseEvent, ReactNode } from 'react'
import './components.css'

export interface SheetProps {
  open: boolean
  onClose: () => void
  title: string
  children?: ReactNode
  footer?: ReactNode
}

/**
 * Port từ .mask + .sheet — modal trượt lên từ đáy màn hình
 * (prototype/index.html dòng 291-317, hàm sheet()/closeSheet() dòng 853-854).
 *
 * Đóng khi bấm nút X hoặc bấm vào lớp nền mờ (mask), KHÔNG đóng khi bấm
 * vào nội dung bên trong sheet — dùng đúng cách kiểm tra
 * event.target === overlay như prototype (dòng 393):
 * onclick="if(event.target===this)closeSheet()"
 */
export default function Sheet({ open, onClose, title, children, footer }: SheetProps) {
  if (!open) return null

  function handleMaskClick(e: MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  return (
    <div className="ccf-mask" onClick={handleMaskClick}>
      <div className="ccf-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="ccf-sheet-sh">
          <h3>{title}</h3>
          <button type="button" className="ccf-x" onClick={onClose} aria-label="Đóng">
            ×
          </button>
        </div>
        <div className="ccf-sheet-sb">{children}</div>
        {footer && <div className="ccf-sheet-sf">{footer}</div>}
      </div>
    </div>
  )
}
