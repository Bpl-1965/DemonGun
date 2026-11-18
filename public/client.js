/* =========================================================
   惡魔輪盤 · 前端（極簡純 2D，上下對戰）
   只做三件事：把狀態畫出來、把意圖送出去、把動作演出來。
   所有規則與傷害都由伺服器決定，這裡不算任何數值。
   ========================================================= */

(function () {
  "use strict";

  // ---------------------------------------------------------------- 小工具
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const ERROR_TEXT = {
    NOT_IN_ROOM: "你不在房間裡。",
    NOT_HOST: "只有房主可以開局。",
    ALREADY_STARTED: "遊戲已經開始了。",
    NOT_ENOUGH_PLAYERS: "人數不足，無法開局。",
    NOT_YOUR_TURN: "還沒輪到你。",
    AMMO_REVEAL: "還在公布裝填結果，稍等一下。",
    GAME_NOT_PLAYING: "遊戲還沒開始或已經結束。",
    PLAYER_DEAD: "你已經出局了。",
    TOO_FAST: "手速太快了，慢一點。",
    UNKNOWN_ITEM: "沒有這個道具。",
    NO_ITEM: "道具已經用掉了。",
    TOO_MANY_ITEMS: "這回合用太多道具了。",
    HP_FULL: "生命值已經滿了，留著之後再用吧。",
    ROOM_NOT_FOUND: "找不到這個房碼。",
    ROOM_FULL: "房間滿了。",
    NAME_TAKEN: "這個名字有人在用了。",
    NOT_A_PLAYER: "旁觀者不能行動。",
  };

  // ---------------------------------------------------------------- 狀態
  const state = {
    socket: null,
    config: null,
    code: null,
    hostId: null,
    youId: null,
    myName: null,
    seats: [],
    lobbyMax: 4, // 房主選的人數上限（由 room:create / lobby:update 帶回）
    game: { public: null, private: null },
    selectedTarget: null,
    busy: false,
    busyAt: 0,
    revealUntil: 0, // 伺服器時間軸（ms）
    revealMs: 0,
    serverOffset: 0, // 伺服器時間 - 本機時間
    turnDeadline: 0, // 伺服器時間軸（ms）；0 = 沒有計時
    serverTurnTimeout: 0, // 伺服器設的回合秒數（拿來算初始數字）
    turnTimerId: null,
    revealTimer: null,
    queue: Promise.resolve(),
  };

  const pub = () => state.game.public || null;
  const priv = () => state.game.private || null;

  // 重新整理（F5）之後要能認回原本的座位，所以把「房碼 + 名字」記在本機
  const SESSION_KEY = "devil.session";
  const loadSession = () => {
    try {
      const raw = window.localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  };
  const saveSession = (patch) => {
    try {
      const next = Object.assign(loadSession() || {}, patch);
      window.localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    } catch (err) {
      /* 隱私模式下 localStorage 會壞，忽略即可 */
    }
  };
  const clearSession = () => {
    try {
      window.localStorage.removeItem(SESSION_KEY);
    } catch (err) {
      /* 同上 */
    }
  };

  const myPlayer = () => {
    const p = pub();
    if (!p) return null;
    return p.players.find((x) => x.id === state.youId) || null;
  };
  const others = () => {
    const p = pub();
    if (!p) return [];
    return p.players.filter((x) => x.id !== state.youId);
  };
  const aliveOthers = () => others().filter((x) => !x.dead);
  const isMyTurn = () => {
    const p = pub();
    return Boolean(p && p.phase === "playing" && p.activeId === state.youId);
  };
  const revealActive = () => state.revealUntil > Date.now() + state.serverOffset;

  // ---------------------------------------------------------------- 畫面切換
  function setMessage(text, kind) {
    const node = $("lobbyMsg");
    node.textContent = text || "";
    node.className = "lobby__msg" + (kind ? " is-" + kind : "");
  }

  function showLobby(keepSession) {
    $("lobby").hidden = false;
    $("game").hidden = true;
    $("result").hidden = true;
    hideReveal();
    stopTimerUI();
    tooltip.hide();
    state.code = null;
    state.youId = null;
    state.game = { public: null, private: null };
    state.seats = [];
    state.selectedTarget = null;
    state.turnDeadline = 0;
    state.busy = false;
    // 回大廳就不該再自動重連回上一場（開機時例外：要留著紀錄去重連）
    if (!keepSession && loadSession()) saveSession({ ingame: false });
  }

  function showGame() {
    $("lobby").hidden = true;
    $("game").hidden = false;
  }

  // ---------------------------------------------------------------- 開局提示
  function showReveal(info) {
    const ms = Math.max(400, Number(info.ms) || 3000);
    $("revealRound").textContent = info.round ?? "1";
    $("revealLive").textContent = info.live ?? 0;
    $("revealBlank").textContent = info.blank ?? 0;
    $("reveal").hidden = false;

    const bar = $("revealBar");
    bar.style.transition = "none";
    bar.style.transform = "scaleX(1)";
    // 強制 reflow，讓下一格的 transition 從頭開始
    void bar.offsetWidth;
    bar.style.transition = "transform " + ms + "ms linear";
    bar.style.transform = "scaleX(0)";

    state.revealUntil = Date.now() + state.serverOffset + ms;
    state.revealMs = ms;
    clearTimeout(state.revealTimer);
    state.revealTimer = setTimeout(hideReveal, ms + 60);
    renderButtons();
  }

  function hideReveal() {
    clearTimeout(state.revealTimer);
    state.revealUntil = 0;
    state.revealMs = 0;
    $("reveal").hidden = true;
    renderButtons();
  }

  // ---------------------------------------------------------------- 渲染
  function renderHearts(node, hp, maxHp) {
    const total = Math.max(maxHp, hp);
    let html = "";
    for (let i = 0; i < total; i += 1) {
      html += i < hp ? '<span class="heart">❤️</span>' : '<span class="heart is-lost">🖤</span>';
    }
    node.innerHTML = html;
  }

  function renderHud() {
    const p = pub();
    $("roundLabel").textContent = p ? p.round : 1;
    $("codeLabel").textContent = state.code || "—";
  }

  /** 上半部：1~3 個對手並排；沒有 pub 時先用座位名單頂著 */
  function renderFoes() {
    const box = $("opponents");
    const p = pub();
    const live = aliveOthers();

    // 選定的目標若已死亡或不存在就清掉；只剩一個活人時自動鎖定他
    if (state.selectedTarget && !live.some((x) => x.id === state.selectedTarget)) {
      state.selectedTarget = null;
    }
    if (!state.selectedTarget && live.length === 1) {
      state.selectedTarget = live[0].id;
    }

    const list = p
      ? others()
      : state.seats.filter((s) => s.id !== state.youId).map((s) => ({ id: s.id, name: s.name, hp: 0, maxHp: 0, dead: false, itemCount: 0, ready: s.ready }));

    box.style.setProperty("--n", String(Math.max(1, Math.min(3, list.length))));
    box.innerHTML = "";

    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "foe";
      empty.classList.add("is-dead");
      empty.innerHTML = '<span class="foe__name">（等待對手）</span>';
      box.appendChild(empty);
    }

    list.forEach((foe) => {
      const card = document.createElement("div");
      card.className = "foe";
      card.dataset.id = foe.id;
      if (foe.dead) card.classList.add("is-dead");
      if (p && p.activeId === foe.id) card.classList.add("is-active");
      if (foe.id === state.selectedTarget) card.classList.add("is-selected");

      const name = document.createElement("span");
      name.className = "foe__name";
      name.textContent = foe.name || "對手";
      card.appendChild(name);

      const hearts = document.createElement("div");
      hearts.className = "hearts";
      hearts.dataset.hearts = foe.id;
      card.appendChild(hearts);
      renderHearts(hearts, foe.hp || 0, foe.maxHp || 0);

      const meta = document.createElement("span");
      meta.className = "foe__items";
      meta.textContent = p ? "🎒 " + (foe.itemCount || 0) : "準備中";
      card.appendChild(meta);

      if (p && p.activeId === foe.id) {
        const tag = document.createElement("span");
        tag.className = "foe__tag";
        tag.textContent = "行動中";
        card.appendChild(tag);
      }

      // 點一下＝鎖定目標，再點一下＝直接開槍
      if (!foe.dead && p && p.phase === "playing") {
        card.addEventListener("click", () => {
          if (state.selectedTarget === foe.id) {
            shoot(foe.id);
          } else {
            state.selectedTarget = foe.id;
            renderFoes();
            renderButtons();
          }
        });
      }

      box.appendChild(card);
    });

    // 多人局才需要選目標的列
    const targets = $("targets");
    if (p && p.phase === "playing" && live.length > 1) {
      targets.hidden = false;
      targets.innerHTML = "";
      live.forEach((foe) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = foe.name + "（❤ " + foe.hp + "）";
        if (foe.id === state.selectedTarget) b.classList.add("is-active");
        b.addEventListener("click", () => {
          state.selectedTarget = foe.id;
          renderFoes();
          renderButtons();
        });
        targets.appendChild(b);
      });
    } else {
      targets.hidden = true;
      targets.innerHTML = "";
    }
  }

  function renderSelf() {
    const me = myPlayer();
    const p = pub();
    $("myName").textContent = me ? me.name : state.myName || "—";
    renderHearts($("myHearts"), me ? me.hp : 0, me ? me.maxHp : 0);

    const node = $("me");
    node.classList.toggle("is-turn", Boolean(p && p.activeId === state.youId));
    node.classList.toggle("is-dead", Boolean(me && me.dead));

    // 狀態標籤（由私有狀態的 mods 推得）
    const mods = (priv() && priv().mods) || {};
    const tags = [];
    if (mods.sawnOff) tags.push("🔪 槍管已鋸短 ×" + mods.sawnOff);
    if (mods.nails) tags.push("🔨 釘槍 ×" + mods.nails);
    if (mods.cuffed) tags.push("⛓ 被銬住");
    $("myStatus").innerHTML = tags.length
      ? tags.map((t) => '<span class="tag">' + t + "</span>").join("")
      : "狀態正常";

    const intel = (priv() && priv().intel) || [];
    const box = $("myIntel");
    if (intel.length) {
      box.hidden = false;
      box.textContent =
        "已知接下來：" + intel.map((s) => (s === "LIVE" ? "🔴 實彈" : "🔵 空包")).join(" → ");
    } else {
      box.hidden = true;
      box.textContent = "";
    }
  }

  function renderTurn() {
    const p = pub();
    const node = $("turnLabel");
    node.classList.remove("is-mine", "is-theirs");

    if (!p || p.phase !== "playing") {
      if (p && p.phase === "gameover") node.textContent = "遊戲結束";
      else if (p) node.textContent = "等待開局…";
      // 已經在房間裡（有座位名單）＝等房主開局；連座位都沒有才是還沒同步到狀態
      else node.textContent = state.seats.length || !state.code ? "等待開局…" : "正在同步遊戲狀態…";
      return;
    }
    if (isMyTurn()) {
      node.textContent = "現在是你的回合";
      node.classList.add("is-mine");
    } else {
      node.textContent = "現在是 " + (p.activeName || "對手") + " 的回合";
      node.classList.add("is-theirs");
    }
  }

  function itemEffect(itemId) {
    const catalog = (state.config && state.config.ITEMS) || [];
    const found = catalog.find((entry) => entry.id === itemId);
    return found ? found.effect : null;
  }

  // ------------------------------------------------------------ 回合倒數
  // 伺服器只送「到期時間」（turnDeadline，epoch ms），倒數由本地每 200ms 對時算出來，
  // 所以就算推播遲到，數字也不會跳格。
  function serverNow() {
    return Date.now() + state.serverOffset;
  }

  function stopTurnTimer() {
    if (state.turnTimerId) {
      clearInterval(state.turnTimerId);
      state.turnTimerId = null;
    }
  }

  function turnSecondsLeft() {
    if (!state.turnDeadline) return null;
    return Math.max(0, Math.ceil((state.turnDeadline - serverNow()) / 1000));
  }

  function stopTimerUI() {
    stopTurnTimer();
    const wrap = $("turnTimerWrap");
    if (wrap) wrap.hidden = true;
    const ring = $("turnTimer");
    if (ring) {
      ring.classList.remove("is-danger", "is-over");
      ring.textContent = "20";
    }
  }

  function paintTurnTimer() {
    const ring = $("turnTimer");
    if (!ring) return;
    const left = turnSecondsLeft();
    if (left === null) {
      stopTimerUI();
      return;
    }
    if (left <= 0) {
      ring.classList.remove("is-danger");
      ring.classList.add("is-over");
      ring.textContent = "時間到";
      stopTurnTimer();
      return;
    }
    ring.classList.remove("is-over");
    ring.textContent = String(left);
    ring.classList.toggle("is-danger", left <= 5);
  }

  function syncTurnTimer() {
    const wrap = $("turnTimerWrap");
    if (!wrap) return;
    const p = pub();
    // 只有「正在玩 + 現在是我的回合」才顯示
    if (!p || p.phase !== "playing" || !isMyTurn() || !state.turnDeadline) {
      stopTimerUI();
      return;
    }
    wrap.hidden = false;
    if (!state.turnTimerId) {
      paintTurnTimer();
      state.turnTimerId = window.setInterval(paintTurnTimer, 200);
    } else {
      paintTurnTimer();
    }
  }

  // ------------------------------------------------------------ 道具提示框
  // pointer-events:none，所以貼著滑鼠也不會擋住點擊
  const tooltip = {
    el: () => $("itemTooltip"),
    show(event, item, wasted) {
      const box = this.el();
      if (!box) return;
      box.innerHTML =
        '<span class="item-tooltip__name">' +
        (item.icon ? item.icon + " " : "") +
        esc(item.name) +
        '</span><span class="item-tooltip__desc">' +
        esc(item.desc || "") +
        "</span>" +
        (wasted ? '<span class="item-tooltip__meta">生命值已滿，現在用會浪費</span>' : "");
      box.hidden = false;
      this.move(event);
    },
    move(event) {
      const box = this.el();
      if (!box || box.hidden || !event) return;
      const pad = 14;
      const w = box.offsetWidth || 220;
      const h = box.offsetHeight || 60;
      let x = (event.clientX || 0) + pad;
      let y = (event.clientY || 0) + pad;
      if (x + w + 8 > window.innerWidth) x = Math.max(8, (event.clientX || 0) - w - pad);
      if (y + h + 8 > window.innerHeight) y = Math.max(8, (event.clientY || 0) - h - pad);
      box.style.left = x + "px";
      box.style.top = y + "px";
    },
    hide() {
      const box = this.el();
      if (!box) return;
      box.hidden = true;
      box.textContent = "";
    },
  };

  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderItems() {
    const grid = $("itemsGrid");
    const items = (priv() && priv().items) || [];
    const canUse = pub() && pub().phase === "playing";
    const me = myPlayer();
    const hpFull = Boolean(me && !me.dead && me.hp >= me.maxHp);
    grid.innerHTML = "";

    items.forEach((item) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "slot";
      // 純回血道具在滿血時沒有意義：直接鎖住，不讓玩家白花一個道具
      const effect = itemEffect(item.id);
      const wasted = hpFull && (effect === "heal" || effect === "random_heal");
      btn.disabled = !canUse || wasted;
      btn.title = wasted ? "生命值已滿，現在用會浪費。" : item.desc || "";
      if (wasted) btn.classList.add("slot--waste");
      btn.innerHTML =
        '<span class="slot__icon">' +
        (item.icon || "❓") +
        '</span><span class="slot__name">' +
        item.name +
        "</span>";
      btn.addEventListener("click", () => useItem(item.id));
      // 懸停說明：mouseenter 填內容、mousemove 跟著滑鼠跑、mouseleave 收起來
      btn.addEventListener("mouseenter", (event) => tooltip.show(event, item, wasted));
      btn.addEventListener("mousemove", (event) => tooltip.move(event));
      btn.addEventListener("mouseleave", () => tooltip.hide());
      // 手機沒有 hover：點完順手收掉
      btn.addEventListener("click", () => tooltip.hide());
      grid.appendChild(btn);
    });

    const empty = Math.max(0, 3 - items.length);
    for (let i = 0; i < empty; i += 1) {
      const slot = document.createElement("div");
      slot.className = "slot slot--empty";
      slot.textContent = "空";
      grid.appendChild(slot);
    }
  }

  function renderButtons() {
    const p = pub();
    // 保險：busy 卡住（ack 掉了 / 伺服器重啟）不該讓按鈕永遠灰著
    if (state.busy && state.busyAt && Date.now() - state.busyAt > 4000) {
      state.busy = false;
    }

    const isLocked = revealActive(); // revealActive() 會自動判斷伺服器時間
    const canAct =
      Boolean(p) && p.phase === "playing" && p.activeId === state.youId && !isLocked && !state.busy;

    const live = aliveOthers();
    $("btnSelf").disabled = !canAct;
    // 有多個對手時，按鈕要能按（按下去會請你選目標）
    $("btnEnemy").disabled = !canAct || live.length === 0;

    // 房主在大廳（遊戲還沒開始）才看得到「開局」
    const inLobby = !p || p.phase === "lobby";
    $("startBtn").hidden = !(inLobby && state.hostId === state.youId);

    const target = live.find((x) => x.id === state.selectedTarget) || null;
    const sub = $("enemySub");
    if (!p || p.phase !== "playing") {
      sub.textContent = "實彈才痛，但打完就交棒";
    } else if (live.length === 0) {
      sub.textContent = "沒有可瞄準的對手";
    } else if (live.length === 1) {
      sub.textContent = "→ " + live[0].name;
    } else {
      sub.textContent = target ? "→ " + target.name : "先選一個對手";
    }

    const hint = $("hint");
    if (!p || p.phase !== "playing") {
      hint.textContent = inLobby ? "等待房主開局…" : "";
    } else if (isLocked) {
      hint.textContent = "公布彈藥中…";
    } else if (!isMyTurn()) {
      hint.textContent = "等 " + (p.activeName || "對手") + " 行動";
    } else if (!live.length) {
      hint.textContent = "沒有可瞄準的對手";
    } else {
      hint.textContent = "";
    }
  }

  function renderAll() {
    renderHud();
    renderFoes();
    renderSelf();
    renderTurn();
    renderItems();
    renderButtons();
    syncTurnTimer();
  }

  // ---------------------------------------------------------------- 動作演出
  function flashGun(kind) {
    const gun = $("gun");
    gun.classList.remove("is-aiming", "is-live", "is-blank", "is-recoil");
    void gun.offsetWidth;
    gun.classList.add("is-aiming");
    if (kind === "live") gun.classList.add("is-live");
    if (kind === "blank") gun.classList.add("is-blank");
  }

  function recoil() {
    const gun = $("gun");
    gun.classList.remove("is-recoil");
    void gun.offsetWidth;
    gun.classList.add("is-recoil");
  }

  function shakeScreen() {
    document.body.classList.remove("is-shaking");
    void document.body.offsetWidth;
    document.body.classList.add("is-shaking");
  }

  function pulseHearts(node) {
    if (!node) return;
    node.classList.remove("is-hit");
    void node.offsetWidth;
    node.classList.add("is-hit");
  }

  function showHit(id, damage) {
    if (id === state.youId) {
      pulseHearts($("myHearts"));
    } else {
      pulseHearts(document.querySelector('[data-hearts="' + id + '"]'));
    }
    if (damage > 0) $("hint").textContent = "-" + damage + " HP";
  }

  function showTaunt(action) {
    const node = $("bubble");
    node.textContent = action.text || "";
    node.hidden = false;
    node.style.animation = "none";
    void node.offsetWidth;
    node.style.animation = "";
    clearTimeout(showTaunt._timer);
    showTaunt._timer = setTimeout(() => {
      node.hidden = true;
    }, 4600);
  }

  // ---------------------------------------------------------------- 伺服器動作
  function applyAction(action) {
    if (!action || !action.type) return;
    switch (action.type) {
      case "GAME_START":
        showGame();
        break;
      case "RELOAD":
        $("roundLabel").textContent = action.round ?? "1";
        flashGun("blank");
        break;
      case "AMMO_REVEAL":
        showReveal({
          round: action.round,
          live: action.live,
          blank: action.blank,
          ms: action.ms,
        });
        break;
      case "AMMO_REVEAL_END":
        hideReveal();
        break;
      case "ITEM_USED":
        $("hint").textContent = (action.playerName || "有人") + " 用了 " + (action.itemName || "道具");
        break;
      case "SHOT": {
        flashGun(action.realShell ? "live" : "blank");
        recoil();
        if (action.realShell) shakeScreen();
        if (action.damage > 0) showHit(action.targetId, action.damage);
        break;
      }
      case "DAMAGE":
        if (action.damage > 0) showHit(action.targetId || action.playerId, action.damage);
        break;
      case "HEAL":
        $("hint").textContent = "回復 " + (action.amount || 1) + " HP";
        break;
      case "TAUNT":
        showTaunt(action);
        break;
      case "ROUND_END":
        $("hint").textContent = "本輪子彈打完了，重新裝填…";
        break;
      default:
        break;
    }
  }

  function runActions(actions) {
    // 串行播放，避免多個動作的動畫互相打斷
    state.queue = state.queue.then(async () => {
      for (const action of actions || []) {
        applyAction(action);
        if (action.type === "SHOT" || action.type === "TAUNT") await sleep(420);
      }
    });
    return state.queue;
  }

  // ---------------------------------------------------------------- 送意圖
  function shoot(targetId) {
    if (!state.socket || state.busy) return;
    if (revealActive()) return;
    state.busy = true;
    state.busyAt = Date.now();
    renderButtons();
    renderItems();

    state.socket.emit("game:shoot", { targetId: targetId }, (res) => {
      state.busy = false;
      if (res && res.ok === false) {
        toast(ERROR_TEXT[res.error] || res.error);
      }
      renderAll();
    });
    // 保險：ack 沒回來也不要卡住
    setTimeout(() => {
      if (state.busy) {
        state.busy = false;
        renderAll();
      }
    }, 5000);
  }

  function useItem(itemId) {
    if (!state.socket || state.busy) return;
    if (revealActive()) return;
    state.busy = true;
    state.busyAt = Date.now();
    renderButtons();
    renderItems();

    state.socket.emit("game:item", { itemId: itemId }, (res) => {
      state.busy = false;
      if (res && res.ok === false) {
        toast(ERROR_TEXT[res.error] || res.error);
      }
      renderAll();
    });
    setTimeout(() => {
      if (state.busy) {
        state.busy = false;
        renderAll();
      }
    }, 5000);
  }

  function toast(text, kind) {
    const node = $("hint");
    node.textContent = text;
    node.style.color = kind === "error" ? "#fca5a5" : "";
    setTimeout(() => {
      node.style.color = "";
    }, 2200);
  }

  // ---------------------------------------------------------------- Socket
  // 重新整理（F5）之後要把座位認回來，所以先準備好重連用的函式
  let rejoinTries = 0;
  let watchdog = null;

  function tryRejoin() {
    const socket = state.socket;
    const session = loadSession();
    if (!socket || !session || !session.code) return Promise.resolve(false);
    if (!state.myName && session.name) state.myName = session.name;

    return new Promise((resolve) => {
      socket.emit("room:rejoin", { code: session.code, name: session.name || "" }, (res) => {
        if (!res || res.ok !== true) {
          // 房間已經結束或被清掉：清紀錄、留在大廳
          clearSession();
          state.code = null;
          state.youId = null;
          resolve(false);
          return;
        }
        rejoinTries = 0;
        state.code = res.code;
        state.youId = res.youId;
        state.hostId = res.hostId || state.hostId;
        showGame();
        renderAll();
        // 重連時如果那局剛好已經結束，直接把結算畫面補回來
        if (pub() && pub().phase === "gameover" && $("result").hidden) {
          showResult({ winnerId: pub().winnerId });
        }
        resolve(true);
      });
    });
  }

  // 保險：真的沒收到 room:update 時，主動再要一次狀態（最多 3 次）
  function armStateWatchdog() {
    if (watchdog) window.clearInterval(watchdog);
    watchdog = window.setInterval(() => {
      const session = loadSession();
      if (!session || !session.ingame) return;
      if (pub()) return;
      if (rejoinTries >= 3) return;
      rejoinTries += 1;
      tryRejoin();
    }, 1500);
  }

  function connect() {
    const socket = io({ transports: ["websocket", "polling"] });
    state.socket = socket;

    socket.on("connect", () => {
      setMessage("已連上伺服器。", "ok");
      // 重新整理 / 斷線重連：拿存下來的房碼與名字把座位認回來
      tryRejoin();
    });

    socket.on("disconnect", () => {
      setMessage("與伺服器斷線，重新連線中…", "error");
    });

    socket.on("server:hello", (payload) => {
      if (payload && payload.config) state.config = payload.config;
    });

    socket.on("room:update", (payload) => {
      if (!payload) return;
      state.busy = false;
      state.busyAt = 0;
      state.code = payload.code || state.code;
      state.hostId = payload.hostId || state.hostId;
      // 伺服器直接告訴我們「你是哪個 id」，不必再靠建房時的 ack 猜
      if (payload.youId) state.youId = payload.youId;
      state.seats = payload.seats || [];
      // 伺服器說「沒有進行中的遊戲」就真的清掉，免得重開房後還畫著上一局的殘影
      state.game = payload.game || { public: null, private: null };

      if (typeof payload.serverNow === "number") {
        state.serverOffset = payload.serverNow - Date.now();
      }
      state.revealUntil = payload.revealUntil || 0;
      state.revealMs = payload.revealMs || 0;
      state.turnDeadline = payload.turnDeadline || 0;
      syncTurnTimer();

      if (pub()) showGame();
      renderAll();
      saveSession({
        code: state.code,
        name: state.myName || (loadSession() || {}).name || "",
        ingame: Boolean(pub()),
      });
      armStateWatchdog();

      // 換人之後再兜一次提示（例如中途加入正卡在公布彈藥）
      if (state.revealUntil > Date.now() + state.serverOffset) {
        const rem = (pub() && pub().remaining) || {};
        if ($("reveal").hidden) {
          showReveal({
            round: pub() ? pub().round : 1,
            live: rem.live || 0,
            blank: rem.blank || 0,
            ms: Math.max(300, state.revealUntil - (Date.now() + state.serverOffset)),
          });
        }
      } else if (!$("reveal").hidden && state.revealUntil === 0) {
        hideReveal();
      }
    });

    socket.on("game:action", (payload) => {
      if (!payload) return;
      state.busy = false;
      state.busyAt = 0;
      runActions(payload.actions);
    });

    socket.on("game:error", (payload) => {
      if (!payload) return;
      toast(ERROR_TEXT[payload.error] || payload.error || "發生錯誤");
    });

    socket.on("game:reveal", (payload) => {
      if (!payload) return;
      showResult(payload);
    });

    socket.on("lobby:update", (payload) => {
      if (!payload) return;
      state.seats = payload.seats || [];
      state.hostId = payload.hostId || state.hostId;
      state.lobbyMax = payload.maxPlayers || state.lobbyMax;
      renderLobbyPlayers(payload);
      if (!payload.inGame) renderAll();
    });
  }

  // 大廳的人數面板：「2 / 4 人（房間已滿）」＋座位清單
  function renderLobbyPlayers(payload) {
    const box = $("lobbyPlayers");
    if (!box) return;
    if (!payload || !payload.code) {
      box.hidden = true;
      box.textContent = "";
      return;
    }
    const limit = payload.humanLimit || state.lobbyMax || 4;
    const joined = typeof payload.joined === "number" ? payload.joined : (payload.seats || []).filter((s) => !s.isAI).length;
    const humans = (payload.seats || []).filter((s) => !s.isAI);
    const names = humans.map((s) => s.name + (s.connected ? "" : "(離線)"));
    const full = Boolean(payload.full);
    box.hidden = false;
    box.className = "lobby__players" + (full ? " is-full" : "");
    box.textContent =
      "人數 " + joined + " / " + limit + (limit === 1 ? "（單人對 AI）" : "") +
      (full ? "・房間已滿" : "") +
      (names.length ? "　" + names.join("、") : "");
  }

  // ---------------------------------------------------------------- 結算
  function showResult(payload) {
    const winnerId = payload.winnerId;
    const win = winnerId === state.youId;
    const title = $("resultTitle");
    title.textContent = win ? "你活下來了" : winnerId ? "你輸了" : "無人生還";
    title.className = "result__title " + (win ? "is-win" : "is-lose");

    const chamber = (payload.chamber || []).map((s) => (s === "LIVE" ? "🔴" : "🔵")).join(" ");
    $("resultText").textContent = chamber ? "最後的彈藥順序：" + chamber : "子彈已經打完了。";
    $("result").hidden = false;
    renderAll();
  }

  // ---------------------------------------------------------------- 大廳事件
  function myName() {
    const value = ($("nameInput").value || "").trim();
    return value || "賭徒" + Math.floor(Math.random() * 900 + 100);
  }

  function bindLobby() {
    $("btnSolo").addEventListener("click", () => {
      const socket = state.socket;
      if (!socket) return;
      setMessage("建立房間中…");
      const name = myName();
      socket.emit("room:create", { name: name }, (res) => {
        if (!res || res.ok !== true) {
          setMessage(ERROR_TEXT[res && res.error] || "建立房間失敗", "error");
          return;
        }
        state.code = res.code;
        state.youId = res.youId;
        state.myName = name;
        saveSession({ code: res.code, name: name, ingame: true });
        socket.emit("game:start", {}, (start) => {
          if (!start || start.ok !== true) {
            setMessage(ERROR_TEXT[start && start.error] || "開局失敗", "error");
            return;
          }
          showGame();
          renderAll();
        });
      });
    });

    $("btnCreate").addEventListener("click", () => {
      const socket = state.socket;
      if (!socket) return;
      const name = myName();
      // 房主選的人數：1 = 單人對 AI，2~4 = 真實玩家數（AI 不佔名額）
      const maxPlayers = Number(($("maxPlayersSelect") || {}).value || 4);
      socket.emit("room:create", { name: name, maxPlayers: maxPlayers }, (res) => {
        if (!res || res.ok !== true) {
          setMessage(ERROR_TEXT[res && res.error] || "建立房間失敗", "error");
          return;
        }
        state.code = res.code;
        state.lobbyMax = res.maxPlayers || maxPlayers;
        state.youId = res.youId;
        state.myName = name;
        saveSession({ code: res.code, name: name, ingame: false });
        showGame();
        setMessage("房間已建立，房碼 " + res.code + "（把房碼給朋友，按開局開始）", "ok");
        renderAll();
      });
    });

    $("btnJoin").addEventListener("click", () => {
      const socket = state.socket;
      if (!socket) return;
      const code = ($("codeInput").value || "").trim().toUpperCase();
      if (code.length < 4) {
        setMessage("請輸入 4 碼房碼。", "error");
        return;
      }
      const name = myName();
      socket.emit("room:join", { code: code, name: name }, (res) => {
        if (!res || res.ok !== true) {
          setMessage(ERROR_TEXT[res && res.error] || "加入失敗", "error");
          return;
        }
        state.code = res.code;
        state.youId = res.youId;
        state.hostId = res.hostId;
        state.myName = name;
        saveSession({ code: res.code, name: name });
        showGame();
        renderAll();
      });
    });

    $("nameInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") $("btnSolo").click();
    });
    $("codeInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") $("btnJoin").click();
    });
  }

  function bindGame() {
    $("btnSelf").addEventListener("click", () => shoot(null));

    $("btnEnemy").addEventListener("click", () => {
      const live = aliveOthers();
      if (!live.length) {
        toast("沒有可瞄準的對手");
        return;
      }
      // 只有一個對手：直接打他
      if (live.length === 1) {
        state.selectedTarget = live[0].id;
        shoot(live[0].id);
        return;
      }
      // 多個對手：已經鎖定就直接打，還沒鎖定就請他先選
      const chosen = live.find((x) => x.id === state.selectedTarget);
      if (chosen) {
        shoot(chosen.id);
        return;
      }
      $("targets").hidden = false;
      toast("先選一個對手（點上面的對手卡片也可以）");
    });

    $("quitBtn").addEventListener("click", () => {
      if (state.socket && state.code) {
        state.socket.emit("room:leave", { code: state.code });
      }
      showLobby();
    });

    $("startBtn").addEventListener("click", () => {
      if (!state.socket) return;
      state.busy = true;
      state.busyAt = Date.now();
      state.socket.emit("game:start", {}, (res) => {
        state.busy = false;
        if (!res || res.ok !== true) {
          toast(ERROR_TEXT[res && res.error] || "開局失敗", "error");
        }
        renderAll();
      });
    });

    $("btnAgain").addEventListener("click", () => {
      $("result").hidden = true;
      if (state.socket) {
        state.socket.emit("room:rematch", {}, (res) => {
          if (res && res.ok === false) {
            toast(res.error === "WAITING_FOR_OTHERS" ? "等其他玩家也按再來一局" : "無法重開");
          }
        });
      }
    });

    $("btnLeave").addEventListener("click", () => {
      $("result").hidden = true;
      if (state.socket && state.code) {
        state.socket.emit("room:leave", { code: state.code });
      }
      showLobby();
    });

    // 鍵盤：Q = 對自己、E = 對敵人
    document.addEventListener("keydown", (event) => {
      if ($("game").hidden) return;
      const tag = (event.target && event.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (event.key === "q" || event.key === "Q") {
        if (!$("btnSelf").disabled) $("btnSelf").click();
      }
      if (event.key === "e" || event.key === "E") {
        if (!$("btnEnemy").disabled) $("btnEnemy").click();
      }
    });
  }

  // ---------------------------------------------------------------- 啟動
  function boot() {
    bindLobby();
    bindGame();
    showLobby(true); // 保留 session，重新整理後才認得回原本的座位
    const session = loadSession();
    if (session && session.name) {
      $("nameInput").value = session.name;
      state.myName = session.name;
    } else if (!$("nameInput").value) {
      $("nameInput").value = "賭徒";
    }
    armStateWatchdog();
    connect();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
