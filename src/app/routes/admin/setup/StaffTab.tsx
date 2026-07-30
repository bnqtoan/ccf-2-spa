import { useEffect, useState } from 'react'
import { Puzzle, User } from 'lucide-react'
import Button from '../../../components/Button'
import Card from '../../../components/Card'
import Field from '../../../components/Field'
import Notice from '../../../components/Notice'
import Pill from '../../../components/Pill'
import EmptyState from '../../../components/EmptyState'
import Sheet from '../../../components/Sheet'
import {
  ApiError,
  assignSkillToStaff,
  createSkill,
  createStaff,
  deleteSkill,
  getSkills,
  getStaff,
  getStaffSkillIds,
  getUpcomingItems,
  unassignSkillFromStaff,
  updateStaff,
  type Skill,
  type Staff,
  type UpcomingItem,
} from './api'
import { localParts } from '../timeline/format'

/** Bản đồ staff_id -> skill_id[]. Nạp thật từ GET /api/admin/staff/:id/skills
 * mỗi khi mở sheet của một nhân viên (openStaffSheet), rồi cập nhật cục bộ theo
 * thao tác gán/bỏ gán. Endpoint đọc này được bổ sung sau T-06. */

/** "DD/MM HH:mm" — lịch sắp tới có thể ở ngày khác hôm nay, nên hiện cả ngày
 * lẫn giờ (formatHm chỉ có giờ). */
function formatDayHm(epochSec: number): string {
  const p = localParts(epochSec)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(p.day)}/${pad(p.month)} ${pad(p.hour)}:${pad(p.minute)}`
}

export default function StaffTab() {
  const [staff, setStaff] = useState<Staff[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [staffSkills, setStaffSkills] = useState<Record<number, Set<number>>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [newName, setNewName] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const [newSkillName, setNewSkillName] = useState('')
  const [skillError, setSkillError] = useState<string | null>(null)

  const [editingStaff, setEditingStaff] = useState<Staff | null>(null)
  const [skillSheetError, setSkillSheetError] = useState<string | null>(null)

  // G0: khi định "Cho ngưng làm" một nhân viên còn lịch sắp tới, KHÔNG tắt âm
  // thầm (tắt active giấu luôn cả cột lẫn khách khỏi timeline mà không vào hàng
  // chờ). Chặn lại, liệt kê lịch bị ảnh hưởng, chỉ sang "Báo nghỉ".
  const [blockedItems, setBlockedItems] = useState<UpcomingItem[] | null>(null)
  const [checkingDeactivate, setCheckingDeactivate] = useState(false)

  async function loadAll() {
    setLoading(true)
    setLoadError(null)
    try {
      const [staffList, skillList] = await Promise.all([getStaff(), getSkills()])
      setStaff(staffList)
      setSkills(skillList)
    } catch {
      setLoadError('Không tải được danh sách. Vui lòng thử lại.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAll()
  }, [])

  async function handleAddStaff() {
    setAddError(null)
    const name = newName.trim()
    if (!name) {
      setAddError('Vui lòng nhập tên nhân viên.')
      return
    }
    setAdding(true)
    try {
      const created = await createStaff(name, newPhone.trim() || null)
      setStaff((prev) => [...prev, created])
      setNewName('')
      setNewPhone('')
    } catch {
      setAddError('Không thêm được nhân viên. Vui lòng thử lại.')
    } finally {
      setAdding(false)
    }
  }

  /** Kích hoạt lại: luôn an toàn, làm ngay. Trả về true nếu đã đổi. */
  async function reactivate(member: Staff): Promise<boolean> {
    try {
      const updated = await updateStaff(member.id, { active: true })
      setStaff((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
      return true
    } catch {
      setLoadError('Không cập nhật được trạng thái nhân viên.')
      return false
    }
  }

  /**
   * Cho ngưng làm: CHẶN nếu nhân viên còn lịch sắp tới (G0). Tắt active sẽ giấu
   * cột + khách khỏi timeline mà không đưa vào hàng chờ — đúng bẫy im lặng.
   * Kiểm tra trước, nếu còn lịch thì không gọi update, hiện danh sách bị ảnh
   * hưởng và chỉ sang "Báo nghỉ". Trả về true nếu đã cho ngưng thành công.
   */
  async function deactivate(member: Staff): Promise<boolean> {
    setBlockedItems(null)
    setCheckingDeactivate(true)
    try {
      const upcoming = await getUpcomingItems(member.id)
      if (upcoming.length > 0) {
        setBlockedItems(upcoming)
        return false
      }
      const updated = await updateStaff(member.id, { active: false })
      setStaff((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
      return true
    } catch {
      setLoadError('Không kiểm tra được lịch sắp tới của nhân viên. Vui lòng thử lại.')
      return false
    } finally {
      setCheckingDeactivate(false)
    }
  }

  async function handleAddSkill() {
    setSkillError(null)
    const name = newSkillName.trim()
    if (!name) {
      setSkillError('Vui lòng nhập tên kỹ năng.')
      return
    }
    try {
      const created = await createSkill(name)
      setSkills((prev) => [...prev, created])
      setNewSkillName('')
    } catch {
      setSkillError('Không thêm được kỹ năng. Vui lòng thử lại.')
    }
  }

  async function handleDeleteSkill(skill: Skill) {
    setSkillError(null)
    try {
      await deleteSkill(skill.id)
      setSkills((prev) => prev.filter((s) => s.id !== skill.id))
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setSkillError(`Không thể xoá "${skill.name}" vì đang có dịch vụ sử dụng kỹ năng này.`)
      } else {
        setSkillError('Không xoá được kỹ năng. Vui lòng thử lại.')
      }
    }
  }

  function currentSkillIds(staffId: number): Set<number> {
    return staffSkills[staffId] ?? new Set<number>()
  }

  /** Mở sheet sửa một nhân viên và nạp skill thật của họ từ server, để checkbox
   * hiện đúng trạng thái đã gán thay vì trống. */
  async function openStaffSheet(staff: Staff) {
    setEditingStaff(staff)
    setSkillSheetError(null)
    setBlockedItems(null)
    try {
      const ids = await getStaffSkillIds(staff.id)
      setStaffSkills((prev) => ({ ...prev, [staff.id]: new Set(ids) }))
    } catch {
      setSkillSheetError('Không tải được kỹ năng hiện có. Bạn vẫn gán/bỏ gán được.')
    }
  }

  async function handleToggleStaffSkill(staffId: number, skillId: number, checked: boolean) {
    setSkillSheetError(null)
    const before = currentSkillIds(staffId)
    const next = new Set(before)
    if (checked) next.add(skillId)
    else next.delete(skillId)
    setStaffSkills((prev) => ({ ...prev, [staffId]: next }))
    try {
      if (checked) await assignSkillToStaff(staffId, skillId)
      else await unassignSkillFromStaff(staffId, skillId)
    } catch {
      // Rollback nếu server từ chối.
      setStaffSkills((prev) => ({ ...prev, [staffId]: before }))
      setSkillSheetError('Không cập nhật được kỹ năng. Vui lòng thử lại.')
    }
  }

  if (loading) {
    return <p>Đang tải...</p>
  }

  return (
    <div>
      {loadError && <Notice tone="warn">{loadError}</Notice>}

      <section className="ccf-su-section">
        <h2>Thêm nhân viên</h2>
        {addError && <Notice tone="warn">{addError}</Notice>}
        <Field label="Tên" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Ví dụ: Chị Lan" data-testid="staff-name-input" />
        <Field
          label="Số điện thoại (tuỳ chọn)"
          type="tel"
          value={newPhone}
          onChange={(e) => setNewPhone(e.target.value)}
          placeholder="09xxxxxxxx"
          data-testid="staff-phone-input"
        />
        <Button onClick={handleAddStaff} disabled={adding} data-testid="staff-add-submit">
          {adding ? 'Đang thêm...' : 'Thêm nhân viên'}
        </Button>
      </section>

      <section className="ccf-su-section">
        <h2>Danh sách nhân viên</h2>
        {staff.length === 0 ? (
          <EmptyState icon={<User />} text="Chưa có nhân viên nào." />
        ) : (
          <div data-testid="staff-list">
            {staff.map((s) => (
              <Card key={s.id} data-testid={`staff-row-${s.id}`} onClick={() => openStaffSheet(s)}>
                <div className="ccf-su-row">
                  <div className="ccf-su-row-main">
                    <div className="ccf-su-row-title">{s.name}</div>
                    <div className="ccf-su-row-sub">{s.phone ?? 'Chưa có số điện thoại'}</div>
                  </div>
                  <Pill tone={s.active ? 'default' : 'gray'} data-testid={`staff-status-${s.id}`}>
                    {s.active ? 'Đang làm' : 'Ngưng'}
                  </Pill>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="ccf-su-section">
        <h2>Kỹ năng</h2>
        {skillError && <Notice tone="warn" data-testid="skill-error">{skillError}</Notice>}
        <div className="ccf-su-inline-form">
          <Field
            label="Thêm kỹ năng mới"
            value={newSkillName}
            onChange={(e) => setNewSkillName(e.target.value)}
            placeholder="Ví dụ: Trang điểm"
            data-testid="skill-name-input"
          />
          <Button variant="ghost" size="sm" onClick={handleAddSkill} data-testid="skill-add-submit">
            Thêm kỹ năng
          </Button>
        </div>
        {skills.length === 0 ? (
          <EmptyState icon={<Puzzle />} text="Chưa có kỹ năng nào." />
        ) : (
          <div className="ccf-su-chips" data-testid="skill-list">
            {skills.map((sk) => (
              <span key={sk.id} className="ccf-su-chip" data-testid={`skill-chip-${sk.id}`}>
                {sk.name}
                <button
                  type="button"
                  className="ccf-su-chip-x"
                  aria-label={`Xoá kỹ năng ${sk.name}`}
                  data-testid={`skill-delete-${sk.id}`}
                  onClick={() => handleDeleteSkill(sk)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </section>

      <Sheet
        open={editingStaff !== null}
        onClose={() => {
          setEditingStaff(null)
          setSkillSheetError(null)
          setBlockedItems(null)
        }}
        title={editingStaff?.name ?? ''}
        footer={
          <Button variant="ghost" onClick={() => setEditingStaff(null)}>
            Đóng
          </Button>
        }
      >
        {editingStaff && (
          <div data-testid="staff-edit-sheet">
            <div className="ccf-su-toggle-row">
              <span>Trạng thái</span>
              <Button
                variant={editingStaff.active ? 'ghost' : 'primary'}
                size="sm"
                disabled={checkingDeactivate}
                data-testid="staff-toggle-active"
                onClick={async () => {
                  if (editingStaff.active) {
                    // Cho ngưng làm: có thể bị CHẶN vì còn lịch sắp tới (G0).
                    const done = await deactivate(editingStaff)
                    if (done) {
                      setEditingStaff((prev) => (prev ? { ...prev, active: 0 } : prev))
                    }
                  } else {
                    const done = await reactivate(editingStaff)
                    if (done) {
                      setEditingStaff((prev) => (prev ? { ...prev, active: 1 } : prev))
                    }
                  }
                }}
              >
                {editingStaff.active
                  ? checkingDeactivate
                    ? 'Đang kiểm tra...'
                    : 'Cho ngưng làm'
                  : 'Kích hoạt lại'}
              </Button>
            </div>

            {blockedItems !== null && blockedItems.length > 0 && (
              <Notice tone="warn" data-testid="deactivate-blocked">
                <strong>Chưa thể cho {editingStaff.name} ngưng làm.</strong>
                <p style={{ margin: '6px 0' }}>
                  Nhân viên này còn {blockedItems.length} lịch hẹn sắp tới. Nếu cho ngưng
                  bây giờ, các lịch này sẽ biến mất khỏi bảng ngày mà không ai được báo — khách
                  vẫn tưởng còn hẹn.
                </p>
                <ul className="ccf-su-blocked-list" data-testid="deactivate-blocked-list">
                  {blockedItems.map((it) => (
                    <li key={it.item_id}>
                      {formatDayHm(it.start_at)} · {it.customer_name} — {it.service_name}
                    </li>
                  ))}
                </ul>
                <p style={{ margin: '6px 0 0' }}>
                  Nếu nhân viên chỉ nghỉ một buổi, hãy dùng <strong>“Báo nghỉ”</strong> trên màn
                  <strong> Lịch ngày</strong> (bấm tên nhân viên ở đầu cột) — cách đó sẽ đưa các
                  lịch bị ảnh hưởng vào hàng chờ để gọi khách và chuyển người.
                </p>
              </Notice>
            )}

            {skillSheetError && <Notice tone="warn">{skillSheetError}</Notice>}

            <div className="ccf-su-label">Kỹ năng đảm nhận</div>
            <p className="ccf-su-hint" data-testid="staff-skill-hint">
              Đánh dấu kỹ năng nhân viên này có. Ô đã đánh dấu trong phiên làm việc
              này đã được lưu; mở lại trang sẽ cần đánh dấu lại (hệ thống hiện
              không lưu trạng thái này để hiển thị lại).
            </p>
            {skills.length === 0 ? (
              <p className="ccf-su-hint">Chưa có kỹ năng nào — thêm ở mục "Kỹ năng" phía trên.</p>
            ) : (
              <div className="ccf-su-checklist" data-testid="staff-skill-checklist">
                {skills.map((sk) => {
                  const checked = currentSkillIds(editingStaff.id).has(sk.id)
                  return (
                    <label key={sk.id} className="ccf-su-check-item" data-testid={`staff-skill-${editingStaff.id}-${sk.id}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => handleToggleStaffSkill(editingStaff.id, sk.id, e.target.checked)}
                      />
                      <span>{sk.name}</span>
                    </label>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </Sheet>
    </div>
  )
}
