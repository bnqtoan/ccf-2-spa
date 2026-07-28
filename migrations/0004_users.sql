-- 0004_users.sql — RBAC 3 vai trò (T-22).
--
-- ADDITIVE ONLY trên 0003: một bảng MỚI `users`. KHÔNG sửa/thêm cột bảng nào
-- đang có (staff giữ nguyên bản chất "người cung cấp dịch vụ" — technician-user
-- link qua users.staff_id, KHÔNG nhét password vào staff). Áp sạch trên 0003.
--
-- MỘT hệ auth, MỘT bảng users. role quyết định thấy/làm được gì:
--   owner        — toàn quyền (tiền/lương/giá + quản lý user).
--   receptionist — mọi vận hành, KHÔNG tiền/lương, KHÔNG sửa giá.
--   technician   — CHỈ dữ liệu của chính mình (row-filter + ownership-check).
--
-- staff_id: nullable FK tới staff(id). Set CHỈ cho technician (trỏ tới dòng
-- staff của họ) — owner/receptionist không phải KTV nên NULL. ON DELETE RESTRICT
-- theo quy ước 0001 (không orphan lịch sử; staff không bị xoá cứng).
--
-- password_hash: PBKDF2/SHA-256 qua crypto.subtle (Workers có sẵn) — KHÔNG
-- bcrypt (không có trong Workers runtime). Định dạng chuỗi tự mô tả:
-- "pbkdf2$<iterations>$<saltB64url>$<hashB64url>" (xem src/worker/lib/auth.ts).
--
-- active: DEFAULT 1. Vô hiệu user = active=0 (KHÔNG xoá dòng), giữ nhất quán với
-- quy ước "không xoá dòng" của app. User inactive không đăng nhập được.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','receptionist','technician')),
  staff_id      INTEGER REFERENCES staff(id) ON DELETE RESTRICT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_users_staff_id ON users(staff_id);
