'use strict';

/**
 * ============================================================================
 *  logic/aiLogic.js —— 惡魔輪盤 AI 決策
 * ============================================================================
 *  AI 只看得到「合法資訊」：
 *    - 公開資訊：剩餘實彈 / 空包彈數量、各人血量、回合
 *    - 個人資訊：自己的道具、自己（透過道具取得）的預知
 *  若設定 RULES.AI.KNOWS_NEXT_SHELL = true，AI 會使用「下一發的真實機率」
 *  當作它的讀心能力；關掉它就是一個純機率判斷的對手。
 *
 *  decide(game, aiId) -> { type:'SHOOT'|'USE_ITEM', payload? }
 *  回傳的是「意圖」，實際結算一律交給 gameEngine.execute()。
 * ============================================================================
 */

const engine = require('./gameEngine');

const SHELL = engine.SHELL;

/** 下一發實彈機率低於此值 → 傾向對自己開槍 */
const SELF_SHOT_THRESHOLD = 0.5;

/** 已經連續保留回合這麼多次（連鎖數）之後，強制改打敵人，避免無限對峙 */
const MAX_CHAIN = 2;

/** 道具的「靜態分數」：決定 AI 有多想用這件道具 */
const ITEM_SCORE = {
  FIRST_AID: 90,
  CIGARETTE: 82,
  CIGARETTES: 72,
  PILLS: 55,
  DOCTOR: 40,
  BEER: 60,
  BEER2: 70,
  BEER3: 85,
  HANDSAW: 65,
  INVERTER: 68,
  MANGLER: 50,
  CHAMPAGNE: 58,
  HANDCUFFS: 60,
  BURNER: 45,
  SPEED: 42,
  ADRENALINE: 75,
  HOURGLASS: 66,
  IRONRECORD: 80,
  NAILGROUP: 55,
  GOLIATH: 35,
  BUNCH: 44,
  MEMORY: 46,
  VISION: 52,
  INSPECT: 62,
};

/**
 * 主入口：回傳 AI 這一步的意圖。
 * @param {object} game 引擎內的 game 物件（AI 在 server 進程內，所以看得到）
 * @param {string} aiId
 * @returns {{ type:'SHOOT', payload:{ targetId:string|null } } | { type:'USE_ITEM', payload:{ itemId:string } }}
 */
function decide(game, aiId) {
  const ai = engine.getPlayer(game, aiId);
  if (!ai || ai.dead) return { type: 'SHOOT', payload: { targetId: null } };

  const enemies = game.players.filter((p) => p.id !== ai.id && !p.dead);
  const total = game.chamber.length;

  // 沒有敵人就只能亂開（理論上不會走到這裡，最後一人時遊戲已結束）
  if (!enemies.length) return { type: 'SHOOT', payload: { targetId: null } };

  /* ---------------------------------------------------------------- */
  /*  ① 計算「下一發實彈」的機率                                       */
  /*    優先使用自己預知到的資訊 → 否則（若允許）使用真實下一發         */
  /* ---------------------------------------------------------------- */
  const pLive = estimateLiveChance(game, ai);

  /* ---------------------------------------------------------------- */
  /*  ② 先看道具：以預期收益挑一件「值得用」的                        */
  /* ---------------------------------------------------------------- */
  const itemMove = pickItemMove(game, ai, enemies, pLive);
  if (itemMove) return itemMove;

  /* ---------------------------------------------------------------- */
  /*  ③ 開槍決策                                                      */
  /*    空包機率高 → 對自己（拿連鎖回合）                              */
  /*    實彈機率高 → 打最殘血的敵人                                    */
  /*    - 只剩下一發、對自己開空包 = 白送（會馬上 reload）→ 改打敵人   */
  /*    AI 也會看自己已知情報／（設定允許時）真實下一發：                */
  /*    只要確定這發是空包，對自己開槍就是「零成本多打一發」。           */
  /* ---------------------------------------------------------------- */
  const selfDamage = 1 + (ai.sawnOff || 0) + (ai.nails > 0 ? 1 : 0);
  const knownNext = readKnownNextShell(game, ai); // 'LIVE' | 'BLANK' | null
  const lastShell = total === 1;

  if (knownNext === 'BLANK' && !lastShell) {
    return { type: 'SHOOT', payload: { targetId: null } };
  }

  // 連鎖過長時（一直自射空包）強制轉打敵人，避免單人局無限對峙
  if (game.turn.chain >= MAX_CHAIN) {
    const target = pickTarget(ai, enemies, pLive);
    return { type: 'SHOOT', payload: { targetId: target ? target.id : enemies[0].id } };
  }

  const wantsSelf = pLive < SELF_SHOT_THRESHOLD;
  const canSurviveSelf = pLive * selfDamage < ai.hp * 0.75;

  if (wantsSelf && canSurviveSelf && !lastShell) {
    return { type: 'SHOOT', payload: { targetId: null } };
  }

  const target = pickTarget(ai, enemies, pLive);
  return { type: 'SHOOT', payload: { targetId: target ? target.id : enemies[0].id } };
}

/* ========================================================================== */
/*  下一發實彈機率                                                           */
/* ========================================================================== */

function estimateLiveChance(game, ai) {
  const known = readKnownNextShell(game, ai);
  if (known) return known === SHELL.LIVE ? 1 : 0;

  // ③ 純機率：剩餘實彈 / 剩餘子彈
  const total = game.chamber.length;
  if (total <= 0) return 0.5;
  return game.live / total;
}

/**
 * AI 眼中「下一發」是什麼（'LIVE' / 'BLANK' / null = 不知道）。
 * ① 自己的 SHIFT 情報 → ② 設定允許時讀真實彈艙（KNOWS_NEXT_SHELL）
 */
function readKnownNextShell(game, ai) {
  const known = ai.intel.find((entry) => entry.type === 'SHIFT' && entry.shells.length > 0);
  if (known) return known.shells[0];
  if (game.config.RULES.AI.KNOWS_NEXT_SHELL && game.chamber.length) return game.chamber[0];
  return null;
}

/* ========================================================================== */
/*  開槍目標                                                                  */
/* ========================================================================== */

function pickTarget(ai, enemies, pLive) {
  if (pLive <= 0) return enemies[0];

  return enemies
    .slice()
    .sort((a, b) => {
      // 殘血優先；血量相同時，用滿血的先（避免集火但溢出）
      const hpDiff = a.hp - b.hp;
      if (hpDiff !== 0) return hpDiff;
      return a.maxHp - b.maxHp;
    })[0];
}

/* ========================================================================== */
/*  道具決策                                                                  */
/* ========================================================================== */

/**
 * 已經「拿在手上」的道具本回合最多連續使用次數。
 * 沒有上限的話，AI 可能一直抽到新道具（BUNCH / PILLS）而永遠不開槍。
 */
const MAX_ITEMS_PER_TURN = 3;

function pickItemMove(game, ai, enemies, pLive) {
  // itemsThisTurn 由引擎在每回合開始時歸零（見 gameEngine 的 turnStartTracking）
  const used = ai.itemsThisTurn || 0;
  if (used >= MAX_ITEMS_PER_TURN) return null;

  const options = [];
  const bloodied = ai.hp < ai.maxHp;
  const dying = ai.hp <= 1;

  for (const itemId of new Set(ai.items)) {
    const item = game.config.ITEMS.find((it) => it.id === itemId);
    if (!item) continue;
    const score = scoreItem(game, ai, enemies, item, pLive, { bloodied, dying });
    if (score > 0) options.push({ itemId, score });
  }

  if (!options.length) return null;

  // 同一件道具連續用兩次幾乎沒有意義（治療、預知、連發都一樣）
  const lastUsed = ai.lastItemId || null;
  options.sort((a, b) => {
    if (a.itemId === lastUsed && b.itemId !== lastUsed) return 1;
    if (b.itemId === lastUsed && a.itemId !== lastUsed) return -1;
    return b.score - a.score;
  });
  return { type: 'USE_ITEM', payload: { itemId: options[0].itemId } };
}

/**
 * 給定道具在「現在这个局面」的分數；<= 0 表示 AI 現在不想用。
 */
function scoreItem(game, ai, enemies, item, pLive, mood) {
  const base = ITEM_SCORE[item.id] ?? 0;
  const pBlank = 1 - pLive;
  const params = item.params || {};

  switch (item.effect) {
    case 'heal':
    case 'randomHeal':
      return mood.bloodied ? base : 0;

    case 'gambleHeal':
      // 只有快死時才賭
      return mood.dying ? base : 0;

    case 'cutBarrel': {
      // 只有在確定實彈、而且目標血夠厚時才鋸
      const target = pickTarget(ai, enemies, pLive);
      return pLive > 0.7 && target && target.hp > (params.DAMAGE ?? 1) ? base : 0;
    }

    case 'invert':
      // 有預知時才值得；知道自己拿到實彈就反轉
      return ai.intel.some((e) => e.type === 'SHIFT' && e.shells.length) ? base : 0;

    case 'peek':
    case 'peekMany':
      return game.chamber.length > 1 ? base : 0;

    case 'eject':
    case 'ejectRandom':
      return game.chamber.length > 1 ? base : 0;

    case 'ejectAndShoot':
      return game.chamber.length > 1 ? base : 0;

    case 'rapidFire':
      // 只有在空包比例高時才連發，避免自爆
      return pBlank >= 0.5 ? base : Math.round(base * 0.4);

    case 'memory':
    case 'memoryAll':
      return game.chamber.length <= 2 ? base : Math.round(base * 0.6);

    case 'stealTurn':
      return ai.usedNoCostThisTurn ? 0 : base;

    case 'extraTurn':
      return ai.usedNoCostThisTurn ? 0 : base;

    case 'skipNext':
      return game.players.filter((p) => !p.dead).length > 2 || enemies.length ? base : 0;

    case 'gacha':
      return ai.items.length < game.config.LIMITS.MAX_ITEMS ? base : 0;

    case 'nailGun':
      return pLive > 0.55 ? base : 0;

    case 'maxHpUp':
      return ai.hp > 2 && ai.maxHp < game.config.HP.MAX_HP ? base : 0;

    default:
      return base;
  }
}

/* ========================================================================== */
/*  給 server 的輔助：AI 思考延遲                                             */
/* ========================================================================== */

function thinkDelay(game) {
  const cfg = (game && game.config.RULES.AI.THINK_DELAY_MS) || { min: 600, max: 1200 };
  return cfg.min + Math.floor(Math.random() * Math.max(1, cfg.max - cfg.min));
}

module.exports = { decide, thinkDelay, estimateLiveChance, pickTarget, scoreItem };
