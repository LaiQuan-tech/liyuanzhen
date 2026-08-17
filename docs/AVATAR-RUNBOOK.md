# 數位李元貞・真人虛擬人上線 Runbook

臉已定：**HeyGen LiveAvatar**，客製 avatar 用老師本人的影片建模。

聲音與模式**暫定 Azure Personal Voice（zh-TW）＋ LITE mode**，但保留
ElevenLabs PVC ＋ FULL mode 這條路，在階段 5 用盲測拍板。理由：
兩者是設定切換不是重做，而拍攝那一趟只要把兩條路的素材都拿到，
就不必在資訊不足的時候提早鎖死。

各選項的比較與被放棄的方案記在本檔末尾的「選型紀錄」。

每個階段都標了「誰做」與「完成判準」。**判準沒達成不要進下一階段**——
這條路上有兩件事不可逆（老師的拍攝、Azure 的審核排隊），順序錯了會多等兩三週。

---

## 階段 0：今天就要送出（前置時間最長，先送不吃虧）

### 0-1　🔴 Azure Personal Voice：很可能整條路走不通（2026-08-17 查證）

**先不要送件。** 送出去大概率被拒，而且拒絕理由不是資格問題，是用途問題。

Microsoft 的 Transparency Note 明列 Personal Voice 的**唯一**四類核准用途，
第一類（也是唯一可能沾到邊的一類）原文是：

> Applications: For use in applications where voice output is **constrained and
> defined by customers, and where the voice does not read user-generated or
> open-ended content**. Voice model usage must remain within the application and
> **output must not be publishable or shareable from the application.**

後面緊接著一句：「All other uses ... are **prohibited**.」

我們這個站三條全踩：訪客自由打字（user-generated）、Gemini 即時生成回答
（open-ended）、公開網址人人可看可轉傳（publishable）。

**這是政策層的不合格，不是文件寫得不夠好可以補救的那種。** 附錄 A 那份申請草稿
先留著但不要送——除非改成「封閉展場、題目固定」的形態，那才落在核准用途內
（見「一個重要的不對稱：展場沒有這個問題」一節，那邊的結論在這裡再次成立）。

> 完成判準：**這一項現在的狀態是「暫停」，不是「待辦」。** 聲音改走 0-1b。

### 0-1b　聲音的替代路線（不需要任何申請）

查證發現 LiveAvatar 建客製 avatar 時，**會自動從那 2 分鐘影片生成她的聲音克隆**，
不需要另外的素材、另外的同意、另外的廠商、另外的審核：

> Because the training footage includes speech, LiveAvatar automatically generates
> a voice clone from the video.

三條路的實際比較（都以「她要配合錄多久」為第一考量）：

| | 素材需求 | 申請 | 每分鐘 | 狀態 |
|---|---|---|---|---|
| LiveAvatar 內建克隆 | 影片那 2 分鐘，不用加錄 | 不用 | 2 credits（FULL） | ✅ 可行 |
| ElevenLabs PVC | **最少 30 分鐘、建議 1–3 小時**乾淨錄音 ＋ 本人即時驗證 | 不用 | 1 credit（LITE） | ⚠️ 素材門檻高 |
| Azure Personal Voice | 1 分鐘 | 要，1–3 週 | 1 credit（LITE） | 🔴 用途不合格 |

⚠️ **內建克隆只能在 FULL mode 用**（官方：「Voices are used in FULL Mode only.
In LITE Mode, you bring your own audio pipeline」）。所以選她的內建克隆＝選 FULL＝
每分鐘 2 credits。**聲音與模式仍然是綁在一起的一個決定。**

ElevenLabs 那條的素材門檻先前被我低估了。她是公眾人物，演講與訪談錄音可能湊得到
30 分鐘，但要單一講者、無背景音、無主持人插話——訪談檔多半不合格，演講檔才有機會。
**這是可以現在就去盤點的，不用等她。**

### 0-2　開 LiveAvatar 帳號　👤 你

⚠️ **不是 heygen.com。** LiveAvatar 已經拆成獨立產品、獨立網域、獨立計費：
註冊在 `app.liveavatar.com`、文件在 `docs.liveavatar.com`、API base 是
`https://api.liveavatar.com`（**不是 `api.heygen.com`**）。heygen.com 的方案表
（Creator $29／Pro $49／Business $149）跟我們完全無關，別看錯。

方案問題已經查清楚，不用再問客服（liveavatar.com/#pricing，2026-08-17）：

| 方案 | 月費 | credits | 單次上限 | 並發 | 浮水印 | 1080p 客製 avatar |
|---|---|---|---|---|---|---|
| Free | $0 | 10 | 2 分 | 1 | 有 | ✗ |
| Starter | $19 | 150 | 5 分 | 5 | **有** | ✗ |
| Essential | $99 | 1,000 | 20 分 | 20 | 無 | ✗ |
| **Business** | **$475** | **5,000** | 60 分 | **40** | 無 | **含 1 個** |
| Enterprise | 洽談 | — | 可調 | 100 起 | 無 | — |

超額計費 $0.10/credit（Starter 是 $0.12/min）。LITE 1 credit/分、FULL／Embed
2 credits/分——**這三個數字讓先前那份成本估算完全對得上，不用重算。**

還剩一題要問業務：**第二個以後的 avatar slot 多少錢**（文件只說「purchase slots
as add-ons」沒標價）。我們短期只需要 1 個，Business 已含，所以這題不擋路。

> 完成判準：`app.liveavatar.com` 有帳號、拿到 API key（Free 方案即可，先不刷卡）。
> 有了 key 我就能跑 1-2 的 sandbox 驗證，那一步不花 credits。

### 0-3　~~開 Azure 訂閱與 Speech resource~~　🔴 取消

隨 0-1 一起暫停。**先不要開訂閱、不要刷卡。**

（唯一還值得做的 Azure 事項：Speech Studio 的 Personal Voice **demo** 只要 S0
resource 就能試，不需要 API 核准。但那只能拿來聽音質，不能上線——demo 產出的
聲音一樣受同一份用途政策約束。目前沒有非做不可的理由。）

### 0-4　換掉共用的 Gemini key　👤 你

目前 `.env.local` 的 `GEMINI_API_KEY` 是沿用其他專案的。公開網址上線前必須換成
本專案專屬 key，並在 Google Cloud 設**硬預算上限**與告警。

理由寫在 `.env.example` 裡：程式內的 rate limit 在 Vercel 多實例之間不共享，
真正的最後防線是雲端後台的硬上限。

> 完成判準：新 key 已寫進 Vercel 環境變數，且 Google Cloud 有預算上限。

---

## 階段 1：架構驗證（零成本，不用等老師）

### 1-1　釘死 LITE mode 的接法　✅ 已完成

**結論：不用另外開常駐主機，可以留在 Vercel。**

LITE mode 的音訊入口不是 LiveKit agent，是 `POST /v1/sessions/start` 回傳的
`ws_url` —— 直接對它送 JSON 就會講話。官方 Integration Paths 明列這條路叫
「**No agent — drive audio directly**」。

LiveKit／Pipecat 那兩個 plugin 確實是常駐 worker（Vercel 跑不了），但它們解的是
「語音進、語音出」的 voice agent；我們的互動發生在文字層（訪客打字 → RAG），
房間裡沒有麥克風音訊要做 STT，所以 worker 唯一能提供的價值我們根本用不到。

**分工：** Vercel 只負責幾支短命的 HTTP route（鑄 token、開 session、TTS proxy）。

⚠️ **這裡原本寫「整段 session 的 WebSocket 由瀏覽器持有」——那句已收回。**
`ws_url` 就是「叫她開口說任意音訊」的控制通道，交給瀏覽器等於親手把注入管道
打開。省一台常駐主機不值得這個代價。正確規則見附錄 D-8：**`ws_url` 只留在
伺服器端。** 走 FULL mode 的話這個問題不存在（音訊完全在 HeyGen 那側合成）。

完整的協定規格見本檔末尾「附錄 D：LITE mode 整合規格」。

### 1-1b　`max_session_duration` 可以在伺服器端釘死　✅ 已查證

鑄 token 的 schema 有 `max_session_duration`（秒），註明「Must be <= the configured
limit for your subscription tier」。

**這讓單次時長上限從「瀏覽器裡數秒數」升級成「LiveAvatar 伺服器端強制」。**
前者訪客改個 JS 就繞過去了，後者不行。`lib/avatar-ledger` 的第三道閘門因此
從「唯一防線」降級成「我們這側的帳務記錄」——實際執行的是對方。

⚠️ 仍然要在我們這側記帳：伺服器端上限擋的是單次，擋不了同一個人連開 200 次。
並發與月度預算兩道閘門的必要性沒有改變。

### 1-2　Sandbox 打通　🤖 我（需要你先給 API key）

`scripts/verify-liveavatar.ts` 已經寫好，`npm run verify:liveavatar` 一鍵跑完。
sandbox 不扣 credits，Free 方案就能跑。它會 LITE／FULL 各開一次，印出三題答案：
訪客 token 能不能發布、`ws_url` 是不是只有 LITE 有、時長上限有沒有被接受。

用 sandbox 模式（不扣 credits）把整條路跑通：token → session → 送音訊 → 出畫面。
用官方的公開 avatar，**完全不需要老師的素材**。

順便修掉現有程式碼的三個已知問題：
- `avatar_persona` 已標記 deprecated，要換成正確的 body 形狀
- `apiUrl` 是多餘的，SDK 內建
- 預設 taskMode 有回報約 9 秒首字延遲，必須改用 ASYNC

> 完成判準：sandbox avatar 在 liyuanzhen 的 `/chat` 頁面上動起來並講話。

### 1-3　用現成聲音驗證繁中對嘴　🤖 我 ＋ 👤 你付 $19

這是**唯一**能回答「LiveAvatar 的繁中對嘴到底行不行」的方法，而且不需要老師的分身。

有一份台灣人的一手實測（柯如竣）發現外掛音訊會讓 HeyGen 對嘴變差——但他測的是
影片生成線不是即時線。這一步就是要驗證那個結論會不會在 LiveAvatar 上重演。

> 完成判準：用 Azure zh-TW 現成語音送一段有人名的婦運史文本，錄一段畫面，
> 肉眼確認嘴型沒有明顯脫節。**這一步不過，整個方案要重新評估。**

---

## 階段 2：老師的拍攝與錄音（一趟做完，不可逆）

⚠️ **階段 1-3 沒過，不要排這一趟。**

### 2-1　行前確認　👤 你

- [ ] 書面授權已簽，且**肖像與聲音分開列**（見附錄 B 的必要條款）
- [ ] 眼鏡怎麼處理已經跟老師談過（LiveAvatar 要求拿掉，會影響像不像她）
- [ ] 場地：安靜房間、深色乾淨背景、人距牆 1.5 公尺
- [ ] 器材：1080p 相機（**不要 4K，不支援**）、好一點的麥克風、柔和均勻打光

### 2-2　現場三件事，一趟做完　👤 你陪同

| # | 項目 | 規格 | 給誰用 |
|---|---|---|---|
| 1 | 分身影片 | **2 分鐘一鏡到底不可剪接**：靜默聆聽 15 秒 → 說話 90 秒 → 靜默 15 秒。胸上景、1080p | HeyGen 建模 |
| 2 | 同意影片 | 老師**本人對 webcam 即時錄**，不能預錄不能代錄，平台會給驗證碼要唸。**可以用中文講** | HeyGen 授權 |
| 3 | 聲音素材 | **最少 30 分鐘、建議 60–90 分鐘**訪談形式錄音，單一講者、無主持人插話、涵蓋婦運史與文學評論的專有名詞 | ElevenLabs PVC（備案） |
| 4 | ~~Azure 同意句~~ | 🔴 **取消**——Azure Personal Voice 用途不合格，見階段 0-1 | — |
| 5 | ElevenLabs voice captcha | 本人當場對麥克風唸平台給的隨機句，10 秒內完成，過聲紋比對。失敗次數有限 | ElevenLabs 授權 |
| 6 | **待機 loop** | 她安靜看鏡頭、自然呼吸眨眼的 **30–60 秒**，可無縫循環。跟第 1 項同機同燈同位置連著錄 | 網站省錢用，見下 |

**第 6 項是這份清單裡投報率最高的一項**

訪客一進站先播這段預錄影片，等他真的送出第一個問題才開 session。公開網站跳出率
通常四到六成，這一招砍掉三到五成的計費分鐘——1 萬人次的情境下一個月省
US$900–1,500，三萬人次省 US$2,700–4,500。**而它的成本是拍攝當天多錄一分鐘。**

⚠️ 一定要在同一場、同機位、同打光錄完。事後補拍會對不上，切換的瞬間會跳一下，
那比沒有待機畫面還糟。

**第 3、5 項現在是備案，不是主線**

主線改成用 LiveAvatar 從第 1 項那 2 分鐘影片自動生成的聲音克隆（見階段 0-1b），
不需要額外素材。第 3、5 項留著的理由只有一個：**萬一內建克隆的繁中專有名詞
讀音差到不能用**，ElevenLabs PVC 是唯一還站得住的備案，而它的素材與 captcha
都不能事後補。

素材門檻要說清楚：ElevenLabs 官方要求**最少 30 分鐘、理想 1–3 小時**，且必須
單一講者、無背景音。訪談形式若有主持人聲音會不合格——要嘛主持人全程不出聲，
要嘛分軌錄。**她的公開演講錄音可能已經湊得到，這件事現在就能去盤點，不用等她。**

**這一趟真正不可逆的只有第 1 項那 2 分鐘（＋緊接著的第 6 項）。**
其他都還能重來，聲音路線可以晚兩週再定。

**錄音的兩個反直覺要求：**

- **不要照稿唸。** 訪談形式才留得住她自然的停頓與氣音；照稿唸會把節奏拉平。
- **不要做降噪與等化。** 降噪演算法會先把氣息聲當噪音砍掉，克隆就學不到了。
  用好麥克風、安靜房間、交原始檔。

**拍影片時最大的風險不是技術，是能量。** HeyGen 官方原文：
「你投入多少能量，就得到多少能量。平板僵硬的錄影會做出機器人般的分身。」
而且神情與手勢完全來自這 2 分鐘、**事後無法調整**。那兩段「不出聲但要有表情」
的靜默段落，建議先排練幾次再正式錄。

### 2-3　同日提交　👤 你

HeyGen 要求同意影片與素材影片**同一天提交**。

> 完成判準：HeyGen 後台顯示素材已受理，處理中（約 24 小時）。

---

## 階段 3：建模與克隆

### 3-1　HeyGen 客製 avatar　👤 你送件 → 等約 24 小時

> 完成判準：拿到 `LIVEAVATAR_AVATAR_ID`。

### 3-2　Azure 聲音克隆　🤖 我

用同一批錄音，同時做 Personal Voice（1 分鐘就夠）與 Professional CNV（吃完整 60–90 分鐘）。
**兩個都做**，階段 5 要盲測比對。

> 完成判準：拿到 speaker profile id，能用它合成出一段可聽的音檔。

### 3-3　建人名讀音表　🤖 我

這是選 Azure 而不是 ElevenLabs 的主要理由，一定要用起來。

把語料裡所有人名、書名、組織名整理成 Azure lexicon：李元貞、婦女新知、
《眾女成城》、華西街、民法親屬編……唸錯任何一個，在婦權基金會的公開專案上
都會被公開指出來。

> 完成判準：lexicon 檔案上線，且抽 20 個專有名詞人耳確認讀音正確。

---

## 階段 4：接起來

### 4-1　`/api/avatar-token`　🤖 我

**不能直接搬 Sunny 的那支。** 它是 FULL mode、用了已 deprecated 的 `avatar_persona`、
而且**無認證無限流**——放在展場螢幕後面還好，放在公開網站上等於誰都能來燒你的額度。

要加的防護（由弱到強）：

| 層 | 擋得住 |
|---|---|
| Origin 檢查 | 隨手把端點嵌到別站；可偽造 |
| 每 IP 限流 | 手滑、隨手寫的腳本 |
| Supabase session 帳本 | **跨 Vercel 實例的腳本攻擊——只有這層真的擋得住** |
| `AVATAR_ENABLED=false` killswitch | 出事時的手動閘門 |
| **HeyGen 後台硬上限** | 以上全破時的最後一道 |

誠實話術：行程內限流只是減速丘，**HeyGen 後台的硬上限才是真正的最後防線。**

### 4-2　Azure TTS 伺服器端 proxy　🤖 我

金鑰絕對不能給瀏覽器。

### 4-3　`lib/avatar/heygen.ts`　🤖 我

現在是刻意留的空殼。前端的 driver 抽象層（`lib/avatar/`）已經做完並測過，
接上去就是填這一個檔案 ＋ 換一個環境變數。

⚠️ session 絕不能建在裸 `useEffect` 裡——`reactStrictMode` 會讓 effect 跑兩次，
等於開兩個計費 session。必須由使用者手勢觸發。這件事 `AvatarStage` 已經處理好了。

### 4-4　客戶端退場　✅ 已完成

閒置 75 秒、切到背景、離開頁面、單次 session 硬上限 5 分鐘——都已經實作並在
瀏覽器實測過。**分頁被切到背景還在燒串流，是網站跟展場最大的成本差異。**

> 階段 4 完成判準：`npm run build` 過（這就是 SSR 測試本身），
> 且在 `/chat` 上實際跟老師的分身對話成功。

---

## 階段 5：盲測與拍板

這一階段同時決定兩件事：用哪個聲音，以及走 LITE 還是 FULL。

同一段**有人名**的婦運史文本，用這四組各產一版，全部接上老師的客製 avatar 實際跑：

| 組合 | 模式 | 測什麼 |
|---|---|---|
| Azure Personal Voice ＋ Dragon | LITE | 保音色優先 |
| Azure Personal Voice ＋ Phoenix | LITE | 保發音優先 |
| Azure Professional CNV | LITE | 吃完整 60–90 分鐘素材 |
| ElevenLabs PVC | FULL | 音色可能最像，但人名讀音不可控 |

**找 5 位認識老師的人盲聽**，評四項：

1. 像不像本人
2. **有沒有被美化成中年人**——氣息聲變少？語速被拉平？音量被正規化？共鳴太年輕？
3. 台灣腔純度
4. 專有名詞讀音正確率

另外由我方評兩項工程指標：對嘴精準度（四組是不是真的沒差）、端到端延遲。

> 完成判準：有一組明確勝出。**用盲測結果拍板，不要用任何人的排名拍板**——
> 中文高齡女聲克隆保真度沒有任何公開評測資料，只能自己測。

**若 ElevenLabs＋FULL 勝出，記得一併處理的事：** 人名讀音改不了，要建一份
「送進 TTS 前的同音字改寫表」（畫面上仍顯示原文），而且每加一個新人名要人工試一次。
費率也會變成兩倍（2 credits/分鐘）。這兩件事要在拍板時一起算進去，不要只比音色。

---

## 階段 6：解除護欄並上線

⚠️ **刻意放最後。** 萬一數位人做不出來，倫理那半邊一個字都還沒動，沒有東西要復原。

真臉一上線，全站有 11 個地方會從「誠實揭露」變成「假話」，必須一起改：

| # | 檔案 | 現在寫著什麼 |
|---|---|---|
| 1 | `content/site.ts` `DEMO_NOTICE` | 「尚未取得肖像與內容授權」——每一頁頁尾都在顯示 |
| 2 | `app/about-ai/page.tsx` | 同一段揭露，**寫死在頁面裡不是引用 site.ts** |
| 3 | `app/about-ai/page.tsx` FAQ | 「為什麼頭像不是老師的臉？」 |
| 4 | `content/knowledge/07-about-this-site.md` | **#3 的 RAG 鏡射，不改的話 AI 會當著客戶的面否定網站** |
| 5 | `data/knowledge-index.json` | `npm run build:index` 後 commit 產物 |
| 6 | Supabase `knowledge_chunks` | `npm run ingest:supabase` |
| 7 | `README.md` 倫理段 | 第 2 條字面上禁止「真人照片對嘴」＝禁止我們要做的事 |
| 8 | `components/avatar/DigitalAvatar.tsx` | 註解要從「立場」改成「這是備援視覺」 |
| 9 | `lib/persona-prompt.ts` | 檔頭寫著「我們並未取得授權」，全 repo 風險最高的檔案 |
| 10 | `app/privacy/page.tsx` | 第三方只列 Gemini 與 Vercel。**HeyGen 會拿到回答文字，WebRTC 還會拿到訪客 IP** |
| 11 | `.env.example` ＋ README | 新增環境變數 |

### 不要改的三樣（換上真臉之後更需要，不是更不需要）

- **`robots.ts` 與 `layout.tsx` 的 noindex** — 肖像授權不等於搜尋引擎授權，是兩件不同的許可
- **`AVATAR_NAME`「數位李元貞（AI 模擬）」**
- **`ANSWER_DISCLAIMER`「非李元貞老師本人發言」**
- **影片上的常駐浮水印** — 已實作。會說話的人臉被螢幕錄影轉傳的機率遠高於文字泡泡，
  而螢幕錄影不會把逐則的免責句一起帶走

### 讓 #4/#5/#6 不會被忘記

那三項是**靜默失敗**的：頁面說「是她」，但聊天機器人被問到同一題時還在背舊索引裡的
「我沒有臉」。要加一條測試，重算語料 sha256 並斷言等於索引裡的 `sourceHash`，
把「改了語料忘了重建索引」從無聲矛盾變成紅燈。

---

## 環境變數總表

```bash
# 已有
GEMINI_API_KEY=              # ⚠️ 上線前換成專案專屬 key ＋ 雲端硬預算上限
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
RETRIEVAL_PROVIDER=
NEXT_PUBLIC_DEMO_MODE=

# 已有（Phase 1 加的）
NEXT_PUBLIC_AVATAR_PROVIDER= # monogram（預設）| mock | heygen

# 還沒有——LiveAvatar（⚠️ 是 liveavatar.com 的 key，不是 heygen.com 的）
LIVEAVATAR_API_KEY=          # 階段 0-2，app.liveavatar.com → developers
LIVEAVATAR_AVATAR_ID=        # 階段 3-1，要等老師拍完 ＋ 24 小時
LIVEAVATAR_VOICE_ID=         # 建 avatar 時自動生成的她的聲音克隆（FULL mode 用）
AVATAR_ENABLED=              # killswitch，出事時手動關

# 還沒有——Azure　🔴 全部暫停，見階段 0-1
# AZURE_SPEECH_KEY=
# AZURE_SPEECH_REGION=
# AZURE_VOICE_PROFILE_ID=
```

⚠️ 舊名 `HEYGEN_API_KEY` 已改為 `LIVEAVATAR_API_KEY`——兩者是**不同的帳號、
不同的 key、不同的計費池**，混用會 401。

---

## 附錄 A：Azure 限制存取申請草稿　🔴 暫緩送件（2026-08-17）

> **不要送。** 不是草稿寫得不好，是用途不合格——見階段 0-1。
> 這份留著的唯一理由：若改成封閉展場（題目固定、非公開網址），用途就落回
> 核准範圍內，這份可以直接送。內容本身仍然有效。

Microsoft 審這張表看的是「你有沒有想過濫用風險」。這個專案的答案剛好都很強——
揭露機制不是事後補的，是一開始就寫進架構的。

**Use case**
> 台灣婦女運動史的公共教育與口述歷史保存專案。委託單位為財團法人婦女權益促進
> 發展基金會（政府捐助之財團法人）。以台灣婦運先驅李元貞女士（婦女新知創辦人）
> 的合成語音，回答公眾關於台灣婦女運動史的提問。知識庫僅取自公開出版資料，
> 並以相似度門檻限制回答範圍，超出範圍即婉拒回答，不由模型自由發揮。

**Voice talent relationship**
> 李元貞女士本人知情且同意，將簽署書面授權，肖像與聲音分列。同意錄音將依
> Microsoft 指定之 zh-TW 口頭聲明格式，由本人親自錄製。

**Disclosure to end users**（這一節是加分最多的，據實寫）
> 揭露為系統的常駐設計，非可關閉之選項：
> 1. 數位人顯示名稱恆為「數位李元貞（AI 模擬）」
> 2. 每一則回答下方強制附加「本回答由 AI 依公開資料生成，非李元貞老師本人發言」
> 3. 影片畫面上有常駐的「AI 生成影像」浮水印，隨螢幕錄影一併留存
> 4. 網站設為 noindex，不進搜尋引擎索引
> 5. 有獨立的「關於這個 AI」頁面說明運作方式與資料來源

**Deployment scope**
> 單一網站（提案展示版，noindex），以及 2027 年實體展覽的現場互動站。
> 不做 API 對外開放，不提供第三方使用。

---

## 附錄 B：授權書必要條款

「肖像授權」四個字不夠。授權「使用她的照片」和授權「合成她的臉說出 AI 生成的話」
是兩件差很遠的事，而我們要做的是後者。必須白紙黑字寫下：

- [ ] 可以合成她的臉**說出 AI 生成的內容**（不是只有使用既有影像）
- [ ] 聲音克隆是**獨立的一項**，不要包在肖像裡帶過
- [ ] 授權期間
- [ ] 可用場合：網站？展場？兩者？能不能用在第二階段與後續年度展？
- [ ] **下架機制**：她或家屬要求停用時，多久內、以什麼方式下線

最後一項對一位 80 歲的公眾人物特別重要，也是基金會的董事會一定會問的問題。

---

## 附錄 C：Azure 同意句原文（zh-TW）

取自 Microsoft 官方 repo `verbal-statement-all-locales.txt`：

> 本人（填入你的姓名）確認我的聲音將會被（填入公司名稱）使用於創建合成版本語音。

公司名稱填「萊乾資訊股份有限公司」。這一句**可以預錄、可以由我方代為上傳**，
老師不必碰電腦——這是選 Azure 而不是 ElevenLabs 最實際的理由。

---

## 選型紀錄（為什麼是這個組合，不要重新討論）

**臉為什麼是 HeyGen LiveAvatar**
只有 LiveAvatar 與 Tavus 是真人影片訓練；Simli、bitHuman、Anam 都只吃單張照片，
臉是她但頭部動態與微表情不是她的。LiveAvatar 勝過 Tavus 的理由：獨立第三方
（Docket.io，實際 production 的公司測了 5 家）評 idle 行為最自然——展場裡她大部分
時間是安靜地看著人，這比說話時的口型更容易露餡；每分鐘便宜約 3 倍；入門月費較低。

**🔴 2026-08-17 作廢：下面這整段「暫定 Azure」的推論前提已經不成立**

理由不是技術，是用途政策——Azure Personal Voice 的核准用途明文排除
「user-generated／open-ended content」與「publishable output」，我們三條全踩。
詳見階段 0-1。**不要再拿下面兩點理由去重啟這個討論**，那兩點沒有錯，
只是它們在一個不合格的選項上比較優劣，沒有意義。

以下保留原文，只為了記錄「Azure 的 lexicon 優勢是真的」——如果哪天改做封閉展場
（用途就合格了），這段直接可以復活。

---

**聲音為什麼暫定 Azure 而不是 ElevenLabs**（已作廢，見上）

純論音色像不像她，證據其實指向 ElevenLabs PVC（真的微調模型權重，而不是 zero-shot
condition；且 ALS 語音銀行社群是目前唯一大量處理衰退語音的實戰紀錄）。

暫定 Azure 是拿一點音色相似度，換兩件事：

1. **人名讀音可控。** Azure 有 lexicon，可以一次建好整份讀音表。ElevenLabs 中文沒有
   音素標註，只能在送進 TTS 前改寫成同音字去騙它，每加一個新人名要人工試一次，
   而且中文破音字用同音字硬換常常連聲調一起跑掉。內容是婦運史，人名密度極高
   且會持續增加，這是**會反覆發生**的錯誤。
2. **每分鐘半價**（LITE 1 credit vs FULL 2 credits）。展場階段 14,400 分鐘/月的話，
   差距是 US$1,400 對 US$2,800。

**三個曾經被我列為理由、但後來收回的論點**（留著避免重蹈）：

- ~~「FULL 走 HeyGen 原生管線，對嘴比較準」~~ ——**錯的，而且錯得比想像中徹底**。
  查證發現 **LiveAvatar 的原生 TTS 本來就是 ElevenLabs Flash v2.5**。所以綁自己的
  ElevenLabs voice 等於在同一家換一個 voice id，走完全同一條伺服器端合成 → 對嘴
  pipeline。原生優勢不存在。
  （順帶：柯如竣那份「外掛音訊讓對嘴變差」的實測**不適用**——他跑的是 HeyGen
  影片生成 API 的 `voice.type: "audio"` 上傳成品 mp3 路徑，跟 LiveAvatar 的伺服器端
  即時合成不是同一條。這個疑慮可以撤掉了。）
- ~~「ElevenLabs 的 captcha 對 80 歲長者是額外負擔」~~ ——**講得太重**。她本來就要
  為了 HeyGen 的同意影片坐到電腦前做即時流程，多一個 captcha 只是多十分鐘。
- ~~「FULL mode 可以關掉瀏覽器端的注入管道，這對真實在世的公眾人物是實質優勢」~~
  ——**錯的**。官方沒有任何伺服器端「叫她講話」的 HTTP 端點，兩種模式都只能從
  瀏覽器驅動。詳見附錄 D-8。

**模式：Azure 出局之後只剩兩條，而且都不是原本那條**

原本的推論是「選 Azure ⇒ 只能 LITE」，因為 FULL 的 custom TTS 只吃 ElevenLabs /
Fish Audio / Cartesia（2026-08-17 覆查，Azure 仍不在名單上）。Azure 出局後改成：

- **FULL ＋ 她的內建克隆**：2 credits/分。聲音跟著 avatar 一起生出來，零額外素材、
  零額外廠商。LLM 可以接我們自己的（官方有 Custom LLM Integration），所以 RAG 與
  answer-guard 都保得住。
- **LITE ＋ ElevenLabs PVC**：1 credit/分，但要先湊到 30 分鐘以上她的乾淨錄音。

以 1 萬人次 × 3 分鐘/月估，FULL 比 LITE 貴約 US$3,000/月。**這筆錢買的是
「不用為了聲音再跟她要 30 分鐘素材」以及「少一個廠商」。**

⚠️ 走 FULL ＋ Custom LLM 的話，answer-guard 的回收機制要在**我們的 endpoint 內**
處理完才吐字——不能邊生成邊 streaming 給 HeyGen，否則被回收的那段已經用她的聲音
講出去了。這跟先前定的「等整段答案才開口」是同一條規則，只是實作位置從瀏覽器
移到伺服器。

**「用內建語音」先前被排除的理由要修正**：當時說 LiveAvatar 內建語音只有籠統的
`zh` 沒有 zh-TW——那句話對的是**現成語音庫**，不適用於**從她本人影片生成的克隆**。
克隆學的是她自己的口音，不存在「選到對岸腔」的問題。這個排除理由撤銷。

**已知的未解風險**
1. 60 歲以上客製 avatar 的品質——公開資料完全空白，只能自己測（階段 1-3、5）
2. 外掛音訊可能讓對嘴變差（柯如竣的一手實測，但測的是影片生成線不是即時線）
3. 聲音克隆普遍會把高齡特徵「美化」掉（階段 5 的盲測第 2 項就是在測這個）
4. ~~瀏覽器持有 `ws_url` = 訪客可以讓她的臉對嘴任意音訊~~
   → 已定案，不再是未解風險：`ws_url` 只留伺服器端即可；FULL 模式連這個欄位
   都沒有。實測結果見附錄 D「已實測」那節。

---

## 附錄 D：LITE mode 整合規格

以下全部來自官方文件一手查證。標「實測值」的來自 Pipecat 官方整合的原始碼。

### D-1　兩條獨立通道

| 通道 | 走哪裡 | 誰持有 |
|---|---|---|
| 看得到（video in） | LiveKit，用 `livekit_url` + `livekit_client_token` 訂閱 avatar 的 track | 瀏覽器 |
| 講得出（audio out） | `ws_url` 上送 base64 PCM | 瀏覽器 |
| 鑄 token／開 session／Azure TTS | HTTP，短命請求 | Vercel route |

`X-API-KEY` 只在 Vercel server route 出現，永不外流。

### D-2　開 session（兩步，同一支 route 內做完）

```
POST https://api.liveavatar.com/v1/sessions/token
Headers: X-API-KEY: <key>

{
  "mode": "LITE",
  "avatar_id": "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a",   // sandbox 的 Wayne
  "is_sandbox": true,                                     // 上線時整個拿掉
  "video_settings": { "quality": "high", "encoding": "H264" },
  "max_session_duration": 300
}
→ { "data": { "session_id", "session_token" } }

POST https://api.liveavatar.com/v1/sessions/start
Headers: Authorization: Bearer <session_token>
（無 body）
→ { "data": { "session_id", "livekit_url", "livekit_client_token",
              "livekit_agent_token", "ws_url", "max_session_duration" } }
```

回傳給前端：`session_id` + `livekit_url` + `livekit_client_token` + `ws_url`。
**不要**回傳 `livekit_agent_token`，那是給 agent 用的，我們不用。

⚠️ **`avatar_persona` 和 `voice_agent` 在 LITE mode 都不存在。** Sunny 那支路由裡整塊
`avatar_persona: {voice_id, language}` 要**整段刪掉**——聲音是我們自己給的，
LiveAvatar 不需要知道用哪個 voice。（`voice_agent` 是 FULL mode 用來取代已 deprecated
的 `avatar_persona` 的，跟我們無關。）

⚠️ `encoding: "VP8"` 已 deprecated，用 `H264`（預設值）。
⚠️ 官方 Configuration 頁的 `livekit_config` 範例欄位名是錯的，以 API reference 為準。

### D-3　WebSocket 事件

**必須等收到 `{"type":"session.state_updated","state":"connected"}` 才能開始送**，
這是文件的明文警告。

| 事件 | payload |
|---|---|
| 送音訊 | `{"type":"agent.speak","event_id":"<uuid>","audio":"<base64>"}` |
| 一段講完 | `{"type":"agent.speak_end","event_id":"<同一個 uuid>"}` |
| 打斷 | `{"type":"agent.interrupt"}` |
| 保活 | `{"type":"session.keep_alive","event_id":"<uuid>"}` |
| 聆聽態 | `agent.start_listening` / `agent.stop_listening` |

⚠️ **`agent.speak` 的語意是排隊不是打斷。** 文件原文是「**Adds** audio to the avatar's
**playback buffer**」。訪客中途送新問題時，一定要先送 `agent.interrupt` 清空 buffer，
否則新答案會排在舊答案後面播。

⚠️ **LITE mode 沒有 `repeat()`、沒有 `say()`、沒有任何送文字的方法。** 只能送音訊。
（那些是 FULL mode 的事件。）

### D-4　音訊格式：Azure 與 LiveAvatar 逐位元對得上

| 項目 | 要求 |
|---|---|
| 編碼 | PCM 16-bit linear（**無 WAV/RIFF header**） |
| 取樣率 | 24,000 Hz |
| 聲道 | mono |
| 包裝 | base64 放進 JSON 的 `audio` 欄位 |
| chunk | 建議約 1 秒，單包上限 1MB |

Azure 端設 `X-Microsoft-OutputFormat: raw-24khz-16bit-mono-pcm`。

⚠️ **一定要 `raw-` 不能是 `riff-`。** `riff-` 會帶 44 bytes 的 WAV header，直接送過去
會在每一段開頭產生爆音；而且 `riff-*` 全在 Azure 的 NonStreaming 清單裡，串流拿不到。

Azure 神經語音原生就是 24kHz，選 24kHz 不會觸發任何 resample 損耗。
**中間不需要轉檔、不需要重新取樣。**

切塊策略（Pipecat 實測值）：首包 19,200 bytes（400ms）求首字快，之後每
48,000 bytes（1000ms）。

### D-5　生命週期

- **idle timeout 5 分鐘**，keepAlive 每 **150 秒**送一次（抓一半，Pipecat 實測值）
- `max_session_duration` 的上限由方案決定，實際生效值看 `/sessions/start` 的回應
- 結束：`POST /v1/sessions/stop`（Bearer session_token），並自行關 WS、離開 LiveKit room

### D-6　Sandbox

`is_sandbox: true`，不用另外申請、不扣 credits、免費帳號就能用。
只有一個 avatar：`dd73ea75-1218-4ef3-92ce-606d5f7fbc0a`（Wayne），session 約 1 分鐘。

那 1 分鐘足夠驗證完整鏈路：token → start → WS 連上 → 收到 `connected` →
送 base64 PCM → 收到 `agent.speak_started` → 畫面上嘴型動。

### D-7　防火牆／CSP 白名單（展場現場會用到）

```
api.liveavatar.com        TCP 443
*.livekit.cloud           TCP 443
*.turn.livekit.cloud      TCP 443
*.host.livekit.cloud      UDP 3478
（建議）所有 host          UDP 50000–60000, TCP 7881
```

### D-8　⚠️ 注入風險：兩種模式都關不掉，這是架構層級的問題

**先講結論：這件事跟選 LITE 還是 FULL 無關，兩邊都有，只是形態不同。**

我原本假設 FULL mode 可能把注入管道關掉（伺服器端 HTTP 驅動、瀏覽器只拿唯讀
token）。**查證結果是錯的。**

官方 `openapi.json` 全部 28 個端點裡，**沒有任何「叫 avatar 講話」的伺服器端 HTTP
端點**——沒有 `/v1/sessions/{id}/task`，也沒有舊版 Streaming API 那種對應物。
FULL mode 唯一的驅動管道是瀏覽器持有的 LiveKit client token，往 topic `agent-control`
發 `avatar.speak_text`。

而且官方 SDK 的 `sendCommandEvent()` 是**雙通道 fallback**（讀 0.0.18 的發行檔確認）：
有 `ws_url` 就走 WebSocket，沒有就走 `room.localParticipant.publishData()`。
所以就算 FULL mode 不回傳 `ws_url`，`repeat()` 照樣從瀏覽器生效。

| | LITE | FULL |
|---|---|---|
| 誰能讓她講話 | 持有 `ws_url` 的任何人 | 持有 `livekit_client_token` 的任何人 |
| 注入內容 | **任意音訊**（可對嘴任何錄音、任何人的聲紋） | **任意文字**（用她的克隆聲唸出來） |
| 伺服器端 HTTP 驅動 | 無 | **無** |
| 官方有無關閉開關 | 無 | **無** |

**FULL 不是比較安全，某種意義上更糟**——「她用自己的聲音講出那句話」比「她的臉對嘴
別人的錄音」更像是她真的說了。

而且憑證一旦進瀏覽器就沒有純前端解法。不用官方 SDK 也沒用，權限在 token 裡：
client token 必然帶 `canPublishData`（FULL 的 push-to-talk 與 command 都靠它），
訪客開 DevTools 就能自己 `publishData`。

### ⚠️ 修正：上面那段講的是 FULL mode，LITE mode 很可能沒有這個洞

後續查證發現一件事，讓「自控 LiveKit room」這個解法可能整個不需要。

官方兩處原文：

> the agent runs STT → LLM → TTS and **forwards synthesized audio over the
> LiveAvatar WebSocket (`ws_url`)**
> — docs/guides/livekit/custom-livekit-agent

> **Instead of your agent publishing audio into the room**, the plugin forwards it
> to LiveAvatar, which syncs it to the avatar's video output.
> — docs/lite-mode/plugins/livekit

也就是說：**LITE mode 的 avatar renderer 不消費 LiveKit room 的 data channel。**
訪客就算 publish 一堆 data message 或音軌進 room，也沒有任何元件在聽——
avatar 只同步從 `ws_url` 送進去的 PCM。

而 `ws_url` 只出現在 `POST /v1/sessions/start` 的回應裡，也就是**只有我們的後端拿得到**。

所以真正的規則比「自控 room」簡單得多：

> **不要把 `ws_url` 交給瀏覽器。** 只要它留在伺服器端，注入管道就不存在，
> 用誰的 LiveKit room 都無所謂。

（本檔更早的版本曾建議「把 WebSocket 交給瀏覽器以維持 serverless」——**那個建議
要作廢**。省下來的那台主機，代價是把注入管道親手打開。）

### ✅ 已實測（2026-08-17，sandbox，`npm run verify:liveavatar`）

三題全部有答案，重跑指令就在 repo 裡，不要再憑推論討論這一段。

| | LITE | FULL |
|---|---|---|
| `ws_url`（叫她開口的控制通道） | **有** | **沒有** |
| `livekit_agent_token` | 有 | 沒有 |
| client token `canSubscribe` | true | true |
| client token `canPublish` | **true** | **true** |
| client token `canPublishData` | **true** | **true** |
| `max_session_duration` 送 180 | **被 400 拒**，回「maximum allowed (60s)」 | 同左 |

room 是 HeyGen 自己的 LiveKit（`wss://heygen-feapbkvq.livekit.cloud`），
每個 session 一個獨立 room id。

#### 🔴 先前的猜測錯了，要收回

我曾經推論「client token 可能本來就沒有發布權限，所以自控 room 大概不必要」。
**實測是 `canPublish` 與 `canPublishData` 兩個都 true**，兩種模式都一樣。
那個推論被直接證偽，不要再引用它。

#### 但結論仍然是「不用自控 room」——理由換了

權限寬鬆只有在**有東西在聽**的時候才是漏洞。逐條看訪客能做什麼：

- 發布音訊軌 → **沒有任何元件在聽**。LITE 的音訊入口是 `ws_url`，不是 room；
  而我們的互動在文字層，後端根本不訂閱 room 音訊。
- 發布 data message → 同上，沒有消費者。
- 發布視訊軌 → room 是 1:1，沒有第三人看得到。
- 混進別人的 room → room id 編在對方 token 的 grant 裡，拿不到就進不去。
- 灌流量 → 那是 **HeyGen 的** LiveKit 帳號，不是我們的；上行本來也免費。

所以正確的規則從頭到尾只有一條，而且跟 token 權限無關：
**`ws_url` 只留在伺服器端。** 它是唯一真的能讓她的臉對嘴任意音訊的東西。

#### 🔴 再次收回：「FULL 結構性更安全」是錯的，通道只是換了路

我曾經寫「FULL 的回應根本沒有 `ws_url`，所以注入風險結構性消失」。
**那是錯的。** 讀 SDK 原始碼（P2 裝套件時查的）發現控制指令有 fallback：

`node_modules/@heygen/liveavatar-web-sdk/lib/LiveAvatarSession/LiveAvatarSession.js`

```js
if (this._sessionEventSocket && readyState === OPEN) {
  this.sendCommandEventToWebSocket(commandEvent);   // LITE：走 ws_url
} else if (this.room.state === "connected") {
  this.room.localParticipant.publishData(data, {
    reliable: true,
    topic: LIVEKIT_COMMAND_CHANNEL_TOPIC,           // FULL：走 LiveKit data channel
  });
}
```

`LIVEKIT_COMMAND_CHANNEL_TOPIC = "agent-control"`，而 `repeat(text)` 送的是
`CommandEventsEnum.AVATAR_SPEAK_TEXT`——**用她的臉和聲音唸任意字串。**

連帶要收回的是我上一節寫的「訪客發布 data message 沒有消費者」。
**有消費者，就是 `agent-control` 這個 topic。** 我們實測到的
`canPublishData: true` 正是讓它能用的權限。

所以現況是：**兩種模式都有一條瀏覽器可及的注入通道，選模式關不掉它。**
`repeat()` 與 `repeatAudio()` 在 SDK 裡都是 public method，訪客開 devtools
就能呼叫。

#### 唯一真的能關掉它的做法（成本比我先前以為的低）

用 `livekit_config` 帶自己的 room，然後**我們自己簽訪客 token**，
把 `canPublish` 與 `canPublishData` 都設成 false。

先前我以為這需要一台常駐 agent worker，**那個顧慮是多餘的**：

- LiveAvatar 用我們給的 agent token 加入**我們的** room 並發布影像
- 訪客用我們簽的唯讀 token 訂閱
- 音訊由我們的後端經 `ws_url` 送（LITE）
- **我們的後端從頭到尾不需要加入 room**——簽 JWT 是純計算，Vercel 做得到

代價只有一個 LiveKit 帳號，沒有常駐主機。

⚠️ 但這條路只有 LITE 走得通。FULL 需要麥克風（`canPublish` 必須開），
而且 session 設定本身也走 data channel，鎖掉會壞。

**這讓 FULL／LITE 變成一個要拍板的取捨，不是可以兩全的：**

| | FULL | LITE ＋ 自控 room |
|---|---|---|
| 她的聲音 | ✅ 內建克隆（2 分鐘影片附帶） | ❌ 要 ElevenLabs PVC（30 分鐘以上素材） |
| 注入通道 | ❌ 關不掉（data channel） | ✅ 唯讀 token 真的關掉 |
| 每分鐘 | 2 credits | 1 credits |
| 多的東西 | 無 | LiveKit 帳號 |

**這一題要 user 拍板，不要我自己選。** 它在「她的聲音有多像」與
「訪客能不能讓她說出任意話」之間二選一，而後者對一位在世的公眾人物
是名譽風險，不是技術偏好。

#### 內容層的防線兩種模式都需要，而且擋不住這一條

檢索門檻與 answer-guard 擋的是「誘導 RAG 產生不當回答」。
`repeat()` **完全繞過我們的後端**——它不經過檢索、不經過 answer-guard，
直接叫她唸。所以內容層不是這個問題的解，別再把兩件事混在一起講。

#### Q3 的附帶收穫：時長上限是伺服器端強制的

送 180 秒被 400 打回來，訊息明確給出上限。也就是說單次時長不是我們自律，
是對方拒收——訪客改 JS 繞不過去。`lib/avatar-ledger` 的第三道閘門因此
降級為帳務記錄（見階段 1-1b）。

⚠️ 實測值 60 秒是 sandbox／Free 的上限，不是我們上線後的值。
Business 方案是 60 分鐘，我們會設 180 秒。**上線前要再跑一次確認 180 被接受。**

### 實作修正：`livekit_config` 的欄位名

⚠️ **2026-08-17 再修正：先前這一段自己搞混了兩個不同的物件，別再被它誤導。**

- **請求側** `livekit_config`（鑄 token 時可選）＝「我要用自己的 room」的覆寫，
  官方 schema 是 `{url, token}`，要 **agent token**，room 編在 `video.room` grant 裡。
  **不給這個欄位＝LiveAvatar 幫你開 room**（官方 lifecycle 明文：「The room is torn
  down *if created by LiveAvatar*」）。所以自控 room 從頭到尾都是選配，不是必要。
- **回應側** `livekit_url` / `livekit_client_token` / `livekit_agent_token`
  ——這三個是**官方 `POST /v1/sessions/start` 的正式回應欄位**，不是 Pipecat 的。
  先前寫「這是 Pipecat wrapper 的欄位名」是錯的，收回。

回應同時給 client token 與 agent token 這件事本身就是線索：兩種 token 權限不同，
給瀏覽器的應該是 client token。到底差在哪，`npm run verify:liveavatar` 會直接印出來。

下面是**請求側**覆寫用的格式：

```json
{
  "mode": "LITE",
  "avatar_id": "<avatar_id>",
  "livekit_config": { "url": "wss://…", "token": "<your_agent_token>" }
}
```

### 真正的防線在內容層，不在 token 層

就算把 data channel 完全關掉，**一個會 prompt injection 的訪客照樣能讓她說出
不該說的話**——因為那條路走的是我們自己的 RAG。

這個題材（婦運先驅的數位分身、台灣、開放給不特定大眾）真正的風險是
**她被誘導說出違背本人立場的政治或歷史發言**，而那是檢索門檻與 answer-guard
在擋的，不是 token 權限。這兩層已經實作並測過了，它們才是主防線。

### 一個重要的不對稱：展場沒有這個問題

展場互動站是**受控裝置**——沒有 DevTools、有現場人員、實體監督。
所以第二階段的 kiosk 完全不受影響。

**暴露的只有公開網站。** 這代表兩個階段可以用不同的安全等級，不必為了網站的
風險去犧牲展場的體驗，也不必為了展場去付網站用不到的主機費。

### 現階段的建議

網站現在是 noindex 的提案展示版，訪客只有客戶與我們。我建議：

1. 接受風險，用現有緩解：常駐浮水印（任何螢幕錄影都會把「AI 生成影像」帶走）、
   `max_session_duration` 300 秒、開 session 的 route 限流、一位訪客一個 session
2. **加開逐字稿留存**：`GET /v1/sessions/{id}/transcript` 這支端點存在，
   全程留存可做事後稽核——真的出事時，我們能證明系統實際輸出過什麼
3. **正式對外或發新聞稿之前，這一題要重新決定**，並先把自控 LiveKit room 那條實測掉

第 3 點是這份文件裡少數「現在不做、但絕對不能忘」的事項。基金會的董事會若問到
「有沒有人能讓她說出奇怪的話」，現在的誠實答案是「有，但會留下 AI 浮水印與逐字稿」。
