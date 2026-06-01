# ReaderPage — Phase 2: Frontend（已完成）

> Historical execution summary. New sessions normally do not need this file.

## 目標

實作 ReaderPage frontend：content cache、virtual scroll、settings panel、offline-first progress tracking。

## 完成內容

- Extended `frontend/src/db.ts` Dexie schema for content/progress/settings cache。
- Extended `frontend/src/api.ts` with content/progress/settings API helpers。
- Implemented `frontend/src/pages/ReaderPage.tsx`。
- Added `frontend/src/tests/ReaderPage.test.tsx`。

## ReaderPage 能力

- 讀取 content cache，miss 時 fetch backend。
- 以 `@tanstack/react-virtual` virtualize paragraphs。
- 設定 panel 即時套用 font size / line height / letter spacing / text/background color。
- Scroll progress debounce save 到 Dexie，並 best-effort sync backend。
- Progress restore 等 virtualizer 有 paragraphs 後再 `scrollToIndex()`。
- 支援章節跳轉、點擊捲動模式、本機設定優先與離線 fallback。

## 後續注意

- Current implementation has moved beyond this original phase plan; source/tests are authoritative。
- 若要做精準分頁，請從 [../product-scope.md](../product-scope.md) 的後續方向開始，而不是沿用本歷史 plan。

## 狀態

Completed and merged.
