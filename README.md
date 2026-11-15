# 🎲 惡魔輪盤 Devil Roulette

資料驅動（Data-Driven）＋ 隨機裝彈的網頁版俄羅斯輪盤（Buckshot Roulette 風格）。
單人對 DeepSeek 娘、或 2～4 人 Socket.io 即時連線，**純 2D 介面**（沒有任何 3D / WebGL 程式碼）。

## 啟動

```bash
npm install          # 第一次才需要（已裝好可略過）
node server.js       # 或 npm start
```

打開 <http://localhost:3000>（區網連線：`http://<你的內網IP>:3000`）。

- `npm run dev` 開發模式（--watch 自動重啟）
- `npm test` 一次跑完 smoke / 台詞 / DOM 鉤子三組驗證
- `npm run sim2d` 直接驗證四個任務的規則（裝填提示鎖、發道具數量、空包彈保留回合、狀態欄位）
- `npm run e2e` 兩個 Socket 客戶端真的打一局的端到端測試（需先 `npm start`）

## 一局的流程

1. **本回合裝填（3 秒）** — 每輪開始畫面正中央彈出「🔴 X 發實彈 / 🔵 Y 發空包彈」，
   進度條跑完 3 秒自動淡出，遊戲才真正開始。這段時間任何人都不能行動
   （後端會回 `AMMO_REVEAL` 錯誤，不是只有前端擋）。
2. **發道具** — 每輪開始每人自動拿到 **2 個**隨機道具，**第 3 輪起 3 個**（右側道具欄）。
3. **輪到你** — 底部兩顆大按鈕亮起：
   - **對自己開槍**：空包彈 → 回合不轉移，你可以繼續開槍或使用道具；實彈 → 扣自己的血並交棒。
   - **對敵人開槍**：不論實彈或空包，回合立刻轉移。
   - 道具有多數**不消耗回合**（`keepsTurn`），連發類道具打完自然交棒。
4. **子彈打完** → 自動重新隨機裝彈、回到第 1 步。

按鈕的可用狀態完全跟伺服器走：`public.activeId !== 你的 id` 時兩顆按鈕是 `disabled`，
另外裝填演出中、動畫播放中、遊戲結束時也會鎖住。

## 畫面配置

```
┌──────────────────────── HUD（房號 / 輪次 / 剩餘彈藥 / 計時）────────────────────────┐
│                   現在輪到你 / 現在輪到 DeepSeek 娘（大字）                        │
├──────────────┬──────────────────────────────────┬──────────────────────────────┤
│ 左：生命值   │ 中：DeepSeek 娘 立繪 + 對話框      │ 右：道具欄（2~3 格）          │
│ ❤❤❤❤        │      其他玩家座位 + 彈艙            │      + 戰鬥日誌               │
├──────────────┴──────────────────────────────────┴──────────────────────────────┤
│              [ 🙎 對自己開槍 ]        [ 💀 對敵人開槍 ]                            │
└────────────────────────────────────────────────────────────────────────────────┘
```

- 手機 / 窄螢幕自動改成單欄，兩顆按鈕變上下排列。
- 也可以直接點 DeepSeek 娘（第一下鎖定、第二下開槍），或用鍵盤 `S` / `E`。

## 檔案結構

```
├── server.js              Express + Socket.io，房間管理、AI 排程、回合計時、裝填鎖定計時器
├── config/gameConfig.js   ★ 唯一數值來源：血量、隨機裝彈權重、道具、裝填提示秒數、DeepSeek 娘
├── logic/gameEngine.js    ★ loadAmmo() 隨機裝彈、shoot() 結算、道具效果、裝填鎖、狀態過濾
├── logic/aiLogic.js       AI 決策（看剩餘實彈/空包彈 + 自身血量；知道是空包就往自己頭上開）
├── logic/dialogue.js      ★ DeepSeek 娘的台詞庫 + getTaunt()（傲嬌／病嬌）
├── public/
│   ├── index.html         純 2D 版面：裝填提示、HUD、三欄棋盤、底部大按鈕
│   ├── style.css          霓虹 HUD、螢幕震動、血濺漸層、對話框彈出、裝填進度條
│   ├── client.js          Socket 事件、UI 渲染、把遊戲事件翻譯成演出
│   └── assets/            立繪（deepseek_girl.jpg）
└── scripts/               smoke.js、test-dialogue.js、sim2d.js、check-dom.js、e2e.js
```

> `public/scene3d.js` 與 `three` 依賴已從頁面移除（檔案還留在磁碟上，但 `index.html` 完全不載入），
> 需要時再刪掉即可。

## DeepSeek 娘（魔王）

單人模式的 AI 對手就是 **DeepSeek 娘**：畫面中央的立繪，待機時微微呼吸、光暈脈動；
被實彈打中會整張圖瞬間變紅（`sepia(1) saturate(5) hue-rotate(-50deg)`）並劇烈左右抖動，
畫面中央同時彈出紅色扣血數字。

**換圖**：把你的立繪丟進 `public/assets/`，再改 `config/gameConfig.js` 的 `DIALOGUE.PORTRAIT`
（目前預設 `deepseek_girl.jpg`）。圖片不存在時會自動換成霓虹剪影，不會破圖。

**對話**：`logic/dialogue.js` 是獨立的台詞庫，18 個情境（`onGameStart`、`onPlayerShootSelf`、
`onPlayerShootDemon`、`onDemonShoot`、`onPlayerBlank`、`onDemonHurt`、`onEmptyGun`、`onVictory`…），
每個情境 4～9 句，`getTaunt(eventType)` 隨機抽一句並記住最近 3 句避免連續重複。

引擎在開槍、換彈、用道具、勝負、回合超時時呼叫 `dialogue.getTaunt()`，
包成 `{ type: 'TAUNT', speaker: 'demon', speakerName, eventType, text }` 塞進 `actions`，
經 Socket.io 的 `game:action` 送到前端 → 對話框以打字機效果逐字彈出。

| 設定 | 意義 |
| --- | --- |
| `DIALOGUE.ENABLED` | 總開關（false = 一句都不說） |
| `DIALOGUE.SPEAKER` | 顯示名稱（預設 `DeepSeek 娘`） |
| `DIALOGUE.PORTRAIT` / `PORTRAIT_SIZE` | 立繪檔名 / 建議尺寸 |
| `DIALOGUE.CHANCE` | 每個情境各自開口機率（1 = 必說） |
| `DIALOGUE.COOLDOWN_MS` | 兩句之間最短間隔（避免洗頻） |
| `DIALOGUE.BUBBLE_MS` / `TYPE_SPEED_MS` | 對話框停留時間 / 打字速度（0 = 直接顯示） |

## 怎麼調數值（完全不動程式碼）

全在 `config/gameConfig.js`：

| 設定 | 意義 |
| --- | --- |
| `HP.START_HP` / `HP.MAX_HP` | 初始 / 最大血量 |
| `AMMO.MIN_SHELLS` / `MAX_SHELLS` | 每輪子彈總數範圍 |
| `AMMO.LIVE_WEIGHT` | 各輪實彈機率（陣列依輪次取，空包權重 = 1 − 實彈） |
| `AMMO.LIVE_VARIANCE` | 在權重上加減 1 發的機率（0 = 完全照權重） |
| `AMMO.SHELLS_PER_ROUND_BASE/STEP/JITTER` | 輪數越多，彈匣越長的節奏 |
| `AMMO.ITEMS_ON_RELOAD` | `{ BASE: 2, ESCALATE_FROM_ROUND: 3, ESCALATED: 3 }`（前兩輪 2 個、第 3 輪起 3 個） |
| `AMMO.AMMO_REVEAL` | `{ ENABLED, REVEAL_MS }`：裝填提示是否啟用 / 停幾毫秒才放行（預設 3000） |
| `AMMO.HEAL_ON_RELOAD` | 每輪開始是否回血 |
| `RULES.MIN_PLAYERS` / `MAX_PLAYERS` / `TURN_TIMEOUT_MS` | 人數與回合限時 |
| `RULES.AI.KNOWS_NEXT_SHELL` | AI 是否「偷看」下一發（調難度） |
| `ITEMS` | 道具的 id / 名稱 / 說明 / 效果 / 參數 / `keepsTurn`（用掉是否保留回合） |
| `LOOT` | 道具掉落權重 |

也可以不改檔、用環境變數覆寫：`DEVIL_START_HP`、`DEVIL_MAX_HP`、`DEVIL_MIN_SHELLS`、`DEVIL_MAX_SHELLS`、
`DEVIL_RELOAD_HEAL`、`DEVIL_REVEAL_MS`、`DEVIL_MIN_PLAYERS`、`DEVIL_MAX_PLAYERS`、`DEVIL_TURN_TIMEOUT`。

> 遊戲進行中改 config 也會在**下一次行動**立刻生效（engine 每次執行前深拷貝最新設定）。

## 隨機裝彈是怎麼隨機的

`loadAmmo(config, roundNumber)`：

1. 子彈總數：`SHELLS_PER_ROUND_BASE + (輪數-1) × STEP ± JITTER`，夾在 `MIN_SHELLS ~ MAX_SHELLS`。
2. 實彈數：以 `LIVE_WEIGHT[輪數]` 為機率做**無偏差取整**（小數部分當抽樣機率），期望值恰等於 `總數 × 權重`，再依 `LIVE_VARIANCE` 微調。
3. 保險絲：`MIN_LIVE` / `MIN_BLANK` 保證至少各一種，不會出現必死局。
4. Fisher–Yates 洗牌，預設用 `crypto.randomInt`（`SHUFFLE_MODE: 'secure'`）。

排序只在伺服器端存在；前端只拿得到「剩餘實彈 / 空包彈數量」，除非用道具（香菸、記憶、檢視…）合法偷看。

## 已驗證

- `npm run smoke`：11/11 通過（隨機裝彈範圍、權重無偏差、改 config 立即生效、洗牌多樣性、shoot 結算與自動重裝、
  狀態不洩漏、AI 對 AI 25 局全數收尾、24 種道具皆可用、**裝填提示鎖**、**每輪發 2/3 個道具**）
- `npm run dialogue`：11/11 通過（18 個情境齊全、插值正確、機率/冷卻生效、TAUNT 欄位不洩漏子彈）
- `npm run sim2d`：28/28 通過（任務 1~4 逐條驗證：3 秒鎖、第 3 輪起 3 個道具、自射空包保留回合、
  對敵人開槍必轉移、AI 知道空包就打自己、狀態欄位齊全且不含子彈順序）
- `npm run hooks`：client.js 引用的 71 個 id、CSS 鉤子、四項任務的關鍵 DOM / 事件全部對得上，
  且 **3D 殘留檢查為 0**（沒有 three.js、沒有 WebGL）
- `npm run e2e`：開局收到 `AMMO_REVEAL`（3000ms，揭曉期間被 `AMMO_REVEAL` 擋下）→ 自動發 2 個道具 →
  回合外被拒（`NOT_YOUR_TURN`）→ 無洩漏 → 開槍打完 → `game:reveal` 正常 → TAUNT 台詞確實經 Socket 送到前端
- HTTP 實測：`/`、`/style.css`、`/client.js`、`/assets/deepseek_girl.jpg`、`/api/config`、`/api/health` 全 200
"# DemonGun" 
