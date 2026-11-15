'use strict';

/**
 * scripts/e2e.js —— 真的開兩個 Socket 客戶端打一局（驗證 server.js）
 * 用法：
 *   1) 另開終端機： npm start
 *   2) node scripts/e2e.js
 *
 * 驗證：
 *   - 建房 / 加入 / 開局事件都有正確廣播
 *   - 玩家收到 room:update（含自己的私人物品）與 game:action
 *   - 非輪到的玩家下指令會被拒絕
 *   - 公開的 room:update 不含子彈順序
 *   - 一局能打到 game:over + game:reveal
 */

const { io } = require('socket.io-client');

const URL = process.env.E2E_URL || 'http://localhost:3000';
const TIMEOUT = 40000;

function client(name) {
  const socket = io(URL, { transports: ['websocket'], forceNew: true });
  const c = { name, socket, last: null, actions: [], reveals: [], log: [] };
  socket.on('room:update', (payload) => {
    c.last = payload;
  });
  socket.on('game:action', (payload) => c.actions.push(...(payload.actions || [])));
  socket.on('game:reveal', (payload) => c.reveals.push(payload));
  return c;
}

function emit(socket, event, payload) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'ACK_TIMEOUT' }), 5000);
    socket.emit(event, payload, (res = {}) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`\nE2E：連線到 ${URL}\n`);

  const host = client('主持人');
  const guest = client('訪客');

  await Promise.all([host, guest].map((c) => new Promise((resolve) => c.socket.on('connect', resolve))));
  console.log('  ✓ 兩個客戶端已連線');

  const created = await emit(host.socket, 'room:create', { name: '主持人', mode: 'multi', maxPlayers: 2 });
  if (!created.ok) throw new Error(`建立房間失敗：${created.error}`);
  console.log(`  ✓ 房間已建立：${created.code}`);

  const joined = await emit(guest.socket, 'room:join', { code: created.code, name: '訪客' });
  if (!joined.ok) throw new Error(`加入房間失敗：${joined.error}`);
  console.log('  ✓ 第二位玩家已加入');

  const started = await emit(host.socket, 'game:start', {});
  if (!started.ok) throw new Error(`開局失敗：${started.error}`);
  await sleep(400);
  console.log('  ✓ 遊戲已開始');

  /* 任務 1：開局必須先送 AMMO_REVEAL，且揭曉期間的開槍會被拒絕 */
  const revealActions = host.actions.filter((a) => a.type === 'AMMO_REVEAL');
  if (!revealActions.length) throw new Error('開局沒有 AMMO_REVEAL（前端沒有彈藥提示可以播）');
  const firstReveal = revealActions[0];
  if (!(firstReveal.live >= 0) || !(firstReveal.blank >= 0)) throw new Error('AMMO_REVEAL 沒有帶實彈 / 空包數量');
  if (!(firstReveal.ms > 0)) throw new Error('AMMO_REVEAL 沒有帶揭曉時長');
  console.log(`  ✓ 開局彈藥提示：🔴 ${firstReveal.live} 發實彈 / 🔵 ${firstReveal.blank} 發空包彈（${firstReveal.ms}ms 後開始）`);

  // 揭曉期間的鎖：只有伺服器真的還在鎖（REVEAL_MS 夠長）時才驗，短揭曉的測試環境跳過
  const locked = await emit(host.socket, 'game:shoot', { targetId: created.youId });
  if (!locked.ok) {
    if (locked.error !== 'AMMO_REVEAL') throw new Error(`揭曉期間的拒絕碼不對：${locked.error}`);
    console.log('  ✓ 揭曉期間被鎖住（AMMO_REVEAL）');
  } else if (firstReveal.ms > 1200) {
    throw new Error('揭曉期間竟然可以開槍（伺服器沒有鎖住）');
  } else {
    console.log(`  ↷ 揭曉只有 ${firstReveal.ms}ms，鎖已解除，跳過這條`);
  }

  /* 任務 2：每位玩家開局就拿到 2 個道具 */
  const myItems = (host.last && host.last.game && host.last.game.private.items) || [];
  if (myItems.length !== 2) throw new Error(`開局道具數量應該要是 2 個，實際 ${myItems.length}`);
  console.log(`  ✓ 開局已自動發道具：${myItems.length} 個（${myItems.join(', ')}）`);

  // 等揭曉動畫結束（伺服器時間到會解鎖）
  await sleep(firstReveal.ms + 500);

  const sneak = await emit(guest.socket, 'game:shoot', { targetId: joined.youId });
  if (sneak.ok && host.last.game && host.last.game.public.activeId !== joined.youId) {
    throw new Error('非回合玩家竟然可以開槍');
  }
  console.log(`  ✓ 回合外玩家被拒絕（${sneak.error || '輪到他，正常'}）`);

  const leak = JSON.stringify(host.last);
  if (leak.includes('chamber')) throw new Error('room:update 洩漏了 chamber！');
  console.log('  ✓ room:update 沒有洩漏子彈順序');

  // 自動打完整局：誰的回合就由誰行動
  const players = { [created.youId]: host, [joined.youId]: guest };
  const deadline = Date.now() + TIMEOUT;
  let moves = 0;

  while (Date.now() < deadline) {
    const any = host.last && host.last.game ? host : guest.last && guest.last.game ? guest : null;
    if (!any) {
      await sleep(120);
      continue;
    }
    const pub = any.last.game.public;
    if (pub.phase === 'gameover') break;

    const active = pub.activeId;
    const seatState = players[active];
    if (!seatState) {
      // 輪到 AI：等它自己動
      await sleep(250);
      continue;
    }

    const me = seatState.last.game.public.players.find((p) => p.id === active);
    const enemies = seatState.last.game.public.players.filter((p) => p.id !== active && !p.dead);
    // 有一半機率打自己（驗證連鎖），否則打敵人
    const target = Math.random() < 0.5 || !enemies.length ? active : enemies[0].id;

    await emit(seatState.socket, 'game:shoot', { targetId: target });
    moves += 1;
    await sleep(140);
    void me;
  }

  await sleep(600);
  const finished = [host, guest].find((c) => c.last && c.last.game && c.last.game.public.phase === 'gameover');
  if (!finished) throw new Error(`遊戲在 ${TIMEOUT}ms 內沒有結束（moves=${moves}）`);

  console.log(`  ✓ 遊戲正常結束（共 ${moves} 次開槍）`);
  const reveals = [...host.reveals, ...guest.reveals];
  if (!reveals.length) throw new Error('結束時沒有送出 game:reveal');
  console.log(`  ✓ 結束時公開最終子彈順序：${reveals[0].chamber.join(', ') || '(空)'}`);

  const shotCount = host.actions.filter((a) => a.type === 'SHOT').length;
  console.log(`  ✓ 收到 SHOT 演出事件：${shotCount} 次`);

  /* DeepSeek 娘的台詞也要走 Socket 送到前端（TAUNT action） */
  const taunts = [...host.actions, ...guest.actions].filter((a) => a.type === 'TAUNT');
  if (!taunts.length) throw new Error('整場都沒有收到 TAUNT 台詞');
  for (const t of taunts) {
    if (typeof t.text !== 'string' || !t.text.length) throw new Error('TAUNT 沒有文字');
    if (t.speaker !== 'demon') throw new Error(`TAUNT speaker 異常：${t.speaker}`);
    if (!t.speakerName) throw new Error('TAUNT 沒有 speakerName');
    if ('chamber' in t || 'shells' in t) throw new Error('TAUNT 洩漏了子彈資訊');
  }
  const sample = taunts[0];
  console.log(`  ✓ 收到 DeepSeek 娘台詞 ${taunts.length} 句（例：${sample.eventType} → ${sample.text}）`);

  host.socket.close();
  guest.socket.close();
  console.log('\nE2E 全部通過 ✅\n');
  process.exit(0);
})().catch((err) => {
  console.error('\nE2E 失敗：', err.message, '\n');
  process.exit(1);
});
