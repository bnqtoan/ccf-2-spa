import { useEffect, useMemo, useState } from 'react'
import { BarChart3 } from 'lucide-react'
import Button from '../../../components/Button'
import EmptyState from '../../../components/EmptyState'
import Notice from '../../../components/Notice'
import Sheet from '../../../components/Sheet'
import {
  ApiError,
  getOverview,
  getStaffEarnings,
  type OverviewResponse,
  type OverviewStaff,
  type Period,
  type StaffEarnings,
} from './api'
import { addDays, formatDateNav, formatPct, formatVnd, isSlotBusy, toDateStr } from './format'
import './overview.css'

// Lưới lấp đầy: mỗi cột giờ rộng 1 slot. Khung giờ hiển thị 9h–19h (giờ mở
// cửa mặc định của spa trong seed). Đây là "máy tính bấm tay": mỗi ô xanh =
// bận, xám = trống.
const FIRST_HOUR = 9
const LAST_HOUR = 19 // exclusive-ish: cột cuối là 18:00–19:00
const SLOT_LEN_MIN = 60

const PERIOD_LABEL: Record<Period, string> = {
  day: 'Ngày',
  week: 'Tuần',
  month: 'Tháng',
}

function occupancyText(s: OverviewStaff): string {
  if (s.on_leave) return 'Nghỉ'
  if (!s.has_shift) return '—'
  if (s.occupancy_pct === null) return '—'
  return `${s.occupancy_pct}%`
}

export default function OverviewPage() {
  const todayStr = useMemo(() => toDateStr(Math.floor(Date.now() / 1000)), [])
  const [date, setDate] = useState(todayStr)
  const [data, setData] = useState<OverviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Drill-down: KTV đang chọn + thu nhập theo kỳ.
  const [selectedStaffId, setSelectedStaffId] = useState<number | null>(null)
  const [period, setPeriod] = useState<Period>('day')
  const [earnings, setEarnings] = useState<StaffEarnings | null>(null)
  const [earningsLoading, setEarningsLoading] = useState(false)
  const [earningsError, setEarningsError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      setData(await getOverview(date))
    } catch {
      setError('Không tải được số liệu. Vui lòng thử lại.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date])

  const selectedStaff = useMemo(
    () => data?.staff.find((s) => s.id === selectedStaffId) ?? null,
    [data, selectedStaffId],
  )

  useEffect(() => {
    if (selectedStaffId === null) return
    let cancelled = false
    setEarningsLoading(true)
    setEarningsError(null)
    getStaffEarnings(selectedStaffId, period, date)
      .then((e) => {
        if (!cancelled) setEarnings(e)
      })
      .catch(() => {
        if (!cancelled) setEarningsError('Không tải được thu nhập. Vui lòng thử lại.')
      })
      .finally(() => {
        if (!cancelled) setEarningsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedStaffId, period, date])

  function openStaff(id: number) {
    setSelectedStaffId(id)
    setPeriod('day')
    setEarnings(null)
  }

  const hours: number[] = []
  for (let h = FIRST_HOUR; h < LAST_HOUR; h++) hours.push(h)

  if (loading && data === null) {
    return (
      <div className="ccf-ov-page">
        <p>Đang tải số liệu...</p>
      </div>
    )
  }

  if (error && data === null) {
    return (
      <div className="ccf-ov-page">
        <Notice tone="warn">{error}</Notice>
        <Button variant="ghost" onClick={load}>
          Thử lại
        </Button>
      </div>
    )
  }

  const kpi = data?.kpi
  const staff = data?.staff ?? []

  return (
    <div className="ccf-ov-page">
      <header className="ccf-ov-head">
        <h1>Tổng quan hôm nay</h1>
        <div className="ccf-ov-datenav">
          <button
            type="button"
            aria-label="Ngày trước"
            data-testid="ov-date-prev"
            onClick={() => setDate((d) => addDays(d, -1))}
          >
            ‹
          </button>
          <span className="ccf-ov-cur" data-testid="ov-date-current">
            {formatDateNav(date, todayStr)}
          </span>
          <button
            type="button"
            aria-label="Ngày sau"
            data-testid="ov-date-next"
            onClick={() => setDate((d) => addDays(d, 1))}
          >
            ›
          </button>
        </div>
      </header>

      {/* KPI strip — mỗi số kèm 1 quyết định nó phục vụ (không phải stat card trơ). */}
      {kpi && (
        <div className="ccf-ov-kpis" data-testid="ov-kpis">
          <div className="ccf-ov-kpi" data-testid="kpi-revenue">
            <div className="ccf-ov-kpi-label">Doanh thu hôm nay</div>
            <div className="ccf-ov-kpi-val">{formatVnd(kpi.revenue)}</div>
            <div className="ccf-ov-kpi-hint">Chỉ tính lịch đã hoàn thành · để đặt giá / chốt chỉ tiêu</div>
          </div>
          <div className="ccf-ov-kpi" data-testid="kpi-done">
            <div className="ccf-ov-kpi-label">Số lịch hoàn thành</div>
            <div className="ccf-ov-kpi-val">{kpi.done_count}</div>
            <div className="ccf-ov-kpi-hint">Số lượt khách thực làm hôm nay</div>
          </div>
          <div className="ccf-ov-kpi" data-testid="kpi-occupancy">
            <div className="ccf-ov-kpi-label">Tỷ lệ lấp đầy</div>
            <div className="ccf-ov-kpi-val">
              {kpi.occupancy_pct === null ? '—' : `${kpi.occupancy_pct}%`}
            </div>
            <div className="ccf-ov-kpi-hint">
              Giờ có khách ÷ giờ làm (đã trừ giờ nghỉ) · để cân ca / quyết định tuyển thêm
            </div>
          </div>
          <div className="ccf-ov-kpi" data-testid="kpi-noshow">
            <div className="ccf-ov-kpi-label">Khách không đến</div>
            <div className="ccf-ov-kpi-val">{kpi.no_show_count}</div>
            <div className="ccf-ov-kpi-hint">Số lịch khách bỏ · để cân nhắc thu cọc giữ chỗ</div>
          </div>
        </div>
      )}

      {staff.length === 0 ? (
        <EmptyState icon={<BarChart3 />} text="Chưa có kỹ thuật viên nào đang hoạt động." />
      ) : (
        <>
          <h2 className="ccf-ov-sub">Ai bận, ai rảnh</h2>
          <div className="ccf-ov-gridwrap">
            <table className="ccf-ov-grid" data-testid="ov-grid">
              <thead>
                <tr>
                  <th className="ccf-ov-name-h">Kỹ thuật viên</th>
                  {hours.map((h) => (
                    <th key={h} className="ccf-ov-hour-h">
                      {String(h).padStart(2, '0')}
                    </th>
                  ))}
                  <th className="ccf-ov-occ-h">Lấp đầy</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((s) => (
                  <tr key={s.id} data-testid={`ov-row-${s.id}`}>
                    <th scope="row" className="ccf-ov-name">
                      <button
                        type="button"
                        className="ccf-ov-name-btn"
                        data-testid={`ov-staff-${s.id}`}
                        onClick={() => openStaff(s.id)}
                      >
                        {s.name}
                        {s.on_leave && <span className="ccf-ov-leave-tag"> · Nghỉ</span>}
                      </button>
                    </th>
                    {hours.map((h) => {
                      const busy = isSlotBusy(h * 60, SLOT_LEN_MIN, s.busy_intervals)
                      return (
                        <td
                          key={h}
                          className={`ccf-ov-cell ${busy ? 'ccf-ov-cell--busy' : 'ccf-ov-cell--free'}`}
                          data-testid={`ov-cell-${s.id}-${h}`}
                          data-busy={busy ? 'true' : 'false'}
                          aria-label={`${s.name} lúc ${h}h: ${busy ? 'có khách' : 'trống'}`}
                        />
                      )
                    })}
                    <td className="ccf-ov-occ" data-testid={`ov-occ-${s.id}`}>
                      {occupancyText(s)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="ccf-ov-legend">
            <span>
              <i className="ccf-ov-sw ccf-ov-sw--busy" /> Có khách
            </span>
            <span>
              <i className="ccf-ov-sw ccf-ov-sw--free" /> Trống
            </span>
            <span className="ccf-ov-legend-note">
              "Nghỉ" = nghỉ cả ngày (không tính vào tỷ lệ lấp đầy) · "—" = không có ca làm hôm nay.
            </span>
          </div>
        </>
      )}

      <Sheet
        open={selectedStaff !== null}
        onClose={() => setSelectedStaffId(null)}
        title={selectedStaff ? `${selectedStaff.name} — thu nhập` : ''}
        footer={
          <Button variant="ghost" onClick={() => setSelectedStaffId(null)}>
            Đóng
          </Button>
        }
      >
        {selectedStaff && (
          <div data-testid="ov-earnings-sheet">
            <div className="ccf-ov-periodtabs">
              {(['day', 'week', 'month'] as Period[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`ccf-ov-periodtab ${period === p ? 'is-active' : ''}`}
                  data-testid={`ov-period-${p}`}
                  onClick={() => setPeriod(p)}
                >
                  {PERIOD_LABEL[p]}
                </button>
              ))}
            </div>

            {earningsError && (
              <Notice tone="warn" style={{ marginTop: 12 }}>
                {earningsError}
              </Notice>
            )}

            {earningsLoading && earnings === null ? (
              <p>Đang tải...</p>
            ) : (
              earnings && (
                <div className="ccf-ov-earn">
                  <div className="ccf-ov-earn-line">
                    <span className="ccf-ov-k">Doanh thu ({PERIOD_LABEL[earnings.period].toLowerCase()})</span>
                    <span className="ccf-ov-v" data-testid="ov-earn-revenue">
                      {formatVnd(earnings.revenue)}
                    </span>
                  </div>
                  <div className="ccf-ov-earn-line">
                    <span className="ccf-ov-k">Số lịch hoàn thành</span>
                    <span className="ccf-ov-v">{earnings.done_count}</span>
                  </div>
                  <div className="ccf-ov-earn-line">
                    <span className="ccf-ov-k">Tỉ lệ hoa hồng</span>
                    <span className="ccf-ov-v">{formatPct(earnings.commission_rate)}</span>
                  </div>
                  <div className="ccf-ov-earn-line ccf-ov-earn-line--total">
                    <span className="ccf-ov-k">Tiền công phải trả</span>
                    <span className="ccf-ov-v" data-testid="ov-earn-payroll">
                      {formatVnd(earnings.payroll)}
                    </span>
                  </div>
                  {earnings.commission_rate === 0 && (
                    <Notice tone="info" style={{ marginTop: 14 }}>
                      Kỹ thuật viên này chưa được đặt tỉ lệ hoa hồng nên tiền công đang là 0. Đặt tỉ lệ ở
                      màn Thiết lập → Nhân viên.
                    </Notice>
                  )}
                </div>
              )
            )}
          </div>
        )}
      </Sheet>
    </div>
  )
}
