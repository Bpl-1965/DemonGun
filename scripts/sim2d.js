'use strict';

/**
 * scripts/sim2d.js —— 在 Node 裡模擬前端會收到的東西，驗證第四輪的四個任務
 *  任務1：每一輪都會送 AMMO_REVEAL（帶 live/blank/ms），且揭曉期間指令被鎖
 *  任務2：每輪發 2 個道具、第 3 輪起 3 個
 *  任務3：對自己開槍 + 空包彈 → 回合不轉移；實彈或對敵人開槍 → 立刻轉移
 *  任務4：狀態直接餵給前端渲染所需的欄位（activeId / remaining / players）
 *
 * 用法：node scripts/sim2d.js（不要設 DEVIL_REVEAL_MS，這裡要驗真的 3 秒鎖）
 */
const engine = require('../logic/gameEngine');
const aiLogic = require('../logic/aiLogic');

const SHARED = require('../config/gameConfig');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
}

function findAction(actions, type) {
  return (actions || []).find((a) => a.type === type) || null;
}

/** 建一局人類 vs AI，回傳 game */
function newGame() {
  const game = engine.createGame({
    id: 'TEST',
    players: [
      { id: 'P1', name: '你', isAI: false },
      { id: 'AI', name: 'DeepSeek 娘', isAI: true },
    ],
  });
  const actions = engine.startGame(game);
  return { game, actions };
}

/** 把局面調成「P1 的回合、指定彈艙」（方便測規則，不動 config） */
function rig(game, chamber) {
  game.revealUntil = 0;
  game.turn.activeId = 'P1';
  game.turn.barrage = null;
  game.turn.skips = {};
  game.chamber = chamber.slice();
  game.live = chamber.filter((s) => s === 'LIVE').length;
  game.blank = chamber.filter((s) => s === 'BLANK').length;
}

console.log('\n惡魔輪盤 · 2D 流程驗證\n');

/* -------------------------------------------------------------------------- */
/*  任務 1：每輪都送 AMMO_REVEAL，且鎖住期間都不能動                            */
/* -------------------------------------------------------------------------- */
{
  const { game, actions } = newGame();
  const reveal = findAction(actions, 'AMMO_REVEAL');

  check('任務1：開局送了 AMMO_REVEAL', Boolean(reveal));
  check('任務1：揭示時長來自 config（3000ms）', reveal && reveal.ms === 3000, reveal ? `${reveal.ms}ms` : '');
  check('任務1：帶上實彈 / 空包數量', Boolean(reveal) && reveal.live + reveal.blank > 0,
    reveal ? `${reveal.live} 實 / ${reveal.blank} 空` : '');
  const reload = findAction(actions, 'RELOAD');
  check('任務1：RELOAD 也帶了本輪彈藥', Boolean(reload), reload ? `第 ${reload.round} 輪 ${reload.live}/${reload.blank}` : '');

  const blocked = engine.execute(game, { type: 'SHOOT', playerId: game.turn.activeId }, { targetId: null });
  check('任務1：揭示期間開槍被拒絕', blocked.ok === false && blocked.error === 'AMMO_REVEAL', blocked.error || 'OK（不該 OK）');

  // 模擬伺服器的釋放（server.js 的 armRevealTimer 到點呼叫這個）
  const released = engine._internals.releaseReveal(game);
  check('任務1：時間到會送 AMMO_REVEAL_END', Boolean(findAction(released.actions, 'AMMO_REVEAL_END')));

  const allowed = engine.execute(game, { type: 'SHOOT', playerId: game.turn.activeId }, { targetId: null });
  check('任務1：揭示結束後可以開槍', allowed.ok === true, allowed.error || '');
}

/* -------------------------------------------------------------------------- */
/*  任務 2：發道具數量 2 → 2 → 3                                               */
/* -------------------------------------------------------------------------- */
{
  const { game } = newGame();
  const granted = game.players.map((p) => p.items.length);
  check('任務2：第 1 輪每人 2 個道具', granted.every((n) => n === 2), granted.join(', '));

  // 把輪次推到第 2 輪，清空道具，再讓最後一發打掉 → 自動 reload 進第 3 輪
  game.revealUntil = 0;
  game.round = 2;
  game.players.forEach((p) => { p.items = []; });
  rig(game, ['BLANK']);

  const res = engine.execute(game, { type: 'SHOOT', playerId: 'P1' }, { targetId: 'AI' });
  const newReload = findAction(res.actions, 'RELOAD');
  check('任務2：彈匣打空會自動重新裝彈', Boolean(newReload), newReload ? `第 ${newReload.round} 輪` : '');
  const after = game.players.map((p) => p.items.length);
  check('任務2：第 3 輪每人 3 個道具', after.every((n) => n === 3), after.join(', '));
  check('任務2：新一輪也送了 AMMO_REVEAL', Boolean(findAction(res.actions, 'AMMO_REVEAL')));
  check('任務2：道具 id 都在 config.ITEMS 裡',
    game.players.every((p) => p.items.every((id) => SHARED.ITEMS.some((it) => it.id === id))));
}

/* -------------------------------------------------------------------------- */
/*  任務 3：空包彈自射保留回合 / 實彈或打敵人立刻轉移                            */
/* -------------------------------------------------------------------------- */
{
  const { game } = newGame();
  game.players[0].hp = 4;
  game.players[0].maxHp = 4;
  rig(game, ['BLANK', 'BLANK', 'LIVE', 'BLANK']);

  const r1 = engine.execute(game, { type: 'SHOOT', playerId: 'P1' }, { targetId: null });
  check('任務3：自射空包彈 → 回合不轉移', r1.ok === true && game.turn.activeId === 'P1', `activeId=${game.turn.activeId}`);
  check('任務3：自射空包彈不扣血', game.players[0].hp === 4, `HP=${game.players[0].hp}`);
  const keptTurn = findAction(r1.actions, 'TURN_CHANGED');
  check('任務3：送出 kept 的 TURN_CHANGED（前端可判斷「回合沒轉移」）',
    Boolean(keptTurn) && keptTurn.kept === true && keptTurn.activeId === 'P1',
    keptTurn ? JSON.stringify(keptTurn) : '');

  const r2 = engine.execute(game, { type: 'SHOOT', playerId: 'P1' }, { targetId: null });
  check('任務3：連兩發空包仍保留回合', r2.ok === true && game.turn.activeId === 'P1', `activeId=${game.turn.activeId}`);

  engine.execute(game, { type: 'SHOOT', playerId: 'P1' }, { targetId: null });
  check('任務3：自射實彈 → 扣血', game.players[0].hp === 3, `HP=${game.players[0].hp}`);
  check('任務3：自射實彈 → 回合轉移給 AI', game.turn.activeId === 'AI', `activeId=${game.turn.activeId}`);
}
{
  // 打敵人：空包也要轉移
  const { game } = newGame();
  rig(game, ['BLANK', 'LIVE', 'BLANK']);
  engine.execute(game, { type: 'SHOOT', playerId: 'P1' }, { targetId: 'AI' });
  check('任務3：對敵人開槍（空包）→ 回合立刻轉移', game.turn.activeId === 'AI', `activeId=${game.turn.activeId}`);
}
{
  // 打敵人：實彈扣敵人血 + 轉移
  const { game } = newGame();
  game.players[1].hp = 2;
  game.players[1].maxHp = 4;
  rig(game, ['LIVE', 'BLANK', 'BLANK']);
  engine.execute(game, { type: 'SHOOT', playerId: 'P1' }, { targetId: 'AI' });
  check('任務3：對敵人開槍（實彈）→ 敵人扣血 + 回合轉移',
    game.players[1].hp === 1 && game.turn.activeId === 'AI',
    `AI HP=${game.players[1].hp}, activeId=${game.turn.activeId}`);
}
{
  // 一輪正常打完會換輪（ROUND_END → RELOAD）
  const { game } = newGame();
  rig(game, ['BLANK']);
  const res = engine.execute(game, { type: 'SHOOT', playerId: 'P1' }, { targetId: 'AI' });
  check('任務3：最後一發打完 → ROUND_END + 自動重裝',
    Boolean(findAction(res.actions, 'ROUND_END')) && Boolean(findAction(res.actions, 'RELOAD')));
}

/* -------------------------------------------------------------------------- */
/*  任務 3 延伸：AI 也遵守同一套規則                                            */
/* -------------------------------------------------------------------------- */
{
  const { game } = newGame();
  rig(game, ['BLANK', 'LIVE', 'BLANK']);
  game.turn.activeId = 'AI';
  game.players[1].items = []; // 清空道具，只看純射擊決策
  const move = aiLogic.decide(game, 'AI');
  check('AI：知道下一發是空包 → 對自己開槍',
    move.type === 'SHOOT' && move.payload.targetId === null, JSON.stringify(move.payload));
}
{
  const { game } = newGame();
  rig(game, ['LIVE', 'BLANK', 'BLANK']);
  game.turn.activeId = 'AI';
  game.players[1].items = [];
  const move = aiLogic.decide(game, 'AI');
  check('AI：知道下一發是實彈 → 對玩家開槍',
    move.type === 'SHOOT' && move.payload.targetId !== null, JSON.stringify(move.payload));
}

/* -------------------------------------------------------------------------- */
/*  任務 4：前端拿到的狀態欄位齊全                                              */
/* -------------------------------------------------------------------------- */
{
  const { game } = newGame();
  const payload = engine.getStateFor(game, 'P1');
  const pub = payload.public;
  const priv = payload.private;

  check('任務4：公開狀態有 activeId（決定底部按鈕 disabled）',
    typeof pub.activeId === 'string' && pub.activeId.length > 0, pub.activeId);
  check('任務4：公開狀態有 remaining（剩餘彈藥計數器）',
    Boolean(pub.remaining) && typeof pub.remaining.live === 'number',
    pub.remaining ? `${pub.remaining.live} 實 / ${pub.remaining.blank} 空` : '');
  check('任務4：每位玩家都有 hp / maxHp（左欄愛心）',
    pub.players.every((p) => typeof p.hp === 'number' && typeof p.maxHp === 'number'));
  check('任務4：自己拿得到 items（右欄道具欄）',
    Array.isArray(priv.items) && priv.items.length === 2, `${priv.items.length} 個`);
  check('任務4：公開狀態不含子彈順序', !JSON.stringify(pub).includes('chamber'));
}

console.log(failures ? `\n有 ${failures} 項失敗 ✗\n` : '\n全部通過 ✅（任務 1~4）\n');
process.exit(failures ? 1 : 0);
