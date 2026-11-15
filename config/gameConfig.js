'use strict';

/**
 * ============================================================================
 *  惡魔輪盤《DEVIL ROULETTE》 遊戲設定檔（唯一資料來源 / Single Source of Truth）
 * ============================================================================
 *  - 所有玩法數值都在這裡；遊戲邏輯（logic/*.js）只是「讀資料」的執行器。
 *  - cost / damage / heal 額外支援 { min, max } 區間型別，由 gameEngine 解析。
 *  - 前端透過 socket 的 'config' 事件拿到這份設定（只會傳公開資訊），
 *    因此調整這裡的數字，前後端會同步生效，不需要改任何程式碼。
 *  - 若要以環境變數覆寫單一數值：DEVIL_MIN_SHELLS=3 node server.js
 *    （環境變數名稱 → 路徑對照見下方 ENV_OVERRIDES）
 * ============================================================================
 */

const GAME_CONFIG = {
  /** 存檔 / 版本識別（升版時前端可據此顯示提示） */
  VERSION: '1.0.0',

  /* ------------------------------------------------------------------------ */
  /*  1. 血量                                                                 */
  /* ------------------------------------------------------------------------ */
  HP: {
    START_HP: 4,          // 初始血量
    MAX_HP: 6,            // 血量上限（急救包 / 生命上限道具不得超過它）
    START_MAX_HP: 4,      // 初始的「上限」，可透過道具提升到 MAX_HP
  },

  /* ------------------------------------------------------------------------ */
  /*  2. 隨機裝彈（核心）                                                     */
  /*     loadAmmo() 完全依照這段設定產生子彈，沒有任何寫死的子彈數量。         */
  /* ------------------------------------------------------------------------ */
  AMMO: {
    MIN_SHELLS: 2,        // 每一輪最少子彈總數
    MAX_SHELLS: 8,        // 每一輪最多子彈總數

    // 實彈機率權重（依當前「第幾輪」取一組；超過長度時沿用最後一組）。
    // 空包彈權重 = 1 - LIVE_WEIGHT，因此兩者必為 0.01 ~ 0.99 之間的互補值。
    // 例：5~7 發時通常 2 實 3 空 → 空包彈多 → 對自己開槍划算。
    LIVE_WEIGHT: [0.5, 0.4, 0.4, 0.35, 0.35, 0.3, 0.3, 0.3, 0.25, 0.25],

    // 保險絲：確保每輪至少各一種子彈，避免出現 100% 實彈的必死局
    MIN_LIVE: 1,
    MIN_BLANK: 1,

    // 額外變異：在權重決定的實彈數上加減 1（0 = 完全照權重）
    LIVE_VARIANCE: 0.25,

    // 子彈總數 = 基礎數 + (輪數 - 1) × 每輪增量，並夾在 MIN/MAX 之間
    SHELLS_PER_ROUND_BASE: 2,
    SHELLS_PER_ROUND_STEP: 1,
    SHELLS_PER_ROUND_JITTER: 1, // 額外隨機 ±N 發，讓節奏不可預測

    // 洗牌：'secure' = crypto.randomInt（真亂數，預設）；'math' = Math.random
    SHUFFLE_MODE: 'secure',

    // true = 重新裝彈時補滿血（Buckshot Roulette 式「換輪回血」）
    HEAL_ON_RELOAD: true,

    // 換輪後自動發放的道具數量（任務 2）：
    //   BASE = 每次裝彈發幾個；ESCALATE_FROM_ROUND = 從第幾輪起改用 ESCALATED
    //   另外道具總數上限 = LIMITS.MAX_ITEMS（超過就發不進去）
    ITEMS_ON_RELOAD: { BASE: 2, ESCALATE_FROM_ROUND: 3, ESCALATED: 3 },

    // 開局彈藥提示（任務 1）：每一輪開始時，前端在畫面中央顯示「本回合裝填」，
    // 倒數 REVEAL_MS 毫秒後才開放行動（伺服器同時鎖住指令，時間到自動解鎖）。
    AMMO_REVEAL: { ENABLED: true, REVEAL_MS: 3000 },
  },

  /* ------------------------------------------------------------------------ */
  /*  3. 遊戲流程 / 回合規則                                                  */
  /* ------------------------------------------------------------------------ */
  RULES: {
    MIN_PLAYERS: 1,          // 1 = 可單人快速對戰
    MAX_PLAYERS: 4,
    HUMAN_ONLY: false,       // true = 多人對戰時不補 AI
    // 第一個名字會被 addAI() 優先使用 → 單人模式固定叫「DeepSeek 娘」
    ENEMY_NAMES: ['DeepSeek 娘', '惡魔荷官', '深淵投注者', '血債收藏家', '紅月莊家'],
    TURN_TIMEOUT_MS: 60000,  // 超過時間自動行動
    AI: {
      ENABLED: true,
      THINK_DELAY_MS: { min: 700, max: 1600 },
      // AI 使用「上帝視角」的真實下一發機率；設更高值可讓 AI 更弱
      KNOWS_NEXT_SHELL: true,
    },
  },

  /* ------------------------------------------------------------------------ */
  /*  4. 道具（資料驅動；前端道具說明完全由這裡生成）                         */
  /*  params 語意：                                                           */
  /*    shots      ：連開 n 槍                                                */
  /*    shotsAfter ：首次扣血後，接下來 n 槍必定實彈（會更痛）                 */
  /*    chance     ：生效機率                                                 */
  /*    hp         ：治療量 / 代價                                            */
  /*    min,max    ：區間型別道具共用鍵                                       */
  /*  keepsTurn：使用後不交給下一位（預設 false；task m01719 明確要求           */
  /*            「用了道具才耗回合」以外的道具都要留回合給自己）               */
  /* ------------------------------------------------------------------------ */
  ITEMS: [
    { id: 'CIGARETTE',   name: '香菸',     icon: '🚬', desc: '回復 {HP} 點生命。',                       effect: 'heal',      params: { HP: 1 }, keepsTurn: true },
    { id: 'FIRST_AID',   name: '急救包',   icon: '💊', desc: '回復 {HP} 點生命。',                       effect: 'heal',      params: { HP: 2 }, keepsTurn: true },
    { id: 'CIGARETTES',  name: '整包菸',   icon: '🧊', desc: '回復 {MIN}～{MAX} 點生命。',               effect: 'heal',      params: { MIN: 1, MAX: 3 }, keepsTurn: true },
    { id: 'PILLS',       name: '興奮劑',   icon: '💉', desc: '{CHANCE}% 機率回復 {MIN}～{MAX} 點生命。', effect: 'randomHeal', params: { CHANCE: 50, MIN: 2, MAX: 4 }, keepsTurn: true },
    { id: 'ADRENALINE',  name: '腎上腺素', icon: '⚡', desc: '1 秒內強制搶走對手的回合（AI 會毫不留情）。', effect: 'stealTurn',  params: { DURATION_MS: 1000 } },
    { id: 'HANDSAW',     name: '手鋸',     icon: '🪚', desc: '鋸短槍管：下一次開槍造成 {DAMAGE} 傷害。',  effect: 'cutBarrel',  params: { DAMAGE: 2, DURATION_TURNS: 1 }, keepsTurn: true },
    { id: 'MANGLER',     name: '萬能工具', icon: '🔧', desc: '取出並公開現在這發子彈。',                 effect: 'peek', keepsTurn: true },
    { id: 'BURNER',      name: '燒錄機',   icon: '📱', desc: '燒掉現在這發子彈，不造成任何效果。',       effect: 'eject', keepsTurn: true },
    { id: 'CHAMPAGNE',   name: '香檳',     icon: '🍾', desc: '拆卸槍管，公開接下來 {COUNT} 發子彈並在擊發前裝回。', effect: 'peekMany', params: { COUNT: 2 }, keepsTurn: true },
    { id: 'BEER',        name: '啤酒',     icon: '🍺', desc: '退出現在這發子彈並公開，然後發射。',      effect: 'ejectAndShoot' },
    { id: 'BEER2',       name: '烈酒',     icon: '🥃', desc: '連續發射 {SHOTS} 發子彈（每發照常結算）。', effect: 'rapidFire', params: { SHOTS: 2 } },
    { id: 'BEER3',       name: '套裝酒',   icon: '🍶', desc: '連續發射 {SHOTS} 發子彈。',               effect: 'rapidFire', params: { SHOTS: 3 } },
    { id: 'SPEED',       name: '加速器',   icon: '⏩', desc: '隨機取出一發子彈（{MIN}～{MAX} 發）並公開。', effect: 'ejectRandom', params: { MIN: 1, MAX: 2 }, keepsTurn: true },
    { id: 'GOLIATH',     name: '巨人',     icon: '🦍', desc: '扣 {HP} 點生命，換取最大生命 +{MAX_HP}。', effect: 'maxHpUp',   params: { HP: 1, MAX_HP: 1 }, keepsTurn: true },
    { id: 'HANDCUFFS',   name: '手銬',     icon: '⛓️', desc: '銬住對手：對手下一回合被跳過。',          effect: 'skipNext',  params: { SKIPS: 1 }, keepsTurn: true },
    { id: 'NAILGROUP',   name: '釘槍',     icon: '🔫', desc: '負荷最重：之後 {SHOTS} 發子彈都造成 {DAMAGE} 傷害。', effect: 'nailGun', params: { SHOTS: 3, DAMAGE: 2 }, keepsTurn: true },
    { id: 'INVERTER',    name: '逆轉器',   icon: '🔄', desc: '反轉現在這發子彈（實↔空）；換輪時失效。', effect: 'invert', keepsTurn: true },
    { id: 'BUNCH',       name: '驚喜包',   icon: '🎁', desc: '隨機抽 {SHOTS} 個道具。',                  effect: 'gacha',      params: { SHOTS: 3 }, keepsTurn: true },
    { id: 'DOCTOR',      name: '醫生',     icon: '🩺', desc: '{CHANCE}% 機率回復 {MIN}～{MAX} 點，否則扣 {HP} 點生命。', effect: 'gambleHeal', params: { CHANCE: 50, MIN: 2, MAX: 4, HP: 1 }, keepsTurn: true },
    { id: 'MEMORY',      name: '記憶藥水', icon: '🧠', desc: '記下「下一輪」至少 {COUNT} 發子彈（僅你自己看得到）。', effect: 'memory', params: { COUNT: 2 }, keepsTurn: true },
    { id: 'HOURGLASS',   name: '沙漏',     icon: '⏳', desc: '額外獲得一回合（{CHANCE}% 機率）。',      effect: 'extraTurn',  params: { CHANCE: 50 } },
    { id: 'IRONRECORD',  name: '鐵唱片',   icon: '💿', desc: '絕對獲得額外一回合。',                     effect: 'extraTurn',  params: { CHANCE: 100 } },
    { id: 'INSPECT',     name: '透視符',   icon: '🔮', desc: '預知下一輪所有子彈的順序（僅你自己看得到）。', effect: 'memoryAll', params: { COUNT: 99 }, keepsTurn: true },
    { id: 'VISION',      name: '預言鏡',   icon: '👁️', desc: '預知下一輪前 {COUNT} 發子彈的順序（僅你自己看得到）。', effect: 'memory', params: { COUNT: 4 }, keepsTurn: true },
  ],

  /* ------------------------------------------------------------------------ */
  /*  5. 道具掉落機率                                                         */
  /*  mode: 'weights' 依 WEIGHTS 表隨機；'uniform' 每件等機率；'boss' 不發        */
  /* ------------------------------------------------------------------------ */
  LOOT: {
    DEFAULT: {
      mode: 'weights',
      WEIGHTS: {
        CIGARETTE: 10, FIRST_AID: 9, CIGARETTES: 7, BEER: 9, HANDSAW: 8,
        MANGLER: 7, BURNER: 8, INVERTER: 7, CHAMPAGNE: 6, HANDCUFFS: 6,
        SPEED: 6, PILLS: 5, ADRENALINE: 4, BEER2: 5, BEER3: 3,
        GOLIATH: 3, NAILGROUP: 3, BUNCH: 4, DOCTOR: 4, MEMORY: 3,
        HOURGLASS: 4, IRONRECORD: 2, INSPECT: 2, VISION: 3,
      },
      EXCLUDE: [],
    },
    // 給「玩家方」的掉落表；省略則沿用 DEFAULT
    PLAYER: null,
    // 給「敵方」的掉落表；省略則沿用 DEFAULT
    ENEMY: null,
  },

  /* ------------------------------------------------------------------------ */
  /*  6. 道具欄容量 / 同時生效上限                                            */
  /* ------------------------------------------------------------------------ */
  LIMITS: {
    MAX_ITEMS: 8,                  // 每人最多持有道具數
    MAX_ACTIVE_MODIFIERS: 3,       // 同時生效的增益（手鋸 / 逆轉器 / 釘槍）
    BARRAGE_WINDOW_MS: 2000,       // 連發型道具（啤酒系列）允許的發射間隔
    DEFAULT_SHOT_DELAY: 10000,     // 沒有 duration 的道具，效果持續這麼久
  },

  /* ------------------------------------------------------------------------ */
  /*  7. 節奏與演出時序                                                       */
  /* ------------------------------------------------------------------------ */
  TIMING: {
    ROOM_CODE_LENGTH: 4,
    RECONNECT_GRACE_MS: 15000,
    GAME_SWITCH_DELAY_MS: 1400,
    RESULT_REVEAL_DELAY_MS: 900,
  },

  /* ------------------------------------------------------------------------ */
  /*  8. 前端視覺特效（純資料，稍具 jQuery-is-a-polyfill 的調味）            */
  /* ------------------------------------------------------------------------ */
  FX: {
    SHAKE_MS: 420,                 // 開槍震動時長
    SHAKE_INTENSITY: 12,           // 震動幅度（px）
    BLOOD_PARTICLES: 22,           // 血液粒子數量
    BLOOD_COLORS: ['#b3000f', '#e01b24', '#5c0006', '#ff5d5d'],
    SHELL_LIVE_COLOR: '#ff2d55',
    SHELL_BLANK_COLOR: '#3aa0ff',
    SCREEN_FLASH_ALPHA: 0.45,
  },

  /* ------------------------------------------------------------------------ */
  /*  9. DeepSeek 娘：立繪 / 對話 / 演出節奏（台詞內容在 logic/dialogue.js）    */
  /* ------------------------------------------------------------------------ */
  DIALOGUE: {
    ENABLED: true,                       // 關掉就完全不出現嘲諷台詞
    SPEAKER: 'DeepSeek 娘',              // 對話框上的名字（沒有 AI 座位時的預設稱呼）
    PORTRAIT: 'deepseek_girl.png',       // public/ 底下的立繪檔名（使用者自行放入）
    PORTRAIT_SIZE: 300,                  // 立繪大小（px，桌機；小螢幕會自動縮小）
    BUBBLE_MS: 4600,                     // 台詞停留時間（毫秒）
    TYPE_SPEED_MS: 24,                   // 打字機速度（毫秒/字，0 = 直接顯示）
    COOLDOWN_MS: 900,                    // 兩句台詞最短間隔，避免洗頻

    // 各種情境「願意開口」的機率（0~1）。沒列出的情境用 DEFAULT_CHANCE。
    DEFAULT_CHANCE: 0.55,
    CHANCE: {
      onGameStart: 1,
      onPlayerShootSelf: 0.6,
      onPlayerShootDemon: 0.6,
      onDemonShoot: 0.6,
      onDemonShootSelf: 0.5,
      onPlayerBlank: 0.65,
      onDemonBlank: 0.55,
      onDemonHurt: 0.75,
      onPlayerHurt: 0.45,
      onPlayerDeath: 1,
      onDemonDeath: 1,
      onItemUsed: 0.3,
      onDemonItem: 0.3,
      onReload: 0.5,
      onEmptyGun: 0.5,
      onIdle: 0.4,
      onVictory: 1,
      onDefeat: 1,
    },
  },
};

/* ========================================================================== */
/*  工具：深層凍結，避免執行期意外改動設定                                     */
/* ========================================================================== */
function deepFreeze(obj) {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(obj);
}

/* ========================================================================== */
/*  工具：環境變數覆寫（方便玩家自己調數值，不用改檔）                         */
/* ========================================================================== */
const ENV_OVERRIDES = {
  DEVIL_START_HP: ['HP', 'START_HP'],
  DEVIL_MAX_HP: ['HP', 'MAX_HP'],
  DEVIL_MIN_SHELLS: ['AMMO', 'MIN_SHELLS'],
  DEVIL_MAX_SHELLS: ['AMMO', 'MAX_SHELLS'],
  DEVIL_RELOAD_HEAL: ['AMMO', 'HEAL_ON_RELOAD'],
  DEVIL_MIN_PLAYERS: ['RULES', 'MIN_PLAYERS'],
  DEVIL_MAX_PLAYERS: ['RULES', 'MAX_PLAYERS'],
  DEVIL_TURN_TIMEOUT: ['RULES', 'TURN_TIMEOUT_MS'],
  DEVIL_REVEAL_MS: ['AMMO', 'AMMO_REVEAL', 'REVEAL_MS'], // 0 = 關掉開局彈藥鎖（測試用）
};

function applyEnvOverrides(config) {
  for (const [envName, path] of Object.entries(ENV_OVERRIDES)) {
    const raw = process.env[envName];
    if (raw === undefined || raw === '') continue;
    const target = path.slice(0, -1).reduce((node, key) => node[key], config);
    const key = path[path.length - 1];
    if (typeof target[key] === 'boolean') target[key] = raw === 'true' || raw === '1';
    else {
      const num = Number(raw);
      if (Number.isFinite(num)) target[key] = num;
    }
  }
}

/* ========================================================================== */
/*  工具：道具說明文字（用 params 填空）                                      */
/* ========================================================================== */
function describeItem(item) {
  const params = item.params || {};
  return String(item.desc || '').replace(/\{([A-Z_]+)\}/g, (whole, key) => {
    const value = params[key];
    return value === undefined ? whole : String(value);
  });
}

/** 公開給前端的道具資料（不含任何需要保密的内容） */
function publicItems() {
  return GAME_CONFIG.ITEMS.map((item) => ({
    id: item.id,
    name: item.name,
    icon: item.icon || '❓',
    desc: describeItem(item),
    effect: item.effect,
    params: item.params || {},
  }));
}

const ITEM_BY_ID = Object.fromEntries(GAME_CONFIG.ITEMS.map((item) => [item.id, item]));

/**
 * 組出要送給前端的設定。
 * @param {boolean} exposeLoot 是否把掉落權重表也送上（前端用來顯示稀有度）
 */
function getClientConfig(exposeLoot = true) {
  return {
    VERSION: GAME_CONFIG.VERSION,
    HP: { ...GAME_CONFIG.HP },
    AMMO: {
      MIN_SHELLS: GAME_CONFIG.AMMO.MIN_SHELLS,
      MAX_SHELLS: GAME_CONFIG.AMMO.MAX_SHELLS,
      MIN_LIVE: GAME_CONFIG.AMMO.MIN_LIVE,
      MIN_BLANK: GAME_CONFIG.AMMO.MIN_BLANK,
      HEAL_ON_RELOAD: GAME_CONFIG.AMMO.HEAL_ON_RELOAD,
      ITEMS_ON_RELOAD: { ...GAME_CONFIG.AMMO.ITEMS_ON_RELOAD },
      AMMO_REVEAL: { ...GAME_CONFIG.AMMO.AMMO_REVEAL },
    },
    RULES: {
      MIN_PLAYERS: GAME_CONFIG.RULES.MIN_PLAYERS,
      MAX_PLAYERS: GAME_CONFIG.RULES.MAX_PLAYERS,
      HUMAN_ONLY: GAME_CONFIG.RULES.HUMAN_ONLY,
      TURN_TIMEOUT_MS: GAME_CONFIG.RULES.TURN_TIMEOUT_MS,
    },
    ITEMS: publicItems(),
    LOOT: exposeLoot
      ? {
          DEFAULT: {
            mode: GAME_CONFIG.LOOT.DEFAULT.mode,
            WEIGHTS: { ...(GAME_CONFIG.LOOT.DEFAULT.WEIGHTS || {}) },
          },
        }
      : null,
    LIMITS: { ...GAME_CONFIG.LIMITS },
    TIMING: {
      RECONNECT_GRACE_MS: GAME_CONFIG.TIMING.RECONNECT_GRACE_MS,
      GAME_SWITCH_DELAY_MS: GAME_CONFIG.TIMING.GAME_SWITCH_DELAY_MS,
      RESULT_REVEAL_DELAY_MS: GAME_CONFIG.TIMING.RESULT_REVEAL_DELAY_MS,
    },
    FX: { ...GAME_CONFIG.FX },
    DIALOGUE: {
      ENABLED: GAME_CONFIG.DIALOGUE.ENABLED,
      SPEAKER: GAME_CONFIG.DIALOGUE.SPEAKER,
      PORTRAIT: GAME_CONFIG.DIALOGUE.PORTRAIT,
      PORTRAIT_SIZE: GAME_CONFIG.DIALOGUE.PORTRAIT_SIZE,
      BUBBLE_MS: GAME_CONFIG.DIALOGUE.BUBBLE_MS,
      TYPE_SPEED_MS: GAME_CONFIG.DIALOGUE.TYPE_SPEED_MS,
      // 不送 COOLDOWN / 機率表：那是伺服器端的節奏控制，前端不需要（也不該知道）
    },
  };
}

const IS_SERVER = typeof window === 'undefined';

// 先在未凍結的物件上套用環境變數覆寫，最後才整份凍結
if (IS_SERVER) applyEnvOverrides(GAME_CONFIG);

/**
 * 匯出策略：
 *   - 伺服器端：module.exports 就是遊戲設定本身（物件），並掛上設定工具函式。
 *     用法：const GAME_CONFIG = require('./config/gameConfig');
 *          GAME_CONFIG.HP.START_HP / GAME_CONFIG.getClientConfig()
 *   - 前端（若以 <script> 引入）：window.DEVIL_CONFIG.getClientConfig()
 */
const API = {
  describeItem,
  publicItems,
  getItem: (id) => ITEM_BY_ID[id] || null,
  getClientConfig,
  deepCloneConfig: () => JSON.parse(JSON.stringify(GAME_CONFIG)),
};

function attachApi(target) {
  for (const [key, fn] of Object.entries(API)) {
    Object.defineProperty(target, key, { value: fn, enumerable: false, configurable: false, writable: false });
  }
  return target;
}

if (IS_SERVER) {
  // 先掛 API 再凍結：凍結後任何人都無法在執行期改寫數值
  module.exports = deepFreeze(attachApi(GAME_CONFIG));
} else {
  // eslint-disable-next-line no-undef
  window.DEVIL_CONFIG = attachApi(GAME_CONFIG);
}
