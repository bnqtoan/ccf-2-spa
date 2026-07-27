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
import LoginPage from './routes/admin/auth/LoginPage'
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
        {/* T-19 — mọi route /admin/* qua guard: chưa đăng nhập → /login */}
        <Route path="/admin" element={<RequireAuth><AdminPage /></RequireAuth>} />
        <Route path="/admin/overview" element={<RequireAuth><OverviewPage /></RequireAuth>} />
        <Route path="/admin/timeline" element={<RequireAuth><TimelinePage /></RequireAuth>} />
        <Route path="/admin/reassign" element={<RequireAuth><ReassignQueuePage /></RequireAuth>} />
        <Route path="/admin/setup" element={<RequireAuth><SetupPage /></RequireAuth>} />
        <Route path="/lookup" element={<LookupPage />} />
        <Route path="/dev/components" element={<ComponentsDemo />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
