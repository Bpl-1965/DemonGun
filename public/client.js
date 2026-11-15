/* ==========================================================================
   惡魔輪盤 DEVIL ROULETTE — 前端（純 2D，不依賴 Three.js）
   --------------------------------------------------------------------------
   這一支只做三件事：
     1. 把 server 送來的 room:update / game:action 畫成 2D 介面
     2. 把玩家的點擊（對自己開槍 / 對敵人開槍 / 用道具）送成 socket 指令
     3. 播 VFX（震動、血濺、霓虹、扣血數字）與 DeepSeek 娘台詞
   所有遊戲規則都在 server（config/gameConfig.js + logic/gameEngine.js），
   前端不判斷勝負、不判斷能否開槍，只照狀態顯示（單一真相來源）。
   ========================================================================== */
(function () {
  'use strict';

  /* ========================================================================== */
  /*  0. 小工具                                                                 */
  /* ========================================================================== */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const rand = (min, max) => min + Math.random() * (max - min);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function setText(node, value) {
    if (node && node.textContent !== String(value)) node.textContent = String(value);
  }

  function safeStorageGet(key, fallback = '') {
    try {
      return window.localStorage.getItem(key) || fallback;
    } catch (err) {
      return fallback;
    }
  }

  function safeStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (err) {
      /* 無痕模式等情況忽略 */
    }
  }

  /* ========================================================================== */
  /*  1. 全域狀態                                                               */
  /* ========================================================================== */
  const RANDOM_NAME = '玩家' + Math.floor(1000 + Math.random() * 9000);

  const state = {
    socket: null,
    connected: false,
    room: null,       // 最近一次 room:update 的原始 payload
    youId: null,
    game: null,       // { public, private }
    config: null,     // /socket hello 或 /api/config 送來的公開設定
    seats: [],
    mode: 'single',
    turnDeadline: 0,
    selectedTarget: null,
    busy: false,
    soundOn: true,
    revealTimers: [],   // 任務1：本回合裝填提示的計時器
    revealShowing: false
  };

  /* ========================================================================== */
  /*  2. DOM 快取                                                               */
  /* ========================================================================== */
  const dom = {
    app: $('#app'),
    // 圖層
    vfxFlash: $('#vfxFlash'),
    vfxBlood: $('#vfxBlood'),
    vfxParticles: $('#vfxParticles'),
    damageFloat: $('#damageFloat'),
    // 任務1：本回合裝填
    ammoReveal: $('#ammoReveal'),
    revealRound: $('#revealRound'),
    revealLive: $('#revealLive'),
    revealBlank: $('#revealBlank'),
    revealBar: $('#revealBar'),
    revealCountdown: $('#revealCountdown'),
    // 頂欄
    connDot: $('#connDot'),
    connText: $('#connText'),
    btnMute: $('#btnMute'),
    btnHowTo: $('#btnHowTo'),
    versionTag: $('#versionTag'),
    // 大廳
    screenLobby: $('#screenLobby'),
    screenGame: $('#screenGame'),
    inputName: $('#inputName'),
    inputCode: $('#inputCode'),
    btnCreate: $('#btnCreate'),
    btnJoin: $('#btnJoin'),
    fieldMaxPlayers: $('#fieldMaxPlayers'),
    selectMaxPlayers: $('#selectMaxPlayers'),
    lobbyHint: $('#lobbyHint'),
    codex: $('#codex'),
    // HUD
    hudCode: $('#hudCode'),
    hudRound: $('#hudRound'),
    countLive: $('#countLive'),
    countBlank: $('#countBlank'),
    countTotal: $('#countTotal'),
    shellCounter: $('#shellCounter'),
    turnTimer: $('#turnTimer'),
    turnBanner: $('#turnBanner'),
    btnQuit: $('#btnQuit'),
    // 左欄：生命值
    hpPanel: $('#hpPanel'),
    hpName: $('#hpName'),
    hpHearts: $('#hpHearts'),
    hpMeta: $('#hpMeta'),
    meMods: $('#meMods'),
    intel: $('#intel'),
    intelShells: $('#intelShells'),
    // 中欄：魔王
    demonStage: $('#demonStage'),
    demon: $('#demon'),
    demonPortrait: $('#demonPortrait'),
    demonImg: $('#demonImg'),
    demonName: $('#demonName'),
    demonHearts: $('#demonHearts'),
    demonItems: $('#demonItems'),
    demonBubble: $('#demonBubble'),
    demonBubbleText: $('#demonBubbleText'),
    // 中欄：其他玩家 / 槍 / toast
    seats: $('#seats'),
    gun: $('#gun'),
    gunCylinder: $('#gunCylinder'),
    gunLabel: $('#gunLabel'),
    toast: $('#actionToast'),
    // 右欄：道具 + 日誌
    inventory: $('#inventory'),
    log: $('#log'),
    // 底部按鈕
    actionsRow: $('#actionsRow'),
    btnSelf: $('#btnSelf'),
    btnEnemy: $('#btnEnemy'),
    enemyHint: $('#enemyHint'),
    targetPicker: $('#targetPicker'),
    // 結算
    modalResult: $('#modalResult'),
    resultTitle: $('#resultTitle'),
    resultSub: $('#resultSub'),
    revealList: $('#revealList'),
    btnRematch: $('#btnRematch'),
    btnBackLobby: $('#btnBackLobby'),
    modalHowTo: $('#modalHowTo'),
    btnCloseHowTo: $('#btnCloseHowTo')
  };

  // FX 參數由 /api/config 覆寫（config.FX）
  const fx = {
    SHAKE_MS: 420,
    SHAKE_INTENSITY: 12,
    BLOOD_PARTICLES: 22,
    BLOOD_COLORS: ['#b3000f', '#e01b24', '#5c0006', '#ff5d5d'],
    SCREEN_FLASH_ALPHA: 0.45
  };

  // DeepSeek 娘（前台只露這幾個欄位，機率與冷卻留給伺服器）
  const demonCfg = {
    ENABLED: true,
    SPEAKER: 'DeepSeek 娘',
    PORTRAIT: '/assets/deepseek_girl.jpg',
    PORTRAIT_SIZE: 300,
    BUBBLE_MS: 4600,
    TYPE_SPEED_MS: 24
  };

  /* ========================================================================== */
  /*  3. 音效（WebAudio 合成，不載入外部檔案）                                  */
  /* ========================================================================== */
  const audio = (() => {
    let ctx = null;
    let master = null;

    function ensure() {
      if (!state.soundOn) return null;
      try {
        if (!ctx) {
          const Ctor = window.AudioContext || window.webkitAudioContext;
          if (!Ctor) return null;
          ctx = new Ctor();
          master = ctx.createGain();
          master.gain.value = 0.24;
          master.connect(ctx.destination);
        }
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
      } catch (err) {
        return null;
      }
    }

    function tone(freq, dur, type = 'sine', gain = 0.3, slideTo = null) {
      const ac = ensure();
      if (!ac) return;
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ac.currentTime);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, ac.currentTime + dur);
      g.gain.setValueAtTime(gain, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
      osc.connect(g).connect(master);
      osc.start();
      osc.stop(ac.currentTime + dur + 0.02);
    }

    function noise(dur, gain = 0.4, filterFreq = 1200, type = 'lowpass') {
      const ac = ensure();
      if (!ac) return;
      const frames = Math.max(1, Math.floor(ac.sampleRate * dur));
      const buffer = ac.createBuffer(1, frames, ac.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < frames; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
      const src = ac.createBufferSource();
      src.buffer = buffer;
      const filter = ac.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = filterFreq;
      const g = ac.createGain();
      g.gain.setValueAtTime(gain, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
      src.connect(filter).connect(g).connect(master);
      src.start();
    }

    return {
      unlock() {
        ensure();
      },
      click() {
        tone(520, 0.06, 'triangle', 0.18);
      },
      gunshot() {
        noise(0.42, 0.85, 900);
        tone(120, 0.34, 'sawtooth', 0.5, 42);
        setTimeout(() => noise(0.24, 0.32, 2600, 'highpass'), 26);
      },
      empty() {
        noise(0.09, 0.5, 2200, 'highpass');
        tone(240, 0.07, 'square', 0.09, 160);
      },
      hurt() {
        tone(196, 0.32, 'sawtooth', 0.26, 78);
        noise(0.22, 0.22, 640);
      },
      item() {
        tone(660, 0.1, 'sine', 0.16);
        setTimeout(() => tone(940, 0.12, 'sine', 0.13), 78);
      },
      reveal() {
        tone(300, 0.24, 'sine', 0.16, 620);
      },
      win() {
        [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.3, 'triangle', 0.2), i * 130));
      },
      lose() {
        [392, 330, 262, 196].forEach((f, i) => setTimeout(() => tone(f, 0.42, 'sawtooth', 0.18), i * 150));
      }
    };
  })();

  /* ========================================================================== */
  /*  4. VFX                                                                   */
  /* ========================================================================== */
  function restartAnimation(node, classNames) {
    if (!node) return;
    [].concat(classNames).forEach((name) => node.classList.remove(name));
    void node.offsetWidth; // 強制 reflow，讓動畫重播
    [].concat(classNames).forEach((name) => node.classList.add(name));
  }

  function vfxScreenShake({ hard = false } = {}) {
    if (!dom.app) return;
    dom.app.style.setProperty('--amp', `${(hard ? 1.6 : 1) * fx.SHAKE_INTENSITY}px`);
    dom.app.style.setProperty('--shake-ms', `${fx.SHAKE_MS}ms`);
    restartAnimation(dom.app, hard ? 'is-hit' : 'is-shaking');
    setTimeout(() => dom.app.classList.remove('is-shaking', 'is-hit'), fx.SHAKE_MS + 60);
  }

  function vfxFlash(kind = 'fire') {
    if (!dom.vfxFlash) return;
    dom.vfxFlash.style.setProperty('--flash-alpha', String(fx.SCREEN_FLASH_ALPHA));
    restartAnimation(dom.vfxFlash, kind === 'danger' ? ['is-danger'] : ['is-fired']);
    setTimeout(() => dom.vfxFlash.classList.remove('is-fired', 'is-danger'), 520);
  }

  function vfxBloodScreen() {
    if (!dom.vfxBlood) return;
    restartAnimation(dom.vfxBlood, 'is-active');
    setTimeout(() => dom.vfxBlood.classList.remove('is-active'), 1400);
  }

  function vfxParticles(x, y, kind = 'blood', count = fx.BLOOD_PARTICLES) {
    if (!dom.vfxParticles) return;
    for (let i = 0; i < count; i += 1) {
      const p = el('i', `particle particle--${kind}`);
      const angle = rand(0, Math.PI * 2);
      const dist = rand(50, 220);
      const size = rand(4, 11);
      p.style.left = `${x}px`;
      p.style.top = `${y}px`;
      p.style.width = `${size}px`;
      p.style.height = `${size}px`;
      p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
      p.style.setProperty('--dy', `${Math.sin(angle) * dist + rand(-40, 90)}px`);
      if (kind === 'blood') {
        p.style.background = fx.BLOOD_COLORS[i % fx.BLOOD_COLORS.length];
      }
      p.style.setProperty('--dur', `${kind === 'blood' ? rand(650, 1250) : rand(380, 720)}ms`);
      dom.vfxParticles.appendChild(p);
      setTimeout(() => p.remove(), 1400);
    }
  }

  function centerOf(node) {
    if (!node) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function showToast(text, kind = '') {
    if (!dom.toast || !text) return;
    dom.toast.textContent = text;
    dom.toast.className = `action-toast${kind ? ` is-${kind}` : ''}`;
    restartAnimation(dom.toast, 'is-visible');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => dom.toast.classList.remove('is-visible'), 1900);
  }

  function rotateCylinder(step = 1) {
    if (!dom.gunCylinder) return;
    dom.gunCylinder.style.setProperty('--step', String((Number(dom.gunCylinder.dataset.step || 0) + step) % 6));
    dom.gunCylinder.dataset.step = String((Number(dom.gunCylinder.dataset.step || 0) + step) % 6);
    restartAnimation(dom.gun, 'is-spinning');
    setTimeout(() => dom.gun && dom.gun.classList.remove('is-spinning'), 700);
  }

  /* ========================================================================== */
  /*  4-1. 任務1：本回合裝填提示（中央彈出 → 3 秒 → 自動隱藏）                    */
  /* ========================================================================== */
  const revealState = { round: 0, live: 0, blank: 0, total: 0, ms: 0 };

  function clearRevealTimers() {
    state.revealTimers.forEach((id) => {
      clearTimeout(id);
      clearInterval(id);
    });
    state.revealTimers = [];
  }

  /**
   * 顯示「本回合裝填：🔴 X 發實彈 / 🔵 Y 發空包彈」，並在 ms 毫秒後自動隱藏。
   * 遊玩權限由 server 鎖著（engine 的 AMMO_REVEAL 鎖），所以這裡只負責演出。
   */
  function showAmmoReveal(info) {
    const data = info || {};
    const round = Number(data.round || 1);
    const live = Math.max(0, Number(data.live || 0));
    const blank = Math.max(0, Number(data.blank || 0));
    const total = Number(data.total || live + blank);
    const ms = Math.max(400, Number(data.ms || 3000));

    const sameRound = state.revealShowing && revealState.round === round && revealState.live === live && revealState.blank === blank;
    if (sameRound) return; // 同一次裝彈不重播

    clearRevealTimers();
    Object.assign(revealState, { round, live, blank, total, ms });
    state.revealShowing = true;

    setText(dom.revealRound, round);
    setText(dom.revealLive, live);
    setText(dom.revealBlank, blank);
    setText(dom.revealCountdown, Math.ceil(ms / 1000));

    if (dom.ammoReveal) {
      dom.ammoReveal.hidden = false;
      dom.ammoReveal.dataset.tone = live > blank ? 'danger' : live === blank ? 'even' : 'safe';
      restartAnimation(dom.ammoReveal, 'is-visible');
      restartAnimation($('.ammo-reveal__card', dom.ammoReveal), 'is-pop');
    }
    if (dom.revealBar) {
      dom.revealBar.style.transition = 'none';
      dom.revealBar.style.transform = 'scaleX(1)';
      void dom.revealBar.offsetWidth;
      dom.revealBar.style.transition = `transform ${ms}ms linear`;
      dom.revealBar.style.transform = 'scaleX(0)';
    }

    audio.reveal();

    // 倒數秒數
    const countTimer = setInterval(() => {
      const left = Math.max(0, Math.ceil((revealState.ms - (Date.now() - startedAt)) / 1000));
      setText(dom.revealCountdown, left);
    }, 200);
    const startedAt = Date.now();

    // 3 秒後自動隱藏
    const hideTimer = setTimeout(() => {
      hideAmmoReveal();
    }, ms);

    state.revealTimers.push(countTimer, hideTimer);

    // 顯示期間不能開槍（server 也會拒絕，但 UI 先鎖住體感更好）
    setActionsDisabled(true);
    state.busy = true;
  }

  function hideAmmoReveal() {
    clearRevealTimers();
    if (!state.revealShowing) return;
    state.revealShowing = false;
    if (dom.ammoReveal) {
      dom.ammoReveal.classList.add('is-closing');
      const target = dom.ammoReveal;
      setTimeout(() => {
        if (state.revealShowing) return;
        target.hidden = true;
        target.classList.remove('is-visible', 'is-closing');
      }, 260);
    }
    state.busy = false;
    renderActionButtons();
  }

  /* ========================================================================== */
  /*  4-2. DeepSeek 娘：立繪 / 被打演出 / 對話框                                  */
  /* ========================================================================== */
  const demonState = { id: null, hp: 0, maxHp: 0, dead: false, name: demonCfg.SPEAKER };
  let bubbleTimer = 0;
  let typeTimer = 0;

  function demonOf(pub) {
    if (!pub || !Array.isArray(pub.players)) return null;
    return pub.players.find((p) => p.isAI && !p.dead) || pub.players.find((p) => p.isAI) || null;
  }

  function shouldShowDemon(pub) {
    if (!pub || !Array.isArray(pub.players)) return false;
    if (pub.players.some((p) => p.isAI)) return true;
    return pub.players.length <= 1; // 單人且 AI 已死：保留舞台但不顯示名牌
  }

  function demonCenter() {
    return centerOf(dom.demonPortrait);
  }

  function showDamageFloat(value, opts = {}) {
    if (!dom.damageFloat) return;
    const amount = Number(value || 0);
    dom.damageFloat.textContent = `${opts.label ? `${opts.label} ` : ''}${opts.heal ? '+' : '-'}${amount}`;
    dom.damageFloat.className = `damage-float${opts.heal ? ' is-heal' : ''}`;
    restartAnimation(dom.damageFloat, 'is-active');
    setTimeout(() => dom.damageFloat && dom.damageFloat.classList.remove('is-active'), 1300);
  }

  function demonHit(damage) {
    const amount = Number(damage || 0);
    if (dom.demon) restartAnimation(dom.demon, 'is-hit');
    if (dom.demonPortrait) restartAnimation(dom.demonPortrait, 'is-hit');
    setTimeout(() => {
      if (dom.demon) dom.demon.classList.remove('is-hit');
      if (dom.demonPortrait) dom.demonPortrait.classList.remove('is-hit');
    }, 700);
    showDamageFloat(amount, { label: '扣血' });
    vfxScreenShake({ hard: true });
    vfxFlash('danger');
    const c = demonCenter();
    vfxParticles(c.x, c.y, 'blood', Math.round(fx.BLOOD_PARTICLES * 1.4));
    audio.hurt();
  }

  function typeDemonText(text) {
    clearInterval(typeTimer);
    const node = dom.demonBubbleText;
    if (!node) return;
    const speed = Number(demonCfg.TYPE_SPEED_MS || 0);
    if (!speed) {
      node.textContent = text;
      return;
    }
    let i = 0;
    node.textContent = '';
    typeTimer = setInterval(() => {
      i += 1;
      node.textContent = text.slice(0, i);
      if (i >= text.length) clearInterval(typeTimer);
    }, speed);
  }

  function showDemonTaunt(action) {
    if (!dom.demonBubble || !action || !action.text) return;
    if (action.speakerName) demonState.name = action.speakerName;
    setText(dom.demonName, demonState.name);
    dom.demonBubble.hidden = false;
    dom.demonBubble.dataset.event = action.eventType || '';
    restartAnimation(dom.demonBubble, ['is-open']);
    typeDemonText(String(action.text));
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(hideDemonTaunt, Math.max(1200, Number(demonCfg.BUBBLE_MS || 4600)));
  }

  function hideDemonTaunt() {
    if (!dom.demonBubble || dom.demonBubble.hidden) return;
    dom.demonBubble.classList.remove('is-open');
    dom.demonBubble.classList.add('is-closing');
    setTimeout(() => {
      if (dom.demonBubble.classList.contains('is-open')) return;
      dom.demonBubble.hidden = true;
      dom.demonBubble.classList.remove('is-closing');
    }, 240);
  }

  function renderHearts(container, hp, maxHp, extraClass = '') {
    if (!container) return;
    const max = clamp(Number(maxHp || 0), 0, 12);
    const cur = clamp(Number(hp || 0), 0, max);
    container.textContent = '';
    for (let i = 0; i < max; i += 1) {
      const heart = el('span', `heart${i < cur ? '' : ' is-lost'}${extraClass}`, i < cur ? '❤️' : '🖤');
      container.appendChild(heart);
    }
  }

  function renderDemon(pub) {
    const demon = demonOf(pub);
    const visible = Boolean(demon) && shouldShowDemon(pub);
    Object.assign(demonState, {
      id: demon ? demon.id : null,
      hp: demon ? demon.hp : 0,
      maxHp: demon ? demon.maxHp : 0,
      dead: demon ? Boolean(demon.dead) : false
    });

    if (dom.demonStage) dom.demonStage.hidden = !visible;
    if (!visible) {
      hideDemonTaunt();
      return;
    }

    setText(dom.demonName, demon.name || demonCfg.SPEAKER);
    renderHearts(dom.demonHearts, demon.hp, demon.maxHp);
    setText(dom.demonItems, `🎒 ${demon.itemCount || 0}`);
    if (dom.demon) {
      dom.demon.classList.toggle('is-active', Boolean(pub.activeId) && pub.activeId === demon.id);
      dom.demon.classList.toggle('is-dead', Boolean(demon.dead));
      dom.demon.classList.toggle('is-target', state.selectedTarget === demon.id);
    }
  }

  /* ========================================================================== */
  /*  5. Socket                                                                */
  /* ========================================================================== */
  function connect() {
    if (!window.io) {
      setConnection(false, '無法載入 Socket.io');
      return;
    }
    const socket = window.io({ transports: ['websocket', 'polling'] });
    state.socket = socket;

    socket.on('connect', () => {
      setConnection(true, '已連線');
      socket.emit('hello', {
        name: dom.inputName ? dom.inputName.value.trim() || RANDOM_NAME : RANDOM_NAME
      });
    });

    socket.on('disconnect', () => setConnection(false, '已斷線，重新連線中…'));
    socket.on('connect_error', () => setConnection(false, '連線失敗，重試中…'));

    socket.on('server:hello', (payload) => {
      if (payload && payload.config) applyConfig(payload.config);
    });

    socket.on('room:update', (payload) => {
      const previous = state.game;
      state.room = payload;
      state.youId = payload.youId || state.youId;
      state.seats = Array.isArray(payload.seats) ? payload.seats : [];
      renderRoom(payload, previous);
    });

    socket.on('game:action', (payload) => {
      if (!payload || !Array.isArray(payload.actions)) return;
      playActions(payload.actions);
    });

    socket.on('game:reveal', (payload) => showResult(payload || {}));
    socket.on('lobby:update', () => {/* 大廳目前靠 room:update 渲染 */});

    socket.on('error:message', (payload) => {
      if (payload && payload.message) flashHint(payload.message);
    });
  }

  function setConnection(ok, text) {
    state.connected = Boolean(ok);
    if (dom.connDot) dom.connDot.dataset.state = ok ? 'on' : 'off';
    setText(dom.connText, text);
  }

  function applyConfig(config) {
    if (!config) return;
    state.config = config;
    if (config.FX) Object.assign(fx, config.FX);
    if (config.DIALOGUE) applyDemonConfig(config.DIALOGUE);
    renderLobbyConfig(config);
    renderCodex(config);
    if (config.VERSION && dom.versionTag) setText(dom.versionTag, `v${config.VERSION}`);
  }

  function applyDemonConfig(cfg) {
    if (!cfg) return;
    Object.assign(demonCfg, cfg);
    if (dom.demonImg && demonCfg.PORTRAIT) dom.demonImg.src = String(demonCfg.PORTRAIT);
    if (!dom.demonName.dataset.locked) setText(dom.demonName, demonCfg.SPEAKER || demonState.name);
    const stage = dom.demonStage;
    if (stage) stage.style.setProperty('--demon-size', `${Number(demonCfg.PORTRAIT_SIZE) || 300}px`);
  }

  /* ========================================================================== */
  /*  6. 大廳                                                                  */
  /* ========================================================================== */
  function renderLobbyConfig(config) {
    if (!config) return;
    const HP = config.HP || {};
    const AMMO = config.AMMO || {};
    const RULES = config.RULES || {};
    const set = (key, text) => $$(`[data-bind="${key}"]`).forEach((n) => setText(n, text));
    set('hpStart', HP.START_HP ?? '–');
    set('hpMax', HP.MAX_HP ?? '–');
    set('shellRange', `${AMMO.MIN_SHELLS ?? '?'} ~ ${AMMO.MAX_SHELLS ?? '?'} 發`);
    set('liveWeight', `約 ${Math.round((AMMO.LIVE_WEIGHT_BASE ?? 0.5) * 100)}%`);
    set('healOnReload', AMMO.HEAL_ON_RELOAD ? '會回血' : '不回血');
    set('turnTimeout', `${Math.round((RULES.TURN_TIMEOUT_MS || 60000) / 1000)} 秒`);
  }

  function renderCodex(config) {
    if (!dom.codex || !config || !Array.isArray(config.ITEMS)) return;
    dom.codex.textContent = '';
    config.ITEMS.forEach((item) => {
      const li = el('li', 'codex__row');
      li.appendChild(el('span', 'codex__icon', item.icon || '🎲'));
      const body = el('div', 'codex__body');
      body.appendChild(el('strong', 'codex__name', item.name || item.id));
      body.appendChild(el('span', 'codex__desc', item.desc || ''));
      li.appendChild(body);
      dom.codex.appendChild(li);
    });
  }

  function setMode(mode) {
    state.mode = mode === 'multi' ? 'multi' : 'single';
    $$('.mode').forEach((btn) => {
      const on = btn.dataset.mode === state.mode;
      btn.classList.toggle('is-selected', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (dom.fieldMaxPlayers) dom.fieldMaxPlayers.hidden = state.mode !== 'multi';
  }

  function showLobby() {
    clearRevealTimers();
    state.revealShowing = false;
    if (dom.ammoReveal) {
      dom.ammoReveal.hidden = true;
      dom.ammoReveal.classList.remove('is-visible', 'is-closing');
    }
    hideDemonTaunt();
    if (dom.modalResult) dom.modalResult.hidden = true;
    if (dom.screenLobby) dom.screenLobby.hidden = false;
    if (dom.screenGame) dom.screenGame.hidden = true;
    document.body.classList.remove('is-playing', 'is-tense');
    state.busy = false;
    state.selectedTarget = null;
    stopCountdown();
  }

  function showGame() {
    if (dom.screenLobby) dom.screenLobby.hidden = true;
    if (dom.screenGame) dom.screenGame.hidden = false;
    document.body.classList.add('is-playing');
  }

  function renderRoom(payload, previousGame) {
    if (!payload) return;
    const game = payload.game;
    if (!game || !game.public) {
      // 還在等待室
      if (state.game && state.game.public) showLobby();
      state.game = null;
      if (dom.lobbyHint && payload.code) {
        setText(dom.lobbyHint, `已在房間 ${payload.code}，等待房主開始…`);
      }
      return;
    }
    state.game = game;
    showGame();
    renderGame(payload, previousGame);
  }

  /* ========================================================================== */
  /*  7. 遊戲畫面渲染                                                          */
  /* ========================================================================== */
  let lastRound = 0;

  function renderGame(payload) {
    const game = state.game;
    if (!game || !game.public) return;
    const pub = game.public;
    const priv = game.private || { items: [], intel: [], mods: [] };

    setText(dom.hudCode, (state.room && state.room.code) || pub.code || '----');
    setText(dom.hudRound, pub.round || 1);

    const remaining = pub.remaining || { live: 0, blank: 0, total: 0 };
    setText(dom.countLive, remaining.live || 0);
    setText(dom.countBlank, remaining.blank || 0);
    setText(dom.countTotal, remaining.total || 0);

    const active = (pub.players || []).find((p) => p.id === pub.activeId) || null;
    const isYourTurn = Boolean(pub.activeId) && pub.activeId === state.youId;
    const me = (pub.players || []).find((p) => p.id === state.youId) || null;
    const canAct = isYourTurn && !state.busy && !state.revealShowing && !pub.winnerId;

    document.body.classList.toggle('is-tense', isYourTurn);

    // ---- 任務4：大字回合 ----
    if (dom.turnBanner) {
      const whose = !active
        ? '等待開始'
        : isYourTurn
          ? '現在輪到你'
          : `現在輪到 ${active.name}${active.isAI ? '（DeepSeek 娘）' : ''}`;
      setText(dom.turnBanner, whose);
      dom.turnBanner.classList.toggle('is-mine', isYourTurn);
      dom.turnBanner.classList.toggle('is-theirs', Boolean(active) && !isYourTurn);
    }

    // ---- 左欄：生命值 ----
    setText(dom.hpName, me ? me.name : '你');
    renderHearts(dom.hpHearts, me ? me.hp : 0, me ? me.maxHp : 0, ' heart--big');
    setText(dom.hpMeta, me ? `HP ${me.hp}/${me.maxHp}` : 'HP 0/0');
    if (dom.hpPanel) dom.hpPanel.classList.toggle('is-active', isYourTurn);
    renderMods(priv.mods || priv);
    renderIntel(priv.intel || []);

    // ---- 中欄：魔王 + 其他座位 ----
    renderDemon(pub);
    renderSeats(pub);
    updateSeatHighlights(pub);
    setText(dom.gunLabel, `瞄準中：${active ? active.name : '—'} · 彈匣 ${remaining.live ?? 0} 實 / ${remaining.blank ?? 0} 空`);
    if (dom.gun) {
      dom.gun.classList.toggle('is-mine', isYourTurn);
      dom.gun.classList.toggle('is-theirs', Boolean(active) && !isYourTurn);
    }

    // ---- 右欄：道具 ----
    renderInventory(priv.items || [], canAct, pub);

    // ---- 新輪次：等 server 的 AMMO_REVEAL（若封包遺失就用狀態兜底）----
    if (pub.round && pub.round !== lastRound) {
      lastRound = pub.round;
      if (!state.revealShowing && remaining.total > 0) {
        showAmmoReveal({
          round: pub.round,
          live: remaining.live,
          blank: remaining.blank,
          total: remaining.total,
          ms: 3000
        });
      }
    }

    // ---- 底部按鈕 ----
    renderActionButtons(pub, canAct);

    renderLog(pub.log || []);
    startTurnCountdown(payload.turnDeadline);
  }

  /* ---- 任務4：底部按鈕停用邏輯（非你回合一律 disabled） ---- */
  function renderActionButtons(pub, canActOverride) {
    const game = state.game;
    const p = pub || (game && game.public);
    if (!p) return;
    const isYourTurn = Boolean(p.activeId) && p.activeId === state.youId;
    const canAct = canActOverride != null
      ? canActOverride
      : isYourTurn && !state.busy && !state.revealShowing && !p.winnerId;

    const enemies = enemiesOf(state.youId, p);
    if (dom.btnSelf) {
      dom.btnSelf.disabled = !canAct;
      dom.btnSelf.classList.toggle('is-ready', canAct);
    }
    if (dom.btnEnemy) {
      dom.btnEnemy.disabled = !canAct || enemies.length === 0;
      dom.btnEnemy.classList.toggle('is-ready', canAct && enemies.length > 0);
    }
    if (dom.enemyHint) {
      setText(dom.enemyHint, enemies.length ? `Fire Enemy · ${enemies.length} 個目標` : '沒有可攻擊的目標');
    }
    renderTargetPicker(enemies, canAct);
  }

  function enemiesOf(youId, pub) {
    if (!pub || !Array.isArray(pub.players)) return [];
    return pub.players.filter((p) => p.id !== youId && !p.dead);
  }

  function renderMods(priv) {
    if (!dom.meMods) return;
    const mods = (priv && priv.mods) || [];
    dom.meMods.textContent = '';
    if (!mods.length && !(priv && Number(priv.handcuffed))) return;
    if (priv && Number(priv.handcuffed)) {
      dom.meMods.appendChild(el('span', 'mod', '⛓️ 被銬住'));
    }
    mods.forEach((m) => {
      const label = typeof m === 'string' ? m : (m.label || m.type || '效果');
      dom.meMods.appendChild(el('span', 'mod', label));
    });
  }

  function renderIntel(intel) {
    if (!dom.intel || !dom.intelShells) return;
    const list = Array.isArray(intel) ? intel : [];
    dom.intel.hidden = list.length === 0;
    dom.intelShells.textContent = '';
    list.forEach((shell) => {
      const live = String(shell) === 'LIVE' || shell === true;
      dom.intelShells.appendChild(el('span', `intel__shell${live ? ' is-live' : ''}`, live ? '實' : '空'));
    });
  }

  /* ---- 任務2：右側道具欄 ---- */
  function renderInventory(items, canUse, pub) {
    if (!dom.inventory) return;
    const catalog = new Map(((state.config && state.config.ITEMS) || []).map((it) => [it.id, it]));
    dom.inventory.textContent = '';
    if (!items.length) {
      dom.inventory.appendChild(el('div', 'inventory__empty', '道具欄空空如也（換輪時會自動補充）'));
      return;
    }
    items.forEach((entry, index) => {
      const item = typeof entry === 'string' ? { id: entry } : entry;
      const meta = catalog.get(item.id) || {};
      const btn = el('button', 'item');
      btn.type = 'button';
      btn.dataset.item = item.id;
      btn.title = meta.desc || meta.name || item.id;
      if (item.usable === false) btn.disabled = true;
      else btn.disabled = !canUse;
      btn.appendChild(el('span', 'item__icon', meta.icon || '🎲'));
      btn.appendChild(el('span', 'item__name', meta.name || item.name || item.id));
      btn.appendChild(el('span', 'item__slot', String(index + 1)));
      btn.addEventListener('click', () => useItem(item.id));
      dom.inventory.appendChild(btn);
    });
    if (pub && pub.winnerId) setActionsDisabled(true);
  }

  /* ========================================================================== */
  /*  8. 座位（其他玩家）                                                       */
  /* ========================================================================== */
  function renderSeats(pub) {
    if (!dom.seats) return;
    const players = pub.players || [];
    const demon = demonOf(pub);
    const others = players.filter((p) => p.id !== state.youId && (!demon || p.id !== demon.id));
    dom.seats.textContent = '';
    dom.seats.hidden = others.length === 0;
    others.forEach((p) => {
      const card = el('button', 'seat');
      card.type = 'button';
      card.dataset.seat = p.id;
      card.classList.toggle('is-dead', Boolean(p.dead));
      card.classList.toggle('is-active', p.id === pub.activeId);
      card.classList.toggle('is-target', state.selectedTarget === p.id);
      const top = el('div', 'seat__top');
      top.appendChild(el('span', 'seat__name', p.name));
      top.appendChild(el('span', 'seat__bag', `🎒 ${p.itemCount || 0}`));
      card.appendChild(top);
      const hearts = el('div', 'hearts');
      renderHearts(hearts, p.hp, p.maxHp);
      card.appendChild(hearts);
      card.appendChild(el('span', 'seat__meta', p.dead ? '已倒下' : `HP ${p.hp}/${p.maxHp}`));
      card.addEventListener('click', () => selectSeatTarget(p.id));
      dom.seats.appendChild(card);
    });
  }

  function selectSeatTarget(id) {
    if (!state.game || !state.game.public) return;
    if (state.game.public.activeId !== state.youId || state.busy) {
      showToast('現在不是你的回合', 'warn');
      return;
    }
    if (state.selectedTarget === id) {
      state.selectedTarget = null;
      shoot(id);
      return;
    }
    state.selectedTarget = id;
    const target = (state.game.public.players || []).find((p) => p.id === id);
    showToast(`已鎖定 ${target ? target.name : '目標'}，再點一次開槍`, 'info');
    updateSeatHighlights(state.game.public);
    renderActionButtons(state.game.public);
  }

  function updateSeatHighlights(pub) {
    $$('.seat', dom.seats).forEach((card) => {
      const id = card.dataset.seat;
      card.classList.toggle('is-active', id === pub.activeId);
      card.classList.toggle('is-target', id === state.selectedTarget);
    });
  }

  function renderTargetPicker(enemies, canAct) {
    if (!dom.targetPicker) return;
    if (!enemies.length) {
      dom.targetPicker.hidden = true;
      dom.targetPicker.textContent = '';
      return;
    }
    dom.targetPicker.hidden = false;
    dom.targetPicker.textContent = '';
    enemies.forEach((p) => {
      const btn = el('button', `target${state.selectedTarget === p.id ? ' is-selected' : ''}`, p.name);
      btn.type = 'button';
      btn.disabled = !canAct;
      btn.addEventListener('click', () => {
        state.selectedTarget = p.id;
        renderTargetPicker(enemies, canAct);
        updateSeatHighlights(state.game.public);
        if (dom.demon) dom.demon.classList.toggle('is-target', demonState.id === p.id);
        showToast(`已選定 ${p.name}，按「對敵人開槍」開火`, 'info');
      });
      dom.targetPicker.appendChild(btn);
    });
  }

  /* ========================================================================== */
  /*  9. 日誌 / 倒數                                                           */
  /* ========================================================================== */
  function renderLog(entries) {
    if (!dom.log) return;
    const list = Array.isArray(entries) ? entries.slice(-40) : [];
    dom.log.textContent = '';
    list.forEach((entry) => {
      const text = typeof entry === 'string' ? entry : entry.text || '';
      const kind = typeof entry === 'string' ? '' : entry.kind || '';
      dom.log.appendChild(el('li', `log__row${kind ? ` log__row--${kind}` : ''}`, text));
    });
    dom.log.scrollTop = dom.log.scrollHeight;
  }

  let countdownTimer = 0;

  function stopCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = 0;
    if (dom.turnTimer) dom.turnTimer.style.transform = 'scaleX(1)';
  }

  function startTurnCountdown(deadline) {
    stopCountdown();
    state.turnDeadline = Number(deadline || 0);
    if (!state.turnDeadline || !dom.turnTimer) return;
    const total = Number((state.config && state.config.RULES && state.config.RULES.TURN_TIMEOUT_MS) || 60000);
    const tick = () => {
      const left = state.turnDeadline - Date.now();
      const ratio = clamp(left / total, 0, 1);
      dom.turnTimer.style.transform = `scaleX(${ratio})`;
      dom.turnTimer.classList.toggle('is-low', ratio < 0.25);
      if (left <= 0) stopCountdown();
    };
    tick();
    countdownTimer = setInterval(tick, 250);
  }

  /* ========================================================================== */
  /*  10. 動作（送指令）                                                       */
  /* ========================================================================== */
  function shoot(targetId) {
    if (!state.socket || state.busy) return;
    const pub = state.game && state.game.public;
    if (!pub || pub.activeId !== state.youId) {
      showToast('現在不是你的回合', 'warn');
      return;
    }
    if (state.revealShowing) {
      showToast('等裝填提示結束', 'warn');
      return;
    }
    state.busy = true;
    setActionsDisabled(true);
    audio.click();
    const payload = targetId ? { targetId } : {};
    console.debug('[shoot] → game:shoot', payload);
    state.socket.emit('game:shoot', payload, (res) => {
      if (res && res.ok === false) {
        state.busy = false;
        flashHint(errorText(res.error) || '這一槍沒送出去');
        renderActionButtons(pub);
      }
    });
    // 保險：5 秒內沒收到任何狀態就解鎖，避免卡死
    setTimeout(() => {
      const live = state.game && state.game.public;
      if (state.busy && live) {
        state.busy = false;
        renderActionButtons(live);
      }
    }, 5000);
  }

  function useItem(itemId) {
    if (!state.socket || state.busy || !itemId) return;
    const pub = state.game && state.game.public;
    if (!pub || pub.activeId !== state.youId) {
      showToast('現在不是你的回合', 'warn');
      return;
    }
    let payload = { itemId };
    const enemies = enemiesOf(state.youId, pub);
    if (itemId === 'HANDCUFFS' && enemies.length > 1) {
      const names = enemies.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
      const pick = window.prompt(`要銬住誰？輸入編號：\n${names}`, '1');
      const index = Number(pick) - 1;
      if (!Number.isInteger(index) || !enemies[index]) return;
      payload = { itemId, targetId: enemies[index].id };
    }
    state.busy = true;
    setActionsDisabled(true);
    audio.item();
    state.socket.emit('game:item', payload, (res) => {
      if (res && res.ok === false) {
        state.busy = false;
        flashHint(errorText(res.error) || '道具用不了');
        renderActionButtons(pub);
      }
    });
    setTimeout(() => {
      if (state.busy) {
        state.busy = false;
        renderActionButtons(state.game && state.game.public);
      }
    }, 5000);
  }

  function setActionsDisabled(disabled) {
    [dom.btnSelf, dom.btnEnemy].forEach((btn) => {
      if (btn) btn.disabled = Boolean(disabled);
    });
    $$('.item', dom.inventory).forEach((btn) => {
      btn.disabled = Boolean(disabled) || btn.dataset.used === '1';
    });
    $$('.target', dom.targetPicker).forEach((btn) => {
      btn.disabled = Boolean(disabled);
    });
  }

  const ERROR_TEXT = {
    NOT_YOUR_TURN: '現在不是你的回合',
    AMMO_REVEAL: '先看完這回合的裝填提示',
    GAME_NOT_PLAYING: '遊戲還沒開始',
    NO_ITEMS: '這件道具用不到',
    ONCE_PER_TURN: '這個道具一回合只能用一次',
    BAD_TARGET: '目標無效',
    UNKNOWN_ITEM: '未知道具',
    HANDCUFFS: '手銬已經用過了',
    INVALID_ACTION: '指令無效'
  };

  function errorText(code) {
    return ERROR_TEXT[code] || code;
  }

  function flashHint(text) {
    showToast(text, 'warn');
  }

  /* ========================================================================== */
  /*  11. 播放 server 的 actions                                               */
  /* ========================================================================== */
  let actionQueue = Promise.resolve();

  function playActions(actions) {
    actionQueue = actionQueue.then(async () => {
      for (const action of actions) {
        try {
          await playAction(action);
        } catch (err) {
          console.warn('[action] 播放失敗', action && action.type, err);
        }
      }
    });
    return actionQueue;
  }

  async function playAction(action) {
    if (!action || !action.type) return;
    switch (action.type) {
      /* ---- 任務1：本回合裝填 ---- */
      case 'AMMO_REVEAL': {
        showAmmoReveal({
          round: action.round,
          live: action.live,
          blank: action.blank,
          total: action.total,
          ms: action.ms
        });
        await sleep(Math.max(400, Number(action.ms || 3000)));
        break;
      }
      case 'AMMO_REVEAL_END': {
        hideAmmoReveal();
        break;
      }

      /* ---- 開局 / 裝彈 ---- */
      case 'GAME_START': {
        lastRound = 0;
        showToast('遊戲開始', 'info');
        break;
      }
      case 'RELOAD':
      case 'ROUND_STATE': {
        rotateCylinder(1);
        if (action.type === 'RELOAD') {
          setText(dom.gunLabel, `第 ${action.round} 輪：裝填 ${action.live} 實 / ${action.blank} 空`);
          showAmmoReveal({
            round: action.round,
            live: action.live,
            blank: action.blank,
            total: action.total,
            ms: (state.config && state.config.AMMO && state.config.AMMO.AMMO_REVEAL
              ? state.config.AMMO.AMMO_REVEAL.REVEAL_MS
              : 3000)
          });
          await sleep(260);
        }
        break;
      }

      /* ---- 任務3：開槍 ---- */
      case 'SHOT': {
        await playShotVFX(action);
        break;
      }

      case 'TAUNT': {
        showDemonTaunt(action);
        await sleep(260);
        break;
      }
      case 'ITEM_USED': {
        showToast(`${action.playerName || '有人'} 用了 ${action.itemName || action.name || '道具'}`, 'info');
        audio.item();
        await sleep(220);
        break;
      }
      case 'ITEM_FAILED': {
        showToast(`${action.itemName || '道具'} 使用失敗`, 'warn');
        await sleep(180);
        break;
      }
      case 'PEEK': {
        const shells = Array.isArray(action.shells) ? action.shells : [];
        showToast(`看到了：${shells.map((s) => (s === 'LIVE' ? '🔴實彈' : '🔵空包')).join(' / ')}`, 'info');
        await sleep(200);
        break;
      }
      case 'HEAL': {
        showToast(`${action.playerName || '有人'} 回復 ${action.amount} HP`, 'good');
        if (action.playerId === demonState.id) showDamageFloat(action.amount, { heal: true });
        await sleep(200);
        break;
      }
      case 'DAMAGE': {
        if (action.playerId === demonState.id) showDamageFloat(action.amount, { label: '扣血' });
        await sleep(160);
        break;
      }
      case 'EJECT': {
        rotateCylinder(1);
        showToast(`退出一發${action.shell === 'LIVE' ? '實彈' : '空包彈'}`, 'info');
        audio.empty();
        await sleep(260);
        break;
      }
      case 'MODIFIER': {
        await sleep(120);
        break;
      }
      case 'EXTRA_TURN':
      case 'STEAL_TURN': {
        showToast(action.type === 'EXTRA_TURN' ? '額外回合！' : '奪取了回合！', 'good');
        await sleep(240);
        break;
      }
      case 'BARRAGE': {
        showToast('連發中…', 'warn');
        await sleep(240);
        break;
      }
      case 'ROUND_END': {
        showToast('子彈打光了，重新裝彈', 'info');
        await sleep(320);
        break;
      }
      case 'GAME_OVER': {
        await sleep(400);
        break;
      }
      case 'TIMEOUT': {
        showToast('逾時，自動開槍', 'warn');
        await sleep(300);
        break;
      }
      default:
        await sleep(60);
    }
  }

  async function playShotVFX(action) {
    const isLive = action.shell === 'LIVE' || action.realShell === 'LIVE';
    const hitDemon = demonState.id && action.targetId === demonState.id;
    const shooterName = action.shooterName || '有人';
    const targetName = action.targetName || (hitDemon ? demonState.name : '某人');

    if (dom.gun) restartAnimation(dom.gun, 'is-aiming');
    await sleep(150);

    if (isLive) {
      audio.gunshot();
      vfxFlash('fire');
      vfxScreenShake({ hard: true });
      if (dom.gun) restartAnimation(dom.gun, 'is-firing');
      if (hitDemon) {
        demonHit(action.damage);
      } else {
        const seat = action.targetId ? $(`[data-seat="${action.targetId}"]`, dom.seats) : null;
        const point = centerOf(seat || dom.demonPortrait);
        vfxParticles(point.x, point.y, 'blood');
        vfxBloodScreen();
        if (seat) restartAnimation(seat, 'is-hit');
        if (action.targetId === state.youId) {
          showDamageFloat(action.damage, { label: '扣血' });
          if (dom.hpHearts) restartAnimation(dom.hpHearts, 'is-hit');
        }
      }
      showToast(`${shooterName} 對 ${targetName} 開槍：實彈！`, 'danger');
    } else {
      audio.empty();
      vfxFlash('fire');
      vfxScreenShake({ hard: false });
      const point = centerOf(action.targetId === demonState.id ? dom.demonPortrait : dom.gun);
      vfxParticles(point.x, point.y, 'spark', 8);
      if (shooterName) showToast(`${shooterName} 對 ${targetName} 開槍：空包彈`, 'safe');
    }

    if (action.remaining) {
      setText(dom.countLive, action.remaining.live ?? 0);
      setText(dom.countBlank, action.remaining.blank ?? 0);
      setText(dom.countTotal, action.remaining.total ?? 0);
    }
    await sleep(320);
    if (dom.gun) dom.gun.classList.remove('is-aiming', 'is-firing');
  }

  /* ========================================================================== */
  /*  12. 結算畫面                                                             */
  /* ========================================================================== */
  function showResult({ chamber, winnerId }) {
    const pub = state.game && state.game.public;
    const winner = pub ? (pub.players || []).find((p) => p.id === winnerId) : null;
    const youWin = winnerId === state.youId;
    if (dom.resultTitle) {
      setText(dom.resultTitle, youWin ? '你贏了' : winner ? `${winner.name} 贏了` : '遊戲結束');
      dom.resultTitle.className = `result-title${youWin ? ' is-win' : ' is-lose'}`;
    }
    if (dom.resultSub) {
      setText(dom.resultSub, youWin ? '你把 DeepSeek 娘的 token 打光了。' : '這次被算力壓過去了。');
    }
    if (dom.revealList) {
      dom.revealList.textContent = '';
      (Array.isArray(chamber) ? chamber : []).forEach((shell) => {
        const live = String(shell) === 'LIVE';
        dom.revealList.appendChild(el('li', `reveal-list__row${live ? ' is-live' : ''}`, live ? '🔴 實彈' : '🔵 空包彈'));
      });
    }
    if (dom.modalResult) dom.modalResult.hidden = false;
    hideAmmoReveal();
    state.busy = false;
    (youWin ? audio.win : audio.lose)();
  }

  /* ========================================================================== */
  /*  13. 事件綁定                                                             */
  /* ========================================================================== */
  function bindEvents() {
    if (dom.inputName) dom.inputName.value = safeStorageGet('devil.name', RANDOM_NAME);
    if (dom.inputCode) dom.inputCode.value = safeStorageGet('devil.code', '');

    dom.inputName && dom.inputName.addEventListener('input', () => safeStorageSet('devil.name', dom.inputName.value.trim()));
    dom.inputCode && dom.inputCode.addEventListener('input', () => {
      dom.inputCode.value = dom.inputCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      safeStorageSet('devil.code', dom.inputCode.value);
    });

    $$('.mode').forEach((btn) => btn.addEventListener('click', () => setMode(btn.dataset.mode)));

    dom.btnCreate && dom.btnCreate.addEventListener('click', () => {
      if (!state.socket) return;
      const name = (dom.inputName.value || '').trim() || RANDOM_NAME;
      const payload = {
        name,
        mode: state.mode,
        maxPlayers: state.mode === 'multi' ? Number(dom.selectMaxPlayers.value || 2) : 2,
        flags: {}
      };
      setText(dom.lobbyHint, '建立房間中…');
      state.socket.emit('room:create', payload, (res) => {
        if (!res || res.ok === false) {
          setText(dom.lobbyHint, `建立失敗：${(res && res.error) || '未知錯誤'}`);
          return;
        }
        state.youId = res.youId || state.youId;
        safeStorageSet('devil.code', res.code || '');
        setText(dom.lobbyHint, `房間 ${res.code} 已建立，等待開始…`);
        audio.click();
      });
    });

    dom.btnJoin && dom.btnJoin.addEventListener('click', () => {
      if (!state.socket) return;
      const code = (dom.inputCode.value || '').trim().toUpperCase();
      if (!code) {
        setText(dom.lobbyHint, '請先輸入房碼');
        return;
      }
      const name = (dom.inputName.value || '').trim() || RANDOM_NAME;
      state.socket.emit('room:join', { code, name }, (res) => {
        if (!res || res.ok === false) {
          setText(dom.lobbyHint, `加入失敗：${(res && res.error) || '房碼錯誤'}`);
          return;
        }
        state.youId = res.youId || state.youId;
        safeStorageSet('devil.code', code);
        audio.click();
      });
    });

    // ---- 任務3：兩個大按鈕 ----
    dom.btnSelf && dom.btnSelf.addEventListener('click', () => shoot(null));
    dom.btnEnemy && dom.btnEnemy.addEventListener('click', () => {
      const pub = state.game && state.game.public;
      if (!pub) return;
      const enemies = enemiesOf(state.youId, pub);
      if (!enemies.length) return;
      const target = enemies.find((p) => p.id === state.selectedTarget) || enemies[0];
      shoot(target.id);
    });

    // 點魔王（第一下選目標、第二下開槍）
    dom.demonPortrait && dom.demonPortrait.addEventListener('click', () => {
      if (!demonState.id) return;
      if (state.selectedTarget === demonState.id) {
        state.selectedTarget = null;
        shoot(demonState.id);
        return;
      }
      state.selectedTarget = demonState.id;
      if (dom.demon) dom.demon.classList.add('is-target');
      updateSeatHighlights(state.game ? state.game.public : {});
      renderActionButtons(state.game ? state.game.public : null);
      showToast(`已鎖定 ${demonState.name}，再點一次扣扳機`, 'info');
    });

    dom.btnRematch && dom.btnRematch.addEventListener('click', () => {
      if (!state.socket) return;
      state.socket.emit('game:rematch', {}, () => {});
      if (dom.modalResult) dom.modalResult.hidden = true;
    });
    dom.btnBackLobby && dom.btnBackLobby.addEventListener('click', () => {
      if (state.socket) state.socket.emit('room:leave', {}, () => {});
      if (dom.modalResult) dom.modalResult.hidden = true;
      state.game = null;
      lastRound = 0;
      showLobby();
    });
    dom.btnQuit && dom.btnQuit.addEventListener('click', () => {
      if (state.socket) state.socket.emit('room:leave', {}, () => {});
      state.game = null;
      lastRound = 0;
      showLobby();
    });

    dom.btnHowTo && dom.btnHowTo.addEventListener('click', () => {
      if (dom.modalHowTo) dom.modalHowTo.hidden = false;
    });
    dom.btnCloseHowTo && dom.btnCloseHowTo.addEventListener('click', () => {
      if (dom.modalHowTo) dom.modalHowTo.hidden = true;
    });

    dom.btnMute && dom.btnMute.addEventListener('click', () => {
      state.soundOn = !state.soundOn;
      dom.btnMute.textContent = state.soundOn ? '🔊' : '🔇';
    });

    // 鍵盤：S = 對自己、E = 對敵人
    window.addEventListener('keydown', (event) => {
      if (!state.game || !state.game.public) return;
      if (event.target && /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return;
      if (event.repeat) return;
      if (event.key === 's' || event.key === 'S') dom.btnSelf && dom.btnSelf.click();
      if (event.key === 'e' || event.key === 'E') dom.btnEnemy && dom.btnEnemy.click();
    });

    // 第一次互動時解鎖 WebAudio
    window.addEventListener('pointerdown', () => audio.unlock(), { once: true });

    // 魔王圖缺檔 → 顯示霓虹剪影
    if (dom.demonImg) {
      const markMissing = () => dom.demon && dom.demon.classList.add('is-missing-art');
      const markLoaded = () => dom.demon && dom.demon.classList.remove('is-missing-art');
      dom.demonImg.addEventListener('error', markMissing);
      dom.demonImg.addEventListener('load', markLoaded);
      if (dom.demonImg.complete && dom.demonImg.naturalWidth === 0) markMissing();
    }
  }

  /* ========================================================================== */
  /*  14. 啟動                                                                 */
  /* ========================================================================== */
  function boot() {
    bindEvents();
    setMode('single');
    showLobby();
    connect();

    // 先抓一次公開設定，讓大廳規則表即使在 socket 連上之前也有內容
    fetch('/api/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((config) => config && applyConfig(config))
      .catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
