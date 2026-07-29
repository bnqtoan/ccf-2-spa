import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import GuestPage from './pages/GuestPage'
import AdminPage from './pages/AdminPage'
import ComponentsDemo from './components/ComponentsDemo'
import LookupPage from './routes/lookup/LookupPage'
import TimelinePage from './routes/admin/timeline/TimelinePage'
import ReassignQueuePage from './routes/admin/reassign/ReassignQueuePage'
import SetupPage from './routes/admin/setup/SetupPage'
import OverviewPage from './routes/admin/overview/OverviewPage'
import UsersPage from './routes/admin/users/UsersPage'
import LoginPage from './routes/admin/auth/LoginPage'
import ChangePasswordPage from './routes/admin/auth/ChangePasswordPage'
import RequireAuth from './routes/admin/auth/RequireAuth'
import './styles/tokens.css'

const root = document.getElementById('root')
if (!root) {
  throw new Error('Root element #root not found')
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<GuestPage />} />
        <Route path="/login" element={<LoginPage />} />
        {/* T-19 — guard đăng nhập; T-22 — guard THEO ROLE (allow=…). Server vẫn
            là gate thật; đây là defense-in-depth để role sai không xem nhầm. */}
        {/* T-23 — bất kỳ role đã đăng nhập (kể cả mustChangePassword=true, RequireAuth
            có ngoại lệ cho đúng path này để không tạo vòng lặp redirect). */}
        <Route path="/admin/change-password" element={<RequireAuth><ChangePasswordPage /></RequireAuth>} />
        <Route path="/admin" element={<RequireAuth allow={['owner', 'receptionist']}><AdminPage /></RequireAuth>} />
        <Route path="/admin/overview" element={<RequireAuth allow={['owner']}><OverviewPage /></RequireAuth>} />
        <Route path="/admin/timeline" element={<RequireAuth allow={['owner', 'receptionist', 'technician']}><TimelinePage /></RequireAuth>} />
        <Route path="/admin/reassign" element={<RequireAuth allow={['owner', 'receptionist']}><ReassignQueuePage /></RequireAuth>} />
        <Route path="/admin/setup" element={<RequireAuth allow={['owner', 'receptionist']}><SetupPage /></RequireAuth>} />
        <Route path="/admin/users" element={<RequireAuth allow={['owner']}><UsersPage /></RequireAuth>} />
        <Route path="/lookup" element={<LookupPage />} />
        <Route path="/dev/components" element={<ComponentsDemo />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
