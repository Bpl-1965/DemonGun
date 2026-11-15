'use strict';

/**
 * scripts/smoke.js —— 無需開瀏覽器的自動驗證
 * 執行：npm run smoke
 *
 * 驗證項目
 *  1. loadAmmo() 產生的子彈數量永遠落在 config 的 MIN/MAX 之間
 *  2. 實彈數量分佈與 config 的權重相符（不是寫死的）
 *  3. 改 config 就立刻改變洗牌結果（證明真的吃設定）
 *  4. 洗牌是隨機的（同一組設定多次出現不同順序）
 *  5. 開槍結算正確、空包彈對自己保留回合、打空自動重新裝彈
 *  6. 公開狀態不會洩漏子彈順序
 *  7. AI vs AI 完整跑完一局，不會卡死或拋錯
 */

process.env.DEVIL_START_HP = process.env.DEVIL_START_HP || '4';
// 單元測試不需要「本回合裝填」的 3 秒鎖（那是伺服器與前端的節奏），關掉讓測試即時行動
process.env.DEVIL_REVEAL_MS = process.env.DEVIL_REVEAL_MS || '0';

const assert = require('node:assert');
const GAME_CONFIG = require('../config/gameConfig');
const engine = require('../logic/gameEngine');
const aiLogic = require('../logic/aiLogic');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('\n惡魔輪盤 · 自動驗證\n');

/* ------------------------------------------------------------------ */
/* 1. 子彈數量永遠在設定範圍內                                         */
/* ------------------------------------------------------------------ */
check('loadAmmo() 的子彈數永遠介於 config.AMMO.MIN_SHELLS ~ MAX_SHELLS', () => {
  for (let round = 1; round <= 20; round++) {
    for (let i = 0; i < 400; i++) {
      const ammo = engine.loadAmmo(GAME_CONFIG, round);
      assert.ok(ammo.total >= GAME_CONFIG.AMMO.MIN_SHELLS, `total ${ammo.total} < MIN`);
      assert.ok(ammo.total <= GAME_CONFIG.AMMO.MAX_SHELLS, `total ${ammo.total} > MAX`);
      assert.strictEqual(ammo.chamber.length, ammo.total);
      assert.strictEqual(ammo.live + ammo.blank, ammo.total);
      assert.ok(ammo.live >= GAME_CONFIG.AMMO.MIN_LIVE, '至少 1 發實彈');
      assert.ok(ammo.blank >= GAME_CONFIG.AMMO.MIN_BLANK, '至少 1 發空包彈');
      for (const shell of ammo.chamber) assert.ok(shell === 'LIVE' || shell === 'BLANK');
    }
  }
});

/* ------------------------------------------------------------------ */
/* 2. 實彈比例與權重相符                                               */
/* ------------------------------------------------------------------ */
check('實彈比例符合 config.AMMO.LIVE_WEIGHT（且不是寫死 0.5）', () => {
  const trials = 6000;
  let live = 0;
  let total = 0;
  for (let i = 0; i < trials; i++) {
    const ammo = engine.loadAmmo(GAME_CONFIG, 1);
    live += ammo.live;
    total += ammo.total;
  }
  const ratio = live / total;
  const expected = GAME_CONFIG.AMMO.LIVE_WEIGHT[0];
  assert.ok(Math.abs(ratio - expected) < 0.06, `實彈比例 ${ratio.toFixed(3)} 與權重 ${expected} 差太多`);
});

/* ------------------------------------------------------------------ */
/* 3. 改設定立即生效（沒有寫死）                                       */
/* ------------------------------------------------------------------ */
check('修改 config.AMMO 後，loadAmmo 的結果立刻跟著變', () => {
  const custom = JSON.parse(JSON.stringify(GAME_CONFIG));
  custom.AMMO.MIN_SHELLS = 6;
  custom.AMMO.MAX_SHELLS = 6;
  custom.AMMO.SHELLS_PER_ROUND_BASE = 6;
  custom.AMMO.SHELLS_PER_ROUND_JITTER = 0;
  custom.AMMO.LIVE_WEIGHT = 0.9;
  custom.AMMO.MIN_LIVE = 1;
  custom.AMMO.MIN_BLANK = 1;

  for (let i = 0; i < 300; i++) {
    const ammo = engine.loadAmmo(custom, 1);
    assert.strictEqual(ammo.total, 6, '應該剛好 6 發');
    assert.ok(ammo.live >= 4, `實彈應該偏多，實際 ${ammo.live}`);
  }
});

/* ------------------------------------------------------------------ */
/* 4. 洗牌真的有隨機                                                  */
/* ------------------------------------------------------------------ */
check('同一組設定下，子彈排列會出現多種不同順序', () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    seen.add(engine.loadAmmo(GAME_CONFIG, 4).chamber.join(','));
  }
  assert.ok(seen.size > 5, `只出現 ${seen.size} 種排列，洗牌可能失效`);
});

/* ------------------------------------------------------------------ */
/* 5. 開槍 / 連鎖 / 自動裝彈                                          */
/* ------------------------------------------------------------------ */
check('shoot()：實彈扣血、空包彈對自己保留回合、打空自動重新裝彈', () => {
  const game = engine.createGame({
    id: 'TEST',
    players: ['A', 'B'],
    names: { A: '甲', B: '乙' },
    io: { randomInt: (min, max) => min, rng: () => 0.5 }, // 決定性
  });

  const start = engine.execute(game, { type: 'START', playerId: 'A' });
  assert.ok(start.ok, '比賽應該能開始');
  assert.strictEqual(game.phase, 'playing');
  assert.ok(game.chamber.length > 0);

  const a = engine.getPlayer(game, 'A');
  const hpBefore = a.hp;
  const nextShell = game.chamber[0];

  const shot1 = engine.execute(game, { type: 'SHOOT', playerId: 'A' }, { targetId: 'A' });
  assert.ok(shot1.ok, 'A 打自己應該成功');

  if (nextShell === 'BLANK') {
    assert.strictEqual(a.hp, hpBefore, '空包彈不該扣血');
    assert.strictEqual(game.turn.activeId, 'A', '空包彈對自己應該保留回合');
  } else {
    assert.ok(a.hp < hpBefore, '實彈應該扣血');
  }

  // 把所有子彈打光，驗證會自動 reload
  let guard = 0;
  const roundsBefore = game.round;
  while (game.round === roundsBefore && game.phase === 'playing' && guard++ < 40) {
    const active = game.turn.activeId;
    engine.execute(game, { type: 'SHOOT', playerId: active }, { targetId: active });
  }
  assert.ok(game.round > roundsBefore || game.phase === 'gameover', '打空後應該重新裝彈（或分出勝負）');
});

/* ------------------------------------------------------------------ */
/* 6. 不洩漏子彈順序                                                  */
/* ------------------------------------------------------------------ */
check('getStateFor() 的公開狀態不含子彈順序', () => {
  const game = engine.createGame({ id: 'LEAK', players: ['A', 'B'] });
  engine.execute(game, { type: 'START', playerId: 'A' });

  const serialized = JSON.stringify(engine.getStateFor(game, 'A'));
  assert.ok(!serialized.includes('chamber'), '公開狀態不應該包含 chamber');
  assert.ok(!/"shells"\s*:\s*\["LIVE"/.test(serialized), '公開狀態不應該包含子彈序列');

  const state = engine.getStateFor(game, 'A');
  assert.strictEqual(Object.keys(state.public.remaining).sort().join(','), 'blank,live,total');
  assert.strictEqual(engine.getRevealedChamber(game), null, '遊戲中不該公開完整順序');
});

/* ------------------------------------------------------------------ */
/* 7. AI 完整對局                                                     */
/* ------------------------------------------------------------------ */
check('AI 對 AI 可以完整打完一局（不拋錯、不卡死）', () => {
  for (let match = 0; match < 25; match++) {
    const game = engine.createGame({
      id: `AI${match}`,
      players: ['X', 'Y'],
      names: { X: 'AI甲', Y: 'AI乙' },
      flags: { X: { isAI: true }, Y: { isAI: true } },
    });
    engine.execute(game, { type: 'START', playerId: 'X' });

    let steps = 0;
    while (game.phase === 'playing' && steps++ < 800) {
      const actor = game.turn.activeId;
      const intent = aiLogic.decide(game, actor);
      const res = engine.execute(game, { type: intent.type, playerId: actor }, intent.payload);
      if (!res.ok) {
        const fallback = engine.execute(game, { type: 'GUARD', playerId: actor });
        assert.ok(fallback.ok, `AI 保底動作失敗：${fallback.error}`);
      }
    }
    assert.ok(game.phase === 'gameover', `第 ${match} 局沒有結束（steps=${steps}）`);
    assert.ok(game.winnerId, '應該有勝者');
  }
});

/* ------------------------------------------------------------------ */
/* 8. 道具全部可用                                                    */
/* ------------------------------------------------------------------ */
check('每一件道具都能被使用且不拋錯', () => {
  for (const item of GAME_CONFIG.ITEMS) {
    const game = engine.createGame({ id: `ITEM-${item.id}`, players: ['A', 'B'] });
    engine.execute(game, { type: 'START', playerId: 'A' });
    const a = engine.getPlayer(game, 'A');
    a.items = [item.id, item.id, item.id];

    const res = engine.execute(game, { type: 'USE_ITEM', playerId: 'A' }, { itemId: item.id });
    assert.ok(res.ok, `道具 ${item.id} 使用失敗：${res.error}`);
    assert.ok(Array.isArray(res.actions) && res.actions.length > 0, `道具 ${item.id} 沒有產生任何 action`);
  }
});

/* ------------------------------------------------------------------ */
/* 9. 前端設定不洩漏                                                */
/* ------------------------------------------------------------------ */
check('getClientConfig() 不包含完整子彈權重曲線與其他秘密', () => {
  const client = GAME_CONFIG.getClientConfig();
  assert.ok(Array.isArray(client.ITEMS) && client.ITEMS.length > 0, '應該包含道具圖鑑');
  assert.strictEqual(client.AMMO.LIVE_WEIGHT, undefined, '不應該送出完整的輪次權重曲線');
  const json = JSON.stringify(client);
  assert.ok(!json.includes('SHUFFLE_MODE'), '不應該送出洗牌實作細節');
});

/* ------------------------------------------------------------------ */
/* 10. 任務 1：每輪開始的「本回合裝填」鎖 + 任務 2：道具發放           */
/* ------------------------------------------------------------------ */
check('RELOAD / AMMO_REVEAL 帶上本輪彈藥，且揭曉期間任何人（含 AI）都不能行動', () => {
  let clock = 1_000_000;
  const game = engine.createGame({
    id: 'REVEAL',
    players: ['A', 'B'],
    names: { A: '甲', B: '乙' },
    flags: { B: { isAI: true } },
    io: { now: () => clock },
  });
  // 測試預設把 3 秒鎖關掉了（DEVIL_REVEAL_MS=0），這裡手動把它裝回去
  game.revealUntil = clock + 3000;
  const start = engine.execute(game, { type: 'START', playerId: 'A' });
  assert.ok(start.ok, '比賽應該能開始');
  game.revealUntil = clock + 3000;

  const reload = start.actions.find((a) => a.type === 'RELOAD');
  assert.ok(reload, '開局應該有 RELOAD');
  assert.strictEqual(reload.live + reload.blank, reload.total, '實彈 + 空包 = 總數');
  assert.ok(reload.total >= GAME_CONFIG.AMMO.MIN_SHELLS, '子彈數應該符合設定下限');

  const reveal = start.actions.find((a) => a.type === 'AMMO_REVEAL');
  assert.ok(reveal, '應該有 AMMO_REVEAL 給前端播動畫');
  assert.strictEqual(reveal.live, reload.live);
  assert.strictEqual(reveal.blank, reload.blank);

  const blocked = engine.execute(game, { type: 'SHOOT', playerId: 'A' }, { targetId: 'B' });
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.error, 'AMMO_REVEAL', '揭曉期間應該拒絕開槍');

  clock += 3000;
  const open = engine.execute(game, { type: 'SHOOT', playerId: 'A' }, { targetId: 'B' });
  assert.ok(open.ok, '3 秒後應該可以開槍');
});

check('每輪自動發道具：第 1~2 輪 2 個、第 3 輪起 3 個（數量由 config 決定）', () => {
  const spec = GAME_CONFIG.AMMO.ITEMS_ON_RELOAD;

  const game = engine.createGame({ id: 'LOOT', players: ['A', 'B'] });
  engine.execute(game, { type: 'START', playerId: 'A' });
  const a = engine.getPlayer(game, 'A');
  assert.strictEqual(a.items.length, spec.BASE, `第 1 輪應發 ${spec.BASE} 個道具`);
  assert.strictEqual(engine._internals.itemGrantCount(game), spec.BASE);

  // 模擬「前兩輪打完」→ 第 3 輪重新裝彈
  a.items = [];
  game.round = spec.ESCALATE_FROM_ROUND - 1;
  game.chamber = [];
  const res = engine.execute(game, { type: 'SHOOT', playerId: 'A' }, { targetId: 'B' });
  assert.ok(res.ok, '空彈匣時應該自動裝彈');
  assert.strictEqual(game.round, spec.ESCALATE_FROM_ROUND, '應該進入第 3 輪');
  assert.strictEqual(a.items.length, spec.ESCALATED, `第 ${spec.ESCALATE_FROM_ROUND} 輪起應發 ${spec.ESCALATED} 個道具`);
});

/* ------------------------------------------------------------------ */
console.log(`\n全部通過：${passed} 項檢查 ✅\n`);
