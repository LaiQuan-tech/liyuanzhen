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

### 0-1　Azure Personal Voice 限制存取申請　👤 你

網址：`aka.ms/customneural`（Personal Voice 與 Professional CNV 一起申請，不要只勾一個）

**審核 1–3 週，這是整條路上最長的前置。** 送件不需要先決定任何技術細節，
所以沒有理由晚送。草擬的填答內容見附錄 A，可直接複製。

> 完成判準：收到 Microsoft 的受理回信（不是通過，是受理）。

### 0-2　開 HeyGen 帳號並問清楚方案　👤 你

先開免費帳號即可，**還不要刷卡**。要問客服／業務兩題：

1. 哪一個方案層級可以建 **1080p 客製 avatar**？官方 Help Center 自相矛盾——
   一處說「所有付費方案（$19 Starter 起）都可以」，另一處說「Business $475
   才含 1 個免費 1080p 客製 avatar」。**這題沒問清楚不要刷卡。**
2. 客製 avatar 的 slot 是否另外計費？月費多少？

> 完成判準：拿到書面（email 或客服對話截圖）答覆，知道要刷哪一個方案、總共多少錢。

### 0-3　開 Azure 訂閱與 Speech resource　👤 你

Region 要選**有支援 Personal Voice 的**（申請通過後 Microsoft 會給清單）。
先開 resource 不影響審核，但可以先把計費與預算告警設好。

> 完成判準：拿到 `AZURE_SPEECH_KEY` 與 `AZURE_SPEECH_REGION`，且已設預算上限。

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

**分工：** Vercel 只負責三支短命的 HTTP route（鑄 token、開 session、Azure TTS
proxy）；整段 session 的 WebSocket 由**瀏覽器**持有，不受 function timeout 影響。

完整的協定規格見本檔末尾「附錄 D：LITE mode 整合規格」。

### 1-2　Sandbox 打通　🤖 我（需要你先給 API key）

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
| 3 | 聲音素材 | **60–90 分鐘訪談形式**錄音，涵蓋婦運史與文學評論的專有名詞 | Azure ＋ ElevenLabs 克隆 |
| 4 | Azure 同意句 | 一句話，可預錄、可我方代傳。原文見附錄 C | Azure 授權 |
| 5 | ElevenLabs voice captcha | 本人當場對麥克風唸平台給的隨機句，10 秒內完成，過聲紋比對。失敗次數有限 | ElevenLabs 授權 |

**第 5 項為什麼是必做而不是可選**

技術路線（Azure＋LITE vs ElevenLabs＋FULL）在拍攝當下還不必定案——客製 avatar 建好
之後，兩種模式是設定切換不是重做，同一張臉可以兩種都試，用階段 5 的盲測決定。

但這件事的前提是**兩條路的素材都要在這一趟拿到**。ElevenLabs 的 captcha 不能事後補，
所以現場多花十分鐘，換一個可能音色最像的選項留在檯面上。

她本來就要為了 HeyGen 的同意影片坐到電腦前做一次即時流程，多做一個 captcha
不是新的類別，只是多十分鐘。

**這一趟真正不可逆的只有第 1 項那 2 分鐘。** 其他都還能重來，技術路線可以晚兩週再定。

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

# 還沒有——HeyGen
HEYGEN_API_KEY=              # 階段 0-2
LIVEAVATAR_AVATAR_ID=        # 階段 3-1，要等老師拍完 ＋ 24 小時
AVATAR_ENABLED=              # killswitch，出事時手動關

# 還沒有——Azure
AZURE_SPEECH_KEY=            # 階段 0-3
AZURE_SPEECH_REGION=         # 要選支援 Personal Voice 的 region
AZURE_VOICE_PROFILE_ID=      # 階段 3-2
```

---

## 附錄 A：Azure 限制存取申請草稿

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

**聲音為什麼暫定 Azure 而不是 ElevenLabs**

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

**為什麼是 LITE（在選 Azure 的前提下沒有別的選擇）**

FULL mode 的 custom TTS 只支援 ElevenLabs / Fish Audio / Cartesia 三家，**Azure 不在
名單上**。所以「Azure ＋ LiveAvatar」只有 LITE 一條路。反過來說，如果最後盲測是
ElevenLabs 勝出，那就會連帶改用 FULL。**聲音與模式是綁在一起的一個決定，不是兩個。**

而 LiveAvatar 內建語音只有籠統的 `zh`，沒有 zh-TW，所以「用內建語音」從一開始就不在
選項內。

**已知的未解風險**
1. 60 歲以上客製 avatar 的品質——公開資料完全空白，只能自己測（階段 1-3、5）
2. 外掛音訊可能讓對嘴變差（柯如竣的一手實測，但測的是影片生成線不是即時線）
3. 聲音克隆普遍會把高齡特徵「美化」掉（階段 5 的盲測第 2 項就是在測這個）
4. **瀏覽器持有 `ws_url` = 訪客可以讓她的臉對嘴任意音訊**（見附錄 D 末節）

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

### 唯一真正的解法，以及它的代價

**自控 LiveKit room**：走 LiveKit Agents 的 plugin，讓 LiveAvatar 加入**我們自己的**
room（`avatar.start(session, room=ctx.room)`），前端 participant token 由我們簽發，
設 `canPublish: false` / `canPublishData: false`，做出真正的唯讀訂閱端。

代價是這條路強制回到常駐 worker——放棄 serverless、多一台主機一筆月費，
等於把 D-1 那個「不用多開主機」的好消息還回去。

⚠️ **而且這條路目前只有二手線索**（前端 token 由誰簽，LiveKit 文件沒明講），
**下賭注前必須實測驗證**。

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
