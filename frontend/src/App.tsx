import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom'
import { LibraryPage } from './pages/LibraryPage.js'
import { ReaderPage } from './pages/ReaderPage.js'

export function App() {
  return (
    <BrowserRouter basename="/reader">
      <Routes>
        <Route path="/" element={<LibraryPage />} />
        <Route path="/read/:bookId" element={<ReaderPage />} />
        {/* Old /admin/* bookmarks and any unknown path land on the library. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
