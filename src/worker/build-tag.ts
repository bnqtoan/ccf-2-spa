// Mốc build. GIÁ TRỊ MẶC ĐỊNH = 'dev' (dùng cho dev/vitest và khi generator
// chưa chạy). Lúc build production, scripts/gen-build-tag.mjs GHI ĐÈ file này
// bằng `YYYY-MM-DD-<sha7>` thật (xem wrangler.jsonc build.command). File được
// commit để import luôn resolve; generator chỉ đổi nội dung lúc build, không
// cần commit lại giá trị sinh ra.
export const BUILD_TAG = 'dev'
