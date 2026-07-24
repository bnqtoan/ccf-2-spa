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
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/admin/timeline" element={<TimelinePage />} />
        <Route path="/admin/reassign" element={<ReassignQueuePage />} />
        <Route path="/admin/setup" element={<SetupPage />} />
        <Route path="/lookup" element={<LookupPage />} />
        <Route path="/dev/components" element={<ComponentsDemo />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
