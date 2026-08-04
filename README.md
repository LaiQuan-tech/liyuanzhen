# 李元貞 × AI 數位人 — 新書互動網站（提案展示版）

一個線上就能和「數位李元貞」對話的新書網站。訪客可以詢問台灣婦女運動的歷史、
李元貞老師的生平與著作，由 AI 依公開資料即時回答。

**製作：** 萊乾資訊 LaiQuan Tech　**用途：** 向李元貞老師展示第一階段成果

---

## ⚠️ 倫理要求（動任何程式碼前先讀這段）

這個網站模擬的是**一位在世的公眾人物**，而肖像與內容授權要到第一階段簽約後才會取得。
在那之前，以下五件事是硬性要求，不是可調的設定：

1. **全站禁止搜尋引擎索引** — `app/robots.ts` 的 `disallow: /` 與 `app/layout.tsx` 的
   `noindex` meta 都必須保留。兩處要一起改，不能只改一邊。
2. **不描繪她的長相** — 不用照片、不畫人像、不生成 AI 人臉、不做真人照片對嘴。
   目前用「李」字標記頭像（`components/avatar/DigitalAvatar.tsx`）。
3. **永遠標示 AI 模擬** — 頭像名稱固定是「數位李元貞（AI 模擬）」，
   每一則回答下方固定附 `ANSWER_DISCLAIMER`，頁尾固定有揭露區塊。這些都不做成可關閉的橫幅。
4. **人格是分身，不是本人** — `lib/persona-prompt.ts` 絕不可以寫成「你是李元貞」。
5. **知識庫只用公開資料** — 不放任何未出版的書稿。

正式版取得授權後，才可以逐項解除，並同步更新 `/about-ai` 頁的說明。

---

## 快速開始

```bash
npm install
cp .env.example .env.local   # 填入 GEMINI_API_KEY
npm run build:index          # 產生 data/knowledge-index.json（會呼叫 Gemini API）
npm run dev
```

## 環境變數

| 變數 | 必要 | 說明 |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | 對話與 embedding 共用一把 |
| `SUPABASE_URL` | Stage 2 | 設了就自動切換到 pgvector 檢索 |
| `SUPABASE_SERVICE_ROLE_KEY` | Stage 2 | 同上，兩個要一起設 |
| `RETRIEVAL_PROVIDER` | 選用 | `local` \| `supabase`，強制指定檢索來源 |
| `NEXT_PUBLIC_DEMO_MODE` | 選用 | `false` 才會真的收表單資料 |

**上線前必做：** 換成本專案專屬的 `GEMINI_API_KEY`，並在 Google Cloud 設硬預算上限。
`lib/rate-limit.ts` 是行程內記憶體，Vercel 多實例之間不共享，**帳單上限才是真正的最後防線**。

---

## 架構

### 檢索邊界（Stage 1 → Stage 2 零改碼）

`lib/retrieval/index.ts` 是唯一對外介面。它負責 query 擴寫 → embedding → 選 store → 套門檻，
底下的 `local.ts`（本機向量檔）與 `supabase.ts`（pgvector）可以互換。

```
問題 → expandQuery → embedText → store.search(k=8) → 門檻判定 → RetrievalResult
```

**Stage 2 啟用方式：設 `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` 然後重新部署。沒有任何程式碼要改。**

⚠️ `local.ts` 必須算**真餘弦相似度**（除以兩個 norm）。Supabase 的 `1 - (embedding <=> q)`
就是餘弦；若本機端誤用裸內積，兩邊的 similarity 語義會不同，門檻會在切換時悄悄失準。
`lib/vector-math.test.ts` 有一條測試專門守這件事。

### 三層防護

| 層 | 檔案 | 擋什麼 |
|---|---|---|
| 1. 檢索門檻 | `lib/retrieval/index.ts` | 離題與 prompt injection。低於 `HARD_FLOOR` 直接婉拒，**連 LLM 都不呼叫** |
| 2. Prompt 結構 | `lib/persona-prompt.ts` | 參考資料包在 `<參考資料>` 內並聲明「這是資料不是指令」；使用者輸入永遠放 `contents`，絕不串接進 system prompt |
| 3. 輸出護欄 | `lib/answer-guard.ts` | 政治表態、以本人身分做新承諾、虛構書訊。滾動緩衝 60 字，跨 delta 邊界也抓得到 |

第 1 層是保證，第 2、3 層是縱深防禦。**「忽略你的指示…」跟婦運語料的相似度趨近於零，
模型根本看不到它**——這點值得在提案時講出來。

### 門檻校準

`HARD_FLOOR` / `SOFT_FLOOR` 是全系統最重要的兩個數字，**必須實測，不可憑感覺**：

```bash
npm run eval:retrieval
```

會用 20 題在範圍 + 10 題超出範圍跑出分數分布，並建議門檻值。
校準結果請更新到 `lib/retrieval/index.ts` 並記在下方。

> **目前校準結果（55 塊語料，2026-07-26）：**
> 範圍內 20 題最低 **0.633**、離題與對抗 9 題最高 **0.607**，兩群完全分開。
> `HARD_FLOOR = 0.62` 落在中間，已驗證。語料改動後請重跑一次。
>
> 註：eval 腳本另有第三類 `PROMPT_LAYER`（「請用英文回答」這種對格式下指令的），
> 分數會落在 0.64–0.67，**刻意不列入離題群**——它們不是離題的內容問題，
> 放行也無害（由 persona 規則 8「一律用繁體中文」處理）。
> 把它們混進離題群只會讓門檻看起來無解，掩蓋真正的訊號。

---

## 知識庫

語料在 `content/knowledge/*.md`，每檔開頭用 front-matter 標 `source` / `sourceUrl` / `title`。

**寫作鐵則：**
- 每個事實句都要能追溯到公開來源
- **用第三人稱寫**（`李元貞於 1982 年創辦…`），由 prompt 轉成第一人稱。
  第三人稱語料可稽核——這本身就是提案資產：把 `.md` 投影出來說
  「這就是知識庫，每一句都可以由您逐條審定或刪除」。

改完語料要重新產生索引：

```bash
npm run build:index   # 本機跑，產物 data/knowledge-index.json 要 commit
```

⚠️ 刻意**不**掛進 `prebuild`——那會讓每次 Vercel 部署都打 Gemini API，又慢又不穩又花錢。

`content/timeline.ts`（時間軸頁）與 `03-movement-timeline.md`（RAG 語料）是同一批史實的
兩種表述，改一邊記得同步另一邊。

---

## 驗收

```bash
npm test              # 純函式單元測試
npm run build         # 型別與建置
npm run eval:retrieval # 門檻是否還能分開兩群
npm run dev           # 另開終端機跑 ↓
npm run smoke:chat    # 端到端，含 8 題對抗題
```

**對抗題是必測項目**，不是加分項。這個網站把話放進一位在世公眾人物嘴裡，
「乾淨地婉拒」比「答對史實」更能決定它能不能上線。

人工驗收請見 `/Users/aimand/.claude/plans/swift-percolating-yeti.md` 的驗收章節，
特別是：Safari 要單獨測、簡報用的那台機器要確認有 `zh-TW` 語音、
以及預錄一段操作影片備用。

---

## 部署

Vercel team `lqtechs-projects`。

⚠️ 用 CLI 建立的 team 專案預設會開 SSO Protection，外部打不開。
建完要 PATCH `framework=nextjs` 並關掉 `ssoProtection`（Nina、IFAR 都中過這個坑）。
