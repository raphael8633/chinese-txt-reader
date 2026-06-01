import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { LibraryPage } from './pages/LibraryPage.js'
import { ReaderPage } from './pages/ReaderPage.js'

export function App() {
  return (
    <BrowserRouter basename="/reader">
      <Routes>
        <Route path="/" element={<LibraryPage />} />
        <Route path="/read/:bookId" element={<ReaderPage />} />
      </Routes>
    </BrowserRouter>
  )
}
