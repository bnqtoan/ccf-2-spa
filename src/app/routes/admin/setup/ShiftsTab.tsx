import { useEffect, useMemo, useState } from 'react'
import Button from '../../../components/Button'
import Field from '../../../components/Field'
import Notice from '../../../components/Notice'
import EmptyState from '../../../components/EmptyState'
import { createShift, deleteShift, getShifts, getStaff, type Staff, type WorkShift } from './api'
import { hmToMinutes, minutesToHm, WEEKDAY_LABELS } from './format'

export interface ShiftsTabProps {
  /** true khi tab này đang hiển thị. Dùng để refetch danh sách nhân viên mỗi
   * lần CHUYỂN TỚI tab (không chỉ lúc mount) — nhân viên có thể vừa được
   * thêm ở tab Nhân viên trong cùng phiên (xem comment ở SetupPage). */
  active: boolean
}

export default function ShiftsTab({ active }: ShiftsTabProps) {
  const [staff, setStaff] = useState<Staff[]>([])
  const [shifts, setShifts] = useState<WorkShift[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [staffId, setStaffId] = useState<number | ''>('')
  const [weekday, setWeekday] = useState<number | ''>('')
  const [startHm, setStartHm] = useState('09:00')
  const [endHm, setEndHm] = useState('17:00')
  const [formError, setFormError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

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
   * ca vừa nhập dở dang trên form) mỗi lần tab được chuyển tới. */
  async function refreshStaffOnly() {
    try {
      setStaff(await getStaff())
    } catch {
      // Giữ danh sách cũ, không chặn thao tác — lỗi mạng tạm thời không nên
      // xoá sạch dropdown đang có.
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

  const staffName = useMemo(() => {
    const map = new Map(staff.map((s) => [s.id, s.name]))
    return (id: number) => map.get(id) ?? `#${id}`
  }, [staff])

  async function handleAddShift() {
    setFormError(null)
    if (staffId === '') {
      setFormError('Vui lòng chọn nhân viên.')
      return
    }
    if (weekday === '') {
      setFormError('Vui lòng chọn thứ trong tuần.')
      return
    }
    const startMin = hmToMinutes(startHm)
    const endMin = hmToMinutes(endHm)
    if (startMin === null || endMin === null) {
      setFormError('Giờ không hợp lệ.')
      return
    }
    if (endMin <= startMin) {
      setFormError('Giờ kết thúc phải sau giờ bắt đầu.')
      return
    }

    setAdding(true)
    try {
      const created = await createShift({ staff_id: staffId, weekday, start_min: startMin, end_min: endMin })
      setShifts((prev) => [...prev, created])
    } catch {
      setFormError('Không thêm được ca làm việc. Vui lòng thử lại.')
    } finally {
      setAdding(false)
    }
  }

  async function handleDeleteShift(shift: WorkShift) {
    try {
      await deleteShift(shift.id)
      setShifts((prev) => prev.filter((s) => s.id !== shift.id))
    } catch {
      setLoadError('Không xoá được ca làm việc. Vui lòng thử lại.')
    }
  }

  if (loading) {
    return <p>Đang tải...</p>
  }

  const sortedShifts = [...shifts].sort((a, b) => a.staff_id - b.staff_id || a.weekday - b.weekday || a.start_min - b.start_min)

  return (
    <div>
      {loadError && <Notice tone="warn">{loadError}</Notice>}

      <section className="ccf-su-section">
        <h2>Đặt ca làm việc</h2>
        {formError && <Notice tone="warn" data-testid="shift-error">{formError}</Notice>}
        <Field
          as="select"
          label="Nhân viên"
          value={staffId}
          onChange={(e) => setStaffId(e.target.value ? Number(e.target.value) : '')}
          data-testid="shift-staff-select"
        >
          <option value="">— Chọn nhân viên —</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Field>
        <Field
          as="select"
          label="Thứ trong tuần"
          value={weekday}
          onChange={(e) => setWeekday(e.target.value ? Number(e.target.value) : '')}
          data-testid="shift-weekday-select"
        >
          <option value="">— Chọn thứ —</option>
          {WEEKDAY_LABELS.map((label, idx) => (
            <option key={idx} value={idx}>
              {label}
            </option>
          ))}
        </Field>
        <Field
          label="Giờ bắt đầu"
          type="time"
          value={startHm}
          onChange={(e) => setStartHm(e.target.value)}
          data-testid="shift-start-input"
        />
        <Field
          label="Giờ kết thúc"
          type="time"
          value={endHm}
          onChange={(e) => setEndHm(e.target.value)}
          data-testid="shift-end-input"
        />
        <Button onClick={handleAddShift} disabled={adding} data-testid="shift-add-submit">
          {adding ? 'Đang thêm...' : 'Thêm ca làm việc'}
        </Button>
      </section>

      <section className="ccf-su-section">
        <h2>Danh sách ca làm việc</h2>
        {sortedShifts.length === 0 ? (
          <EmptyState icon="🕒" text="Chưa có ca làm việc nào." />
        ) : (
          <div data-testid="shift-list">
            {sortedShifts.map((sh) => (
              <div key={sh.id} className="ccf-su-shift-row" data-testid={`shift-row-${sh.id}`}>
                <div className="ccf-su-row-main">
                  <div className="ccf-su-row-title">{staffName(sh.staff_id)}</div>
                  <div className="ccf-su-row-sub">
                    {WEEKDAY_LABELS[sh.weekday]} · {minutesToHm(sh.start_min)} – {minutesToHm(sh.end_min)}
                  </div>
                </div>
                <Button
                  variant="danger"
                  size="sm"
                  data-testid={`shift-delete-${sh.id}`}
                  onClick={() => handleDeleteShift(sh)}
                >
                  Xoá
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
