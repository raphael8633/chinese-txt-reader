# Current State — raph-reader

## 已完成功能

- Root npm workspaces：backend + frontend，root scripts 管理 build/lint/test/dev。
- Backend：Fastify v5 + TypeScript + SQLite (`better-sqlite3`)。
- Auth：development 使用 `dev-user`；production 預期由 trusted reverse proxy / auth gateway 傳入使用者 header，backend 以該 user id 隔離書庫。
- Auth redirect：`api.ts` 的 `checkAuthRedirect()` helper 偵測 `res.redirected`（auth gateway 對過期 session 返回 redirect 被 fetch 自動 follow），丟出 `AuthExpiredError`；書庫頁切換離線模式並提供手動「重新登入」按鈕。按鈕直接導 `/auth/?rd=<origin>/reader/&rm=GET`，避免 app shell/service worker 把 `/reader/` reload 接回原地，也避免登入後落到 API endpoint。
- Books API：list/upload/content/rename/delete；`.txt` 上限 20MB；保存 original 與 normalized UTF-8 text；list 以 `updated_at DESC, created_at DESC` 排序（最近閱讀排最前）。
- Encoding：UTF-8 BOM、UTF-8、Big5/CP950、GB18030/GBK detection + normalize。
- Sync API：`GET/POST /api/books/:id/progress`、`GET/POST /api/settings`。
- Frontend：React + Vite + Tailwind + Dexie + Workbox PWA，basename/base `/reader/`。
- LibraryPage：上傳、列表（顯示「上次閱讀」或「上傳」日期）、重新命名、刪除、離線下載/移除、離線 fallback。
- ReaderPage：virtual scroll、streaming content load、頂部顯示書名 + 目前章節、右/左側工具列、手機章節狀態列、settings panel（PanelOverlay modal + SectionHeader 分段 + 頂部字型即時預覽 + StepperRow 步進列）、章節選擇（ChapterPanel 列表取代 select 下拉）、progress debounce sync、章節跳轉、點擊捲動模式、顯示層繁簡轉換。
- 閱讀設定（全裝置全域）：fontSize、lineHeight、letterSpacing、text/background color、readingMode、tapScroll、toolbarSide、hardWrapMode、chineseConversion、padding/margin、paragraphSpacing/Indent、fontWeight、justifyText；後端 `book_id IS NULL` 存全域。
- Offline：Dexie `contentChunks` chunk storage；下載完整成功後才標記 `isAvailableOffline=true`。
- App update：書庫 header「檢查更新」，閱讀頁併入側邊工具列；偵測到新 Service Worker 時顯示「更新」並 reload。Safari DOMException（pattern error）降級為 warning，不進 error UI；只更新 active registration 而非 `getRegistrations()` 全部更新。

## 重要實作決策

- MVP 閱讀模式目前是 scroll + virtualized paragraph rendering；設計中的 hidden DOM pagination / char offset 是後續方向。
- 進度以 `chapter_index` 儲存（非 char/paragraph offset），避免段落切分策略改變時漂移；舊 `paragraph_index` 仍可 fallback 載入。
- 跨裝置進度合併：差距 < 10% → 自動採用較後章節並補寫兩端；差距 ≥ 10% → 顯示「此裝置 / 雲端」選擇 UI。
- LibraryPage 不下載全文估算進度；使用 backend metadata (`paragraph_count` / `chapters_json`) 顯示章節或段落位置。
- Session 過期不是自動 reload：API fetch 追到 auth gateway 時只丟 `AuthExpiredError`；LibraryPage 以 IndexedDB 顯示已下載書籍，使用者按「重新登入」才進 `/auth/?rd=<origin>/reader/&rm=GET` 回線上模式。
- 離線副本必須由使用者顯式下載；ReaderPage 不再隱式把整本書標成可離線。
- ReaderPage 設定本機優先，server/global 設定只在本機沒有值時補上。
- ReaderPage 工具列桌面預設右側，可在設定中切到左側；手機預設收起，從右側左滑展開，展開時鎖住內文捲動並可點內文收起。
- `GET /api/books/:id/content` 以 stream 傳回 UTF-8 text；前端第一個 chunk 到達即結束 loading，離線下載時前端再切 128KiB chunks 存 IndexedDB。
- `chineseConversion` 只作用在前端 display pipeline，不改 server normalized text / IndexedDB raw chunks；目前不轉換章節 metadata 或搜尋索引。
- IndexedDB migration 不改舊 `content` table primary key；新增 `contentChunks` table，避免 Dexie v2 -> v3 `UpgradeError`。
- Production data should live outside the repository checkout so cleanup or build output does not affect user data.
- The frontend build can be served by any static server or reverse-proxy setup that preserves the `/reader/` base path.

## 測試現況

最近完整驗證：

```bash
npm run lint
npm test
npm run build
```

最近測試數：backend 51、frontend 94。

## 已知後續

- Manual encoding override UI 尚未完整接上。
- 目前設定 UI 為純全域；backend 已支援 per-book override（`book_id NOT NULL`），UI 切換尚未做。
- 大檔案首載已 streaming，但主 chunk 仍包含 OpenCC 字典而觸發 Vite >500k warning；若首包大小變成問題，可做 dynamic import / manualChunks。
- Settings panel accessibility（keyboard navigation、aria 屬性）尚未處理。
- 離線下載仍由前端切 chunks；大書可考慮 server-side chunking。
