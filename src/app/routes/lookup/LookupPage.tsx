import { useEffect, useState } from 'react'
import Button from '../../components/Button'
import EmptyState from '../../components/EmptyState'
import Field from '../../components/Field'
import Notice from '../../components/Notice'
import Pill from '../../components/Pill'
import { ApiError, cancelBooking, getBookingsByPhone, type CustomerBooking } from './api'
import { formatWhen, hoursUntil } from './format'
import './lookup.css'

// Số hotline của spa — theo đúng prototype/index.html dòng 678-681.
const SPA_PHONE_DISPLAY = '028 3822 1179'
const SPA_PHONE_TEL = 'tel:02838221179'

// Ngưỡng hiển thị của UI — CHỈ để quyết định hiện gì trên màn hình. Server
// (CANCEL_CUTOFF_MIN trong src/worker/lib/status.ts) mới là trọng tài cuối
// cùng; UI không bao giờ tự tin tưởng con số này để bỏ qua phản hồi 409 thật.
const CANCEL_CUTOFF_DISPLAY_HOURS = 2

type Screen = { name: 'phone' } | { name: 'list'; phone: string }

export default function LookupPage() {
  const [screen, setScreen] = useState<Screen>({ name: 'phone' })
  const [phoneInput, setPhoneInput] = useState('')

  if (screen.name === 'phone') {
    return (
      <PhoneScreen
        phoneInput={phoneInput}
        onPhoneInputChange={setPhoneInput}
        onSubmit={(phone) => setScreen({ name: 'list', phone })}
      />
    )
  }

  return <BookingsScreen phone={screen.phone} onBack={() => setScreen({ name: 'phone' })} />
}

function PhoneScreen({
  phoneInput,
  onPhoneInputChange,
  onSubmit,
}: {
  phoneInput: string
  onPhoneInputChange: (v: string) => void
  onSubmit: (phone: string) => void
}) {
  const canSubmit = phoneInput.replace(/\D/g, '').length >= 9

  return (
    <div className="ccf-lk-page">
      <div className="ccf-lk-h2">Lịch hẹn của tôi</div>
      <p className="ccf-lk-lede">Nhập số điện thoại bạn đã dùng khi đặt lịch.</p>
      <Field
        label="Số điện thoại"
        type="tel"
        inputMode="numeric"
        placeholder="0901 234 567"
        value={phoneInput}
        onChange={(e) => onPhoneInputChange(e.target.value)}
        data-testid="lookup-phone-input"
      />
      <Notice tone="info">Không cần mật khẩu. Chúng tôi chỉ hiện lịch gắn với số này.</Notice>
      <Button
        disabled={!canSubmit}
        onClick={() => onSubmit(phoneInput.trim())}
        data-testid="lookup-submit"
      >
        Xem lịch hẹn
      </Button>
    </div>
  )
}

function BookingsScreen({ phone, onBack }: { phone: string; onBack: () => void }) {
  const [bookings, setBookings] = useState<CustomerBooking[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // item_id các lịch mà server VỪA trả 409 CANCEL_TOO_LATE bất ngờ (đồng hồ
  // khách lệch, hoặc dữ liệu đổi giữa lúc tải trang và lúc bấm huỷ). Từ lúc
  // đó UI luôn hiện hotline cho lịch này, không hiện lại nút huỷ nữa.
  const [forceHotline, setForceHotline] = useState<Set<number>>(new Set())

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getBookingsByPhone(phone)
      .then((rows) => {
        if (!cancelled) setBookings(rows)
      })
      .catch(() => {
        if (!cancelled) setError('Không tải được lịch hẹn. Vui lòng thử lại.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone])

  const handleCancel = async (item: CustomerBooking) => {
    const ok = window.confirm(`Huỷ lịch ${formatWhen(item.start_at)}?\n\nSlot sẽ được mở lại cho khách khác.`)
    if (!ok) return

    try {
      await cancelBooking(item.item_id)
      // 200 → cập nhật danh sách tại chỗ, không cần tải lại trang.
      setBookings((prev) =>
        (prev ?? []).map((b) => (b.item_id === item.item_id ? { ...b, status: 'cancelled' } : b)),
      )
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CANCEL_TOO_LATE') {
        // Bất ngờ trả 409 dù UI tính trước là còn xa giờ hẹn — không hiện mã
        // lỗi thô, chuyển ngay sang giao diện hotline giống hệt case <2 tiếng.
        setForceHotline((prev) => new Set(prev).add(item.item_id))
        return
      }
      setError('Không huỷ được lịch này. Vui lòng thử lại hoặc gọi cho spa.')
    }
  }

  if (loading && bookings === null) {
    return (
      <div className="ccf-lk-page">
        <div className="ccf-lk-h2">Lịch hẹn của tôi</div>
        <p className="ccf-lk-lede">{phone}</p>
        <p data-testid="lookup-loading">Đang tải...</p>
      </div>
    )
  }

  if (error && bookings === null) {
    return (
      <div className="ccf-lk-page">
        <div className="ccf-lk-h2">Lịch hẹn của tôi</div>
        <Notice tone="warn" data-testid="lookup-error">
          {error}
        </Notice>
        <Button variant="ghost" onClick={onBack}>
          Quay lại
        </Button>
      </div>
    )
  }

  const rows = bookings ?? []
  const upcoming = rows.filter((b) => b.status === 'booked')
  const cancelled = rows.filter((b) => b.status === 'cancelled')
  const done = rows.filter((b) => b.status === 'done' || b.status === 'no_show')

  return (
    <div className="ccf-lk-page">
      <div className="ccf-lk-h2">Lịch hẹn của tôi</div>
      <p className="ccf-lk-lede">{phone}</p>

      {upcoming.length === 0 && (
        <EmptyState icon="🌿" text="Bạn chưa có lịch hẹn sắp tới." data-testid="lookup-empty" />
      )}

      {upcoming.length > 0 && <div className="ccf-lk-label">Sắp tới</div>}
      {upcoming.map((b) => {
        const hrs = hoursUntil(b.start_at)
        const tooSoon = hrs < CANCEL_CUTOFF_DISPLAY_HOURS || forceHotline.has(b.item_id)
        return (
          <div className="ccf-lk-bk" key={b.item_id} data-testid={`booking-${b.item_id}`}>
            <div className="ccf-lk-row">
              <div className="ccf-lk-when">{formatWhen(b.start_at)}</div>
              {tooSoon ? (
                <Pill tone="warn">Sắp bắt đầu</Pill>
              ) : (
                <Pill>Đã xác nhận</Pill>
              )}
            </div>
            <div className="ccf-lk-what">
              {b.service_name} · {b.variant_name}
              <br />
              Kỹ thuật viên: {b.staff_name}
            </div>
            {tooSoon ? (
              <Notice tone="warn" className="ccf-lk-notice-margin">
                Còn dưới 2 tiếng nên không huỷ trực tuyến được. Bạn gọi giúp spa để đổi giờ nhé — thường
                vẫn xếp được.
                <a className="ccf-lk-tel" href={SPA_PHONE_TEL} data-testid={`tel-${b.item_id}`}>
                  📞 {SPA_PHONE_DISPLAY}
                </a>
              </Notice>
            ) : (
              <div className="ccf-lk-acts">
                <Button
                  variant="danger"
                  onClick={() => handleCancel(b)}
                  data-testid={`cancel-${b.item_id}`}
                >
                  Huỷ lịch
                </Button>
              </div>
            )}
          </div>
        )
      })}

      {cancelled.length > 0 && <div className="ccf-lk-label">Đã huỷ</div>}
      {cancelled.map((b) => (
        <div className="ccf-lk-bk ccf-lk-bk--past" key={b.item_id} data-testid={`booking-${b.item_id}`}>
          <div className="ccf-lk-row">
            <div className="ccf-lk-when">{formatWhen(b.start_at)}</div>
            <Pill tone="gray">Đã huỷ</Pill>
          </div>
          <div className="ccf-lk-what">
            {b.service_name} · {b.variant_name}
          </div>
        </div>
      ))}

      {done.length > 0 && <div className="ccf-lk-label">Đã hoàn thành</div>}
      {done.map((b) => (
        <div className="ccf-lk-bk ccf-lk-bk--past" key={b.item_id} data-testid={`booking-${b.item_id}`}>
          <div className="ccf-lk-row">
            <div className="ccf-lk-when">{formatWhen(b.start_at)}</div>
            <Pill tone="gray">Xong</Pill>
          </div>
          <div className="ccf-lk-what">
            {b.service_name} · {b.variant_name} · {b.staff_name}
          </div>
        </div>
      ))}
    </div>
  )
}
