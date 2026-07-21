import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import GuestPage from './pages/GuestPage'
import AdminPage from './pages/AdminPage'

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
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
