// T-22 — trang quản lý user (OWNER ONLY; guard route + nav đã lọc, server là
// gate thật). owner: xem danh sách user, tạo user mới (gán role + link KTV cho
// technician), đổi role, vô hiệu/kích hoạt, đặt lại mật khẩu.
//
// RÀNG BUỘC role↔staff hiện TRƯỚC (Gate-1): chọn role=technician → mở ô "Liên
// kết kỹ thuật viên" (bắt buộc); role khác → ẩn ô đó. Server vẫn validate lại.

import { useEffect, useState } from 'react'
import Button from '../../../components/Button'
import Field from '../../../components/Field'
import Notice from '../../../components/Notice'
import { ApiError, createUser, listStaff, listUsers, patchUser, type AdminUser, type StaffLite } from './api'
import type { Role } from '../../../lib/authClient'
import '../setup/setup.css'

const ROLE_LABEL: Record<Role, string> = {
  owner: 'Chủ spa',
  receptionist: 'Lễ tân',
  technician: 'Kỹ thuật viên',
}

export default function UsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [staff, setStaff] = useState<StaffLite[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Form tạo user mới.
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('receptionist')
  const [staffId, setStaffId] = useState<number | ''>('')
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [formOk, setFormOk] = useState<string | null>(null)

  async function reload() {
    setLoading(true)
    setError(null)
    try {
      const [u, s] = await Promise.all([listUsers(), listStaff()])
      setUsers(u)
      setStaff(s)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Không tải được danh sách người dùng.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    reload()
  }, [])

  async function onCreate(e: React.FormEvent) {
    e.preventDefault()
    if (creating) return
    setFormError(null)
    setFormOk(null)
    if (username.trim() === '' || password.length < 6) {
      setFormError('Nhập tên đăng nhập và mật khẩu tối thiểu 6 ký tự.')
      return
    }
    if (role === 'technician' && staffId === '') {
      setFormError('Kỹ thuật viên phải được liên kết với một nhân viên.')
      return
    }
    setCreating(true)
    try {
      await createUser({
        username: username.trim(),
        password,
        role,
        staff_id: role === 'technician' ? Number(staffId) : null,
      })
      setFormOk(`Đã tạo tài khoản "${username.trim()}".`)
      setUsername('')
      setPassword('')
      setRole('receptionist')
      setStaffId('')
      await reload()
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : 'Không tạo được tài khoản.')
    } finally {
      setCreating(false)
    }
  }

  async function toggleActive(u: AdminUser) {
    try {
      await patchUser(u.id, { active: u.active !== 1 })
      await reload()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Không đổi được trạng thái tài khoản.')
    }
  }

  async function changeRole(u: AdminUser, next: Role) {
    if (next === u.role) return
    // technician cần staff_id — nếu chưa có, hỏi ngay (server cũng chặn).
    let sid: number | null = u.staff_id
    if (next === 'technician' && sid === null) {
      const chosen = window.prompt(
        `Nhập ID nhân viên để liên kết cho kỹ thuật viên "${u.username}":\n` +
          staff.map((s) => `${s.id} = ${s.name}`).join('\n'),
      )
      if (chosen === null) return
      const n = Number(chosen)
      if (!Number.isInteger(n) || n <= 0) {
        setError('ID nhân viên không hợp lệ.')
        return
      }
      sid = n
    }
    try {
      await patchUser(u.id, { role: next, staff_id: next === 'technician' ? sid : null })
      await reload()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Không đổi được vai trò.')
    }
  }

  async function resetPassword(u: AdminUser) {
    const pw = window.prompt(`Mật khẩu mới cho "${u.username}" (tối thiểu 6 ký tự):`)
    if (pw === null) return
    if (pw.length < 6) {
      setError('Mật khẩu phải có ít nhất 6 ký tự.')
      return
    }
    try {
      await patchUser(u.id, { password: pw })
      setError(null)
      setFormOk(`Đã đặt lại mật khẩu cho "${u.username}".`)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Không đặt lại được mật khẩu.')
    }
  }

  return (
    <div className="ccf-su-page">
      <header className="ccf-su-head">
        <h1>Người dùng</h1>
        <p>Thêm/sửa/vô hiệu tài khoản, gán vai trò và liên kết kỹ thuật viên.</p>
      </header>

      {error && (
        <Notice tone="warn" data-testid="users-error">
          {error}
        </Notice>
      )}

      <form className="ccf-su-body" onSubmit={onCreate} data-testid="user-create-form">
        <h2>Tạo tài khoản mới</h2>
        <div className="ccf-su-form-col">
          <Field
            label="Tên đăng nhập"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            data-testid="user-username"
          />
          <Field
            label="Mật khẩu (≥ 6 ký tự)"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="user-password"
          />
          <Field
            as="select"
            label="Vai trò"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            data-testid="user-role"
          >
            <option value="owner">Chủ spa</option>
            <option value="receptionist">Lễ tân</option>
            <option value="technician">Kỹ thuật viên</option>
          </Field>
          {role === 'technician' && (
            <Field
              as="select"
              label="Liên kết kỹ thuật viên (nhân viên)"
              value={staffId}
              onChange={(e) => setStaffId(e.target.value === '' ? '' : Number(e.target.value))}
              data-testid="user-staff"
            >
              <option value="">— Chọn nhân viên —</option>
              {staff
                .filter((s) => s.active === 1)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} (#{s.id})
                  </option>
                ))}
            </Field>
          )}
          {formError && (
            <Notice tone="warn" data-testid="user-form-error">
              {formError}
            </Notice>
          )}
          {formOk && (
            <Notice tone="info" data-testid="user-form-ok">
              {formOk}
            </Notice>
          )}
          <Button type="submit" variant="primary" disabled={creating} data-testid="user-create-submit">
            {creating ? 'Đang tạo…' : 'Tạo tài khoản'}
          </Button>
        </div>
      </form>

      <div className="ccf-su-body">
        <h2>Danh sách tài khoản</h2>
        {loading ? (
          <p>Đang tải…</p>
        ) : (
          <div className="ccf-su-table-wrap">
            <table className="ccf-su-table" data-testid="users-table">
              <thead>
                <tr>
                  <th>Tên đăng nhập</th>
                  <th>Vai trò</th>
                  <th>Kỹ thuật viên</th>
                  <th>Trạng thái</th>
                  <th>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} data-testid={`user-row-${u.id}`}>
                    <td>{u.username}</td>
                    <td>
                      <select
                        value={u.role}
                        onChange={(e) => changeRole(u, e.target.value as Role)}
                        data-testid={`user-role-${u.id}`}
                        aria-label={`Vai trò của ${u.username}`}
                      >
                        <option value="owner">{ROLE_LABEL.owner}</option>
                        <option value="receptionist">{ROLE_LABEL.receptionist}</option>
                        <option value="technician">{ROLE_LABEL.technician}</option>
                      </select>
                    </td>
                    <td>{u.staff_name ?? '—'}</td>
                    <td data-testid={`user-active-${u.id}`}>
                      <span className={`ccf-su-badge ccf-su-badge--${u.active === 1 ? 'on' : 'off'}`}>
                        {u.active === 1 ? 'Hoạt động' : 'Đã vô hiệu'}
                      </span>
                    </td>
                    <td className="ccf-su-cell-actions">
                      <Button variant="ghost" size="sm" onClick={() => toggleActive(u)} data-testid={`user-toggle-${u.id}`}>
                        {u.active === 1 ? 'Vô hiệu' : 'Kích hoạt'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => resetPassword(u)} data-testid={`user-reset-${u.id}`}>
                        Đặt lại mật khẩu
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
