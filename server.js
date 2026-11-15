'use strict';

/**
 * ============================================================================
 *  惡魔輪盤《DEVIL ROULETTE》—— Express + Socket.io 後端
 * ============================================================================
 *  啟動： node server.js        （或 npm start，預設 http://localhost:3000）
 *  自訂埠： PORT=4000 node server.js
 *
 *  架構
 *    Rooms（記憶體）          → 房間 / 玩家 / 座位
 *    gameEngine（logic/）     → 唯一的規則與狀態來源
 *    aiLogic（logic/）        → AI 決策（只回傳意圖，結算仍走 gameEngine）
 *    本檔只做：I/O、權限檢查、回合計時、AI 排程、狀態同步
 *
 *  同步原則（洩漏防護）
 *    - 'room:update'  給「整個房間」：公開狀態 + 你自己的私人物品
 *    - 'game:action'  給「整個房間」：只含可公開的演出（不含子彈順序）
 *    - 'player:intel' 只發給「你」：預知到的子彈順序
 *    - 子彈順序只有在 gameover 時才透過 'game:reveal' 公開
 * ============================================================================
 */

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');

const GAME_CONFIG = require('./config/gameConfig');
const engine = require('./logic/gameEngine');
const aiLogic = require('./logic/aiLogic');

const PORT = Number(process.env.PORT) || 3000;
const SOCKET_PATH = process.env.SOCKET_PATH || '/socket.io';
/** 一隻 AI 在同一個回合最多能做幾步（用道具不消耗回合，設上限防死循環） */
const AI_MAX_STEPS_PER_TURN = 8;

/* ========================================================================== */
/*  1. Express 靜態檔                                                         */
/* ========================================================================== */

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  path: SOCKET_PATH,
  cors: { origin: process.env.CORS_ORIGIN || '*' },
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
// Three.js（本地安裝版本）：優先由 /vendor/three/* 提供，前端會優先用它、失敗才退回 CDN
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three', 'build')));
app.get('/api/config', (req, res) => res.json(GAME_CONFIG.getClientConfig()));
app.get('/api/health', (req, res) => res.json({ ok: true, rooms: rooms.size, uptime: process.uptime() }));

/* ========================================================================== */
/*  2. 記憶體房間                                                             */
/* ========================================================================== */

/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {Map<string, string>}  socket.id -> roomCode */
const socketRoom = new Map();

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeRoomCode() {
  const len = GAME_CONFIG.TIMING.ROOM_CODE_LENGTH;
  for (let attempt = 0; attempt < 200; attempt++) {
    let code = '';
    for (let i = 0; i < len; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return `R${Date.now().toString(36).slice(-len).toUpperCase()}`;
}

function sanitize(value, maxLen = 16) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, maxLen);
}

/**
 * @typedef {object} Room
 * @property {string} code
 * @property {'lobby'|'playing'|'gameover'} phase
 * @property {object[]} seats  { id, name, isAI, isHost, connected, socketId, rematch }
 * @property {object|null} game
 * @property {Function|null} aiTimer
 * @property {Function|null} turnTimer
 * @property {number} turnDeadline
 */

function createRoom(hostSocket, { name, mode, maxPlayers }) {
  const code = makeRoomCode();
  const room = {
    code,
    phase: 'lobby',
    mode: mode === 'multi' ? 'multi' : 'single',
    maxPlayers: Math.max(2, Math.min(GAME_CONFIG.RULES.MAX_PLAYERS, Number(maxPlayers) || 2)),
    seats: [],
    game: null,
    aiTimer: null,
    turnTimer: null,
    turnDeadline: 0,
    createdAt: Date.now(),
  };
  rooms.set(code, room);

  const seat = makeSeat(hostSocket.id, name, { isHost: true });
  room.seats.push(seat);
  hostSocket.join(code);
  socketRoom.set(hostSocket.id, code);
  return room;
}

let seatCounter = 0;
function makeSeat(socketId, name, opts = {}) {
  seatCounter += 1;
  return {
    id: `P${seatCounter.toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    name: sanitize(name) || `玩家 ${seatCounter}`,
    isAI: Boolean(opts.isAI),
    isHost: Boolean(opts.isHost),
    connected: !opts.isAI,
    socketId: socketId || null,
    rematch: false,
  };
}

function getRoomOf(socket) {
  const code = socketRoom.get(socket.id);
  return code ? rooms.get(code) : null;
}

function getSeat(room, socket) {
  return room.seats.find((s) => s.socketId === socket.id) || null;
}

function connectedHumans(room) {
  return room.seats.filter((s) => !s.isAI && s.connected);
}

function AI_NAMES(room) {
  const used = new Set(room.seats.map((s) => s.name));
  return GAME_CONFIG.RULES.ENEMY_NAMES.filter((n) => !used.has(n));
}

function addAI(room) {
  const pool = AI_NAMES(room);
  const name = pool.length ? pool[0] : `AI ${room.seats.filter((s) => s.isAI).length + 1}`;
  const seat = makeSeat(null, name, { isAI: true });
  room.seats.push(seat);
  return seat;
}

/* ========================================================================== */
/*  3. 遊戲生命週期                                                           */
/* ========================================================================== */

function startGame(room, bySeat) {
  if (room.phase === 'playing') return { ok: false, error: 'ALREADY_PLAYING' };
  if (!bySeat || !bySeat.isHost) return { ok: false, error: 'NOT_HOST' };

  // 單人模式：保證有 1 個 AI 對手
  if (room.mode === 'single' && room.seats.filter((s) => s.isAI).length === 0) addAI(room);

  // 多人模式：主持人開始時，空位自動補 AI（可在 config 關閉）
  if (room.mode === 'multi' && !GAME_CONFIG.RULES.HUMAN_ONLY && room.seats.length < 2) {
    while (room.seats.length < 2) addAI(room);
  }

  if (room.seats.length < 2) return { ok: false, error: 'NEED_OPPONENT' };

  room.seats.forEach((s) => {
    s.rematch = false;
  });

  const ids = room.seats.map((s) => s.id);
  const names = Object.fromEntries(room.seats.map((s) => [s.id, s.name]));
  const flags = Object.fromEntries(room.seats.map((s) => [s.id, { isAI: s.isAI, isBoss: s.isAI }]));

  room.game = engine.createGame({ id: room.code, players: ids, names, flags });
  room.phase = 'playing';

  const result = engine.execute(room.game, { type: 'START', playerId: room.seats[0].id });
  if (!result.ok) {
    room.phase = 'lobby';
    return result;
  }

  broadcast(room, result.actions);
  scheduleAfterBroadcast(room);
  return result;
}

/** 把 engine 產生的 actions 廣播出去（含私密資訊的分流） */
function broadcast(room, actions = []) {
  const game = room.game;
  if (!game) return;

  // ① 公開演出：清掉任何可能含子彈順序的欄位（保險層）
  const publicActions = actions.map((action) => redactAction(room, action));
  io.to(room.code).emit('game:action', { code: room.code, actions: publicActions });

  // ② 每人一份自己的狀態 + 自己的預知
  for (const seat of room.seats) {
    if (seat.isAI) continue;
    if (seat.socketId) {
      const socket = io.sockets.sockets.get(seat.socketId);
      if (socket) emitState(socket, room, seat.id);
    }
  }

  // ③ 遊戲結束：公開完整順序（唯一合法的洩漏時機）
  if (game.phase === 'gameover') {
    room.phase = 'gameover';
    const revealed = engine.getRevealedChamber(game);
    room.seats.forEach((s) => {
      s.rematch = false;
    });
    io.to(room.code).emit('game:reveal', { chamber: revealed, winnerId: game.winnerId });
  }

  broadcastLobby(room);
}

function redactAction(room, action) {
  if (!action || typeof action !== 'object') return action;
  const clone = JSON.parse(JSON.stringify(action));
  // 只允許本人看到的情報一律從公開廣播中刪除
  if (clone.type === 'PEEK') delete clone.shells;
  if (clone.type === 'INTEL_NEXT_ROUND') delete clone.shells;
  if (Array.isArray(clone.intel)) delete clone.intel;
  if (clone && clone.pending) delete clone.pending;
  return clone;
}

function emitState(socket, room, playerId) {
  const game = room.game;
  const seat = room.seats.find((s) => s.id === playerId);
  const payload = {
    code: room.code,
    mode: room.mode,
    phase: room.phase,
    youId: playerId,
    seat: seat ? { id: seat.id, name: seat.name, isHost: seat.isHost, isAI: seat.isAI } : null,
    turnDeadline: room.turnDeadline,
    revealUntil: game ? game.revealUntil || 0 : 0,
    revealMs: game ? game.revealMs || 0 : 0,
    game: game ? engine.getStateFor(game, playerId) : null,
    seats: publicSeats(room),
    config: GAME_CONFIG.getClientConfig(),
  };
  socket.emit('room:update', payload);
}

function publicSeats(room) {
  return room.seats.map((s) => ({
    id: s.id,
    name: s.name,
    isAI: s.isAI,
    isHost: s.isHost,
    connected: s.connected,
    rematch: s.rematch,
  }));
}

function broadcastLobby(room) {
  const payload = {
    code: room.code,
    mode: room.mode,
    maxPlayers: room.maxPlayers,
    phase: room.phase,
    seats: publicSeats(room),
  };
  io.to(room.code).emit('lobby:update', payload);
  // 遊戲中 / 回合變化也順便更新每個人的狀態（含倒數）
  if (room.game) {
    for (const seat of room.seats) {
      if (seat.isAI || !seat.socketId) continue;
      const socket = io.sockets.sockets.get(seat.socketId);
      if (socket) emitState(socket, room, seat.id);
    }
  }
}

/* ========================================================================== */
/*  4. 回合控制：AI + 超時                                                   */
/* ========================================================================== */

function clearTimers(room) {
  if (room.aiTimer) clearTimeout(room.aiTimer);
  if (room.turnTimer) clearTimeout(room.turnTimer);
  if (room.revealTimer) clearTimeout(room.revealTimer);
  room.aiTimer = null;
  room.turnTimer = null;
  room.revealTimer = null;
  room.turnDeadline = 0;
}

/**
 * 任務 1：裝彈揭曉鎖。每一輪開始的前 REVEAL_MS（設定在 config.AMMO.AMMO_REVEAL）
 * 只播「本回合裝填」動畫，任何人（含 AI）都不能行動；時間到才排 AI / 開回合計時。
 */
function armRevealTimer(room) {
  clearTimers(room);
  const game = room.game;
  if (!game || game.phase !== 'playing') return false;

  const remaining = engine._internals.revealRemainingMs(game);
  if (remaining <= 0) return false;

  room.revealTimer = setTimeout(() => {
    room.revealTimer = null;
    if (!room.game || room.game.phase !== 'playing') return;
    const result = engine._internals.releaseReveal(room.game);
    if (result.ok) broadcast(room, result.actions);
    scheduleAfterBroadcast(room);
  }, remaining);
  return true;
}

/** 廣播之後呼叫：決定下一個是 AI 還是玩家，並排定計時器 */
function scheduleAfterBroadcast(room) {
  clearTimers(room);
  const game = room.game;
  if (!game || game.phase !== 'playing') return;

  // 還在播「本回合裝填」→ 整個遊戲先暫停，時間到再下來排
  if (armRevealTimer(room)) return;

  const activeSeat = room.seats.find((s) => s.id === game.turn.activeId);
  if (!activeSeat) return;

  if (activeSeat.isAI) {
    const delay = aiLogic.thinkDelay(game);
    room.aiTimer = setTimeout(() => runAITurn(room, activeSeat.id), delay);
    return;
  }

  if (!activeSeat.connected) {
    // 斷線玩家：給一點時間重連，不行就跳過
    room.turnTimer = setTimeout(() => skipDisconnected(room), GAME_CONFIG.TIMING.RECONNECT_GRACE_MS);
    return;
  }

  const timeoutMs = GAME_CONFIG.RULES.TURN_TIMEOUT_MS;
  if (timeoutMs > 0) {
    room.turnDeadline = Date.now() + timeoutMs;
    room.turnTimer = setTimeout(() => {
      if (!room.game || room.game.phase !== 'playing') return;
      const result = engine.execute(room.game, { type: 'TIMEOUT', playerId: activeSeat.id });
      if (result.ok) {
        broadcast(room, [{ type: 'NOTICE', code: 'TURN_TIMEOUT', playerId: activeSeat.id }, ...result.actions]);
        scheduleAfterBroadcast(room);
      }
    }, timeoutMs);
  }
}

function skipDisconnected(room) {
  const game = room.game;
  if (!game || game.phase !== 'playing') return;
  const seat = room.seats.find((s) => s.id === game.turn.activeId);
  if (!seat || seat.connected) return;
  const result = engine.execute(game, { type: 'GUARD', playerId: seat.id });
  if (result.ok) {
    broadcast(room, [{ type: 'NOTICE', code: 'PLAYER_SKIPPED', playerId: seat.id }, ...result.actions]);
    scheduleAfterBroadcast(room);
  }
}

/**
 * AI 的一步：用 aiLogic 決定意圖 → gameEngine 結算 → 廣播 → 排下一步。
 * AI 使用道具不消耗回合，因此迴圈會繼續；設安全上限避免無限迴圈。
 */
function runAITurn(room, seatId) {
  room.aiTimer = null;
  const game = room.game;
  if (!game || game.phase !== 'playing' || game.turn.activeId !== seatId) return;

  for (let step = 0; step < AI_MAX_STEPS_PER_TURN; step++) {
    const intent = aiLogic.decide(game, seatId);
    const result = engine.execute(game, { type: intent.type, playerId: seatId }, intent.payload);

    if (!result.ok) {
      // AI 算出來的意圖被規則拒絕（例如道具狀態變了）：改用保底行動
      const fallback = engine.execute(game, { type: 'GUARD', playerId: seatId });
      if (fallback.ok) broadcast(room, fallback.actions);
      break;
    }

    broadcast(room, result.actions);

    // 用道具不消耗回合 → 繼續這隻 AI 的回合；開槍則結束本步
    if (intent.type !== 'USE_ITEM') break;
    if (game.phase !== 'playing' || game.turn.activeId !== seatId) break;
  }

  scheduleAfterBroadcast(room);
}

/** 玩家行動後：清掉舊計時器，讓 scheduleAfterBroadcast 重新排 */
function afterHumanAction(room) {
  scheduleAfterBroadcast(room);
}

/* ========================================================================== */
/*  5. Socket.io 事件                                                         */
/* ========================================================================== */

io.on('connection', (socket) => {
  socket.emit('server:hello', {
    version: GAME_CONFIG.VERSION,
    config: GAME_CONFIG.getClientConfig(),
    limits: { ROOM_CODE_LENGTH: GAME_CONFIG.TIMING.ROOM_CODE_LENGTH },
  });

  /* ---------------------------- 建立房間 ---------------------------- */
  socket.on('room:create', (payload = {}, ack) => {
    try {
      const existing = getRoomOf(socket);
      if (existing) leaveRoom(socket, existing, { silent: true });

      const mode = payload.mode === 'multi' ? 'multi' : 'single';
      const room = createRoom(socket, {
        name: payload.name,
        mode,
        maxPlayers: mode === 'single' ? 2 : payload.maxPlayers,
      });

      emitState(socket, room, room.seats[0].id);
      broadcastLobby(room);
      if (typeof ack === 'function') ack({ ok: true, code: room.code, youId: room.seats[0].id });
    } catch (err) {
      console.error('[room:create]', err);
      if (typeof ack === 'function') ack({ ok: false, error: 'SERVER_ERROR' });
    }
  });

  /* ---------------------------- 加入房間 ---------------------------- */
  socket.on('room:join', (payload = {}, ack) => {
    const code = sanitize(payload.code, 8).toUpperCase();
    const room = rooms.get(code);
    if (!room) return ack && ack({ ok: false, error: 'ROOM_NOT_FOUND' });

    // 斷線重連：同名且原本的座位還空著
    const name = sanitize(payload.name);
    const reconnected = room.seats.find((s) => !s.isAI && !s.connected && s.name === name);

    if (reconnected) {
      reconnected.connected = true;
      reconnected.socketId = socket.id;
      socket.join(room.code);
      socketRoom.set(socket.id, room.code);
      if (room.game && room.game.phase === 'playing') scheduleAfterBroadcast(room);
      emitState(socket, room, reconnected.id);
      broadcastLobby(room);
      return ack && ack({ ok: true, code: room.code, youId: reconnected.id, reconnected: true });
    }

    if (room.phase !== 'lobby') return ack && ack({ ok: false, error: 'GAME_IN_PROGRESS' });
    if (room.seats.length >= room.maxPlayers) return ack && ack({ ok: false, error: 'ROOM_FULL' });

    const seat = makeSeat(socket.id, name, { isHost: false });
    room.seats.push(seat);
    socket.join(room.code);
    socketRoom.set(socket.id, room.code);

    emitState(socket, room, seat.id);
    broadcastLobby(room);
    if (typeof ack === 'function') ack({ ok: true, code: room.code, youId: seat.id });
  });

  /* ---------------------------- 開始遊戲 ---------------------------- */
  socket.on('game:start', (payload = {}, ack) => {
    const room = getRoomOf(socket);
    if (!room) return ack && ack({ ok: false, error: 'NOT_IN_ROOM' });
    const seat = getSeat(room, socket);
    const result = startGame(room, seat);
    if (typeof ack === 'function') ack({ ok: result.ok, error: result.error });
  });

  /* ---------------------------- 再來一局 ---------------------------- */
  socket.on('game:rematch', (payload = {}, ack) => {
    const room = getRoomOf(socket);
    if (!room) return ack && ack({ ok: false, error: 'NOT_IN_ROOM' });
    const seat = getSeat(room, socket);
    if (!seat) return ack && ack({ ok: false, error: 'NOT_IN_ROOM' });

    const inGame = room.game && (room.game.phase === 'playing' || room.game.phase === 'waiting');
    if (inGame) return ack && ack({ ok: false, error: 'GAME_IN_PROGRESS' });

    if (room.phase === 'gameover') {
      room.phase = 'lobby';
      room.game = null;
    }
    seat.rematch = true;
    broadcastLobby(room);

    // 所有「連線中的人類」都按了再開 → 由主持人開局
    const humans = connectedHumans(room);
    const everyoneReady = humans.every((s) => s.rematch);
    if (!everyoneReady) return ack && ack({ ok: true, waiting: true });

    const host = room.seats.find((s) => s.isHost && !s.isAI) || humans[0];
    if (!host) return ack && ack({ ok: false, error: 'NO_HOST' });

    // 主持人在線：由主持人開局；主持人剛好離線：把主持人身分交給第一位在線人類
    if (!host.connected) {
      host.isHost = false;
      const successor = humans[0];
      successor.isHost = true;
      return ack && ack({ ok: true, waiting: true });
    }
    const result = startGame(room, host);
    return ack && ack({ ok: result.ok, error: result.error });
  });

  /* ---------------------------- 回到大廳 ---------------------------- */
  socket.on('room:lobby', (payload = {}, ack) => {
    const room = getRoomOf(socket);
    if (!room) return ack && ack({ ok: false, error: 'NOT_IN_ROOM' });
    const seat = getSeat(room, socket);
    if (!seat || !seat.isHost) return ack && ack({ ok: false, error: 'NOT_HOST' });
    room.phase = 'lobby';
    room.game = null;
    room.seats.forEach((s) => {
      s.rematch = false;
    });
    clearTimers(room);
    broadcastLobby(room);
    ack && ack({ ok: true });
  });

  /* ---------------------------- 遊戲指令 ---------------------------- */
  socket.on('game:shoot', (payload = {}, ack) => {
    handleIntent(socket, { type: 'SHOOT' }, payload, ack);
  });

  socket.on('game:item', (payload = {}, ack) => {
    handleIntent(socket, { type: 'USE_ITEM' }, payload, ack);
  });

  /* ---------------------------- 離開房間 ---------------------------- */
  socket.on('room:leave', (payload = {}, ack) => {
    const room = getRoomOf(socket);
    if (room) leaveRoom(socket, room, {});
    ack && ack({ ok: true });
  });

  socket.on('disconnect', () => {
    const room = getRoomOf(socket);
    socketRoom.delete(socket.id);
    if (!room) return;

    const seat = room.seats.find((s) => s.socketId === socket.id);
    if (!seat) return;

    if (room.phase === 'lobby') {
      // 還沒開始：直接移除座位
      room.seats = room.seats.filter((s) => s !== seat);
      if (!room.seats.some((s) => !s.isAI)) {
        rooms.delete(room.code);
        return;
      }
      if (seat.isHost) {
        const nextHost = room.seats.find((s) => !s.isAI);
        if (nextHost) nextHost.isHost = true;
      }
      broadcastLobby(room);
      return;
    }

    // 遊戲中：保留座位（可重連），若正輪到他則給寬限期
    seat.connected = false;
    seat.socketId = null;
    broadcastLobby(room);
    if (room.game && room.game.turn.activeId === seat.id) {
      clearTimers(room);
      room.turnTimer = setTimeout(() => skipDisconnected(room), GAME_CONFIG.TIMING.RECONNECT_GRACE_MS);
    }
  });
});

function handleIntent(socket, intent, payload, ack) {
  const room = getRoomOf(socket);
  if (!room) return ack && ack({ ok: false, error: 'NOT_IN_ROOM' });
  if (!room.game) return ack && ack({ ok: false, error: 'NO_GAME' });

  const seat = getSeat(room, socket);
  if (!seat) return ack && ack({ ok: false, error: 'NOT_IN_ROOM' });
  if (room.game.phase !== 'playing') return ack && ack({ ok: false, error: 'GAME_NOT_PLAYING' });
  if (room.game.turn.activeId !== seat.id) return ack && ack({ ok: false, error: 'NOT_YOUR_TURN' });

  // 只接受白名單欄位
  const clean = {};
  if (payload && typeof payload.targetId === 'string') clean.targetId = payload.targetId.slice(0, 32);
  if (payload && typeof payload.itemId === 'string') clean.itemId = payload.itemId.slice(0, 32);
  if (intent.type === 'SHOOT' && !payload?.targetId) clean.targetId = seat.id;

  const result = engine.execute(room.game, { type: intent.type, playerId: seat.id }, clean);
  if (!result.ok) return ack && ack({ ok: false, error: result.error });

  broadcast(room, result.actions);
  afterHumanAction(room);
  ack && ack({ ok: true, version: result.version });
}

function leaveRoom(socket, room, { silent = false } = {}) {
  const seat = room.seats.find((s) => s.socketId === socket.id);
  socket.leave(room.code);
  socketRoom.delete(socket.id);
  if (!seat) return;

  if (room.phase === 'lobby') {
    room.seats = room.seats.filter((s) => s !== seat);
    if (seat.isHost) {
      const nextHost = room.seats.find((s) => !s.isAI);
      if (nextHost) nextHost.isHost = true;
    }
  } else {
    seat.connected = false;
    seat.socketId = null;
  }

  if (!room.seats.some((s) => !s.isAI)) {
    clearTimers(room);
    rooms.delete(room.code);
    return;
  }
  if (!silent) broadcastLobby(room);
}

/* ========================================================================== */
/*  6. 啟動                                                                   */
/* ========================================================================== */

server.listen(PORT, () => {
  const where = `http://localhost:${PORT}`;
  console.log('');
  console.log('  🎲  惡魔輪盤 DEVIL ROULETTE 已啟動');
  console.log(`  ➜  ${where}`);
  console.log(`  ➜  區網多人：http://<你的區網 IP>:${PORT}`);
  console.log(`  ➜  子彈規則：${GAME_CONFIG.AMMO.MIN_SHELLS}~${GAME_CONFIG.AMMO.MAX_SHELLS} 發 / 輪，實彈權重 ${JSON.stringify(GAME_CONFIG.AMMO.LIVE_WEIGHT)}`);
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n  關閉伺服器…');
  for (const room of rooms.values()) clearTimers(room);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});

module.exports = { app, server, io, rooms };
