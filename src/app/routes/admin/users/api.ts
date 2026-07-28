// T-22 — fetch helpers cho màn quản lý user (owner-only). Endpoint thật:
// GET/POST/PATCH /api/admin/users + GET /api/admin/staff (để link technician).
// Lỗi server hình dạng { error: { code, message } } → ném ApiError giữ code.

import type { Role } from '../../../lib/authClient'

export interface AdminUser {
  id: number
  username: string
  role: Role
  staff_id: number | null
  active: number
  staff_name: string | null
}

export interface StaffLite {
  id: number
  name: string
  active: number
}

export class ApiError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

async function parseErrorAndThrow(res: Response): Promise<never> {
  let body: { error?: { code?: string; message?: string } } = {}
  try {
    body = (await res.json()) as typeof body
  } catch {
    /* body không JSON — vẫn ném lỗi chung */
  }
  throw new ApiError(body.error?.code ?? 'UNKNOWN', body.error?.message ?? 'Có lỗi xảy ra')
}

export async function listUsers(): Promise<AdminUser[]> {
  const res = await fetch('/api/admin/users', { credentials: 'same-origin' })
  if (!res.ok) return parseErrorAndThrow(res)
  return ((await res.json()) as { users: AdminUser[] }).users
}

export async function listStaff(): Promise<StaffLite[]> {
  const res = await fetch('/api/admin/staff', { credentials: 'same-origin' })
  if (!res.ok) return parseErrorAndThrow(res)
  return (await res.json()) as StaffLite[]
}

export async function createUser(input: {
  username: string
  password: string
  role: Role
  staff_id?: number | null
}): Promise<void> {
  const res = await fetch('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(input),
  })
  if (!res.ok) return parseErrorAndThrow(res)
}

export async function patchUser(
  id: number,
  patch: { role?: Role; staff_id?: number | null; active?: boolean; password?: string },
): Promise<void> {
  const res = await fetch(`/api/admin/users/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(patch),
  })
  if (!res.ok) return parseErrorAndThrow(res)
}
