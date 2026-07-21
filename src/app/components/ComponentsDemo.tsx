import { useState } from 'react'
import Button from './Button'
import Card from './Card'
import Pill from './Pill'
import Field from './Field'
import Notice from './Notice'
import Sheet from './Sheet'
import Avatar from './Avatar'
import EmptyState from './EmptyState'

/**
 * Trang demo nội bộ — route ẩn /dev/components — dựng đủ component nền
 * (Button/Card/Pill/Field/Notice/Sheet/Avatar/EmptyState) để
 * tests/e2e/components.spec.ts kiểm tra. Không phải màn hình nghiệp vụ.
 */
export default function ComponentsDemo() {
  const [sheetOpen, setSheetOpen] = useState(false)
  const [selected, setSelected] = useState(false)
  const [disabledClicked, setDisabledClicked] = useState(false)

  return (
    <main style={{ padding: 14, maxWidth: 440, margin: '0 auto' }}>
      <h1>Component demo</h1>

      <section>
        <h2 className="ccf-demo-h2">Button</h2>
        <Button data-testid="btn-primary">Xác nhận</Button>
        <Button data-testid="btn-ghost" variant="ghost">
          Quay lại
        </Button>
        <Button data-testid="btn-danger" variant="danger">
          Huỷ lịch
        </Button>
        <Button data-testid="btn-sm" size="sm">
          Nhỏ
        </Button>
        <Button data-testid="btn-disabled" disabled onClick={() => setDisabledClicked(true)}>
          Vô hiệu hoá
        </Button>
        <div data-testid="disabled-clicked-flag">{disabledClicked ? 'clicked' : 'not-clicked'}</div>
      </section>

      <section>
        <h2 className="ccf-demo-h2">Card</h2>
        <Card data-testid="card-default">Thẻ mặc định</Card>
        <Card data-testid="card-selected" selected={selected} onClick={() => setSelected((s) => !s)}>
          Thẻ có thể chọn
        </Card>
      </section>

      <section>
        <h2 className="ccf-demo-h2">Pill</h2>
        <Pill data-testid="pill-default">Mặc định</Pill>
        <Pill data-testid="pill-gray" tone="gray">
          Gray
        </Pill>
        <Pill data-testid="pill-warn" tone="warn">
          Warn
        </Pill>
        <Pill data-testid="pill-red" tone="red">
          Red
        </Pill>
      </section>

      <section>
        <h2 className="ccf-demo-h2">Field</h2>
        <Field data-testid="field-name" label="Họ tên" placeholder="Nhập tên" />
        <Field
          data-testid="field-phone"
          label="Số điện thoại"
          type="tel"
          hint="Dùng để liên hệ xác nhận lịch"
        />
        <Field data-testid="field-error" label="Email" error="Email không hợp lệ" />
      </section>

      <section>
        <h2 className="ccf-demo-h2">Notice</h2>
        <Notice tone="info" data-testid="notice-info">
          Thông tin bình thường.
        </Notice>
        <Notice tone="warn" data-testid="notice-warn">
          Cảnh báo quan trọng.
        </Notice>
      </section>

      <section>
        <h2 className="ccf-demo-h2">Avatar</h2>
        <Avatar name="Chị Lan" data-testid="avatar-1" />
        <Avatar name="Bạn Mai" data-testid="avatar-2" />
      </section>

      <section>
        <h2 className="ccf-demo-h2">EmptyState</h2>
        <EmptyState icon="🌿" text="Chưa có lịch hẹn nào" data-testid="empty-state" />
      </section>

      <section>
        <h2 className="ccf-demo-h2">Sheet</h2>
        <Button data-testid="sheet-trigger" onClick={() => setSheetOpen(true)}>
          Mở sheet
        </Button>
        <Sheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          title="Chi tiết lịch hẹn"
          footer={
            <Button data-testid="sheet-footer-btn" onClick={() => setSheetOpen(false)}>
              Đóng
            </Button>
          }
        >
          <div data-testid="sheet-content">Nội dung bên trong sheet, bấm vào đây không được đóng.</div>
        </Sheet>
      </section>
    </main>
  )
}
