import { useEffect, useMemo, useState } from 'react'
import Button from '../../../components/Button'
import Field from '../../../components/Field'
import Notice from '../../../components/Notice'
import EmptyState from '../../../components/EmptyState'
import { getShifts, getStaff, replaceStaffWeek, type Staff, type WorkShift } from './api'
import { hmToMinutes, minutesToHm, WEEKDAY_LABELS } from './format'

export interface ShiftsTabProps {
  /** true khi tab này đang hiển thị. Dùng để refetch danh sách nhân viên mỗi
   * lần CHUYỂN TỚI tab (không chỉ lúc mount) — nhân viên có thể vừa được
   * thêm ở tab Nhân viên trong cùng phiên (xem comment ở SetupPage). */
  active: boolean
}

// Thứ tự hiển thị lưới: Thứ 2 → Chủ nhật (quen mắt owner VN). weekday LƯU trong
// DB vẫn là 0=CN..6=T7 (khớp WEEKDAY_LABELS + weekdayOf trong engine) — đây chỉ
// là thứ tự DÒNG trong lưới, không đổi giá trị lưu.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const

// Nhãn ngắn cho tóm tắt tuần (đỡ dài như "Thứ Hai").
const WEEKDAY_SHORT = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'] as const

const DEFAULT_START = '09:00'
const DEFAULT_END = '17:00'

interface DayState {
  on: boolean
  start: string
  end: string
}

// Map giữ ĐỦ 7 ngày; dayOf() luôn trả DayState (không undefined) để tránh
// noUncheckedIndexedAccess.
type WeekState = Map<number, DayState>

function dayOf(week: WeekState, weekday: number): DayState {
  return week.get(weekday) ?? { on: false, start: DEFAULT_START, end: DEFAULT_END }
}

function emptyWeek(): WeekState {
  const w: WeekState = new Map()
  for (const wd of WEEK_ORDER) w.set(wd, { on: false, start: DEFAULT_START, end: DEFAULT_END })
  return w
}

/** Dựng trạng thái lưới từ các dòng work_shifts hiện có của MỘT KTV. */
function weekFromShifts(shifts: WorkShift[], staffId: number): WeekState {
  const w = emptyWeek()
  for (const sh of shifts) {
    if (sh.staff_id !== staffId) continue
    w.set(sh.weekday, { on: true, start: minutesToHm(sh.start_min), end: minutesToHm(sh.end_min) })
  }
  return w
}

/** Tóm tắt gọn một tuần: "T2–T6 09:00–17:00, T7 09:00–12:00" hoặc "Chưa có ca". */
function summarize(shifts: WorkShift[], staffId: number): string {
  const rows = shifts
    .filter((s) => s.staff_id === staffId)
    .sort((a, b) => a.weekday - b.weekday || a.start_min - b.start_min)
  if (rows.length === 0) return 'Chưa có ca'
  return rows
    .map((r) => `${WEEKDAY_SHORT[r.weekday]} ${minutesToHm(r.start_min)}–${minutesToHm(r.end_min)}`)
    .join(', ')
}

export default function ShiftsTab({ active }: ShiftsTabProps) {
  const [staff, setStaff] = useState<Staff[]>([])
  const [shifts, setShifts] = useState<WorkShift[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [staffId, setStaffId] = useState<number | ''>('')
  const [week, setWeek] = useState<WeekState>(emptyWeek())
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedOk, setSavedOk] = useState(false)

  // Giờ dùng cho nút "Áp giờ này cho các ngày đang bật".
  const [bulkStart, setBulkStart] = useState(DEFAULT_START)
  const [bulkEnd, setBulkEnd] = useState(DEFAULT_END)
  // KTV nguồn cho nút "Copy tuần".
  const [copyFromId, setCopyFromId] = useState<number | ''>('')

  async function loadAll() {
    setLoading(true)
    setLoadError(null)
    try {
      const [staffList, shiftList] = await Promise.all([getStaff(), getShifts()])
      setStaff(staffList)
      setShifts(shiftList)
    } catch {
      setLoadError('Không tải được danh sách. Vui lòng thử lại.')
    } finally {
      setLoading(false)
    }
  }

  /** Refetch danh sách nhân viên (không phải toàn bộ loadAll, để không mất
   * lưới đang sửa dở) mỗi lần tab được chuyển tới. */
  async function refreshStaffOnly() {
    try {
      setStaff(await getStaff())
    } catch {
      // Giữ danh sách cũ, không chặn thao tác.
    }
  }

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (active) refreshStaffOnly()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // Khi đổi KTV đang chọn → nạp lại lưới từ work_shifts của KTV đó.
  function selectStaff(next: number | '') {
    setStaffId(next)
    setFormError(null)
    setSavedOk(false)
    setWeek(next === '' ? emptyWeek() : weekFromShifts(shifts, next))
  }

  function setDay(weekday: number, patch: Partial<DayState>) {
    setSavedOk(false)
    setWeek((prev) => {
      const next = new Map(prev)
      next.set(weekday, { ...dayOf(prev, weekday), ...patch })
      return next
    })
  }

  function applyBulkHours() {
    setSavedOk(false)
    setWeek((prev) => {
      const next = new Map(prev)
      for (const wd of WEEK_ORDER) {
        const d = dayOf(prev, wd)
        if (d.on) next.set(wd, { ...d, start: bulkStart, end: bulkEnd })
      }
      return next
    })
  }

  function copyWeekFrom(sourceId: number) {
    setSavedOk(false)
    setFormError(null)
    setWeek(weekFromShifts(shifts, sourceId))
  }

  const staffName = useMemo(() => {
    const map = new Map(staff.map((s) => [s.id, s.name]))
    return (id: number) => map.get(id) ?? `#${id}`
  }, [staff])

  async function handleSaveWeek() {
    setFormError(null)
    setSavedOk(false)
    if (staffId === '') {
      setFormError('Vui lòng chọn nhân viên.')
      return
    }
    const rows: { weekday: number; start_min: number; end_min: number }[] = []
    for (const wd of WEEK_ORDER) {
      const d = dayOf(week, wd)
      if (!d.on) continue
      const startMin = hmToMinutes(d.start)
      const endMin = hmToMinutes(d.end)
      if (startMin === null || endMin === null) {
        setFormError(`${WEEKDAY_LABELS[wd]}: giờ không hợp lệ.`)
        return
      }
      if (endMin <= startMin) {
        setFormError(`${WEEKDAY_LABELS[wd]}: giờ kết thúc phải sau giờ bắt đầu.`)
        return
      }
      rows.push({ weekday: wd, start_min: startMin, end_min: endMin })
    }

    setSaving(true)
    try {
      const saved = await replaceStaffWeek(staffId, rows)
      // Cập nhật danh sách shift toàn cục: bỏ dòng cũ của KTV này, thêm dòng mới.
      setShifts((prev) => [...prev.filter((s) => s.staff_id !== staffId), ...saved])
      setSavedOk(true)
    } catch {
      setFormError('Không lưu được tuần làm việc. Vui lòng thử lại.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <p>Đang tải...</p>
  }

  const otherStaff = staff.filter((s) => s.id !== staffId)

  return (
    <div>
      {loadError && <Notice tone="warn">{loadError}</Notice>}

      <section className="ccf-su-section">
        <h2>Ca làm việc theo tuần mẫu</h2>
        <p className="ccf-su-hint">
          Chọn kỹ thuật viên rồi bật/tắt từng ngày và đặt giờ vào–ra cho cả tuần, một lần lưu.
          Nghỉ đột xuất một hôm → dùng <strong>Báo nghỉ</strong> trên Lịch ngày, không sửa ở đây.
        </p>

        <Field
          as="select"
          label="Kỹ thuật viên"
          value={staffId}
          onChange={(e) => selectStaff(e.target.value ? Number(e.target.value) : '')}
          data-testid="shift-staff-select"
        >
          <option value="">— Chọn kỹ thuật viên —</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Field>

        {staffId === '' ? (
          <EmptyState icon="🕒" text="Chọn một kỹ thuật viên để sửa tuần làm việc." />
        ) : (
          <>
            {formError && (
              <Notice tone="warn" data-testid="shift-error">
                {formError}
              </Notice>
            )}
            {savedOk && (
              <Notice tone="info" data-testid="shift-saved">
                Đã lưu tuần làm việc.
              </Notice>
            )}

            <div className="ccf-su-week-grid" data-testid="shift-week-grid">
              {WEEK_ORDER.map((wd) => {
                const d = dayOf(week, wd)
                return (
                  <div
                    key={wd}
                    className={`ccf-su-week-day${d.on ? '' : ' ccf-su-week-day--off'}`}
                    data-testid={`shift-day-${wd}`}
                  >
                    <label className="ccf-su-week-toggle">
                      <input
                        type="checkbox"
                        checked={d.on}
                        onChange={(e) => setDay(wd, { on: e.target.checked })}
                        data-testid={`shift-day-toggle-${wd}`}
                      />
                      <span className="ccf-su-week-dayname">{WEEKDAY_LABELS[wd]}</span>
                    </label>
                    {d.on ? (
                      <div className="ccf-su-week-hours">
                        <input
                          type="time"
                          className="ccf-su-week-time"
                          value={d.start}
                          onChange={(e) => setDay(wd, { start: e.target.value })}
                          data-testid={`shift-day-start-${wd}`}
                          aria-label={`${WEEKDAY_LABELS[wd]} giờ vào`}
                        />
                        <span className="ccf-su-week-dash">–</span>
                        <input
                          type="time"
                          className="ccf-su-week-time"
                          value={d.end}
                          onChange={(e) => setDay(wd, { end: e.target.value })}
                          data-testid={`shift-day-end-${wd}`}
                          aria-label={`${WEEKDAY_LABELS[wd]} giờ ra`}
                        />
                      </div>
                    ) : (
                      <span className="ccf-su-week-off-label">Nghỉ</span>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="ccf-su-week-tools">
              <div className="ccf-su-week-tool">
                <span className="ccf-su-label">Áp giờ cho các ngày đang bật</span>
                <div className="ccf-su-week-hours">
                  <input
                    type="time"
                    className="ccf-su-week-time"
                    value={bulkStart}
                    onChange={(e) => setBulkStart(e.target.value)}
                    data-testid="shift-bulk-start"
                    aria-label="Áp giờ vào"
                  />
                  <span className="ccf-su-week-dash">–</span>
                  <input
                    type="time"
                    className="ccf-su-week-time"
                    value={bulkEnd}
                    onChange={(e) => setBulkEnd(e.target.value)}
                    data-testid="shift-bulk-end"
                    aria-label="Áp giờ ra"
                  />
                  <Button variant="ghost" size="sm" onClick={applyBulkHours} data-testid="shift-bulk-apply">
                    Áp
                  </Button>
                </div>
              </div>

              {otherStaff.length > 0 && (
                <div className="ccf-su-week-tool">
                  <span className="ccf-su-label">Copy tuần của KTV khác</span>
                  <div className="ccf-su-week-hours">
                    <Field
                      as="select"
                      value={copyFromId}
                      onChange={(e) => setCopyFromId(e.target.value ? Number(e.target.value) : '')}
                      data-testid="shift-copy-select"
                    >
                      <option value="">— Chọn KTV nguồn —</option>
                      {otherStaff.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Field>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={copyFromId === ''}
                      onClick={() => copyFromId !== '' && copyWeekFrom(copyFromId)}
                      data-testid="shift-copy-apply"
                    >
                      Copy
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <Button onClick={handleSaveWeek} disabled={saving} data-testid="shift-save-week">
              {saving ? 'Đang lưu...' : 'Lưu tuần'}
            </Button>
          </>
        )}
      </section>

      <section className="ccf-su-section">
        <h2>Tóm tắt tuần theo KTV</h2>
        {staff.length === 0 ? (
          <EmptyState icon="🕒" text="Chưa có kỹ thuật viên nào." />
        ) : (
          <div data-testid="shift-summary-list">
            {staff.map((s) => (
              <button
                key={s.id}
                type="button"
                className="ccf-su-shift-row ccf-su-week-summary"
                data-testid={`shift-summary-${s.id}`}
                onClick={() => selectStaff(s.id)}
              >
                <div className="ccf-su-row-main">
                  <div className="ccf-su-row-title">{staffName(s.id)}</div>
                  <div className="ccf-su-row-sub">{summarize(shifts, s.id)}</div>
                </div>
                <span className="ccf-su-week-edit-hint">Sửa →</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
