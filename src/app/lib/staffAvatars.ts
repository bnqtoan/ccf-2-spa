// Map tên KTV (seed) sang ảnh chân dung thật, cùng tinh thần với
// serviceImages.ts: map tĩnh ở tầng UI, không đụng backend/DB.
//
// Khác với dịch vụ (map theo body_zone — enum cố định), tên KTV là free-text
// nên map này CHỈ khớp đúng 5 cái tên seed (Lan, Huong, Mai, Trang, Yen).
// KTV mới do admin thêm sau (tên khác, hoặc trùng tên nhưng không phải seed)
// sẽ không có ảnh — Avatar component tự rơi về chữ cái đầu (hành vi gốc,
// không đổi), không vỡ giao diện. Đây là đánh đổi đã biết của lựa chọn (b).
//
// Ảnh tải từ Unsplash — xem public/images/CREDITS.md.
const STAFF_AVATAR_BY_NAME: Record<string, string> = {
  Lan: '/images/staff/lan.jpg',
  Huong: '/images/staff/huong.jpg',
  Mai: '/images/staff/mai.jpg',
  Trang: '/images/staff/trang.jpg',
  Yen: '/images/staff/yen.jpg',
}

/** Trả về URL ảnh nếu tên khớp seed, ngược lại `undefined` (Avatar tự fallback chữ cái đầu). */
export function staffAvatarUrl(name: string): string | undefined {
  return STAFF_AVATAR_BY_NAME[name.trim()]
}
