import { useEffect, useMemo, useState } from 'react'
import Button from '../../components/Button'
import Card from '../../components/Card'
import EmptyState from '../../components/EmptyState'
import Field from '../../components/Field'
import Notice from '../../components/Notice'
import Pill from '../../components/Pill'
import {
  ApiError,
  type AvailabilitySlot,
  cancelBooking,
  type CustomerBooking,
  getAvailability,
  getBookingsByPhone,
  rescheduleBooking,
} from './api'
import {
  dateChipLabel,
  dayOfMonth,
  dayPartOf,
  formatWhen,
  hm,
  hoursUntil,
  next14Days,
} from './format'
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
  // Lịch đang được ĐỔI GIỜ (T-24). Khác null → hiện màn chọn giờ mới của đúng
  // dịch vụ đó, thay cho danh sách. null → danh sách bình thường.
  const [rescheduling, setRescheduling] = useState<CustomerBooking | null>(null)

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

  // Đổi giờ thành công: cập nhật lịch tại chỗ (giờ + KTV mới), thoát màn đổi giờ.
  const handleRescheduled = (itemId: number, updated: CustomerBooking) => {
    setBookings((prev) =>
      (prev ?? []).map((b) =>
        b.item_id === itemId
          ? { ...b, start_at: updated.start_at, end_at: updated.end_at, block_end_at: updated.block_end_at, staff_id: updated.staff_id }
          : b,
      ),
    )
    setRescheduling(null)
  }

  // Server bất ngờ trả CANCEL_TOO_LATE khi đang đổi giờ (đồng hồ lệch) →
  // chuyển lịch đó sang hotline như luồng huỷ, thoát màn đổi giờ.
  const handleRescheduleTooLate = (itemId: number) => {
    setForceHotline((prev) => new Set(prev).add(itemId))
    setRescheduling(null)
  }

  // Màn ĐỔI GIỜ chiếm trọn khung, thay cho danh sách, cho tới khi xong/huỷ.
  if (rescheduling !== null) {
    return (
      <RescheduleScreen
        booking={rescheduling}
        onCancel={() => setRescheduling(null)}
        onRescheduled={(updated) => handleRescheduled(rescheduling.item_id, updated)}
        onTooLate={() => handleRescheduleTooLate(rescheduling.item_id)}
      />
    )
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
                  variant="ghost"
                  onClick={() => setRescheduling(b)}
                  data-testid={`reschedule-${b.item_id}`}
                >
                  Đổi giờ
                </Button>
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

// ---------------------------------------------------------------------------
// Đổi giờ (T-24) — mở lại lưới chọn giờ của ĐÚNG dịch vụ lịch này, chọn giờ
// mới, xác nhận. Cùng khuôn với TimeScreen của BookingPage nhưng gói gọn trong
// thư mục lookup/ (touches). KTV giữ nguyên (khách chỉ đổi GIỜ) → không gửi
// staff_id, server giữ KTV cũ.
// ---------------------------------------------------------------------------

const SPA_PHONE_DISPLAY_RS = '028 3822 1179'

function RescheduleScreen({
  booking,
  onCancel,
  onRescheduled,
  onTooLate,
}: {
  booking: CustomerBooking
  onCancel: () => void
  onRescheduled: (updated: CustomerBooking) => void
  onTooLate: () => void
}) {
  const days = useMemo(() => next14Days(), [])
  const [dateStr, setDateStr] = useState(days[0] ?? '')
  const [slots, setSlots] = useState<AvailabilitySlot[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selectedStartAt, setSelectedStartAt] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSlots(null)
    setError(null)
    setSelectedStartAt(null)
    getAvailability(booking.variant_id, dateStr)
      .then((rows) => {
        if (!cancelled) setSlots(rows)
      })
      .catch(() => {
        if (!cancelled) setError('Không tải được khung giờ. Vui lòng thử lại.')
      })
    return () => {
      cancelled = true
    }
  }, [dateStr, booking.variant_id])

  const grouped = useMemo(() => {
    const groups: Record<'Buổi sáng' | 'Buổi chiều' | 'Buổi tối', AvailabilitySlot[]> = {
      'Buổi sáng': [],
      'Buổi chiều': [],
      'Buổi tối': [],
    }
    for (const slot of slots ?? []) groups[dayPartOf(slot.start_at)].push(slot)
    return groups
  }, [slots])

  async function reloadSlots() {
    try {
      const rows = await getAvailability(booking.variant_id, dateStr)
      setSlots(rows)
    } catch {
      // giữ danh sách cũ; notice đã báo cho khách.
    }
  }

  async function handleConfirm() {
    if (selectedStartAt === null || submitting) return
    setSubmitting(true)
    setNotice(null)
    try {
      // KTV giữ nguyên: không gửi staff_id → server giữ KTV cũ của lịch.
      const updated = await rescheduleBooking(booking.item_id, selectedStartAt)
      onRescheduled(updated)
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'SLOT_TAKEN') {
          // Giờ mới vừa bị cướp (race). Item CŨ vẫn nguyên (server đảm bảo).
          // Báo nhẹ, tải lại khung giờ để khách chọn giờ khác — không mã lỗi thô.
          setNotice('Giờ này vừa có người đặt mất. Bạn chọn giờ khác giúp mình nhé.')
          setSelectedStartAt(null)
          await reloadSlots()
          setSubmitting(false)
          return
        }
        if (err.code === 'CANCEL_TOO_LATE') {
          // Dưới 2 tiếng (đồng hồ lệch) — chuyển sang hotline như luồng huỷ.
          onTooLate()
          return
        }
      }
      // 422/OUTSIDE_SHIFT/STAFF_LACKS_SKILL/khác — báo chung, chọn lại.
      setNotice(
        `Rất tiếc, chưa đổi được sang giờ này. Bạn thử giờ khác, hoặc gọi ${SPA_PHONE_DISPLAY_RS} để được hỗ trợ.`,
      )
      setSelectedStartAt(null)
      await reloadSlots()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="ccf-lk-page">
      <div className="ccf-lk-h2">Đổi giờ</div>
      <p className="ccf-lk-lede">
        {booking.service_name} · {booking.variant_name}
        <br />
        Giờ hiện tại: {formatWhen(booking.start_at)}
      </p>

      <div className="ccf-lk-rs-dates" data-testid="reschedule-dates">
        {days.map((d, i) => (
          <button
            key={d}
            type="button"
            className={`ccf-lk-rs-date ${dateStr === d ? 'ccf-lk-rs-date--sel' : ''}`}
            onClick={() => setDateStr(d)}
            data-testid={`rs-date-${d}`}
          >
            <div className="ccf-lk-rs-dw">{dateChipLabel(d, i === 0)}</div>
            <div className="ccf-lk-rs-dd">{dayOfMonth(d)}</div>
          </button>
        ))}
      </div>

      {error && <Notice tone="warn" data-testid="reschedule-error">{error}</Notice>}
      {notice && <Notice tone="warn" data-testid="reschedule-notice">{notice}</Notice>}

      {slots !== null && slots.length === 0 && (
        <EmptyState icon="🗓️" text="Ngày này đã kín lịch. Bạn chọn ngày khác nhé." data-testid="reschedule-empty" />
      )}

      {(Object.entries(grouped) as ['Buổi sáng' | 'Buổi chiều' | 'Buổi tối', AvailabilitySlot[]][])
        .filter(([, v]) => v.length > 0)
        .map(([part, partSlots]) => (
          <div key={part}>
            <div className="ccf-lk-rs-daypart">{part}</div>
            <div className="ccf-lk-rs-slots">
              {partSlots.map((s) => (
                <button
                  key={s.start_at}
                  type="button"
                  className={`ccf-lk-rs-slot ${selectedStartAt === s.start_at ? 'ccf-lk-rs-slot--sel' : ''}`}
                  onClick={() => setSelectedStartAt(s.start_at)}
                  data-testid={`rs-slot-${s.start_at}`}
                >
                  {hm(s.start_at)}
                </button>
              ))}
            </div>
          </div>
        ))}

      {selectedStartAt !== null && (
        <Card selected data-testid="reschedule-chosen">
          <div className="ccf-lk-row">
            <div>
              <div className="ccf-lk-t">Giờ mới</div>
              <div className="ccf-lk-d">{formatWhen(selectedStartAt)}</div>
            </div>
            <Pill>Đã chọn</Pill>
          </div>
        </Card>
      )}

      <div className="ccf-lk-rs-dock">
        <Button variant="ghost" onClick={onCancel} data-testid="reschedule-back">
          Quay lại
        </Button>
        <Button
          disabled={selectedStartAt === null || submitting}
          onClick={handleConfirm}
          data-testid="reschedule-confirm"
        >
          {submitting ? 'Đang đổi...' : selectedStartAt !== null ? `Xác nhận · ${hm(selectedStartAt)}` : 'Chọn giờ mới'}
        </Button>
      </div>
    </div>
  )
}
