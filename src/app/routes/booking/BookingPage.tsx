import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, Hand, Scissors, Smile, Sparkles } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
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
  createComboBooking,
  createPayment,
  getAvailability,
  getComboAvailability,
  getPaymentStatus,
  getServices,
  type AvailabilitySlot,
  type BookingResult,
  type ComboBookingResult,
  type ComboMode,
  type CreatePaymentResult,
  type PaymentProviderId,
  type Service,
  type ServiceVariant,
} from '../../lib/apiClient'
import { dateChipLabel, dateStrOf, dayOfMonth, dayPartOf, formatVnd, fullDateLabel, hm, next14Days } from './format'
import { serviceImageUrl } from '../../lib/serviceImages'
import { staffAvatarUrl } from '../../lib/staffAvatars'
import './booking.css'

// Nhãn nhóm dịch vụ theo body_zone — dùng cho chip lọc danh mục ngang trên
// màn chọn dịch vụ (đặc tả revamp: chip lọc nằm ngang, cuộn được, icon nhỏ
// bên trái). body_zone là 4 giá trị cố định của seed (xem
// src/worker/db/seed.ts) — "Tất cả" luôn đứng đầu và không lọc gì.
const ZONE_LABEL: Record<string, string> = {
  body: 'Massage',
  hair: 'Tóc',
  hands: 'Móng',
  face: 'Da mặt',
}
const ZONE_ICON: Record<string, LucideIcon> = {
  body: Sparkles,
  hair: Scissors,
  hands: Hand,
  face: Smile,
}

// Số hotline của spa — theo đúng prototype/index.html dòng 646 ("028 3822 1179").
const SPA_PHONE_DISPLAY = '028 3822 1179'

type StepName = 'service' | 'variant' | 'time' | 'confirm'
const STEP_ORDER: StepName[] = ['service', 'variant', 'time', 'confirm']

/** Một mục đã chọn trong giỏ combo: giữ đủ dữ liệu để hiện lại + tính tổng. */
export interface BasketItem {
  service: Service
  variant: ServiceVariant
}

/** Tổng thời lượng (gồm buffer) và giá của cả chuỗi combo. */
function basketTotals(basket: BasketItem[]): { totalMin: number; totalBlockMin: number; totalPrice: number } {
  let totalMin = 0
  let totalBlockMin = 0
  let totalPrice = 0
  for (const it of basket) {
    totalMin += it.variant.duration_min
    totalBlockMin += it.variant.duration_min + it.variant.buffer_after_min
    totalPrice += it.variant.price
  }
  return { totalMin, totalBlockMin, totalPrice }
}

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
      /** true when the customer paid online (QR/PayPal) and it landed — the
       *  success screen must say "đã thanh toán", never "trả tại spa". */
      paidOnline?: boolean
    }
  // PAYMENT track: after a booking is created with "pay online", show the
  // payment screen (QR for SePay / redirect for PayPal) and wait for it to land.
  | {
      name: 'pay'
      service: Service
      variant: ServiceVariant
      dateStr: string
      startAt: number
      staffId: number | null
      result: BookingResult
      provider: PaymentProviderId
      amountVnd: number
    }
  // --- combo (≥2 dịch vụ). mode chọn ở màn combo-time:
  //     serial = 1 KTV nối tiếp (R1a) · parallel = nhiều KTV cùng lúc (R1b) ---
  | { name: 'combo-time'; basket: BasketItem[] }
  | {
      name: 'combo-confirm'
      basket: BasketItem[]
      mode: ComboMode
      dateStr: string
      startAt: number
      /** serial: KTV được chọn (hoặc null = spa sắp xếp). parallel: bỏ qua. */
      staffId: number | null
      /** parallel: gán KTV cho từng leg theo thứ tự basket (từ slot.staff_ids). */
      staffIds: number[] | null
    }
  | {
      name: 'combo-done'
      basket: BasketItem[]
      mode: ComboMode
      dateStr: string
      startAt: number
      result: ComboBookingResult
    }

/** Khoá dữ liệu cần cho bước xác nhận — server luôn là trọng tài cuối
 * (CONVENTIONS + cạm bẫy đã biết của card), state này chỉ giữ lựa chọn của
 * khách để hiển thị lại, không tự quyết định hợp lệ hay không. */
export default function BookingPage() {
  const [screen, setScreen] = useState<Screen>({ name: 'service' })
  // Giỏ combo sống NGOÀI `screen` để giữ qua các lần quay lại chọn thêm dịch
  // vụ. 1 mục = luồng đơn (giữ nguyên hành vi cũ); ≥2 mục = luồng combo nối
  // tiếp. Bắt đầu rỗng — khách chọn dịch vụ đầu tiên mới đẩy vào.
  const [basket, setBasket] = useState<BasketItem[]>([])

  const stepIndex = STEP_ORDER.indexOf(screen.name as StepName)
  const showSteps = screen.name === 'variant' || screen.name === 'time' || screen.name === 'confirm'

  function resetToStart() {
    setBasket([])
    setScreen({ name: 'service' })
  }

  function goBack() {
    if (screen.name === 'variant') setScreen({ name: 'service' })
    else if (screen.name === 'time') setScreen({ name: 'variant', service: screen.service })
    else if (screen.name === 'confirm')
      setScreen({ name: 'time', service: screen.service, variant: screen.variant })
    else if (screen.name === 'combo-time') setScreen({ name: 'service' })
    else if (screen.name === 'combo-confirm') setScreen({ name: 'combo-time', basket: screen.basket })
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
  } else if (screen.name === 'combo-time') {
    title = 'Chọn kiểu & giờ'
    sub = `Combo ${screen.basket.length} dịch vụ`
  } else if (screen.name === 'combo-confirm') {
    title = 'Xác nhận'
    sub = `Combo ${screen.basket.length} dịch vụ`
  } else if (screen.name === 'pay') {
    title = 'Thanh toán'
    sub = 'Hoàn tất thanh toán để giữ chỗ'
  } else if (screen.name === 'done' || screen.name === 'combo-done') {
    title = 'Đã đặt lịch'
    sub = ''
  }

  const canGoBack =
    screen.name === 'variant' ||
    screen.name === 'time' ||
    screen.name === 'confirm' ||
    screen.name === 'combo-time' ||
    screen.name === 'combo-confirm'

  return (
    <div className="ccf-bk-page">
      <div className="ccf-bk-bar">
        {canGoBack && (
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
          <ServiceScreen
            basket={basket}
            onPick={(service) => setScreen({ name: 'variant', service })}
            onRemoveFromBasket={(variantId) => setBasket((b) => b.filter((it) => it.variant.id !== variantId))}
            onContinueCombo={() => setScreen({ name: 'combo-time', basket })}
          />
        )}
        {screen.name === 'variant' && (
          <VariantScreen
            service={screen.service}
            basket={basket}
            onContinue={(variant) => {
              // 1 dịch vụ trong giỏ (kể cả vừa thêm) → luồng đơn như cũ.
              // Nếu giỏ đã có sẵn dịch vụ khác → thành combo, ra màn combo.
              const others = basket.filter((it) => it.variant.id !== variant.id)
              if (others.length === 0) {
                setBasket([{ service: screen.service, variant }])
                setScreen({ name: 'time', service: screen.service, variant })
              } else {
                const next = [...others, { service: screen.service, variant }]
                setBasket(next)
                setScreen({ name: 'combo-time', basket: next })
              }
            }}
            onAddMore={(variant) => {
              // Thêm dịch vụ này vào giỏ rồi quay lại danh sách để chọn tiếp.
              setBasket((b) => {
                const others = b.filter((it) => it.variant.id !== variant.id)
                return [...others, { service: screen.service, variant }]
              })
              setScreen({ name: 'service' })
            }}
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
            onDone={(result, payWith) => {
              // payWith === null → pay at spa (existing path, straight to done).
              // Otherwise start the online payment flow on the new appointment.
              if (payWith === null) {
                setScreen({
                  name: 'done',
                  service: screen.service,
                  variant: screen.variant,
                  dateStr: screen.dateStr,
                  startAt: screen.startAt,
                  staffId: screen.staffId,
                  result,
                })
              } else {
                setScreen({
                  name: 'pay',
                  service: screen.service,
                  variant: screen.variant,
                  dateStr: screen.dateStr,
                  startAt: screen.startAt,
                  staffId: screen.staffId,
                  result,
                  provider: payWith,
                  amountVnd: screen.variant.price,
                })
              }
            }}
          />
        )}
        {screen.name === 'pay' && (
          <PaymentScreen
            service={screen.service}
            variant={screen.variant}
            dateStr={screen.dateStr}
            startAt={screen.startAt}
            staffId={screen.staffId}
            result={screen.result}
            provider={screen.provider}
            amountVnd={screen.amountVnd}
            onPaid={() =>
              setScreen({
                name: 'done',
                service: screen.service,
                variant: screen.variant,
                dateStr: screen.dateStr,
                startAt: screen.startAt,
                staffId: screen.staffId,
                result: screen.result,
                paidOnline: true,
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
            paidOnline={screen.paidOnline ?? false}
            onHome={resetToStart}
          />
        )}
        {screen.name === 'combo-time' && (
          <ComboTimeScreen
            basket={screen.basket}
            onContinue={(mode, dateStr, startAt, staffId, staffIds) =>
              setScreen({ name: 'combo-confirm', basket: screen.basket, mode, dateStr, startAt, staffId, staffIds })
            }
          />
        )}
        {screen.name === 'combo-confirm' && (
          <ComboConfirmScreen
            basket={screen.basket}
            mode={screen.mode}
            dateStr={screen.dateStr}
            startAt={screen.startAt}
            staffId={screen.staffId}
            staffIds={screen.staffIds}
            onSlotTaken={() => setScreen({ name: 'combo-time', basket: screen.basket })}
            onDone={(result) =>
              setScreen({ name: 'combo-done', basket: screen.basket, mode: screen.mode, dateStr: screen.dateStr, startAt: screen.startAt, result })
            }
          />
        )}
        {screen.name === 'combo-done' && (
          <ComboDoneScreen
            basket={screen.basket}
            mode={screen.mode}
            dateStr={screen.dateStr}
            startAt={screen.startAt}
            result={screen.result}
            onHome={resetToStart}
          />
        )}
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 1. Danh sách dịch vụ
// ---------------------------------------------------------------------------

function ServiceScreen({
  basket,
  onPick,
  onRemoveFromBasket,
  onContinueCombo,
}: {
  basket: BasketItem[]
  onPick: (service: Service) => void
  onRemoveFromBasket: (variantId: number) => void
  onContinueCombo: () => void
}) {
  const [services, setServices] = useState<Service[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // "all" = không lọc. Danh sách chip suy ra từ chính dữ liệu services trả
  // về (không hard-code 4 zone cố định), nên nếu backend thêm zone mới, chip
  // vẫn tự hiện đúng — chỉ nhãn/icon lạ sẽ fallback về chính body_zone thô.
  const [zoneFilter, setZoneFilter] = useState<string>('all')

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

  const zones = Array.from(new Set((services ?? []).map((s) => s.body_zone)))
  const visibleServices = (services ?? []).filter((s) => zoneFilter === 'all' || s.body_zone === zoneFilter)
  const { totalPrice, totalMin } = basketTotals(basket)

  return (
    <>
      <div className="ccf-bk-h2">Bạn muốn làm gì hôm nay?</div>
      <p className="ccf-bk-lede">Chọn dịch vụ, chúng tôi sắp kỹ thuật viên phù hợp. Muốn làm nhiều dịch vụ trong một buổi? Cứ chọn thêm.</p>
      {error && <Notice tone="warn">{error}</Notice>}
      {services === null && !error && <p>Đang tải...</p>}

      {services !== null && zones.length > 1 && (
        <div className="ccf-bk-chips" data-testid="service-zone-chips">
          <button
            type="button"
            className={`ccf-bk-chip ${zoneFilter === 'all' ? 'ccf-bk-chip--sel' : ''}`}
            onClick={() => setZoneFilter('all')}
            data-testid="zone-chip-all"
          >
            Tất cả
          </button>
          {zones.map((z) => {
            const ZoneIco = ZONE_ICON[z]
            return (
              <button
                key={z}
                type="button"
                className={`ccf-bk-chip ${zoneFilter === z ? 'ccf-bk-chip--sel' : ''}`}
                onClick={() => setZoneFilter(z)}
                data-testid={`zone-chip-${z}`}
              >
                <span className="ccf-bk-chip-icon" aria-hidden="true">
                  {ZoneIco ? <ZoneIco size="1em" /> : '•'}
                </span>
                {ZONE_LABEL[z] ?? z}
              </button>
            )
          })}
        </div>
      )}

      <div className="ccf-bk-svc-grid">
        {visibleServices.map((s) => {
          const fromPrice = Math.min(...s.variants.map((v) => v.price))
          const totalMin = Math.min(...s.variants.map((v) => v.duration_min))
          const inBasket = basket.some((it) => it.service.id === s.id)
          return (
            <button
              key={s.id}
              type="button"
              className="ccf-bk-svc-card"
              onClick={() => onPick(s)}
              data-testid={`service-${s.id}`}
            >
              <div className="ccf-bk-svc-img-wrap">
                <img className="ccf-bk-svc-img" src={serviceImageUrl(s.body_zone)} alt="" loading="lazy" />
              </div>
              <div className="ccf-bk-svc-body">
                <div className="ccf-bk-svc-name">{s.name}</div>
                <div className="ccf-bk-svc-meta">{totalMin} phút</div>
                <div className="ccf-bk-svc-foot">
                  <span className="ccf-bk-svc-price">từ {formatVnd(fromPrice)}</span>
                  <span className="ccf-bk-svc-plus" aria-hidden="true">
                    {inBasket ? '✓' : '+'}
                  </span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {/* Giỏ combo: chỉ hiện khi đã chọn ≥1 dịch vụ. Cho xoá từng mục (revise)
          và đi tiếp. Đây là affordance "chọn nhiều dịch vụ trong một buổi". */}
      {basket.length > 0 && (
        <div className="ccf-bk-combobar" data-testid="combo-basket">
          <div className="ccf-bk-combobar-list">
            {basket.map((it) => (
              <div key={it.variant.id} className="ccf-bk-combobar-item" data-testid={`basket-item-${it.variant.id}`}>
                <span className="ccf-bk-combobar-nm">
                  {it.service.name} · {it.variant.name}
                </span>
                <button
                  type="button"
                  className="ccf-bk-combobar-x"
                  aria-label={`Bỏ ${it.service.name}`}
                  onClick={() => onRemoveFromBasket(it.variant.id)}
                  data-testid={`basket-remove-${it.variant.id}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className="ccf-bk-combobar-foot">
            <span className="ccf-bk-combobar-total">
              {basket.length} dịch vụ · {totalMin} phút · {formatVnd(totalPrice)}
            </span>
          </div>
          <Button onClick={onContinueCombo} data-testid="combo-continue">
            {basket.length >= 2 ? `Đặt combo ${basket.length} dịch vụ` : 'Tiếp tục'}
          </Button>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// 2. Chọn gói (variant)
// ---------------------------------------------------------------------------

function VariantScreen({
  service,
  basket,
  onContinue,
  onAddMore,
}: {
  service: Service
  basket: BasketItem[]
  onContinue: (variant: ServiceVariant) => void
  onAddMore: (variant: ServiceVariant) => void
}) {
  // Nếu dịch vụ này đã có trong giỏ, chọn sẵn đúng gói đó (khách quay lại sửa).
  const preselected = basket.find((it) => it.service.id === service.id)?.variant ?? null
  const [selected, setSelected] = useState<ServiceVariant | null>(preselected)
  const hasOthers = basket.some((it) => it.service.id !== service.id)

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
        {/* "Thêm dịch vụ khác" giữ khách ở lại luồng chọn để gộp combo. Nút
            chính "Tiếp tục" đưa thẳng tới chọn giờ (đơn hoặc combo tuỳ giỏ). */}
        <Button
          variant="ghost"
          disabled={selected === null}
          onClick={() => selected && onAddMore(selected)}
          data-testid="variant-add-more"
        >
          + Thêm dịch vụ khác
        </Button>
        <Button
          disabled={selected === null}
          onClick={() => selected && onContinue(selected)}
          data-testid="variant-continue"
        >
          {hasOthers ? 'Tiếp tục với combo' : 'Tiếp tục'}
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
        <EmptyState icon={<CalendarDays />} text="Ngày này đã kín lịch. Bạn chọn ngày khác nhé." data-testid="time-empty" />
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
  onDone: (result: BookingResult, payWith: PaymentProviderId | null) => void
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // Payment MODE (playbook: rule shown BEFORE commit). Default 'at_spa' keeps
  // the existing behaviour untouched. Choosing an online provider means the
  // slot is only fully confirmed once payment lands — shown right here.
  const [payMode, setPayMode] = useState<'at_spa' | PaymentProviderId>('at_spa')

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
      onDone(result, payMode === 'at_spa' ? null : payMode)
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

      <div className="ccf-bk-label">Hình thức thanh toán</div>
      <Card
        selected={payMode === 'at_spa'}
        onClick={() => setPayMode('at_spa')}
        data-testid="pay-mode-at_spa"
      >
        <div className="ccf-bk-row">
          <div>
            <div className="ccf-bk-t">Trả tại spa</div>
            <div className="ccf-bk-d">Thanh toán khi đến. Huỷ miễn phí đến trước giờ hẹn 2 tiếng.</div>
          </div>
          <Pill>Mặc định</Pill>
        </div>
      </Card>
      <Card
        selected={payMode === 'sepay'}
        onClick={() => setPayMode('sepay')}
        data-testid="pay-mode-sepay"
      >
        <div className="ccf-bk-row">
          <div>
            <div className="ccf-bk-t">Chuyển khoản QR (VietQR)</div>
            <div className="ccf-bk-d">Quét mã, chuyển khoản để giữ chỗ ngay.</div>
          </div>
        </div>
      </Card>
      <Card
        selected={payMode === 'paypal'}
        onClick={() => setPayMode('paypal')}
        data-testid="pay-mode-paypal"
      >
        <div className="ccf-bk-row">
          <div>
            <div className="ccf-bk-t">Thẻ quốc tế (PayPal)</div>
            <div className="ccf-bk-d">Thanh toán bằng thẻ qua PayPal.</div>
          </div>
        </div>
      </Card>

      {payMode !== 'at_spa' && (
        <Notice tone="info" data-testid="pay-online-hint">
          Chỗ của bạn được <b>giữ tạm</b> và chỉ xác nhận chắc chắn sau khi thanh toán thành công. Nếu bạn
          thoát giữa chừng, lịch sẽ chưa được xác nhận — bạn có thể đặt lại hoặc chọn "Trả tại spa".
        </Notice>
      )}

      {notice && (
        <Notice tone="warn" data-testid="confirm-error">
          {notice}
        </Notice>
      )}

      <div className="ccf-bk-dock">
        <Button disabled={!canSubmit} onClick={handleSubmit} data-testid="confirm-submit">
          {submitting
            ? 'Đang xử lý...'
            : payMode === 'at_spa'
              ? 'Xác nhận đặt lịch'
              : 'Đặt lịch & thanh toán'}
        </Button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// 4b. Thanh toán online (PAYMENT track) — SePay QR hoặc PayPal redirect.
// ---------------------------------------------------------------------------
// Đây là nơi hai cổng OPPOSITE-shaped lộ ra khác nhau đúng chỗ: SePay hiện QR
// và CHỜ webhook; PayPal đưa khách sang trang PayPal. UI switch trên
// intent.kind. Ràng buộc hiện TRƯỚC: khách luôn thấy "chỗ chỉ chắc chắn sau khi
// thanh toán" — không có trạng thái "đã trả tiền mà không có xác nhận".

function PaymentScreen({
  service,
  variant,
  startAt,
  result,
  provider,
  amountVnd,
  onPaid,
}: {
  service: Service
  variant: ServiceVariant
  dateStr: string
  startAt: number
  staffId: number | null
  result: BookingResult
  provider: PaymentProviderId
  amountVnd: number
  onPaid: () => void
}) {
  const [intent, setIntent] = useState<CreatePaymentResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<'pending' | 'paid'>('pending')

  // 1) Create the payment intent once, on mount.
  useEffect(() => {
    let cancelled = false
    createPayment({
      appointment_id: result.appointment.id as number,
      amount_vnd: amountVnd,
      provider,
      description: `${service.name} · ${variant.name}`,
    })
      .then((res) => {
        if (cancelled) return
        setIntent(res)
        // PayPal: send the customer to approve. (In sandbox this opens the
        // real PayPal approve page; here we surface the link as a button too.)
        if (res.intent.kind === 'redirect') {
          // Do not auto-redirect silently — show the button so the customer
          // understands they are leaving to pay. See render below.
        }
      })
      .catch(() => {
        if (!cancelled)
          setError('Chưa tạo được thanh toán. Bạn thử lại, hoặc quay lại chọn "Trả tại spa".')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 2) Poll payment status while pending (the SePay webhook flips it server-
  // side; the customer's screen learns via this poll). Stops on 'paid'.
  useEffect(() => {
    if (intent === null || status === 'paid') return
    let cancelled = false
    const timer = setInterval(async () => {
      try {
        const s = await getPaymentStatus(intent.order_ref)
        if (cancelled) return
        if (s.status === 'paid') {
          setStatus('paid')
          clearInterval(timer)
        }
      } catch {
        // transient — keep polling.
      }
    }, 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [intent, status])

  if (error) {
    return (
      <>
        <Notice tone="warn" data-testid="pay-error">
          {error}
        </Notice>
        <div className="ccf-bk-dock">
          <Button onClick={onPaid} variant="ghost" data-testid="pay-skip">
            Tiếp tục (trả tại spa)
          </Button>
        </div>
      </>
    )
  }

  if (intent === null) {
    return <p data-testid="pay-loading">Đang tạo thanh toán...</p>
  }

  const paid = status === 'paid'

  return (
    <>
      <div className="ccf-bk-summary">
        <div className="ccf-bk-sline">
          <span className="ccf-bk-k">Dịch vụ</span>
          <span className="ccf-bk-v">
            {service.name} · {variant.name}
          </span>
        </div>
        <div className="ccf-bk-sline">
          <span className="ccf-bk-k">Thời gian</span>
          <span className="ccf-bk-v">{hm(startAt)}</span>
        </div>
        <div className="ccf-bk-sline ccf-bk-sline--total">
          <span className="ccf-bk-k">Cần thanh toán</span>
          <span className="ccf-bk-v">{formatVnd(amountVnd)}</span>
        </div>
      </div>

      {paid ? (
        <Notice tone="info" data-testid="pay-confirmed">
          <b>Đã nhận thanh toán.</b> Lịch của bạn đã được xác nhận chắc chắn.
        </Notice>
      ) : (
        <Notice tone="info" data-testid="pay-waiting">
          Chỗ đang được <b>giữ tạm</b>. Lịch chỉ xác nhận chắc chắn sau khi thanh toán thành công.
        </Notice>
      )}

      {/* SePay = QR to display + wait. PayPal = redirect button. Switch on kind. */}
      {intent.intent.kind === 'qr' && !paid && (
        <div data-testid="pay-qr">
          {intent.intent.qrImageUrl ? (
            <img
              src={intent.intent.qrImageUrl}
              alt="Mã QR chuyển khoản"
              style={{ width: '100%', maxWidth: 280, display: 'block', margin: '12px auto' }}
            />
          ) : (
            <Notice tone="warn">Chưa cấu hình tài khoản nhận. Vui lòng chọn "Trả tại spa".</Notice>
          )}
          <div className="ccf-bk-summary">
            <div className="ccf-bk-sline">
              <span className="ccf-bk-k">Số tài khoản</span>
              <span className="ccf-bk-v">{intent.intent.accountNumber || '—'}</span>
            </div>
            <div className="ccf-bk-sline">
              <span className="ccf-bk-k">Nội dung chuyển khoản</span>
              <span className="ccf-bk-v" data-testid="pay-code">
                {intent.intent.code}
              </span>
            </div>
          </div>
          <p className="ccf-bk-d">
            Quét mã bằng app ngân hàng, giữ nguyên <b>nội dung chuyển khoản</b> để hệ thống tự xác nhận. Màn
            hình sẽ tự cập nhật khi nhận được tiền.
          </p>
        </div>
      )}

      {intent.intent.kind === 'redirect' && !paid && (
        <div className="ccf-bk-dock" data-testid="pay-redirect">
          <a href={intent.intent.approveUrl} target="_blank" rel="noreferrer">
            <Button>Thanh toán qua PayPal</Button>
          </a>
        </div>
      )}

      {paid && (
        <div className="ccf-bk-dock">
          <Button onClick={onPaid} data-testid="pay-continue">
            Xem lịch đã đặt
          </Button>
        </div>
      )}
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
  paidOnline,
  onHome,
}: {
  service: Service
  variant: ServiceVariant
  dateStr: string
  startAt: number
  staffId: number | null
  result: BookingResult
  paidOnline: boolean
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
          <span className="ccf-bk-k">{paidOnline ? 'Đã thanh toán' : 'Thanh toán tại spa'}</span>
          <span className="ccf-bk-v">{formatVnd(variant.price)}</span>
        </div>
      </div>
      {paidOnline && (
        <Notice tone="info" data-testid="done-paid-online">
          Bạn đã thanh toán trực tuyến — không cần trả thêm tại spa.
        </Notice>
      )}
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

// ===========================================================================
// R1a — SERIAL COMBO screens (≥2 dịch vụ, 1 KTV, nối tiếp)
// ===========================================================================

// 6. Combo — chọn KIỂU (nối tiếp / song song) + ngày + giờ. Điểm mấu chốt của
// playbook: RÀNG BUỘC HIỆN TRƯỚC khi khách cam kết.
//   • Nối tiếp (serial, R1a): 1 KTV làm trọn combo liền mạch. Slot chỉ hiện khi
//     CÙNG MỘT KTV làm được cả combo và có cửa sổ liền đủ dài.
//   • Song song (parallel, R1b): mỗi dịch vụ một KTV RIÊNG làm CÙNG LÚC → xong
//     nhanh hơn. Slot chỉ hiện khi đủ N KTV khác nhau rảnh đồng thời; khách thấy
//     rõ "ai làm gì" ngay tại đây, trước khi xác nhận.
// Nếu kiểu đang chọn không khả thi (không ai làm trọn combo / trùng vùng cơ thể
// khi song song / không đủ người) → báo rõ tại đây, KHÔNG để khách đi tới xác
// nhận rồi mới lỗi.
function ComboTimeScreen({
  basket,
  onContinue,
}: {
  basket: BasketItem[]
  onContinue: (
    mode: ComboMode,
    dateStr: string,
    startAt: number,
    staffId: number | null,
    staffIds: number[] | null,
  ) => void
}) {
  const days = useMemo(() => next14Days(), [])
  const variantIds = useMemo(() => basket.map((it) => it.variant.id), [basket])
  const [mode, setMode] = useState<ComboMode>('serial')
  const [dateStr, setDateStr] = useState(days[0] ?? '')
  const [slots, setSlots] = useState<AvailabilitySlot[] | null>(null)
  const [coverable, setCoverable] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedStartAt, setSelectedStartAt] = useState<number | null>(null)
  const [selectedStaffId, setSelectedStaffId] = useState<number | null>(null)

  const { totalPrice, totalMin, totalBlockMin } = basketTotals(basket)
  // Song song: khách xong trong thời gian của dịch vụ DÀI NHẤT (không cộng dồn).
  const longestMin = useMemo(() => Math.max(...basket.map((it) => it.variant.duration_min)), [basket])

  useEffect(() => {
    let cancelled = false
    setSlots(null)
    setError(null)
    setSelectedStartAt(null)
    setSelectedStaffId(null)
    getComboAvailability(variantIds, dateStr, { mode })
      .then((res) => {
        if (cancelled) return
        setCoverable(res.coverable)
        setSlots(res.slots)
      })
      .catch(() => {
        if (!cancelled) setError('Không tải được khung giờ. Vui lòng thử lại.')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateStr, mode, variantIds.join(',')])

  const grouped = useMemo(() => {
    const groups: Record<'Buổi sáng' | 'Buổi chiều' | 'Buổi tối', AvailabilitySlot[]> = {
      'Buổi sáng': [],
      'Buổi chiều': [],
      'Buổi tối': [],
    }
    for (const slot of slots ?? []) groups[dayPartOf(slot.start_at)].push(slot)
    return groups
  }, [slots])

  const chosenSlot = selectedStartAt !== null ? (slots ?? []).find((s) => s.start_at === selectedStartAt) : null
  const canContinue = selectedStartAt !== null

  function selectMode(next: ComboMode) {
    setMode(next)
    setSelectedStartAt(null)
    setSelectedStaffId(null)
  }

  return (
    <>
      {/* Tóm tắt combo luôn hiện. */}
      <div className="ccf-bk-summary" data-testid="combo-time-summary">
        {basket.map((it) => (
          <div key={it.variant.id} className="ccf-bk-sline">
            <span className="ccf-bk-k">
              {it.service.name} · {it.variant.name}
            </span>
            <span className="ccf-bk-v">{it.variant.duration_min} phút</span>
          </div>
        ))}
        <div className="ccf-bk-sline ccf-bk-sline--total">
          <span className="ccf-bk-k">{mode === 'parallel' ? 'Xong sau ~' : 'Tổng · liền mạch 1 KTV'}</span>
          <span className="ccf-bk-v">
            {mode === 'parallel' ? `${longestMin} phút` : `${totalMin} phút`} · {formatVnd(totalPrice)}
          </span>
        </div>
      </div>

      {/* CHỌN KIỂU — bước riêng của R1b. Hai lựa chọn giải thích rõ khác biệt. */}
      <div className="ccf-bk-label">Bạn muốn làm kiểu nào?</div>
      <Card selected={mode === 'serial'} onClick={() => selectMode('serial')} data-testid="combo-mode-serial">
        <div className="ccf-bk-row">
          <div>
            <div className="ccf-bk-t">Nối tiếp · một kỹ thuật viên</div>
            <div className="ccf-bk-d">
              Một người làm trọn combo, hết dịch vụ này sang dịch vụ khác (~{totalBlockMin} phút).
            </div>
          </div>
          {mode === 'serial' && <Pill>Đang chọn</Pill>}
        </div>
      </Card>
      <Card selected={mode === 'parallel'} onClick={() => selectMode('parallel')} data-testid="combo-mode-parallel">
        <div className="ccf-bk-row">
          <div>
            <div className="ccf-bk-t">Song song · nhiều kỹ thuật viên cùng lúc</div>
            <div className="ccf-bk-d">
              Mỗi dịch vụ một người làm đồng thời → bạn xong nhanh hơn (~{longestMin} phút).
            </div>
          </div>
          {mode === 'parallel' && <Pill>Đang chọn</Pill>}
        </div>
      </Card>

      <div className="ccf-bk-dates">
        {days.map((d, i) => (
          <button
            key={d}
            type="button"
            className={`ccf-bk-date ${dateStr === d ? 'ccf-bk-date--sel' : ''}`}
            onClick={() => setDateStr(d)}
            data-testid={`date-${d}`}
          >
            <div className="ccf-bk-dw">{dateChipLabel(d, i === 0)}</div>
            <div className="ccf-bk-dd">{dayOfMonth(d)}</div>
          </button>
        ))}
      </div>

      {error && <Notice tone="warn">{error}</Notice>}

      {/* RÀNG BUỘC HIỆN TRƯỚC — thông điệp khác nhau theo kiểu. */}
      {slots !== null && !coverable && mode === 'serial' && (
        <Notice tone="warn" data-testid="combo-uncoverable">
          <b>Chưa có kỹ thuật viên nào làm được trọn combo này.</b> Các dịch vụ bạn chọn cần những kỹ năng khác
          nhau mà chưa ai làm được cả. Bạn có thể thử kiểu <b>song song</b> (mỗi dịch vụ một người), bớt một dịch
          vụ, hoặc gọi {SPA_PHONE_DISPLAY} để được sắp xếp.
        </Notice>
      )}
      {slots !== null && !coverable && mode === 'parallel' && (
        <Notice tone="warn" data-testid="combo-parallel-uncoverable">
          <b>Chưa làm song song combo này được.</b> Có thể hai dịch vụ cùng một vùng cơ thể (không thể làm cùng
          lúc), hoặc một dịch vụ chưa có kỹ thuật viên. Bạn thử kiểu <b>nối tiếp</b> (một người làm lần lượt),
          hoặc gọi {SPA_PHONE_DISPLAY}.
        </Notice>
      )}

      {slots !== null && coverable && slots.length === 0 && (
        <EmptyState
          icon={<CalendarDays />}
          text={
            mode === 'parallel'
              ? 'Ngày này chưa đủ kỹ thuật viên rảnh cùng lúc cho combo. Bạn thử ngày khác nhé.'
              : 'Ngày này không có khung giờ đủ dài cho cả combo. Bạn thử ngày khác nhé.'
          }
          data-testid="combo-time-empty"
        />
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
                  onClick={() => {
                    setSelectedStartAt(s.start_at)
                    setSelectedStaffId(null)
                  }}
                  data-testid={`slot-${s.start_at}`}
                >
                  {hm(s.start_at)}
                </button>
              ))}
            </div>
          </div>
        ))}

      {/* SERIAL: chọn 1 KTV cho cả combo (hoặc để spa sắp). */}
      {chosenSlot && mode === 'serial' && (
        <>
          <div className="ccf-bk-label">Kỹ thuật viên</div>
          <p className="ccf-bk-d" style={{ marginBottom: 10 }}>
            Cả combo do một người làm liền mạch (~{totalBlockMin} phút kể cả nghỉ giữa các bước).
          </p>
          <Card selected={selectedStaffId === null} onClick={() => setSelectedStaffId(null)} data-testid="staff-auto">
            <div className="ccf-bk-row">
              <div>
                <div className="ccf-bk-t">Để spa sắp xếp</div>
                <div className="ccf-bk-d">Chọn bạn làm được cả combo và đang rảnh</div>
              </div>
              <Pill>Gợi ý</Pill>
            </div>
          </Card>
          {chosenSlot.staff_ids.map((staffId) => (
            <Card
              key={staffId}
              selected={selectedStaffId === staffId}
              onClick={() => setSelectedStaffId(staffId)}
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

      {/* PARALLEL: "ai làm gì lúc nào" — mỗi dịch vụ ghép với KTV được gán, đều
          bắt đầu cùng giờ. Đây là điểm khách phải THẤY RÕ trước khi cam kết. */}
      {chosenSlot && mode === 'parallel' && (
        <div data-testid="combo-parallel-plan">
          <div className="ccf-bk-label">Ai làm gì lúc nào</div>
          <p className="ccf-bk-d" style={{ marginBottom: 10 }}>
            Tất cả bắt đầu lúc <b>{hm(chosenSlot.start_at)}</b>, mỗi dịch vụ một kỹ thuật viên làm cùng lúc.
          </p>
          <div className="ccf-bk-summary">
            {basket.map((it, i) => {
              const staffId = chosenSlot.staff_ids[i]
              const end = chosenSlot.start_at + it.variant.duration_min * 60
              return (
                <div key={it.variant.id} className="ccf-bk-sline" data-testid={`combo-parallel-leg-${it.variant.id}`}>
                  <span className="ccf-bk-k">
                    {it.service.name} · {it.variant.name}
                  </span>
                  <span className="ccf-bk-v">
                    KTV #{staffId} · {hm(chosenSlot.start_at)}–{hm(end)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="ccf-bk-dock">
        <Button
          disabled={!canContinue}
          onClick={() => {
            if (selectedStartAt === null || chosenSlot === null || chosenSlot === undefined) return
            if (mode === 'parallel') {
              onContinue('parallel', dateStr, selectedStartAt, null, chosenSlot.staff_ids)
            } else {
              onContinue('serial', dateStr, selectedStartAt, selectedStaffId, null)
            }
          }}
          data-testid="combo-time-continue"
        >
          {selectedStartAt !== null ? `Tiếp tục · ${hm(selectedStartAt)}` : 'Chọn giờ để tiếp tục'}
        </Button>
      </div>
    </>
  )
}

// 7. Combo — xác nhận. Hiện lịch trình nối tiếp từng bước (giờ bắt đầu mỗi
// dịch vụ) để khách thấy rõ trình tự trước khi cam kết.
function ComboConfirmScreen({
  basket,
  mode,
  dateStr,
  startAt,
  staffId,
  staffIds,
  onSlotTaken,
  onDone,
}: {
  basket: BasketItem[]
  mode: ComboMode
  dateStr: string
  startAt: number
  staffId: number | null
  staffIds: number[] | null
  onSlotTaken: () => void
  onDone: (result: ComboBookingResult) => void
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const nameValid = name.trim().length > 1
  const phoneValid = phone.replace(/\D/g, '').length >= 9
  const canSubmit = nameValid && phoneValid && !submitting

  const { totalPrice } = basketTotals(basket)

  // Lịch trình. Serial: nối tiếp (mỗi bước sau block bước trước — khớp
  // layoutChain). Parallel: mọi dịch vụ CÙNG bắt đầu tại startAt, mỗi dịch vụ
  // một KTV riêng (khớp layoutParallel) — khách thấy rõ "ai làm gì lúc nào".
  const schedule = useMemo(() => {
    if (mode === 'parallel') {
      return basket.map((it, i) => ({
        it,
        start: startAt,
        end: startAt + it.variant.duration_min * 60,
        legStaffId: staffIds?.[i] ?? null,
      }))
    }
    let cursor = startAt
    return basket.map((it) => {
      const start = cursor
      const end = start + it.variant.duration_min * 60
      cursor = end + it.variant.buffer_after_min * 60
      return { it, start, end, legStaffId: null as number | null }
    })
  }, [basket, startAt, mode, staffIds])

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    setNotice(null)
    try {
      const result = await createComboBooking({
        customer: { name: name.trim(), phone: phone.trim() },
        variant_ids: basket.map((it) => it.variant.id),
        start_at: startAt,
        mode,
        // Chỉ serial mới gửi staff_id (song song mỗi leg một KTV, server tự gán).
        ...(mode === 'serial' && staffId !== null ? { staff_id: staffId } : {}),
      })
      onDone(result)
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.code === 'SLOT_TAKEN' || err.code === 'STAFF_LACKS_SKILL' || err.code === 'ZONE_CONFLICT')
      ) {
        // Chỗ vừa bị chiếm (kể cả song song mất một phần), hoặc KTV/vùng không
        // còn hợp lệ: quay về bước chọn kiểu & giờ — không hiện mã lỗi thô.
        onSlotTaken()
        return
      }
      setNotice(
        `Rất tiếc, chúng tôi chưa đặt được combo này. Bạn thử lại giúp mình nhé, hoặc gọi ${SPA_PHONE_DISPLAY} để được hỗ trợ.`,
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div className="ccf-bk-h2">Gần xong rồi</div>
      <p className="ccf-bk-lede">
        {mode === 'parallel'
          ? 'Mỗi dịch vụ một kỹ thuật viên làm cùng lúc. Kiểm tra lại ai làm gì nhé.'
          : 'Cả combo do một kỹ thuật viên làm liền mạch. Kiểm tra lại trình tự nhé.'}
      </p>
      <div className="ccf-bk-summary" data-testid="combo-confirm-summary">
        <div className="ccf-bk-sline">
          <span className="ccf-bk-k">Ngày</span>
          <span className="ccf-bk-v">{fullDateLabel(dateStr)}</span>
        </div>
        <div className="ccf-bk-sline">
          <span className="ccf-bk-k">Kiểu</span>
          <span className="ccf-bk-v">{mode === 'parallel' ? 'Song song (nhiều KTV cùng lúc)' : 'Nối tiếp (một KTV)'}</span>
        </div>
        {schedule.map(({ it, start, end, legStaffId }) => (
          <div key={it.variant.id} className="ccf-bk-sline">
            <span className="ccf-bk-k">
              {it.service.name} · {it.variant.name}
            </span>
            <span className="ccf-bk-v">
              {hm(start)} – {hm(end)}
              {mode === 'parallel' && legStaffId !== null ? ` · KTV #${legStaffId}` : ''}
            </span>
          </div>
        ))}
        {mode === 'serial' && (
          <div className="ccf-bk-sline">
            <span className="ccf-bk-k">Kỹ thuật viên</span>
            <span className="ccf-bk-v">{staffId !== null ? `Kỹ thuật viên #${staffId}` : 'Spa sắp xếp'}</span>
          </div>
        )}
        <div className="ccf-bk-sline ccf-bk-sline--total">
          <span className="ccf-bk-k">Tổng cộng</span>
          <span className="ccf-bk-v">{formatVnd(totalPrice)}</span>
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
          {submitting ? 'Đang xử lý...' : 'Xác nhận đặt combo'}
        </Button>
      </div>
    </>
  )
}

// 8. Combo — thành công.
function ComboDoneScreen({
  basket,
  mode,
  dateStr,
  startAt,
  result,
  onHome,
}: {
  basket: BasketItem[]
  mode: ComboMode
  dateStr: string
  startAt: number
  result: ComboBookingResult
  onHome: () => void
}) {
  const isToday = dateStr === dateStrOf(Math.floor(Date.now() / 1000))
  const { totalPrice } = basketTotals(basket)
  // Parallel: tra tên KTV theo staff_id của từng item, khớp variant → leg.
  const staffNameById = useMemo(() => {
    const map = new Map<number, string>()
    for (const s of result.staff_by_id ?? []) map.set(s.id, s.name)
    return map
  }, [result])
  const itemByVariant = useMemo(() => {
    const map = new Map<number, { staff_id?: number }>()
    for (const it of result.items) if (typeof it.variant_id === 'number') map.set(it.variant_id as number, it)
    return map
  }, [result])

  return (
    <>
      <div className="ccf-bk-ok">
        <div className="ccf-bk-mark">✓</div>
        <h2>Đặt combo thành công</h2>
        <p>
          Hẹn gặp bạn {isToday ? 'hôm nay' : `ngày ${fullDateLabel(dateStr)}`} lúc <b>{hm(startAt)}</b>
        </p>
        <div className="ccf-bk-code" data-testid="booking-code">
          MÃ ĐẶT LỊCH · {result.appointment.id}
        </div>
      </div>
      <div className="ccf-bk-summary">
        {basket.map((it) => {
          const legStaffId = itemByVariant.get(it.variant.id)?.staff_id
          const legStaffName = legStaffId !== undefined ? staffNameById.get(legStaffId) ?? `KTV #${legStaffId}` : null
          return (
            <div key={it.variant.id} className="ccf-bk-sline">
              <span className="ccf-bk-k">{it.service.name}</span>
              <span className="ccf-bk-v">
                {it.variant.name}
                {mode === 'parallel' && legStaffName ? ` · ${legStaffName}` : ''}
              </span>
            </div>
          )
        })}
        <div className="ccf-bk-sline">
          <span className="ccf-bk-k">{mode === 'parallel' ? 'Kiểu' : 'Kỹ thuật viên'}</span>
          <span className="ccf-bk-v">
            {mode === 'parallel' ? 'Song song · nhiều KTV cùng lúc' : result.staff?.name ?? 'Spa sắp xếp'}
          </span>
        </div>
        <div className="ccf-bk-sline ccf-bk-sline--total">
          <span className="ccf-bk-k">Thanh toán tại spa</span>
          <span className="ccf-bk-v">{formatVnd(totalPrice)}</span>
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
