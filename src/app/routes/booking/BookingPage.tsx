import { useEffect, useMemo, useState } from 'react'
import Avatar from '../../components/Avatar'
import Button from '../../components/Button'
import Card from '../../components/Card'
import EmptyState from '../../components/EmptyState'
import Field from '../../components/Field'
import Notice from '../../components/Notice'
import Pill from '../../components/Pill'
import {
  ApiError,
  createBooking,
  getAvailability,
  getServices,
  type AvailabilitySlot,
  type BookingResult,
  type Service,
  type ServiceVariant,
} from '../../lib/apiClient'
import { dateChipLabel, dateStrOf, dayOfMonth, dayPartOf, formatVnd, fullDateLabel, hm, next14Days } from './format'
import './booking.css'

// Số hotline của spa — theo đúng prototype/index.html dòng 646 ("028 3822 1179").
const SPA_PHONE_DISPLAY = '028 3822 1179'

type StepName = 'service' | 'variant' | 'time' | 'confirm'
const STEP_ORDER: StepName[] = ['service', 'variant', 'time', 'confirm']

type Screen =
  | { name: 'service' }
  | { name: 'variant'; service: Service }
  | { name: 'time'; service: Service; variant: ServiceVariant }
  | {
      name: 'confirm'
      service: Service
      variant: ServiceVariant
      dateStr: string
      startAt: number
      staffId: number | null // null = "Để spa sắp xếp"
    }
  | {
      name: 'done'
      service: Service
      variant: ServiceVariant
      dateStr: string
      startAt: number
      staffId: number | null
      result: BookingResult
    }

/** Khoá dữ liệu cần cho bước xác nhận — server luôn là trọng tài cuối
 * (CONVENTIONS + cạm bẫy đã biết của card), state này chỉ giữ lựa chọn của
 * khách để hiển thị lại, không tự quyết định hợp lệ hay không. */
export default function BookingPage() {
  const [screen, setScreen] = useState<Screen>({ name: 'service' })

  const stepIndex = STEP_ORDER.indexOf(screen.name as StepName)
  const showSteps = screen.name !== 'service' && screen.name !== 'done'

  function goBack() {
    if (screen.name === 'variant') setScreen({ name: 'service' })
    else if (screen.name === 'time') setScreen({ name: 'variant', service: screen.service })
    else if (screen.name === 'confirm')
      setScreen({ name: 'time', service: screen.service, variant: screen.variant })
  }

  let title = 'Sen Spa'
  let sub = 'Đặt lịch trong 30 giây'
  if (screen.name === 'variant') {
    title = screen.service.name
    sub = 'Chọn gói phù hợp'
  } else if (screen.name === 'time') {
    title = 'Chọn ngày & giờ'
    sub = `${screen.service.name} · ${screen.variant.name}`
  } else if (screen.name === 'confirm') {
    title = 'Xác nhận'
    sub = 'Kiểm tra lại thông tin'
  } else if (screen.name === 'done') {
    title = 'Đã đặt lịch'
    sub = ''
  }

  return (
    <div className="ccf-bk-page">
      <div className="ccf-bk-bar">
        {screen.name !== 'service' && screen.name !== 'done' && (
          <button className="ccf-bk-iconbtn" onClick={goBack} aria-label="Quay lại">
            ←
          </button>
        )}
        <div>
          <h1>{title}</h1>
          <div className="ccf-bk-sub">{sub}</div>
        </div>
      </div>
      {showSteps && (
        <div className="ccf-bk-steps">
          {[0, 1, 2, 3].map((i) => (
            <i key={i} className={i <= stepIndex ? 'ccf-bk-step--on' : ''} />
          ))}
        </div>
      )}
      <main className="ccf-bk-main">
        {screen.name === 'service' && (
          <ServiceScreen onPick={(service) => setScreen({ name: 'variant', service })} />
        )}
        {screen.name === 'variant' && (
          <VariantScreen
            service={screen.service}
            onContinue={(variant) => setScreen({ name: 'time', service: screen.service, variant })}
          />
        )}
        {screen.name === 'time' && (
          <TimeScreen
            service={screen.service}
            variant={screen.variant}
            onContinue={(dateStr, startAt, staffId) =>
              setScreen({
                name: 'confirm',
                service: screen.service,
                variant: screen.variant,
                dateStr,
                startAt,
                staffId,
              })
            }
          />
        )}
        {screen.name === 'confirm' && (
          <ConfirmScreen
            service={screen.service}
            variant={screen.variant}
            dateStr={screen.dateStr}
            startAt={screen.startAt}
            staffId={screen.staffId}
            onSlotTaken={() =>
              setScreen({ name: 'time', service: screen.service, variant: screen.variant })
            }
            onDone={(result) =>
              setScreen({
                name: 'done',
                service: screen.service,
                variant: screen.variant,
                dateStr: screen.dateStr,
                startAt: screen.startAt,
                staffId: screen.staffId,
                result,
              })
            }
          />
        )}
        {screen.name === 'done' && (
          <DoneScreen
            service={screen.service}
            variant={screen.variant}
            dateStr={screen.dateStr}
            startAt={screen.startAt}
            staffId={screen.staffId}
            result={screen.result}
            onHome={() => setScreen({ name: 'service' })}
          />
        )}
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 1. Danh sách dịch vụ
// ---------------------------------------------------------------------------

function ServiceScreen({ onPick }: { onPick: (service: Service) => void }) {
  const [services, setServices] = useState<Service[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getServices()
      .then((rows) => {
        if (!cancelled) setServices(rows)
      })
      .catch(() => {
        if (!cancelled) setError('Không tải được danh sách dịch vụ. Vui lòng thử lại.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <>
      <div className="ccf-bk-h2">Bạn muốn làm gì hôm nay?</div>
      <p className="ccf-bk-lede">Chọn dịch vụ, chúng tôi sắp kỹ thuật viên phù hợp.</p>
      {error && <Notice tone="warn">{error}</Notice>}
      {services === null && !error && <p>Đang tải...</p>}
      {services?.map((s) => {
        const fromPrice = Math.min(...s.variants.map((v) => v.price))
        return (
          <Card key={s.id} onClick={() => onPick(s)} data-testid={`service-${s.id}`}>
            <div className="ccf-bk-row">
              <div>
                <div className="ccf-bk-t">{s.name}</div>
                <div style={{ marginTop: 8 }}>
                  <Pill>từ {formatVnd(fromPrice)}</Pill>
                </div>
              </div>
              <div className="ccf-bk-chev">›</div>
            </div>
          </Card>
        )
      })}
    </>
  )
}

// ---------------------------------------------------------------------------
// 2. Chọn gói (variant)
// ---------------------------------------------------------------------------

function VariantScreen({
  service,
  onContinue,
}: {
  service: Service
  onContinue: (variant: ServiceVariant) => void
}) {
  const [selected, setSelected] = useState<ServiceVariant | null>(null)

  return (
    <>
      <div className="ccf-bk-h2">{service.name}</div>
      <div className="ccf-bk-label">Chọn thời lượng</div>
      {service.variants.map((v) => (
        <Card
          key={v.id}
          selected={selected?.id === v.id}
          onClick={() => setSelected(v)}
          data-testid={`variant-${v.id}`}
        >
          <div className="ccf-bk-row">
            <div>
              <div className="ccf-bk-t">{v.name}</div>
              <div className="ccf-bk-d">Nghỉ {v.buffer_after_min} phút dọn dẹp sau đó</div>
            </div>
            <div className="ccf-bk-price">{formatVnd(v.price)}</div>
          </div>
        </Card>
      ))}
      <div className="ccf-bk-dock">
        <Button
          disabled={selected === null}
          onClick={() => selected && onContinue(selected)}
          data-testid="variant-continue"
        >
          Tiếp tục
        </Button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// 3. Chọn ngày + giờ (+ KTV)
// ---------------------------------------------------------------------------

function TimeScreen({
  service,
  variant,
  onContinue,
}: {
  service: Service
  variant: ServiceVariant
  onContinue: (dateStr: string, startAt: number, staffId: number | null) => void
}) {
  const days = useMemo(() => next14Days(), [])
  const [dateStr, setDateStr] = useState(days[0] ?? '')
  const [slots, setSlots] = useState<AvailabilitySlot[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedStartAt, setSelectedStartAt] = useState<number | null>(null)
  // null = "Để spa sắp xếp" — đây là MẶC ĐỊNH, không phải "chưa chọn".
  // Khách chỉ cần chọn giờ là đi tiếp được; chọn KTV cụ thể là tuỳ chọn thêm.
  // Bắt khách bấm thêm một nút để xác nhận điều vốn đã mặc định là ma sát vô
  // ích, nhất là với người không rành công nghệ (prototype dòng 597: nút chỉ
  // phụ thuộc `S.time !== null`).
  const [selectedStaffId, setSelectedStaffId] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    setSlots(null)
    setError(null)
    setSelectedStartAt(null)
    setSelectedStaffId(null)
    getAvailability(variant.id, dateStr)
      .then((rows) => {
        if (!cancelled) setSlots(rows)
      })
      .catch(() => {
        if (!cancelled) setError('Không tải được khung giờ. Vui lòng thử lại.')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateStr, variant.id])

  const grouped = useMemo(() => {
    const groups: Record<'Buổi sáng' | 'Buổi chiều' | 'Buổi tối', AvailabilitySlot[]> = {
      'Buổi sáng': [],
      'Buổi chiều': [],
      'Buổi tối': [],
    }
    for (const slot of slots ?? []) {
      groups[dayPartOf(slot.start_at)].push(slot)
    }
    return groups
  }, [slots])

  const chosenSlot = selectedStartAt !== null ? (slots ?? []).find((s) => s.start_at === selectedStartAt) : null

  const canContinue = selectedStartAt !== null

  function pickDate(d: string) {
    setDateStr(d)
  }

  function pickTime(startAt: number) {
    setSelectedStartAt(startAt)
    setSelectedStaffId(null)
  }

  function pickStaff(staffId: number | null) {
    // null = quay lại "Để spa sắp xếp", đúng như trạng thái mặc định.
    setSelectedStaffId(staffId)
  }

  return (
    <>
      <div className="ccf-bk-dates">
        {days.map((d, i) => (
          <button
            key={d}
            type="button"
            className={`ccf-bk-date ${dateStr === d ? 'ccf-bk-date--sel' : ''}`}
            onClick={() => pickDate(d)}
            data-testid={`date-${d}`}
          >
            <div className="ccf-bk-dw">{dateChipLabel(d, i === 0)}</div>
            <div className="ccf-bk-dd">{dayOfMonth(d)}</div>
          </button>
        ))}
      </div>

      {error && <Notice tone="warn">{error}</Notice>}

      {slots !== null && slots.length === 0 && (
        <EmptyState icon="🗓️" text="Ngày này đã kín lịch. Bạn chọn ngày khác nhé." data-testid="time-empty" />
      )}

      {(Object.entries(grouped) as [string, AvailabilitySlot[]][])
        .filter(([, v]) => v.length > 0)
        .map(([part, partSlots]) => (
          <div key={part}>
            <div className="ccf-bk-daypart">{part}</div>
            <div className="ccf-bk-slots">
              {partSlots.map((s) => (
                <button
                  key={s.start_at}
                  type="button"
                  className={`ccf-bk-slot ${selectedStartAt === s.start_at ? 'ccf-bk-slot--sel' : ''}`}
                  onClick={() => pickTime(s.start_at)}
                  data-testid={`slot-${s.start_at}`}
                >
                  {hm(s.start_at)}
                </button>
              ))}
            </div>
          </div>
        ))}

      {chosenSlot && (
        <>
          <div className="ccf-bk-label">Kỹ thuật viên</div>
          <Card
            selected={selectedStaffId === null}
            onClick={() => pickStaff(null)}
            data-testid="staff-auto"
          >
            <div className="ccf-bk-row">
              <div>
                <div className="ccf-bk-t">Để spa sắp xếp</div>
                <div className="ccf-bk-d">Chọn bạn đang rảnh và phù hợp nhất</div>
              </div>
              <Pill>Gợi ý</Pill>
            </div>
          </Card>
          {chosenSlot.staff_ids.map((staffId) => (
            <Card
              key={staffId}
              selected={selectedStaffId === staffId}
              onClick={() => pickStaff(staffId)}
              data-testid={`staff-${staffId}`}
            >
              <div className="ccf-bk-staffpick">
                <Avatar name={`KTV ${staffId}`} />
                <div className="ccf-bk-nm">Kỹ thuật viên #{staffId}</div>
              </div>
            </Card>
          ))}
        </>
      )}

      <div className="ccf-bk-dock">
        <Button
          disabled={!canContinue}
          onClick={() => {
            if (selectedStartAt === null) return
            onContinue(dateStr, selectedStartAt, selectedStaffId)
          }}
          data-testid="time-continue"
        >
          {selectedStartAt !== null ? `Tiếp tục · ${hm(selectedStartAt)}` : 'Chọn giờ để tiếp tục'}
        </Button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// 4. Xác nhận
// ---------------------------------------------------------------------------

function ConfirmScreen({
  service,
  variant,
  dateStr,
  startAt,
  staffId,
  onSlotTaken,
  onDone,
}: {
  service: Service
  variant: ServiceVariant
  dateStr: string
  startAt: number
  staffId: number | null
  onSlotTaken: () => void
  onDone: (result: BookingResult) => void
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const nameValid = name.trim().length > 1
  const phoneDigits = phone.replace(/\D/g, '')
  const phoneValid = phoneDigits.length >= 9
  const canSubmit = nameValid && phoneValid && !submitting

  const endAt = startAt + variant.duration_min * 60

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    setNotice(null)
    try {
      const result = await createBooking({
        customer: { name: name.trim(), phone: phone.trim() },
        variant_id: variant.id,
        start_at: startAt,
        ...(staffId !== null ? { staff_id: staffId } : {}),
      })
      onDone(result)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SLOT_TAKEN') {
        // Race condition thật (PRD §5): người khác vừa đặt mất chỗ này. Không
        // hiện mã lỗi thô — quay khách về bước chọn giờ với danh sách mới.
        onSlotTaken()
        return
      }
      // 422/404/5xx khác — thông báo chung chung, gợi ý thử lại hoặc gọi hotline.
      setNotice(
        `Rất tiếc, chúng tôi chưa đặt được lịch này. Bạn thử lại giúp mình nhé, hoặc gọi ${SPA_PHONE_DISPLAY} để được hỗ trợ.`,
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div className="ccf-bk-h2">Gần xong rồi</div>
      <p className="ccf-bk-lede">Kiểm tra lại và cho chúng tôi biết tên bạn.</p>
      <div className="ccf-bk-summary">
        <div className="ccf-bk-sline">
          <span className="ccf-bk-k">Dịch vụ</span>
          <span className="ccf-bk-v">{service.name}</span>
        </div>
        <div className="ccf-bk-sline">
          <span className="ccf-bk-k">Gói</span>
          <span className="ccf-bk-v">{variant.name}</span>
        </div>
        <div className="ccf-bk-sline">
          <span className="ccf-bk-k">Thời gian</span>
          <span className="ccf-bk-v">
            {fullDateLabel(dateStr)}
            <br />
            {hm(startAt)} – {hm(endAt)}
          </span>
        </div>
        <div className="ccf-bk-sline">
          <span className="ccf-bk-k">Kỹ thuật viên</span>
          <span className="ccf-bk-v">{staffId !== null ? `Kỹ thuật viên #${staffId}` : 'Spa sắp xếp'}</span>
        </div>
        <div className="ccf-bk-sline ccf-bk-sline--total">
          <span className="ccf-bk-k">Tổng cộng</span>
          <span className="ccf-bk-v">{formatVnd(variant.price)}</span>
        </div>
      </div>

      <Field
        label="Tên của bạn"
        placeholder="Ví dụ: Nguyễn Thu Hà"
        value={name}
        onChange={(e) => setName(e.target.value)}
        data-testid="confirm-name"
      />
      <Field
        label="Số điện thoại"
        type="tel"
        inputMode="numeric"
        placeholder="0901 234 567"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        hint="Dùng để tra cứu và đổi lịch. Không cần tạo tài khoản."
        data-testid="confirm-phone"
      />

      <Notice tone="info">
        <b>Thanh toán tại spa.</b> Bạn có thể huỷ miễn phí đến trước giờ hẹn 2 tiếng.
      </Notice>

      {notice && (
        <Notice tone="warn" data-testid="confirm-error">
          {notice}
        </Notice>
      )}

      <div className="ccf-bk-dock">
        <Button disabled={!canSubmit} onClick={handleSubmit} data-testid="confirm-submit">
          {submitting ? 'Đang xử lý...' : 'Xác nhận đặt lịch'}
        </Button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// 5. Thành công
// ---------------------------------------------------------------------------

function DoneScreen({
  service,
  variant,
  dateStr,
  startAt,
  staffId,
  result,
  onHome,
}: {
  service: Service
  variant: ServiceVariant
  dateStr: string
  startAt: number
  staffId: number | null
  result: BookingResult
  onHome: () => void
}) {
  const isToday = dateStr === dateStrOf(Math.floor(Date.now() / 1000))
  const staffName = result.staff?.name ?? (staffId !== null ? `Kỹ thuật viên #${staffId}` : 'Spa sắp xếp')

  return (
    <>
      <div className="ccf-bk-ok">
        <div className="ccf-bk-mark">✓</div>
        <h2>Đặt lịch thành công</h2>
        <p>
          Hẹn gặp bạn {isToday ? 'hôm nay' : `ngày ${fullDateLabel(dateStr)}`} lúc <b>{hm(startAt)}</b>
        </p>
        <div className="ccf-bk-code" data-testid="booking-code">
          MÃ ĐẶT LỊCH · {result.appointment.id}
        </div>
      </div>
      <div className="ccf-bk-summary">
        <div className="ccf-bk-sline">
          <span className="ccf-bk-k">Dịch vụ</span>
          <span className="ccf-bk-v">
            {service.name} · {variant.name}
          </span>
        </div>
        <div className="ccf-bk-sline">
          <span className="ccf-bk-k">Kỹ thuật viên</span>
          <span className="ccf-bk-v">{staffName}</span>
        </div>
        <div className="ccf-bk-sline ccf-bk-sline--total">
          <span className="ccf-bk-k">Thanh toán tại spa</span>
          <span className="ccf-bk-v">{formatVnd(variant.price)}</span>
        </div>
      </div>
      <Notice tone="info">
        Vui lòng đến sớm 5 phút. Cần đổi lịch, gọi <b>{SPA_PHONE_DISPLAY}</b>.
      </Notice>
      <div className="ccf-bk-dock">
        <Button variant="ghost" onClick={onHome} data-testid="done-home">
          Về trang chủ
        </Button>
      </div>
    </>
  )
}
