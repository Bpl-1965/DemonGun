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
    ROUND_PAUSE: "本輪剛結束，稍等一下就換你。",
    GAME_NOT_PLAYING: "遊戲還沒開始或已經結束。",
    PLAYER_DEAD: "你已經出局了。",
    TOO_FAST: "手速太快了，慢一點。",
    ACTION_PAUSE: "開槍中，等結果揭曉。",
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
    roomUrl: null, // 分享連結（/room/<code>/<token>），由伺服器提供
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
    // 本輪打光後的緩衝（伺服器時間軸 ms）：期間按鈕鎖住，讓最後一發的動畫播完
    roundPauseUntil: 0,
    actionPauseUntil: 0,
    actionPauseTimer: null,
    actionPauseTimerDeadline: 0,
    // 道具兩段式操作：第一次點擊只選中並顯示說明，第二次才真的使用
    armedItem: null,
    armedItemAt: 0,
    lastTurnKey: "none", // 用來偵測回合 / 輪次變化，變化時清除道具鎖定
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
  // 本輪打光後的緩衝（伺服器會在這段時間鎖住按鈕，讓最後一發的動畫播完）
  const roundPauseActive = () => state.roundPauseUntil > Date.now() + state.serverOffset;
  const actionPauseActive = () => state.actionPauseUntil > Date.now() + state.serverOffset;

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

    // 只有「對手名單 / 血量 / 回合 / 死亡 / 選中」真的變了才重建 DOM。
    // 每輪換彈時只要血量沒變就不重建，避免重複產生節點與事件監聽器。
    const sig = JSON.stringify([
      list.map((f) => [f.id, f.name, f.hp, f.maxHp, f.dead, f.itemCount, f.skips || 0]),
      p ? p.activeId : null,
      state.selectedTarget,
    ]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;

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
      if (Number(foe.skips) > 0) card.classList.add("is-cuffed");

      // ⛓️ 被上銬的紅色警示徽章
      if (Number(foe.skips) > 0) {
        const cuff = document.createElement("span");
        cuff.className = "cuffed-badge";
        cuff.textContent = "⛓️ 已上銬" + (Number(foe.skips) > 1 ? " ×" + foe.skips : "");
        card.appendChild(cuff);
      }

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
    // ⛓️ 自己被上銬時也顯示鎖鏈邊框
    const meCuffed = Number(me && me.skips) > 0;
    node.classList.toggle("is-cuffed", meCuffed);
    if (typeof node.querySelector === "function") {
      const oldBadge = node.querySelector(".cuffed-badge");
      if (oldBadge && typeof oldBadge.remove === "function") oldBadge.remove();
    }
    if (meCuffed && typeof node.appendChild === "function") {
      const cuff = document.createElement("span");
      cuff.className = "cuffed-badge";
      cuff.textContent = "⛓️ 已上銬" + (Number(me.skips) > 1 ? " ×" + me.skips : "");
      node.appendChild(cuff);
    }

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
      const chance = itemChance(item);
      box.innerHTML =
        '<span class="item-tooltip__name">' +
        (item.icon ? item.icon + " " : "") +
        esc(item.name) +
        '</span><span class="item-tooltip__desc">' +
        esc(item.desc || "") +
        "</span>" +
        (chance === null
          ? ""
          : '<span class="item-tooltip__meta">成功率 ' + formatChance(chance) + "%</span>") +
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

  // ---------------------------------------------------------------- 道具（兩段式操作）
  // 第一次點擊＝選中並顯示說明；第二次點擊同一格（或 Tooltip 的「使用」）才真的送 game:item。
  // 觸控裝置沒有 hover，這個機制讓玩家能先看清楚再決定，也避免誤觸。

  // 小工具：有些極簡 DOM 環境（或舊瀏覽器）沒有 setAttribute，避免直接炸掉
  function setAttr(node, name, value) {
    if (node && typeof node.setAttribute === "function") node.setAttribute(name, value);
  }

  function armItem(item, wasted) {
    state.armedItem = item ? item.id : null;
    state.armedItemAt = Date.now();
    tooltip.hide();
    const grid = $("itemsGrid");
    if (grid) {
      Array.prototype.forEach.call(grid.querySelectorAll(".slot"), (node) => {
        const on = item && node.dataset && node.dataset.itemId === item.id;
        node.classList.toggle("is-armed", Boolean(on));
        setAttr(node, "aria-pressed", on ? "true" : "false");
      });
    }
    if (item) openItemCard(item, wasted);
    else closeItemCard();
  }

  function disarmItem() {
    // 不管 armedItem 是否為 null 都清一次 DOM，
    // 避免狀態與畫面不同步時留下殘留的選中框或說明卡。
    state.armedItem = null;
    state.armedItemAt = 0;
    const grid = $("itemsGrid");
    if (grid) {
      Array.prototype.forEach.call(grid.querySelectorAll(".slot.is-armed"), (node) => {
        node.classList.remove("is-armed");
        setAttr(node, "aria-pressed", "false");
      });
    }
    closeItemCard();
    tooltip.hide();
  }

  function itemChance(item) {
    const catalog = (state.config && state.config.ITEMS) || [];
    const definition = catalog.find((entry) => entry.id === item.id);
    const raw = (item.params || (definition && definition.params) || {}).CHANCE;
    if (typeof raw === "undefined") return null;
    let pct;
    if (typeof raw === "string" && raw.indexOf("/") !== -1) {
      const parts = raw.split("/", 2).map(Number);
      pct = parts[1] ? (parts[0] / parts[1]) * 100 : 0;
    } else {
      const value = Number(raw);
      if (!Number.isFinite(value)) return 100;
      pct = value <= 1 ? value * 100 : value;
    }
    return Math.max(0, Math.min(100, Number(pct.toFixed(1))));
  }

  function formatChance(chance) {
    return Number.isInteger(chance) ? String(chance) : chance.toFixed(1);
  }

  /** 固定在道具欄上方（手機）或賭桌中央的說明卡 */
  function openItemCard(item, wasted) {
    const card = $("itemCard");
    if (!card) return;
    const chance = itemChance(item);
    const chanceText = chance === null
      ? ""
      : '<span class="item-card__chance">成功率 ' + formatChance(chance) + "%</span>";
    card.innerHTML =
      '<div class="item-card__head">' +
      '<span class="item-card__icon">' + esc(item.icon || "❓") + "</span>" +
      '<span class="item-card__name">' + esc(item.name) + "</span>" +
      chanceText +
      "</div>" +
      '<p class="item-card__desc">效果：' + esc(item.desc || "") + "</p>" +
      (wasted ? '<p class="item-card__warn">生命值已滿，現在用會浪費</p>' : "") +
      '<p class="item-card__hint">再點一次道具即可使用</p>';
    card.hidden = false;
    card.classList.add("is-open");
  }

  function closeItemCard() {
    const card = $("itemCard");
    if (!card) return;
    card.classList.remove("is-open");
    card.hidden = true;
    card.innerHTML = "";
  }

  function renderItems() {
    const grid = $("itemsGrid");
    if (!grid) return;
    const allItems = (priv() && priv().items) || [];
    const me = myPlayer();
    const p = pub();

    // ⚠ 道具欄硬上限：後端有 8 件上限，但前端也要自己裁一次，
    // 避免任何情況（舊存檔 / 伺服器版本不同）畫出超過 8 格把版面撐壞。
    const slotCap = Number(
      (state.config && state.config.LIMITS && state.config.LIMITS.MAX_ITEMS) || 8
    ) || 8;
    const items = allItems.slice(0, slotCap);

    // ── 道具可用的必要條件（全部成立才解鎖）──
    //   1. 遊戲進行中
    //   2. 不是裝填揭曉鎖定期
    //   3. 現在是我的回合
    //   4. 我還活著
    //   5. 這一回合使用道具數還沒到上限
    // ⚠ 不能用 || 3：設定值 0 代表「不限」，但 0 是 falsy 會被誤判成 3。
    const rawMax =
      state.config && state.config.LIMITS && typeof state.config.LIMITS.MAX_ITEMS_PER_TURN === "number"
        ? state.config.LIMITS.MAX_ITEMS_PER_TURN
        : 0;
    const maxPerTurn = Number(rawMax);
    const usedThisTurn = Number((priv() && priv().itemsThisTurn) || 0);
    const revealLocked = revealActive();
    const myTurnNow = isMyTurn();
    const alive = Boolean(me && !me.dead);
    // maxPerTurn <= 0 → 不限次數
    const itemBudgetLeft = maxPerTurn <= 0 || usedThisTurn < maxPerTurn;
    const canUse =
      Boolean(p) && p.phase === "playing" && !revealLocked && !roundPauseActive() &&
      !actionPauseActive() && !state.busy && myTurnNow && alive && itemBudgetLeft;
    const hpFull = Boolean(alive && me.hp >= me.maxHp);

    // ── 跨回合清除：只要不是我的回合 / 正在裝填 / 道具已消失，就取消鎖定 ──
    if (
      state.armedItem &&
      (!canUse || !items.some((it) => it.id === state.armedItem))
    ) {
      disarmItem();
    }

    // 內容沒變就不重建 DOM，避免每幀重繪造成卡頓
    const sig =
      items.map((it) => it.id).join("|") +
      "#" + (canUse ? 1 : 0) +
      (hpFull ? 1 : 0) +
      "#" + (myTurnNow ? 1 : 0) +
      (revealLocked ? 1 : 0) +
      (roundPauseActive() ? 1 : 0) +
      (actionPauseActive() ? 1 : 0) +
      (state.busy ? 1 : 0) +
      usedThisTurn;
    if (grid.dataset.sig === sig) return;
    grid.dataset.sig = sig;
    grid.innerHTML = "";

    items.forEach((item) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "slot";
      btn.dataset.itemId = item.id;
      setAttr(btn, "aria-pressed", "false");
      // 純回血道具在滿血時沒有意義：直接鎖住，不讓玩家白花一個道具
      const effect = itemEffect(item.id);
      const wasted = hpFull && (effect === "heal" || effect === "random_heal");
      btn.disabled = !canUse || wasted;
      btn.title = wasted ? "生命值已滿，現在用會浪費。" : item.desc || "";
      if (wasted) btn.classList.add("slot--waste");
      if (state.armedItem === item.id) btn.classList.add("is-armed");
      btn.innerHTML =
        '<span class="slot__icon">' +
        (item.icon || "❓") +
        '</span><span class="slot__name">' +
        item.name +
        "</span>";

      // 兩段式：第一下選中，第二下才使用。
      // 點擊當下再驗一次：不是我的回合 / 裝填中 / 已用滿 → 直接忽略，不進入鎖定狀態。
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        if (btn.disabled) return;
        if (!isMyTurn() || revealActive() || roundPauseActive() || actionPauseActive()) {
          disarmItem();
          return;
        }
        if (state.armedItem === item.id) {
          disarmItem();
          useItem(item.id);
        } else {
          armItem(item, wasted);
        }
      });

      // 滑鼠 hover 仍保留原本的浮動提示（觸控裝置沒有 hover，不受影響）
      btn.addEventListener("mouseenter", (event) => {
        if (state.armedItem) return; // 已經選中時以說明卡為準
        tooltip.show(event, item, wasted);
      });
      btn.addEventListener("mousemove", (event) => {
        if (state.armedItem) return;
        tooltip.move(event);
      });
      btn.addEventListener("mouseleave", () => tooltip.hide());
      grid.appendChild(btn);
    });

    // 空格補到 slotCap（設定裡的道具欄位數），不要硬寫 3
    const empty = Math.max(0, slotCap - items.length);
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

    // revealActive() / roundPauseActive() 都會自動換算伺服器時間
    const isLocked = revealActive() || roundPauseActive() || actionPauseActive();
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
    if (actionPauseActive()) {
      disarmItem();
      $("btnSelf").disabled = true;
      $("btnEnemy").disabled = true;
      const grid = $("itemsGrid");
      if (grid && typeof grid.querySelectorAll === "function") {
        Array.prototype.forEach.call(grid.querySelectorAll(".slot"), (slot) => {
          slot.disabled = true;
        });
      }
      if (state.actionPauseTimerDeadline !== state.actionPauseUntil) {
        clearTimeout(state.actionPauseTimer);
        state.actionPauseTimerDeadline = state.actionPauseUntil;
        state.actionPauseTimer = setTimeout(() => {
          state.actionPauseTimer = null;
          if (!actionPauseActive()) state.actionPauseUntil = 0;
          renderAll();
        }, Math.max(0, state.actionPauseUntil - (Date.now() + state.serverOffset)) + 20);
      }
      return;
    }
    clearTimeout(state.actionPauseTimer);
    state.actionPauseTimer = null;
    state.actionPauseTimerDeadline = 0;
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
    gun.classList.remove("is-aiming", "is-winding", "is-live", "is-blank", "is-recoil");
    void gun.offsetWidth;
    gun.classList.add("is-aiming");
    if (kind === "live") gun.classList.add("is-live");
    if (kind === "blank") gun.classList.add("is-blank");
  }

  function windupGun(action) {
    const gun = $("gun");
    if (!gun) return;
    gun.classList.remove("is-aiming", "is-winding", "is-live", "is-blank", "is-recoil");
    gun.classList.add("is-winding");
    gun.dataset.aimTarget = action.targetId || "";
    document.body.classList.remove("is-awaiting");
    void document.body.offsetWidth;
    document.body.classList.add("is-awaiting");
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
      // 只有自己受傷才用 hint 提醒血量
      if (damage > 0) $("hint").textContent = "-" + damage + " HP";
    } else {
      pulseHearts(document.querySelector('[data-hearts="' + id + '"]'));
      // 別人受傷：保留原本「誰對誰開槍」的紀錄，不要被 -N HP 蓋掉
    }
  }

  /** 🍺 啤酒退彈：全房可見的退殼展示（1.8 秒後淡出） */
  function showEject(action) {
    const node = $("ejectToast");
    if (!node) return;
    const shells = action.shells && action.shells.length ? action.shells : [action.shell];
    const kind = shells[0] === "LIVE" ? "live" : "blank";
    const label = kind === "live" ? "實彈" : "空包彈";
    const count = shells.length > 1 ? "共 " + shells.length + " 發" : "";
    node.innerHTML =
      '<span class="eject-toast__shell eject-toast__shell--' + kind + '">' +
      '<i class="eject-toast__cap"></i><i class="eject-toast__body"></i><i class="eject-toast__rim"></i>' +
      "</span>" +
      '<span class="eject-toast__text">🍺 退出了 ' + shells.length + " 發【" + label + "】" + count + "</span>";
    node.hidden = false;
    node.classList.remove("is-showing");
    void node.offsetWidth;
    node.classList.add("is-showing");
    clearTimeout(showEject._timer);
    showEject._timer = setTimeout(() => {
      node.classList.remove("is-showing");
      node.hidden = true;
    }, 1800);

    // 同步更新剩餘彈數提示
    const rem = action.remaining || {};
    if (typeof rem.live === "number") {
      $("hint").textContent = "剩餘 " + rem.live + " 實彈 / " + rem.blank + " 空包";
    }
  }

  /** ⛓️ 手銬生效：座位震動 + 提示 */
  function showSkipTurn(action) {
    const name = action.playerName || "對手";
    $("hint").textContent = "⛓️ " + name + " 行動被手銬封鎖，跳過本回合！";
    const id = action.playerId;
    const card =
      id === state.youId ? $("me") : document.querySelector('.foe[data-id="' + id + '"]');
    if (!card) return;
    card.classList.remove("is-cuffed-hit");
    void card.offsetWidth;
    card.classList.add("is-cuffed-hit");
    setTimeout(() => card.classList.remove("is-cuffed-hit"), 900);
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
        // 換輪：取消任何道具鎖定，避免上一輪的選中框留到新的一輪
        disarmItem();
        break;
      case "AMMO_REVEAL":
        // 進入裝填揭曉 → 立刻解除道具鎖定並收起說明卡
        disarmItem();
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
      case "EJECT":
        // 🍺 啤酒退彈：所有人都看得到退出來的那一顆
        showEject(action);
        break;
      case "SKIP_TURN":
        // ⛓️ 手銬生效：座位卡片震動 + 明確提示
        showSkipTurn(action);
        break;
      case "SHOT": {
        document.body.classList.remove("is-awaiting");
        const report = (action.shooterName || "有人") + " 對 " +
          (action.targetName || "目標") + " 開槍（" + (action.realShell ? "實彈" : "空包彈") + "）";
        $("hint").textContent = report;
        flashGun(action.realShell ? "live" : "blank");
        recoil();
        // 只有「自己打」或「自己被打」才震動整個畫面；
        // 別人互打只在旁邊跑動畫，不然畫面會一直晃。
        const mine = action.shooterId === state.youId || action.targetId === state.youId;
        if (action.realShell && mine) shakeScreen();
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
        if (action.type === "SHOT") {
          windupGun(action);
          await sleep(650);
        }
        applyAction(action);
        if (action.type === "SHOT" || action.type === "TAUNT") await sleep(420);
      }
    });
    return state.queue;
  }

  // ---------------------------------------------------------------- 送意圖
  function shoot(targetId) {
    if (!state.socket || state.busy) return;
    if (revealActive() || roundPauseActive()) return;
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
    // 最後一道防線：不是我的回合、裝填中、或本輪緩衝期間就不送（後端同樣會擋）
    if (!isMyTurn() || revealActive() || roundPauseActive() || actionPauseActive()) {
      disarmItem();
      return;
    }
    disarmItem();
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
  // ⚠ 只建立一次常駐計時器。之前每次收到 room:update 都 clear + 重設一次，
  //    等於每輪都重新建立 setInterval，換幾輪之後就會累積一堆計時器造成卡頓。
  function armStateWatchdog() {
    if (watchdog) return; // 已經在跑就不要重建
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
      // 用分享連結進來的人：連上後自動加入那間房
      joinFromLink();
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
      if (payload.roomUrl) state.roomUrl = payload.roomUrl;
      // 伺服器直接告訴我們「你是哪個 id」，不必再靠建房時的 ack 猜
      if (payload.youId) state.youId = payload.youId;
      state.seats = payload.seats || [];
      // 伺服器每次都會帶最新道具表：中途加入或伺服器改過道具時，說明文字不會過期
      if (Array.isArray(payload.items) && state.config) {
        state.config = Object.assign({}, state.config, { ITEMS: payload.items });
      }
      // 伺服器說「沒有進行中的遊戲」就真的清掉，免得重開房後還畫著上一局的殘影
      state.game = payload.game || { public: null, private: null };

      if (typeof payload.serverNow === "number") {
        state.serverOffset = payload.serverNow - Date.now();
      }
      state.revealUntil = payload.revealUntil || 0;
      state.revealMs = payload.revealMs || 0;
      state.roundPauseUntil = payload.roundPauseUntil || 0;
      state.actionPauseUntil = payload.actionPauseUntil || 0;
      state.turnDeadline = payload.turnDeadline || 0;
      syncTurnTimer();

      // ── 跨回合 / 換輪清除道具鎖定 ──
      // 回合換人、換輪、進入裝填、遊戲結束 → 一律取消選中並收起說明卡，
      // 避免上一回合的燙金選中框與浮動卡片殘留到下一輪。
      const nowPub = pub();
      const turnKey =
        nowPub ? nowPub.phase + "|" + (nowPub.activeId || "") + "|" + (nowPub.round || 0) : "none";
      if (state.lastTurnKey !== turnKey) {
        state.lastTurnKey = turnKey;
        if (state.armedItem) disarmItem();
      }
      if (state.revealUntil > Date.now() + state.serverOffset && state.armedItem) {
        disarmItem();
      }

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
      if ((payload.actions || []).some((action) => action && action.type === "SHOT")) {
        state.actionPauseUntil = Math.max(
          state.actionPauseUntil,
          Date.now() + state.serverOffset + 650
        );
        disarmItem();
        renderAll();
      }
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
      if (payload.roomUrl) state.roomUrl = payload.roomUrl;
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

    // 分享連結：給房主複製，朋友打開就是 /room/<房碼>/<token>
    const share = $("roomShare");
    if (share) {
      const url = payload.roomUrl ? window.location.origin + payload.roomUrl : state.roomUrl;
      if (url) {
        share.hidden = false;
        share.textContent = "邀請連結： " + url + "（點一下複製）";
        share.dataset.url = url;
      } else {
        share.hidden = true;
      }
    }
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
        state.roomUrl = res.roomUrl || roomShareUrl(res.code, res.token);
        // 把網址換成分享連結，複製瀏覽器網址列就是邀請連結
        if (state.roomUrl) {
          try {
            if (window.history && window.history.replaceState) {
              window.history.replaceState({}, "", state.roomUrl);
            }
          } catch (err) {
            /* 舊瀏覽器忽略 */
          }
        }
        saveSession({ code: res.code, name: name, ingame: false });
        showGame();
        setMessage("房間已建立，房碼 " + res.code + "（把連結給朋友，按開局開始）", "ok");
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

    // 點邀請連結文字即複製到剪貼簿
    const share = $("roomShare");
    if (share) {
      share.addEventListener("click", () => {
        const url = share.dataset.url || "";
        if (!url) return;
        const done = () => setMessage("已複製邀請連結 ✅", "ok");
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done, () => setMessage("複製失敗，請手動選取", "error"));
        } else {
          setMessage("請手動複製：" + url);
        }
      });
    }
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
      if (event.key === "Escape") disarmItem();
    });

    // 點空白處（不是道具格、也不是說明卡）就取消選中並收起說明卡
    document.addEventListener("click", (event) => {
      if (!state.armedItem) return;
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      if (target.closest(".slot") || target.closest("#itemCard")) return;
      disarmItem();
    });
  }

  // ---------------------------------------------------------------- 分享連結
  // 網址格式：/room/<房碼>/<token>
  // 朋友點連結就能直接進房；token 只是讓連結不好猜，真正的身分仍由 socket 決定。
  function parseRoomLink() {
    const loc = window.location || {};
    const m = String(loc.pathname || "").match(/^\/room\/([^/]+)\/([^/]+)\/?$/);
    if (!m) return null;
    try {
      return { code: decodeURIComponent(m[1]).toUpperCase(), token: decodeURIComponent(m[2]) };
    } catch (err) {
      return null;
    }
  }

  // 房間被刪掉或 token 不對時，把網址還原成首頁，免得重整後又卡在同一個壞連結
  function clearRoomLink() {
    if (!parseRoomLink()) return;
    try {
      if (window.history && window.history.replaceState) {
        window.history.replaceState({}, "", "/");
      }
    } catch (err) {
      /* 舊瀏覽器忽略 */
    }
  }

  // 連上伺服器後，若網址帶著房碼就自動加入（避免使用者還要手動輸入）
  function joinFromLink() {
    const link = parseRoomLink();
    const socket = state.socket;
    if (!link || !socket) return;
    if (state.code === link.code && pub()) return; // 已經在這間房了

    $("codeInput").value = link.code;
    if (!state.myName) {
      const value = ($("nameInput").value || "").trim();
      state.myName = value || "賭徒" + Math.floor(Math.random() * 900 + 100);
      $("nameInput").value = state.myName;
    }
    setMessage("正在加入房間 " + link.code + "…");

    socket.emit("room:join", { code: link.code, name: state.myName }, (res) => {
      if (!res || res.ok !== true) {
        const error = (res && res.error) || "JOIN_FAILED";
        setMessage(ERROR_TEXT[error] || "無法加入房間", "error");
        clearRoomLink();
        return;
      }
      state.code = res.code;
      state.youId = res.youId;
      state.hostId = res.hostId || state.hostId;
      saveSession({ code: res.code, name: state.myName, ingame: false });
      showGame();
      setMessage("已加入房間 " + res.code, "ok");
      renderAll();
    });
  }

  // 房主複製分享連結用（大廳顯示的房碼也可以點）
  function roomShareUrl(code, token) {
    const origin = (window.location && window.location.origin) || "";
    if (!code || !token) return "";
    return origin + "/room/" + encodeURIComponent(code) + "/" + encodeURIComponent(token);
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
    // 網址帶著房碼時先把房碼填好，連線後會自動加入
    const link = parseRoomLink();
    if (link) $("codeInput").value = link.code;
    armStateWatchdog();
    connect();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
