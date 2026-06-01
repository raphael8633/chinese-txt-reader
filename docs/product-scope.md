# Product Scope — raph-reader

## 產品目標

打造可在電腦與手機閱讀長篇中文 TXT 小說的 Web/PWA。核心是可靠處理中文 encoding、管理個人書庫、支援離線閱讀、保存閱讀設定與進度。

## MVP 範圍

- Web/PWA 客戶端。
- 使用外部 auth gateway，不自建帳號系統。
- 使用者雲端書庫：上傳、列表、重新命名、刪除。
- `.txt` 上傳，單檔上限 20MB。
- UTF-8 BOM / UTF-8 / Big5 / GB18030 detection，server 保存 normalized UTF-8 text。
- 離線下載：Service Worker cache app shell，IndexedDB 保存書籍 chunks。
- 閱讀器：virtualized rendering、閱讀設定、進度保存。
- 閱讀設定：text/background color、font size、line height、letter spacing、hard-wrap、toolbar side、tap scroll、繁簡轉換等。
- 手機閱讀：點擊區域快捷捲動、可收合工具列、PWA 離線閱讀。

## 非 MVP

- EPUB/PDF。
- AI 摘要、翻譯、朗讀。
- 社群分享。
- DRM 或版權管理。
- 直書、注音、圖片章節等複雜排版。

## 架構

- Frontend：React + Vite + Tailwind + Dexie + Workbox。
- Backend：Node.js + Fastify + SQLite。
- Auth：由 trusted reverse proxy / auth gateway 注入 user id header，backend 以 user id 隔離資料。
- Server storage：SQLite metadata + local disk original/normalized text。
- Client storage：IndexedDB books/progress/settings/content chunks。

## 進度與衝突規則

- 目前用 `chapter_index` 保存進度，避免 hard-wrap / 段落切分策略改變時漂移；舊 `paragraph_index` 仍可 fallback 載入。
- 後續精準分頁方向：保存 `char_offset` / chunk offset，設定變更後重新 pagination 並回到附近位置。
- 衝突差距 < 10%：自動採用較後章節並補寫兩端。
- 衝突差距 >= 10%：詢問使用者採用此裝置或雲端進度。

## 後續方向

- Hidden DOM measurement pagination。
- Manual encoding override UI。
- Backend content chunk API / server-side chunk storage。
- Per-book settings override UI。
- Progress conflict resolution UI。

## 歷史設計

早期設計入口保留於 [plans/2026-05-12-chinese-txt-reader-design.md](plans/2026-05-12-chinese-txt-reader-design.md)。它現在只保留仍有效的核心決策與拆分文件導覽；只有追溯背景時再讀。
