# 長篇中文 TXT 閱讀器設計草案（已歸檔）

> 這是 2026-05-12 的早期設計入口，已不再作為每個 session 的必讀文件。
> Current source and product docs are authoritative; this file is retained only as design background.

## 拆分後文件

- [`../product-scope.md`](../product-scope.md)：產品目標、MVP / non-MVP、架構、後續方向。
- [`../current-state.md`](../current-state.md)：已完成功能、重要實作決策、已知 tradeoff。

## 仍有效的核心決策

- 客戶端形態：Web/PWA 優先，後續視需求再包 native。
- Auth：使用外部 auth gateway，不自建帳號；API 以 user id 隔離資料。
- MVP 格式：只支援 `.txt`，單檔上限 20MB。
- Encoding：上傳時保存原始檔並產生 UTF-8 normalized text；需支援 UTF-8 BOM / UTF-8 / Big5 / GB18030。
- 離線：Service Worker cache app shell，IndexedDB/Dexie 保存書籍 content chunks、metadata、進度與設定。
- 大檔案：不得一次 render 全文到 DOM；閱讀頁使用 chunk/window 或 virtualized rendering。
- 進度衝突：差距 <= 10% 全書自動合併；差距 > 10% 詢問使用者採用哪端。
- 閱讀設定：支援全域預設 + 每本書覆寫，`book_id = null` 表示全域。

## 歷史實作計畫

ReaderPage 的 TDD 分工計畫已完成，僅追溯時需要讀：

- [`2026-05-12-reader-page.md`](2026-05-12-reader-page.md)
- [`2026-05-12-reader-page-p1.md`](2026-05-12-reader-page-p1.md)
- [`2026-05-12-reader-page-p2.md`](2026-05-12-reader-page-p2.md)
