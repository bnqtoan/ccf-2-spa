// Map `body_zone` (đã có sẵn trong GET /api/services, xem
// src/worker/routes/services.ts) sang ảnh dịch vụ thật.
//
// Lựa chọn (b) trong 2 phương án gắn ảnh: map cứng theo body_zone ở tầng UI,
// KHÔNG thêm cột image_url ở DB/backend. Lý do:
//   - Phạm vi cho phép của card revamp này ưu tiên (b) cho gọn ("v1 tôi
//     nghiêng về (b)").
//   - body_zone đã là enum cố định 4 giá trị (body/hair/hands/face) dùng
//     xuyên suốt seed + availability, không phải free-text — map tĩnh an
//     toàn, không có input lạ nào lọt qua được.
//   - Đánh đổi đã biết: dịch vụ mới do admin tạo qua CRUD với body_zone nằm
//     ngoài 4 giá trị này (hoặc value lạ) sẽ rơi vào FALLBACK, không vỡ giao
//     diện — chỉ mất ảnh minh hoạ, không mất chức năng.
//
// Ảnh tải về từ Unsplash (giấy phép thương mại, không bắt buộc ghi công),
// lưu tại public/images/services/ — xem public/images/CREDITS.md.
const SERVICE_IMAGE_BY_ZONE: Record<string, string> = {
  body: '/images/services/massage.jpg',
  hair: '/images/services/hair.jpg',
  hands: '/images/services/nails.jpg',
  face: '/images/services/face.jpg',
}

const FALLBACK_IMAGE = '/images/services/massage.jpg'

export function serviceImageUrl(bodyZone: string): string {
  return SERVICE_IMAGE_BY_ZONE[bodyZone] ?? FALLBACK_IMAGE
}
