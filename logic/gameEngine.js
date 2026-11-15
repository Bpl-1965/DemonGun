'use strict';

/**
 * ============================================================================
 *  logic/gameEngine.js —— 惡魔輪盤核心引擎（純邏輯，不碰 socket / DOM）
 * ============================================================================
 *  設計原則
 *  1. 資料驅動：子彈數量、實彈比例、血量、道具全部從 config 推導。
 *     引擎會「深拷貝」傳入的設定，且每次 execute() 前同步一次，因此
 *     改 config.AMMO.MIN_SHELLS 立刻影響下一輪洗牌 —— 證明沒有寫死。
 *  2. 點擊與演出分離：execute() 回傳 actions，server / 前端只負責播放。
 *     action.type === 'SHOT' 就是一次「開槍演出」。
 *  3. 洩漏防護：getStateFor(playerId) 只給「剩餘實彈 / 空包彈數量」，
 *     順序只有在遊戲結束（getRevealedChamber）或玩家用道具才會看到。
 *  4. 同步、可注入 rng / randomInt / now，方便寫測試。
 *
 *  game 物件（createGame 產生，會被就地修改）
 *  {
 *    id, config, rng, randomInt, now,
 *    phase: 'waiting' | 'playing' | 'gameover',
 *    round, players[], turn: { activeId, chain, barrage, skips },
 *    chamber[]   子彈陣列；chamber[0] 是「槍口裡的那一發」（玩家不可見）
 *    live, blank 剩餘實彈 / 空包彈數量（公開）
 *    log[], version, winnerId
 *  }
 * ============================================================================
 */

const crypto = require('node:crypto');
const SHARED_CONFIG = require('../config/gameConfig');
const dialogue = require('./dialogue');

const SHELL = Object.freeze({ LIVE: 'LIVE', BLANK: 'BLANK' });

/* ========================================================================== */
/*  小工具                                                                    */
/* ========================================================================== */

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function secureRandomInt(min, maxInclusive) {
  return crypto.randomInt(min, maxInclusive + 1);
}

function mathRandomInt(min, maxInclusive) {
  return min + Math.floor(Math.random() * (maxInclusive - min + 1));
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

/** 把設定值解析成整數區間：number | [a, b] | { min, max } */
function rangeOf(spec, fallback = 0) {
  if (typeof spec === 'number') return { min: spec, max: spec };
  if (Array.isArray(spec)) {
    const [a, b = a] = spec;
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  if (spec && typeof spec === 'object' && (spec.min !== undefined || spec.max !== undefined)) {
    const a = spec.min ?? spec.max ?? fallback;
    const b = spec.max ?? spec.min ?? fallback;
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  if (spec && typeof spec === 'object' && (spec.BASE !== undefined || spec.ESCALATED !== undefined)) {
    const a = spec.BASE ?? spec.ESCALATED ?? fallback;
    const b = spec.ESCALATED ?? spec.BASE ?? fallback;
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  return { min: fallback, max: fallback };
}

/* ========================================================================== */
/*  0. DeepSeek 娘：台詞產生器                                                */
/*     台詞內容在 logic/dialogue.js；「要不要開口」的機率與冷卻在             */
/*     config.DIALOGUE（資料驅動）。這裡只把它包成一個 TAUNT action。          */
/* ========================================================================== */

/** 找出這局的「魔王」座位（AI）。沒有 AI 時回 null → 台詞由「荷官」發言。 */
function demonPlayer(game) {
  return game.players.find((p) => p.isAI) || null;
}

function demonName(game) {
  const demon = demonPlayer(game);
  const D = game.config.DIALOGUE || {};
  return (demon && demon.name) || D.SPEAKER || 'DeepSeek 娘';
}

/**
 * 依情境抽一句台詞，成功則回傳可直接 push 進 actions 的 TAUNT 物件。
 * 失敗（沒開、機率沒過、冷卻中、沒台詞）一律回 null。
 */
function tauntAction(game, eventType, vars) {
  const D = game.config.DIALOGUE || {};
  if (!eventType || D.ENABLED === false) return null;

  const now = game.now();
  const cooldown = Number(D.COOLDOWN_MS) || 0;
  if (game._tauntAt && now - game._tauntAt < cooldown) return null;

  const chance =
    D.CHANCE && typeof D.CHANCE[eventType] === 'number'
      ? D.CHANCE[eventType]
      : (typeof D.DEFAULT_CHANCE === 'number' ? D.DEFAULT_CHANCE : 1);

  const demon = demonPlayer(game);
  const text = dialogue.getTaunt(eventType, {
    rng: game.rng,
    chance,
    vars: { demon: demonName(game), ...(vars || {}) },
  });
  if (!text) return null;

  game._tauntAt = now;
  return {
    type: 'TAUNT',
    speaker: 'demon',
    speakerId: demon ? demon.id : null,
    speakerName: demonName(game),
    eventType,
    text,
  };
}

/** 一句開槍台詞：依「誰射誰 / 打中 / 死亡」挑最合適的情境 */
function tauntForShot(game, shooter, target, res) {
  const action = res.action;
  const vars = { player: shooter.name, damage: action.damage, hp: target.hp };

  if (action.targetDead) {
    return tauntAction(game, target.isAI ? 'onDemonDeath' : 'onPlayerDeath', vars);
  }
  if (target.isAI && action.damage > 0) return tauntAction(game, 'onDemonHurt', vars);
  if (shooter.isAI && !target.isAI && action.damage > 0) return tauntAction(game, 'onPlayerHurt', vars);

  if (shooter.isAI) {
    if (res.selfShot) {
      return tauntAction(game, res.result === SHELL.BLANK ? 'onDemonBlank' : 'onDemonShootSelf', vars);
    }
    return tauntAction(game, res.result === SHELL.BLANK ? 'onDemonBlank' : 'onDemonShoot', vars);
  }

  if (res.selfShot) return tauntAction(game, 'onPlayerShootSelf', vars);
  if (res.result === SHELL.BLANK) return tauntAction(game, 'onPlayerBlank', vars);
  return tauntAction(game, 'onPlayerShootDemon', vars);
}

/* ========================================================================== */
/*  1. loadAmmo() —— 隨機裝彈（本專案唯一決定子彈內容的地方）                  */
/* ========================================================================== */

/**
 * 依 config.AMMO 產生一輪全新的、已洗牌的子彈陣列。
 * 純函式：不修改設定的其他部分，只回傳結果，由 reload() 套用到遊戲。
 *
 * @param {object} config       gameConfig（或其深拷貝）
 * @param {number} roundNumber  從 1 開始的輪數
 * @param {object} [io]         { randomInt(min,max), rng() }
 * @returns {{ chamber:string[], live:number, blank:number, total:number, liveWeight:number }}
 */
function loadAmmo(config, roundNumber = 1, io = {}) {
  const A = config.AMMO;
  const randomInt = io.randomInt || mathRandomInt;
  const rng = io.rng || Math.random;
  const round = Math.max(1, Number(roundNumber) || 1);

  /* --- ① 這一輪的總彈數（由設定推算 + 少量隨機） --- */
  const step = A.SHELLS_PER_ROUND_STEP ?? 0;
  const jitter = A.SHELLS_PER_ROUND_JITTER ?? 0;
  const base = (A.SHELLS_PER_ROUND_BASE ?? A.MIN_SHELLS) + (round - 1) * step;
  const lower = clamp(base - jitter, A.MIN_SHELLS, A.MAX_SHELLS);
  const upper = clamp(base + jitter, A.MIN_SHELLS, A.MAX_SHELLS);
  const total = randomInt(lower, upper);

  /* --- ② 依權重決定實彈數 --- */
  const weightSpec = A.LIVE_WEIGHT;
  const rawWeight = Array.isArray(weightSpec)
    ? weightSpec[Math.min(round - 1, weightSpec.length - 1)]
    : typeof weightSpec === 'number'
      ? weightSpec
      : 0.5;
  const liveWeight = clamp(Number(rawWeight) || 0.5, 0.01, 0.99);

  // 可用的實彈數區間（保險絲：每輪至少各一種，避免 100% 實彈的必死局）
  const minLive = A.MIN_LIVE ?? 1;
  const minBlank = A.MIN_BLANK ?? 1;
  const lowLive = Math.min(minLive, total - 1);
  const highLive = Math.max(lowLive, total - minBlank);

  /*
   * 用「逐發抽樣」讓期望值恰好等於權重：
   *  期望實彈 = total × liveWeight（再夾到 [lowLive, highLive]）
   *  隨機法：floor(x) 或 ceil(x)，以 x 的小數部分為機率 → 無偏差
   * 另外以 LIVE_VARIANCE 的機率 ±1 做額外抖動，讓每輪長得不一樣。
   */
  const targetLive = clamp(total * liveWeight, lowLive, highLive);
  const baseLive = Math.floor(targetLive);
  let liveCount = baseLive + (rng() < targetLive - baseLive ? 1 : 0);

  const variance = Number(A.LIVE_VARIANCE ?? 0);
  if (variance > 0 && rng() < variance && liveCount > lowLive && liveCount < highLive) {
    liveCount += rng() < 0.5 ? -1 : 1;
  }
  liveCount = clamp(liveCount, lowLive, highLive);
  const blankCount = total - liveCount;

  /* --- ③ 組陣列 + Fisher–Yates 洗牌 --- */
  const chamber = [];
  for (let i = 0; i < total; i++) chamber.push(i < liveCount ? SHELL.LIVE : SHELL.BLANK);

  const useMathRandom = A.SHUFFLE_MODE === 'math';
  for (let i = chamber.length - 1; i > 0; i--) {
    const j = useMathRandom ? mathRandomInt(0, i) : randomInt(0, i);
    const tmp = chamber[i];
    chamber[i] = chamber[j];
    chamber[j] = tmp;
  }

  return { chamber, live: liveCount, blank: blankCount, total, liveWeight };
}

/* ========================================================================== */
/*  2. 建立遊戲                                                               */
/* ========================================================================== */

/**
 * @param {object} params
 * @param {string} params.id
 * @param {string[]} params.players    player id 陣列（順序 = 輪轉順序）
 * @param {object} [params.config]     設定（預設 config/gameConfig.js）
 * @param {object} [params.names]      { [id]: 顯示名稱 }
 * @param {object} [params.flags]      { [id]: { isAI, isBoss } }
 * @param {object} [params.io]         { randomInt, rng, now }
 */
function createGame({ id, players, config = SHARED_CONFIG, names = {}, flags = {}, io = {} }) {
  const gameConfig = deepClone(config);
  const useSecure = gameConfig.AMMO.SHUFFLE_MODE !== 'math';
  const randomInt = io.randomInt || (useSecure ? secureRandomInt : mathRandomInt);
  const rng = io.rng || Math.random;
  const now = io.now || Date.now;

  const startMax = gameConfig.HP.START_MAX_HP ?? gameConfig.HP.START_HP;

  const game = {
    id,
    config: gameConfig,
    rng,
    randomInt,
    now,
    phase: 'waiting',
    round: 0,
    players: players.map((entry, index) => {
      // 寬鬆輸入：支援 'P1' / { id, name, isAI } / { id, name, flags:{isAI} }
      const spec = typeof entry === 'object' && entry !== null ? entry : { id: entry };
      const id = spec.id;
      const isAI = Boolean(spec.isAI ?? (spec.flags && spec.flags.isAI) ?? (flags[id] && flags[id].isAI));
      const isBoss = Boolean(spec.isBoss ?? (flags[id] && flags[id].isBoss));
      return {
        id,
        name: spec.name || names[id] || (index === 0 ? '玩家' : `對手 ${index + 1}`),
        isAI,
        isBoss,
        hp: gameConfig.HP.START_HP,
        maxHp: Math.max(startMax, gameConfig.HP.START_HP),
        sawnOff: 0,       // >0 = 槍管已鋸短，下次開槍傷害 +N
        inverted: false,  // 逆轉器：反轉現在這發子彈
        nails: 0,         // 釘槍剩餘彈數
        items: [],        // string[] 道具 id
        intel: [],        // [{ type:'SHIFT'|'NEXT', shells:string[], count?:number }] 只有本人看得到
        dead: false,
        eliminatedRound: null,
        stats: { shotsFired: 0, damageDealt: 0, damageTaken: 0, itemsUsed: 0 },
      };
    }),
    turn: { activeId: null, chain: 0, barrage: null, skips: {} },
    chamber: [],
    live: 0,
    blank: 0,
    log: [],
    winnerId: null,
    version: 0,
    createdAt: now(),
  };

  addLog(game, `新的一局開始，共 ${game.players.length} 名參與者。`);
  return game;
}

/* ========================================================================== */
/*  3. 開始 / 裝彈                                                            */
/* ========================================================================== */

function startGame(game) {
  for (const p of game.players) {
    p.hp = game.config.HP.START_HP;
    p.maxHp = Math.max(game.config.HP.START_MAX_HP ?? 0, game.config.HP.START_HP);
    p.sawnOff = 0;
    p.inverted = false;
    p.nails = 0;
    p.items = [];
    p.intel = [];
    p.dead = false;
    p.eliminatedRound = null;
    p.usedNoCostThisTurn = false;
    p.stats = { shotsFired: 0, damageDealt: 0, damageTaken: 0, itemsUsed: 0 };
  }
  game.round = 0;
  game.winnerId = null;
  game.log = [];
  // 開局直接把第一位玩家的 id 注入（要取 .id，不能整個物件塞進去，否則 activeId 會變成物件）
  const firstSeat = game.players[0];
  game.turn = {
    activeId: firstSeat ? firstSeat.id : null,
    chain: 0,
    barrage: null,
    skips: {},
  };
  game.players.forEach((p) => {
    p.itemsThisTurn = 0;
    p.lastItemId = null;
  });
  game.phase = 'playing';
  addLog(game, '遊戲開始！');

  const actions = [{ type: 'GAME_START', players: game.players.map((p) => p.id) }];
  actions.push(...reload(game, { refill: false, initial: true }));

  // 開場招呼（DeepSeek 娘）
  game._tauntAt = 0;
  const greeting = tauntAction(game, 'onGameStart', { round: 1 });
  if (greeting) actions.push(greeting);
  return actions;
}

/**
 * 重新裝彈：呼叫 loadAmmo() 產生全新的一輪子彈，並處理回血與發道具。
 * @returns {object[]} actions
 */
function reload(game, options = {}) {
  const refill = options.refill === true;
  const A = game.config.AMMO;
  const actions = [];

  game.round = options.roundNumber || game.round + 1;

  // 換輪：清空所有臨時增益與資訊（逆轉器、手鋸、釘槍、預知）
  for (const p of game.players) {
    p.sawnOff = 0;
    p.inverted = false;
    p.nails = 0;
    p.intel = [];
  }

  const ammo = loadAmmo(game.config, game.round, { randomInt: game.randomInt, rng: game.rng });
  game.chamber = ammo.chamber;
  game.live = ammo.live;
  game.blank = ammo.blank;

  addLog(game, `第 ${ammo.total} 發裝填完成（實彈 ${ammo.live} / 空包彈 ${ammo.blank}）── 第 ${game.round} 輪。`);
  actions.push({ type: 'RELOAD', round: game.round, total: ammo.total, live: ammo.live, blank: ammo.blank });

  if (A.HEAL_ON_RELOAD) {
    for (const p of game.players) {
      if (p.dead) continue;
      p.hp = refill ? p.maxHp : Math.min(p.maxHp, p.hp + 1);
    }
  }

  for (const p of game.players) {
    if (p.dead) continue;
    const count = itemGrantCount(game);
    grantRandomItems(game, p, count);
  }

  // 任務 1：這一輪的前 REVEAL_MS 毫秒只播「本回合裝填」提示，任何人（含 AI）都不能行動。
  armAmmoReveal(game);

  actions.push(roundStateAction(game));
  resolveNextRoundIntel(game);
  actions.push(turnAction(game));

  // 換彈時 DeepSeek 娘插嘴（新一輪的機率分佈是她最愛聊的話題）
  if (!options.initial) {
    const eventType = game.rng() < 0.5 ? 'onReload' : 'onEmptyGun';
    const line = tauntAction(game, eventType, { round: game.round, live: ammo.live, blank: ammo.blank });
    if (line) actions.push(line);
  }

  actions.push(revealAction(game));
  return actions;
}

/* -------------------------------------------------------------------------- */
/*  4-0. 開局彈藥提示鎖（任務 1）                                              */
/*      伺服器維持「單一真相」：揭曉動畫期間 reject 指令，時間到解鎖。         */
/* -------------------------------------------------------------------------- */

/** 目前這輪的揭曉動畫還有多久結束（毫秒，0 = 已解鎖） */
function revealRemainingMs(game) {
  if (!game.revealUntil) return 0;
  const nowMs = typeof game.now === 'function' ? game.now() : Date.now();
  return Math.max(0, game.revealUntil - nowMs);
}

function armAmmoReveal(game) {
  const reveal = (game.config.AMMO && game.config.AMMO.AMMO_REVEAL) || {};
  const ms = reveal.ENABLED === false ? 0 : Math.max(0, Number(reveal.REVEAL_MS) || 0);
  const nowMs = typeof game.now === 'function' ? game.now() : Date.now();
  game.revealMs = ms;
  game.revealUntil = ms > 0 ? nowMs + ms : 0;
}

/** 給前端播動畫用的 action（帶上何時解鎖與還剩多久） */
function revealAction(game) {
  const remaining = revealRemainingMs(game);
  return {
    type: 'AMMO_REVEAL',
    round: game.round,
    live: game.live,
    blank: game.blank,
    total: game.chamber.length,
    ms: remaining,
    until: game.revealUntil || 0,
  };
}

/** 揭曉時間就到了：解鎖並讓下一位 AI 動起來（由伺服器呼叫） */
function releaseReveal(game) {
  game.revealUntil = 0;
  return succeed(game, [{ type: 'AMMO_REVEAL_END', round: game.round, ...turnSnapshot(game) }]);
}

/* ========================================================================== */
/*  4. 開槍 shoot()                                                           */
/* ========================================================================== */

/**
 * 射擊核心（一次槍響）。
 *  - 從 chamber 取出第一發；實彈扣血、空包彈不扣血。
 *  - 不負責切換回合，是否保留回合（連鎖 / 連發 / 額外回合）交給 finishTurn()。
 *
 * @param {object} game
 * @param {string} shooterId
 * @param {string|null} targetId  傳 null 表示對自己開槍
 * @param {object} [options]
 * @param {string} [options.knownShell]  由道具（啤酒）預先取出的子彈
 * @param {boolean} [options.barrage]    是否屬於連發中的一發
 * @returns {{ ok:boolean, error?:string, action?:object, selfShot?:boolean, result?:string }}
 */
function shoot(game, shooterId, targetId, options = {}) {
  if (game.phase !== 'playing') return { ok: false, error: 'GAME_NOT_PLAYING' };

  const shooter = getPlayer(game, shooterId);
  if (!shooter || shooter.dead) return { ok: false, error: 'SHOOTER_INVALID' };

  const selfShot = !targetId || targetId === shooterId;
  const target = selfShot ? shooter : getPlayer(game, targetId);
  if (!target || target.dead) return { ok: false, error: 'TARGET_INVALID' };

  // 子彈打完 → 自動重新裝彈（保險：正常流程不會走到這裡）
  let autoReloaded = false;
  if (game.chamber.length === 0) {
    reload(game);
    autoReloaded = true;
  }

  /* --- ① 取出子彈，並套用 逆轉器 / 手鋸 / 釘槍 --- */
  const realShell = options.knownShell || game.chamber.shift() || SHELL.BLANK;
  if (realShell === SHELL.LIVE) game.live = Math.max(0, game.live - 1);
  else game.blank = Math.max(0, game.blank - 1);

  let shell = realShell;
  let inverted = false;
  if (shooter.inverted) {
    shell = shell === SHELL.LIVE ? SHELL.BLANK : SHELL.LIVE;
    shooter.inverted = false;
    inverted = true;
  }

  const power = options.power ?? Math.max(1, 1 + shooter.sawnOff + (shooter.nails > 0 ? 1 : 0));

  /* --- ② 結算 --- */
  let damage = 0;
  if (shell === SHELL.LIVE) {
    const applied = applyDamage(game, target, Math.min(target.hp, power));
    damage = applied;
    if (applied > 0) {
      shooter.stats.damageDealt += damage;
      game.turn.chain = 0; // 有人受傷 → 連鎖中斷
    }
  }

  shooter.sawnOff = 0;
  if (shooter.nails > 0) shooter.nails -= 1;
  shooter.stats.shotsFired += 1;
  consumeIntel(game, realShell);

  const action = {
    type: 'SHOT',
    shooterId,
    shooterName: shooter.name,
    targetId: target.id,
    targetName: target.name,
    selfShot,
    shell,            // 結算用（扣除逆轉器後）
    realShell,        // 槍膛裡真正的那一發
    inverted,
    power,
    damage,
    hp: target.hp,
    targetDead: target.dead,
    remaining: { live: game.live, blank: game.blank, total: game.chamber.length },
    round: game.round,
    chain: game.turn.chain,
    autoReloaded,
  };

  addLog(
    game,
    `${shooter.name} 對${selfShot ? '自己' : target.name}開槍：${shell === SHELL.LIVE ? `實彈 -${damage}` : '空包彈'}${inverted ? '（逆轉）' : ''}`,
  );

  return { ok: true, action, selfShot, result: shell };
}

/* ========================================================================== */
/*  5. 指令入口 execute()                                                     */
/* ========================================================================== */

/**
 * 玩家（含 AI）下達指令。回傳 { ok, error?, actions?, version? }。
 * actions 由呼叫端（server / 前端）依序播放，不影響伺服器已定的狀態。
 */
function execute(game, intent, payload) {
  const player = getPlayer(game, intent.playerId);
  if (!player) return fail('PLAYER_NOT_FOUND');

  // 每次執行前把共享設定同步進來（深拷貝），讓 config 成為唯一的數值來源
  syncConfig(game);

  switch (intent.type) {
    case 'START':
      return commandStart(game, player);
    case 'SHOOT':
      return commandShoot(game, player, payload || {});
    case 'USE_ITEM':
      return commandUseItem(game, player, payload || {});
    case 'GUARD':
      return guard(game, player, false);
    case 'TIMEOUT':
      return guard(game, player, true);
    default:
      return fail('UNKNOWN_COMMAND');
  }
}

/** 不消耗回合、且一回合只能使用一次的道具效果（在 commandUseItem 之前定義） */
const NO_TURN_COST_EFFECTS = new Set(['stealTurn', 'extraTurn']);

/**
 * 把「當前」的 config/gameConfig.js 深拷貝進遊戲。
 * 這樣 config 成為唯一真相來源：改檔 → 下一次行動起即刻生效。
 * （也讓測試可以在 createGame 之後偷改設定，驗證 loadAmmo 真的吃設定。）
 */
function syncConfig(game) {
  const fresh = deepClone(SHARED_CONFIG);
  game.config = fresh;
  game.randomInt = fresh.AMMO.SHUFFLE_MODE === 'math' ? mathRandomInt : secureRandomInt;
  return game.config;
}

function commandStart(game, player) {
  if (game.phase !== 'waiting') return fail('ALREADY_STARTED');
  if (game.players[0] && game.players[0].id !== player.id) return fail('NOT_HOST');
  if (alivePlayers(game).length < game.config.RULES.MIN_PLAYERS) return fail('NOT_ENOUGH_PLAYERS');
  game.phase = 'playing';
  const actions = startGame(game);
  return succeed(game, actions);
}

function commandShoot(game, player, payload) {
  if (game.phase !== 'playing') return fail('GAME_NOT_PLAYING');
  if (revealRemainingMs(game) > 0) return fail('AMMO_REVEAL');
  if (game.turn.activeId !== player.id) return fail('NOT_YOUR_TURN');
  if (player.dead) return fail('YOU_ARE_DEAD');

  const barrage = game.turn.barrage;
  const inBarrage = Boolean(barrage && barrage.by === player.id && barrage.left > 0);
  const targetId = payload.targetId || player.id;
  const target = getPlayer(game, targetId);
  if (!target || target.dead) return fail('TARGET_INVALID');

  const res = shoot(game, player.id, targetId, { barrage: inBarrage });
  if (!res.ok) return fail(res.error);

  const actions = [res.action];

  // DeepSeek 娘對這一槍發表高見
  const line = tauntForShot(game, player, target, res);
  if (line) actions.push(line);

  if (inBarrage) {
    barrage.left -= 1;
    actions.push({ type: 'BARRAGE', by: player.id, left: barrage.left });
    if (barrage.left <= 0) game.turn.barrage = null;
  }

  if (game.phase === 'gameover' || res.action.targetDead || countAlive(game) <= 1) {
    game.turn.barrage = null;
    actions.push(...finishTurn(game, false));
    return succeed(game, actions);
  }

  if (inBarrage && game.turn.barrage) {
    // 連發中：回合保持在射手身上，直到彈匣打完或連發結束
    actions.push({ type: 'TURN_CHANGED', activeId: player.id, chain: game.turn.chain, kept: true });
    return succeed(game, actions);
  }

  actions.push(...finishTurn(game, res.selfShot && res.result === SHELL.BLANK));
  return succeed(game, actions);
}

function commandUseItem(game, player, payload) {
  if (game.phase !== 'playing') return fail('GAME_NOT_PLAYING');
  if (revealRemainingMs(game) > 0) return fail('AMMO_REVEAL');
  if (game.turn.activeId !== player.id) return fail('NOT_YOUR_TURN');
  if (player.dead) return fail('YOU_ARE_DEAD');

  const item = game.config.ITEMS.find((it) => it.id === payload.itemId);
  if (!item) return fail('ITEM_NOT_FOUND');
  const slot = player.items.indexOf(item.id);
  if (slot === -1) return fail('ITEM_NOT_IN_INVENTORY');

  // 一回合只能用一次「不消耗回合」的道具，避免時間類道具無限疊加
  if (NO_TURN_COST_EFFECTS.has(item.effect) && player.usedNoCostThisTurn) return fail('ONCE_PER_TURN');

  const effect = applyItem(game, player, item, payload.targetId);
  if (!effect.ok) return fail(effect.error);

  player.items.splice(slot, 1);
  player.stats.itemsUsed += 1;
  player.itemsThisTurn = (player.itemsThisTurn || 0) + 1;
  player.lastItemId = item.id;
  if (NO_TURN_COST_EFFECTS.has(item.effect)) player.usedNoCostThisTurn = true;
  addLog(game, `${player.name} 使用了【${item.name}】。`);

  const actions = [{ type: 'ITEM_USED', playerId: player.id, itemId: item.id, name: item.name, icon: item.icon }];
  actions.push(...effect.actions);
  for (const extra of effect.shots || []) actions.push(extra.action);

  const itemLine = tauntAction(game, player.isAI ? 'onDemonItem' : 'onItemUsed', { player: player.name });
  if (itemLine) actions.push(itemLine);

  // 這些道具「不消耗回合」：額外回合 / 搶回合 / 連發（連發打完自然結束回合），
  // 以及資料驅動的 item.keepsTurn（香菸、手鋸、萬能工具…用完仍然輪到你）。
  if (effect.extendsTurn || item.keepsTurn === true) {
    if (effect.echo) actions.push({ type: 'EXTRA_TURN', playerId: player.id });
    actions.push(turnAction(game, item.keepsTurn === true && !effect.extendsTurn));
    return succeed(game, actions);
  }

  actions.push(...finishTurn(game, false));
  return succeed(game, actions);
}

/**
 * 回合收尾（開一槍或使用道具之後呼叫）。
 *  - 勝負判定
 *  - 子彈打完 → 自動 reload()（並重新輪到原本的人）
 *  - 對自己開槍打出空包彈 → 保留回合（連鎖）
 *  - 其他 → 傳給下一位（略過被銬住的人）
 */
function finishTurn(game, keepTurn) {
  const actions = [];

  if (game.winnerId || countAlive(game) <= 1) {
    game.phase = 'gameover';
    game.winnerId = game.winnerId || (alivePlayers(game)[0] || {}).id || null;
    actions.push({ type: 'GAME_OVER', winnerId: game.winnerId });

    const winner = getPlayer(game, game.winnerId);
    const closing = tauntAction(game, winner && winner.isAI ? 'onVictory' : 'onDefeat', {
      player: winner ? winner.name : '',
    });
    if (closing) actions.push(closing);
    return actions;
  }

  const current = getPlayer(game, game.turn.activeId);

  if (game.chamber.length === 0) {
    actions.push({ type: 'ROUND_END', round: game.round });
    actions.push(...reload(game));
    actions.push({ type: 'TURN_CHANGED', activeId: game.turn.activeId, chain: 0 });
    return actions;
  }

  if (keepTurn && current && !current.dead) {
    game.turn.chain += 1;
    actions.push({ type: 'TURN_CHANGED', activeId: current.id, chain: game.turn.chain, kept: true });
    return actions;
  }

  if (current) current.usedNoCostThisTurn = false;
  game.turn.barrage = null;
  game.turn.chain = 0;
  const previous = current ? current.id : null;
  game.turn.activeId = nextAliveId(game, previous);
  // 新回合開始：把下一家「本回合用過幾件道具」歸零
  const next = getPlayer(game, game.turn.activeId);
  if (next) {
    next.itemsThisTurn = 0;
    next.lastItemId = null;
  }
  actions.push({ type: 'TURN_CHANGED', activeId: game.turn.activeId, chain: 0 });
  return actions;
}

function guard(game, player, isTimeout) {
  if (game.phase !== 'playing') return fail('GAME_NOT_PLAYING');
  if (game.turn.activeId !== player.id) return fail('NOT_YOUR_TURN');
  const res = shoot(game, player.id, player.id);
  if (!res.ok) return fail(res.error);
  const actions = [res.action];
  if (isTimeout) {
    actions.push({ type: 'TIMEOUT', playerId: player.id });
    const idleLine = tauntAction(game, 'onIdle', { player: player.name });
    if (idleLine) actions.push(idleLine);
  }
  actions.push(...finishTurn(game, res.result === SHELL.BLANK));
  return succeed(game, actions);
}

/* ========================================================================== */
/*  6. 道具效果                                                               */
/* ========================================================================== */

function applyItem(game, player, item, targetId) {
  const params = item.params || {};
  const actions = [];

  switch (item.effect) {
    case 'heal': {
      const amount = rollRange(game, params);
      const healed = heal(player, amount);
      actions.push({ type: 'HEAL', playerId: player.id, amount, healed, hp: player.hp });
      break;
    }
    case 'randomHeal':
    case 'gambleHeal': {
      const success = rollChance(game, params.CHANCE ?? 100);
      if (success) {
        const amount = rollRange(game, params);
        const healed = heal(player, amount);
        actions.push({ type: 'HEAL', playerId: player.id, amount, healed, hp: player.hp, success: true });
      } else if (item.effect === 'gambleHeal') {
        const dmg = params.HP ?? 1;
        applyDamage(game, player, dmg);
        actions.push({ type: 'DAMAGE', playerId: player.id, targetId: player.id, amount: dmg, hp: player.hp, success: false });
      } else {
        actions.push({ type: 'ITEM_FAILED', playerId: player.id, hp: player.hp });
      }
      break;
    }
    case 'cutBarrel': {
      player.sawnOff += params.DAMAGE ?? 1;
      actions.push({ type: 'MODIFIER', playerId: player.id, key: 'SAWN_OFF', value: player.sawnOff });
      break;
    }
    case 'invert': {
      player.inverted = !player.inverted;
      actions.push({ type: 'MODIFIER', playerId: player.id, key: 'INVERTED', value: player.inverted });
      break;
    }
    case 'nailGun': {
      player.nails += params.SHOTS ?? 1;
      actions.push({ type: 'MODIFIER', playerId: player.id, key: 'NAILS', value: player.nails });
      break;
    }
    case 'peek':
    case 'peekMany': {
      // 只給使用者的 private state：動作本身不含順序，避免被同一房間的其他人攔截
      if (game.chamber.length === 0) return { ok: false, error: 'NO_SHELLS' };
      const count = Math.min(params.COUNT ?? 1, game.chamber.length);
      player.intel.push({ type: 'SHIFT', shells: game.chamber.slice(0, count) });
      actions.push({ type: 'PEEK', playerId: player.id, count });
      break;
    }
    case 'memory':
    case 'memoryAll': {
      const want = item.effect === 'memoryAll' ? Number.MAX_SAFE_INTEGER : (params.COUNT ?? 1);
      player.intel.push({ type: 'NEXT', count: want, shells: [] });
      actions.push({ type: 'INTEL', playerId: player.id, count: want === Number.MAX_SAFE_INTEGER ? 'ALL' : want, when: 'nextRound' });
      break;
    }
    case 'eject':
    case 'ejectRandom': {
      const range = item.effect === 'ejectRandom' ? rangeOf(params, 1) : { min: 1, max: 1 };
      const count = Math.min(game.randomInt(range.min, range.max), game.chamber.length);
      const shells = [];
      for (let i = 0; i < count; i++) {
        const idx = item.effect === 'ejectRandom' ? game.randomInt(0, game.chamber.length - 1) : 0;
        shells.push(...game.chamber.splice(idx, 1));
      }
      for (const s of shells) {
        if (s === SHELL.LIVE) game.live = Math.max(0, game.live - 1);
        else game.blank = Math.max(0, game.blank - 1);
      }
      actions.push({ type: 'EJECT', playerId: player.id, shells, remaining: roundState(game) });
      break;
    }
    case 'ejectAndShoot': {
      if (game.chamber.length === 0) return { ok: false, error: 'NO_SHELLS' };
      const known = game.chamber.shift();
      if (known === SHELL.LIVE) game.live = Math.max(0, game.live - 1);
      else game.blank = Math.max(0, game.blank - 1);
      actions.push({ type: 'EJECT', playerId: player.id, shells: [known], remaining: roundState(game) });
      const res = shoot(game, player.id, player.id);
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, actions, shots: [res] };
    }
    case 'rapidFire': {
      const total = Math.max(1, params.SHOTS ?? 1);
      const shots = [];
      for (let i = 0; i < total; i++) {
        if (game.chamber.length === 0 || game.phase === 'gameover') break;
        const res = shoot(game, player.id, player.id, { barrage: i > 0 });
        if (!res.ok) break;
        shots.push(res);
        if (res.action.targetDead) break;
      }
      if (game.phase !== 'gameover') {
        if (game.chamber.length === 0) {
          game.turn.barrage = null;
          actions.push({ type: 'ROUND_END', round: game.round });
          actions.push(...reload(game));
        } else {
          game.turn.barrage = { by: player.id, left: total - shots.length };
          actions.push({ type: 'BARRAGE', by: player.id, left: game.turn.barrage.left });
        }
      }
      return { ok: true, actions, shots };
    }
    case 'skipNext': {
      if (!game.turn.skips) game.turn.skips = {};
      let victims = payloadTarget(game, player, targetId);
      if (!victims.length) victims = [nextAliveId(game, player.id)].filter(Boolean);
      for (const id of victims) {
        game.turn.skips[id] = (game.turn.skips[id] || 0) + (params.SKIPS ?? 1);
      }
      actions.push({ type: 'MODIFIER', playerId: player.id, key: 'HANDCUFFS', targets: victims });
      break;
    }
    case 'stealTurn': {
      actions.push({ type: 'STEAL_TURN', playerId: player.id, ms: params.DURATION_MS ?? 0 });
      return { ok: true, actions, extendsTurn: true };
    }
    case 'extraTurn': {
      const success = rollChance(game, params.CHANCE ?? 50);
      actions.push({ type: success ? 'EXTRA_TURN' : 'ITEM_FAILED', playerId: player.id });
      return { ok: true, actions, extendsTurn: success, echo: success };
    }
    case 'gacha': {
      const gained = grantRandomItems(game, player, params.SHOTS ?? 1);
      actions.push({ type: 'ITEM_GRANTED', playerId: player.id, items: gained });
      break;
    }
    case 'maxHpUp': {
      const cost = params.HP ?? 1;
      applyDamage(game, player, cost);
      player.maxHp = Math.min(game.config.HP.MAX_HP, player.maxHp + (params.MAX_HP ?? 1));
      if (!player.dead) player.hp = Math.min(player.maxHp, player.hp + cost);
      actions.push({ type: 'MODIFIER', playerId: player.id, key: 'MAX_HP', value: player.maxHp, hp: player.hp });
      break;
    }
    default:
      return { ok: false, error: 'EFFECT_NOT_IMPLEMENTED' };
  }

  if (game.winnerId || countAlive(game) <= 1) {
    game.phase = 'gameover';
    game.winnerId = game.winnerId || (alivePlayers(game)[0] || {}).id || null;
    actions.push({ type: 'GAME_OVER', winnerId: game.winnerId });
  }
  return { ok: true, actions };
}

/* ========================================================================== */
/*  7. 基礎操作                                                               */
/* ========================================================================== */

function heal(player, amount) {
  if (player.dead) return 0;
  const before = player.hp;
  player.hp = Math.min(player.maxHp, player.hp + amount);
  return player.hp - before;
}

function applyDamage(game, target, amount) {
  if (target.dead) return 0;
  const applied = Math.max(0, Math.min(target.hp, amount));
  target.hp -= applied;
  target.stats.damageTaken += applied;
  target.sawnOff = 0;
  if (target.hp <= 0) {
    target.hp = 0;
    target.dead = true;
    target.items = [];
    target.intel = [];
    target.eliminatedRound = game.round;
    target.sawnOff = 0;
    target.nails = 0;
    target.inverted = false;
  }
  return applied;
}

function rollRange(game, params) {
  const range = rangeOf(params, 0);
  return game.randomInt(range.min, range.max);
}

function rollChance(game, percent) {
  return game.randomInt(1, 100) <= clamp(percent, 0, 100);
}

/** 預知資訊在使用者開槍後前移；紀錄用完就移除 */
function consumeIntel(game, realShell) {
  for (const p of game.players) {
    if (!p.intel.length) continue;
    p.intel = p.intel.filter((entry) => {
      if (entry.type !== 'SHIFT') return true;
      if (entry.shells.length && entry.shells[0] === realShell) {
        entry.shells.shift();
      }
      return entry.shells.length > 0;
    });
  }
}

/** 把新一輪的子彈順序填入 NEXT 型預知（在 reload 之後呼叫） */
function resolveNextRoundIntel(game) {
  for (const p of game.players) {
    if (p.dead) continue;
    for (const entry of p.intel) {
      if (entry.type === 'NEXT') {
        entry.type = 'SHIFT';
        entry.shells = game.chamber.slice(0, Math.min(entry.count, game.chamber.length));
      }
    }
  }
}

/** 手銬目標：多人房中若沒指定，就銬「下一位」 */
function payloadTarget(game, player, targetId) {
  if (targetId) {
    const target = getPlayer(game, targetId);
    if (target && !target.dead && target.id !== player.id) return [target.id];
  }
  const others = alivePlayers(game).filter((p) => p.id !== player.id);
  if (others.length === 1) return [others[0].id];
  return [];
}

/**
 * 本次裝彈要發給「每位玩家」幾個道具（任務 2）。
 *  - 第 1~2 輪：ITEMS_ON_RELOAD.BASE（預設 2）
 *  - 第 3 輪起：ITEMS_ON_RELOAD.ESCALATED（預設 3）
 *  - 仍支援舊格式 { min, max }（相容舊設定 / 舊測試）
 */
function itemGrantCount(game) {
  const spec = game.config.AMMO.ITEMS_ON_RELOAD || {};
  const escalateFrom = Number(spec.ESCALATE_FROM_ROUND) || 0;
  const base = Number(spec.BASE);
  const escalated = Number(spec.ESCALATED);

  if (Number.isFinite(base) || Number.isFinite(escalated)) {
    const normal = Number.isFinite(base) ? base : 2;
    const high = Number.isFinite(escalated) ? escalated : normal;
    const want = escalateFrom > 0 && game.round >= escalateFrom ? high : normal;
    return Math.max(0, Math.floor(want));
  }
  const legacy = rangeOf(spec, 0);
  return game.randomInt(legacy.min, legacy.max);
}

/** 依 LOOT 設定隨機發道具（不超過 MAX_ITEMS） */
function grantRandomItems(game, player, count) {
  const table = lootTableFor(game, player);
  const gained = [];
  for (let i = 0; i < count; i++) {
    if (player.items.length >= game.config.LIMITS.MAX_ITEMS) break;
    const id = rollLoot(game, table);
    if (!id) break;
    player.items.push(id);
    gained.push(id);
  }
  return gained;
}

function lootTableFor(game, player) {
  const loot = game.config.LOOT || {};
  return (player.isAI ? loot.ENEMY : loot.PLAYER) || loot.DEFAULT || { mode: 'uniform' };
}

function rollLoot(game, table) {
  if (!table || table.mode === 'boss') return null;
  const exclude = table.EXCLUDE || [];
  const allIds = game.config.ITEMS.map((it) => it.id).filter((id) => !exclude.includes(id));

  if (table.mode === 'weights' && table.WEIGHTS) {
    const ids = allIds.filter((id) => Number(table.WEIGHTS[id]) > 0);
    if (ids.length) {
      const total = ids.reduce((sum, id) => sum + Number(table.WEIGHTS[id]), 0);
      let roll = game.randomInt(1, total);
      for (const id of ids) {
        roll -= Number(table.WEIGHTS[id]);
        if (roll <= 0) return id;
      }
      return ids[ids.length - 1];
    }
  }
  // 'uniform'（或權重為空）：等機率
  return allIds.length ? allIds[game.randomInt(0, allIds.length - 1)] : null;
}

/**
 * 找出下一位還有命的人；被手銬銬住（skips>0）的人直接跳過並扣一次。
 * 注意：多人房可能「全部都被銬住」，此時跳過一輪後允許繼續，避免死鎖。
 */
function nextAliveId(game, fromId) {
  const skips = game.turn.skips || {};
  const list = game.players;
  const fromIndex = list.findIndex((p) => p.id === fromId);
  let fallback = null;

  for (let pass = 0; pass < 2; pass++) {
    for (let step = 1; step <= list.length; step++) {
      const candidate = list[(fromIndex + step + list.length) % list.length];
      if (!candidate || candidate.dead) continue;
      if (pass === 0 && (skips[candidate.id] || 0) > 0) {
        skips[candidate.id] -= 1;
        fallback = fallback || candidate.id;
        continue;
      }
      return candidate.id;
    }
  }

  if (fallback) return fallback;
  const alive = alivePlayers(game);
  return alive.length ? alive[0].id : null;
}

function alivePlayers(game) {
  return game.players.filter((p) => !p.dead);
}

function countAlive(game) {
  return alivePlayers(game).length;
}

function getPlayer(game, id) {
  return game.players.find((p) => p.id === id) || null;
}

function roundState(game) {
  return { live: game.live, blank: game.blank, total: game.chamber.length, round: game.round };
}

function roundStateAction(game) {
  return { type: 'ROUND_STATE', remaining: roundState(game) };
}

function turnAction(game, kept) {
  const action = { type: 'TURN_CHANGED', activeId: game.turn.activeId, chain: game.turn.chain };
  if (kept) action.kept = true; // 用了 keepsTurn 道具，回合仍在你身上
  return action;
}

/** 回合快照（給 AMMO_REVEAL_END / 斷線等外部事件補一次狀態） */
function turnSnapshot(game) {
  return {
    activeId: game.turn.activeId,
    chain: game.turn.chain,
    round: game.round,
    remaining: roundState(game),
  };
}

function addLog(game, text) {
  game.log.push({ round: game.round, at: Date.now(), text });
  if (game.log.length > 200) game.log.shift();
}

function succeed(game, actions) {
  game.version += 1;
  return { ok: true, actions, version: game.version };
}

function fail(error) {
  return { ok: false, error };
}

/* ========================================================================== */
/*  8. 狀態同步（洩漏防護在此）                                               */
/* ========================================================================== */

/** 公開狀態：所有人（含觀戰者）都看得到；只有「剩餘數量」，沒有「順序」 */
function getPublicState(game) {
  return {
    version: game.version,
    phase: game.phase,
    round: game.round,
    activeId: game.turn.activeId,
    chain: game.turn.chain,
    barrage: game.turn.barrage ? { by: game.turn.barrage.by, left: game.turn.barrage.left } : null,
    winnerId: game.winnerId,
    remaining: { live: game.live, blank: game.blank, total: game.chamber.length },
    players: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      isAI: p.isAI,
      hp: p.hp,
      maxHp: p.maxHp,
      dead: p.dead,
      itemCount: p.items.length,
      modified: { sawnOff: p.sawnOff, inverted: p.inverted, nails: p.nails },
    })),
    log: game.log.slice(-30),
  };
}

/** 個人狀態：只給自己知道的情報（道具、預知、手鋸等） */
function getPrivateState(game, playerId) {
  const player = getPlayer(game, playerId);
  if (!player || player.dead) return { items: [], intel: [] };
  return {
    items: [...player.items],
    intel: player.intel.map((entry) => ({ type: entry.type, shells: [...entry.shells] })),
    mods: {
      sawedOff: player.sawnOff > 0,
      inverted: player.inverted,
      nails: player.nails,
    },
  };
}

/** 每人一份的狀態（server 只會把這份送給對應的 socket） */
function getStateFor(game, playerId) {
  return { public: getPublicState(game), private: getPrivateState(game, playerId) };
}

/**
 * 旁觀者 / 轉播用：只有在遊戲結束時才公開完整子彈順序。
 * 遊戲進行中永遠回傳 null —— 這是「不可洩漏順序」的最後一道防線。
 */
function getRevealedChamber(game) {
  if (game.phase !== 'gameover') return null;
  return [...game.chamber];
}

module.exports = {
  SHELL,
  loadAmmo,
  createGame,
  startGame,
  reload,
  shoot,
  execute,
  getPlayer,
  getPublicState,
  getPrivateState,
  getStateFor,
  getRevealedChamber,
  resolveNextRoundIntel,
  /** 測試 / AI 專用 */
  _internals: {
    deepClone,
    rangeOf,
    nextAliveId,
    countAlive,
    syncConfig,
    finishTurn,
    tauntAction,
    tauntForShot,
    demonOf: demonPlayer,
    revealRemainingMs,
    releaseReveal,
    itemGrantCount,
  },
};
