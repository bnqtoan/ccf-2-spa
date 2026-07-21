import BookingPage from '../routes/booking/BookingPage'

// T-10: trang khách hàng giờ là luồng đặt lịch thật (dịch vụ → gói → giờ →
// xác nhận). GuestPage.tsx không nằm trong `touches` của T-10, nhưng đây là
// dây nối một dòng bắt buộc để luồng đặt lịch có thể mở được ở "/" — không
// card nào khác claim file này (xem docs/tasks/T-11, T-12 touches), và T-11
// đã có tiền lệ tương tự khi nối LookupPage vào main.tsx.
export default function GuestPage() {
  return <BookingPage />
}
