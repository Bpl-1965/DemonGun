'use strict';

/**
 * scripts/test-dialogue.js —— 驗證 DeepSeek 娘台詞系統
 *   1. dialogue.js 每個情境都有台詞、不會回傳 undefined 型別
 *   2. gameEngine 在開槍 / 換彈 / 用道具 / 勝負時會產生 TAUNT action
 *   3. TAUNT 不含任何機密（只有文字與說話者）
 */

const assert = require('node:assert');
const dialogue = require('../logic/dialogue');
const engine = require('../logic/gameEngine');
const config = require('../config/gameConfig');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

console.log('\nDeepSeek 娘 · 台詞系統驗證\n');

/* ---------------------------------------------------------------- 1. 對話庫 */
check('dialogue.js 定義了所有必備情境', () => {
  const required = [
    'onPlayerShootSelf',
    'onPlayerShootDemon',
    'onDemonShoot',
    'onEmptyGun',
    'onGameStart',
    'onDemonHurt',
    'onPlayerBlank',
    'onVictory',
    'onDefeat',
  ];
  for (const key of required) {
    assert.ok(dialogue.hasTaunt(key), `缺少情境 ${key}`);
    assert.ok(Array.isArray(dialogue.TAUNTS[key]) && dialogue.TAUNTS[key].length >= 3, `${key} 台詞太少`);
  }
});

check('getTaunt() 回的永遠是字串（且會插值 {demon} / {damage}）', () => {
  for (const eventType of dialogue.EVENT_TYPES) {
    const text = dialogue.getTaunt(eventType, { rng: () => 0.42, chance: 1, vars: { demon: 'DeepSeek 娘', damage: 2 } });
    assert.strictEqual(typeof text, 'string', `${eventType} 沒有回字串`);
    assert.ok(!text.includes('{'), `${eventType} 有未填的佔位符：${text}`);
  }
});

check('機率 0 時不說話，機率 1 時一定說話', () => {
  dialogue.resetRecent();
  assert.strictEqual(dialogue.getTaunt('onDemonShoot', { rng: () => 0.99, chance: 0 }), null);
  assert.strictEqual(typeof dialogue.getTaunt('onDemonShoot', { rng: () => 0.01, chance: 1 }), 'string');
});

check('同一情境不會連續回同一句', () => {
  dialogue.resetRecent('onDemonBlank');
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    seen.add(dialogue.getTaunt('onDemonBlank', { rng: () => Math.random(), chance: 1 }));
  }
  assert.ok(seen.size > 1, '台詞完全重複，隨機失效');
});

/* ------------------------------------------------------------ 2. 引擎插樁 */
let CLOCK = 1_000_000; // 可控時鐘：冷卻 / 節奏測試都靠它
const clock = () => CLOCK;

function newGame(seedRng) {
  const g = engine.createGame({
    id: 'test',
    players: ['p1', 'ai1'],
    names: { p1: '玩家', ai1: 'DeepSeek 娘' },
    flags: { ai1: { isAI: true } },
    io: { now: clock },
  });
  if (seedRng) g.rng = seedRng;
  return g;
}

check('開局會有一句開場台詞（speaker = demon）', () => {
  const g = newGame();
  const res = engine.execute(g, { type: 'START', playerId: 'p1' });
  assert.ok(res.ok, res.error);
  const taunts = res.actions.filter((a) => a.type === 'TAUNT');
  assert.strictEqual(taunts.length, 1, `開場台詞數 = ${taunts.length}`);
  assert.strictEqual(taunts[0].speaker, 'demon');
  assert.strictEqual(taunts[0].speakerName, 'DeepSeek 娘');
  assert.ok(typeof taunts[0].text === 'string' && taunts[0].text.length > 0);
});

check('開槍時有機會出現 TAUNT，且不含 chamber / 子彈順序', () => {
  const g = newGame();
  engine.execute(g, { type: 'START', playerId: 'p1' });

  let total = 0;
  let tauntCount = 0;
  for (let i = 0; i < 300 && g.phase === 'playing'; i++) {
    CLOCK += 2000; // 讓冷卻（900ms）不會擋住每一槍
    const id = g.turn.activeId;
    const others = g.players.filter((p) => p.id !== id && !p.dead);
    const targetId = others.length && Math.random() < 0.5 ? others[0].id : id;
    const res = engine.execute(g, { type: 'SHOOT', playerId: id }, { targetId });
    if (!res.ok) continue;
    total += 1;
    for (const a of res.actions) {
      if (a.type !== 'TAUNT') continue;
      tauntCount += 1;
      assert.strictEqual(a.type, 'TAUNT');
      assert.ok(!('chamber' in a), 'TAUNT 洩漏了子彈順序');
      assert.deepStrictEqual(
        Object.keys(a).sort(),
        ['eventType', 'speaker', 'speakerId', 'speakerName', 'text', 'type'],
        `TAUNT 欄位異常：${Object.keys(a).join(',')}`,
      );
    }
  }
  assert.ok(total > 5, '開槍次數太少');
  assert.ok(tauntCount > 0, '300 次開槍完全沒有台詞，插樁沒有生效');
  console.log(`      （開槍 ${total} 次，觸發台詞 ${tauntCount} 次）`);
});

check('換彈（新一輪）會產生 onReload / onEmptyGun 台詞', () => {
  const g = newGame();
  engine.execute(g, { type: 'START', playerId: 'p1' });

  let reloadTaunts = 0;
  for (let i = 0; i < 600 && g.phase === 'playing'; i++) {
    CLOCK += 2000;
    const id = g.turn.activeId;
    const res = engine.execute(g, { type: 'SHOOT', playerId: id }, { targetId: id });
    if (!res.ok) continue;
    for (const a of res.actions) {
      if (a.type === 'TAUNT' && (a.eventType === 'onReload' || a.eventType === 'onEmptyGun')) reloadTaunts += 1;
    }
  }
  assert.ok(reloadTaunts > 0, '換彈時沒有台詞');
});

check('DIALOGUE.ENABLED = false 時 tauntAction 直接回 null', () => {
  const g = newGame();
  engine.execute(g, { type: 'START', playerId: 'p1' });

  // 不經過 execute()（execute 會 syncConfig 把設定還原），直接測台詞產生器
  const { tauntAction } = engine._internals;
  g.config.DIALOGUE.CHANCE.onDemonShoot = 1;
  assert.strictEqual(typeof tauntAction(g, 'onDemonShoot', {}), 'object');

  g.config.DIALOGUE.ENABLED = false;
  assert.strictEqual(tauntAction(g, 'onDemonShoot', {}), null);

  g.config.DIALOGUE.ENABLED = true;
  g.config.DIALOGUE.CHANCE.onDemonShoot = 0;
  assert.strictEqual(tauntAction(g, 'onDemonShoot', {}), null, '機率 0 仍然開口');
});

check('COOLDOWN_MS 內不會連續開口', () => {
  const g = newGame();
  engine.execute(g, { type: 'START', playerId: 'p1' });
  const { tauntAction } = engine._internals;
  g.config.DIALOGUE.CHANCE.onDemonShoot = 1;
  g.config.DIALOGUE.COOLDOWN_MS = 5000;
  g._tauntAt = 0;

  const first = tauntAction(g, 'onDemonShoot', {});
  const second = tauntAction(g, 'onDemonShoot', {});
  assert.ok(first && !second, '冷卻沒有生效');
});

check('getClientConfig() 有 DIALOGUE 但不洩漏機率表', () => {
  const exposed = config.getClientConfig();
  assert.ok(exposed.DIALOGUE, 'DIALOGUE 沒有送到前端');
  assert.strictEqual(exposed.DIALOGUE.PORTRAIT, 'deepseek_girl.png');
  assert.ok(exposed.DIALOGUE.PORTRAIT_SIZE > 0);
  assert.strictEqual(exposed.DIALOGUE.CHANCE, undefined, '不該把機率表送到前端');
});

check('單人模式的 AI 名字是「DeepSeek 娘」', () => {
  assert.strictEqual(config.RULES.ENEMY_NAMES[0], 'DeepSeek 娘');
});

/* ------------------------------------------------------------------ 收尾 */
console.log('');
if (fail) {
  console.log(`失敗 ${fail} 項，通過 ${pass} 項 ❌\n`);
  process.exit(1);
}
console.log(`全部通過：${pass} 項檢查 ✅\n`);
