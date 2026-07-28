// Quản lý user — OWNER ONLY (T-22). owner thêm/sửa/vô hiệu user + gán role +
// (với technician) link staff_id.
//
//   GET   /api/admin/users              — liệt kê user (KHÔNG trả password_hash).
//   POST  /api/admin/users              — tạo user mới {username, password, role, staff_id?}.
//   PATCH /api/admin/users/:id          — sửa role/active/password/staff_id.
//
// Cụm này mount SAU requireRoleMw('owner') trong registerRoutes → lễ tân/KTV
// chạm vào đây nhận 403 (đã qua adminAuthGuard 401-gate). File này KHÔNG tự
// kiểm role — role-gate là middleware mount ở registerRoutes (một chỗ).
//
// RÀNG BUỘC role↔staff_id (bất biến nghiệp vụ): CHỈ technician có staff_id (trỏ
// tới dòng staff của họ). owner/receptionist KHÔNG phải KTV → staff_id phải NULL.
// technician BẮT BUỘC có staff_id hợp lệ (else không lọc được "của mình").

import { Hono } from 'hono'
import { hashPassword, isRole, type AuthUser, type Role } from '../lib/auth.ts'

type Bindings = { DB: D1Database }
type Variables = { user: AuthUser }

const routes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

interface UserPublicRow {
  id: number
  username: string
  role: Role
  staff_id: number | null
  active: number
  staff_name: string | null
}

/** Validate cặp (role, staff_id). Trả message lỗi hoặc null nếu hợp lệ. */
async function validateRoleStaff(
  db: D1Database,
  role: Role,
  staffId: number | null,
): Promise<string | null> {
  if (role === 'technician') {
    if (staffId === null) return 'Kỹ thuật viên phải được liên kết với một nhân viên (staff_id).'
    const staff = await db.prepare('SELECT id FROM staff WHERE id = ?').bind(staffId).first<{ id: number }>()
    if (staff === null) return `Không tìm thấy nhân viên ${staffId}.`
    return null
  }
  // owner / receptionist: KHÔNG được gán staff_id.
  if (staffId !== null) return 'Chỉ kỹ thuật viên mới được liên kết nhân viên.'
  return null
}

routes.get('/api/admin/users', async (c) => {
  const res = await c.env.DB.prepare(
    `SELECT u.id AS id, u.username AS username, u.role AS role, u.staff_id AS staff_id,
            u.active AS active, s.name AS staff_name
     FROM users u
     LEFT JOIN staff s ON s.id = u.staff_id
     ORDER BY u.id`,
  ).all<UserPublicRow>()
  // KHÔNG trả password_hash ra ngoài.
  return c.json({ users: res.results })
})

interface CreateBody {
  username?: unknown
  password?: unknown
  role?: unknown
  staff_id?: unknown
}

routes.post('/api/admin/users', async (c) => {
  const db = c.env.DB

  let body: CreateBody
  try {
    body = (await c.req.json()) as CreateBody
  } catch {
    return c.json(errorBody('VALIDATION', 'Body phải là JSON hợp lệ'), 422)
  }

  const username = typeof body.username === 'string' ? body.username.trim() : ''
  if (username === '') {
    return c.json(errorBody('VALIDATION', 'username là bắt buộc'), 422)
  }
  const password = typeof body.password === 'string' ? body.password : ''
  if (password.length < 6) {
    return c.json(errorBody('VALIDATION', 'password phải có ít nhất 6 ký tự'), 422)
  }
  if (!isRole(body.role)) {
    return c.json(errorBody('VALIDATION', 'role phải là owner, receptionist hoặc technician'), 422)
  }
  const role = body.role
  const staffId =
    body.staff_id === undefined || body.staff_id === null ? null : Number(body.staff_id)
  if (staffId !== null && (!Number.isInteger(staffId) || staffId <= 0)) {
    return c.json(errorBody('VALIDATION', 'staff_id phải là số nguyên dương'), 422)
  }

  const roleErr = await validateRoleStaff(db, role, staffId)
  if (roleErr !== null) {
    return c.json(errorBody('VALIDATION', roleErr), 422)
  }

  const existing = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first()
  if (existing !== null) {
    return c.json(errorBody('VALIDATION', 'Tên đăng nhập đã tồn tại'), 409)
  }

  const hash = await hashPassword(password)
  const now = Math.floor(Date.now() / 1000)
  const res = await db
    .prepare(
      'INSERT INTO users (username, password_hash, role, staff_id, active, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    )
    .bind(username, hash, role, staffId, now)
    .run()

  const id = res.meta.last_row_id
  return c.json({ id, username, role, staff_id: staffId, active: 1 }, 201)
})

interface PatchBody {
  role?: unknown
  staff_id?: unknown
  active?: unknown
  password?: unknown
}

routes.patch('/api/admin/users/:id', async (c) => {
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    return c.json(errorBody('NOT_FOUND', 'Không tìm thấy user'), 404)
  }

  let body: PatchBody
  try {
    body = (await c.req.json()) as PatchBody
  } catch {
    return c.json(errorBody('VALIDATION', 'Body phải là JSON hợp lệ'), 422)
  }

  const current = await db
    .prepare('SELECT id, role, staff_id, active FROM users WHERE id = ?')
    .bind(id)
    .first<{ id: number; role: Role; staff_id: number | null; active: number }>()
  if (current === null) {
    return c.json(errorBody('NOT_FOUND', `Không tìm thấy user ${id}`), 404)
  }

  // Giá trị đích: giữ nguyên nếu field không có trong patch.
  const nextRole: Role = body.role !== undefined ? (isRole(body.role) ? body.role : current.role) : current.role
  if (body.role !== undefined && !isRole(body.role)) {
    return c.json(errorBody('VALIDATION', 'role phải là owner, receptionist hoặc technician'), 422)
  }

  let nextStaffId: number | null = current.staff_id
  if (body.staff_id !== undefined) {
    if (body.staff_id === null) nextStaffId = null
    else {
      const sid = Number(body.staff_id)
      if (!Number.isInteger(sid) || sid <= 0) {
        return c.json(errorBody('VALIDATION', 'staff_id phải là số nguyên dương'), 422)
      }
      nextStaffId = sid
    }
  }
  // Nếu đổi sang non-technician mà không nói gì về staff_id → tự gỡ liên kết.
  if (nextRole !== 'technician' && body.staff_id === undefined) nextStaffId = null

  const roleErr = await validateRoleStaff(db, nextRole, nextStaffId)
  if (roleErr !== null) {
    return c.json(errorBody('VALIDATION', roleErr), 422)
  }

  let nextActive = current.active
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') {
      return c.json(errorBody('VALIDATION', 'active phải là boolean'), 422)
    }
    nextActive = body.active ? 1 : 0
  }

  // password (tuỳ chọn): owner đặt lại tay.
  let newHashClause = ''
  const binds: (string | number | null)[] = [nextRole, nextStaffId, nextActive]
  if (body.password !== undefined) {
    if (typeof body.password !== 'string' || body.password.length < 6) {
      return c.json(errorBody('VALIDATION', 'password phải có ít nhất 6 ký tự'), 422)
    }
    newHashClause = ', password_hash = ?'
    binds.push(await hashPassword(body.password))
  }
  binds.push(id)

  await db
    .prepare(`UPDATE users SET role = ?, staff_id = ?, active = ?${newHashClause} WHERE id = ?`)
    .bind(...binds)
    .run()

  return c.json({ id, role: nextRole, staff_id: nextStaffId, active: nextActive })
})

export default routes
