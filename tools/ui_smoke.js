/* 用假的 DOM 跑 client.js，驗證 1~3 個對手的版面與按鈕邏輯（不需瀏覽器） */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "public", "client.js");
const code = fs.readFileSync(SRC, "utf8");

// ------------------------------------------------------------------ DOM stub
function makeEl(tag) {
  const el = {
    tagName: (tag || "div").toUpperCase(),
    children: [],
    dataset: {},
    style: {
      setProperty(k, v) {
        this[k] = String(v);
      },
      removeProperty(k) {
        delete this[k];
      },
    },
    _text: "",
    _html: "",
    hidden: false,
    disabled: false,
    className: "",
    offsetWidth: 1,
    _listeners: {},
    classList: {
      _set: new Set(),
      add(...c) {
        c.forEach((x) => this._set.add(x));
      },
      remove(...c) {
        c.forEach((x) => this._set.delete(x));
      },
      toggle(c, on) {
        const want = on === undefined ? !this._set.has(c) : Boolean(on);
        if (want) this._set.add(c);
        else this._set.delete(c);
      },
      contains(c) {
        return this._set.has(c);
      },
    },
    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
      return child;
    },
    querySelectorAll(selector) {
      const hasClass = (child, name) =>
        child.classList.contains(name) || String(child.className || "").split(/\s+/).includes(name);
      if (selector === ".slot") {
        return this.children.filter((child) => hasClass(child, "slot"));
      }
      if (selector === ".slot.is-armed") {
        return this.children.filter(
          (child) => hasClass(child, "slot") && hasClass(child, "is-armed")
        );
      }
      return [];
    },
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    click() {
      (this._listeners.click || []).forEach((fn) => fn({ stopPropagation() {} }));
    },
  };
  Object.defineProperty(el, "textContent", {
    get() {
      return this._text;
    },
    set(v) {
      this._text = String(v);
      this.children.length = 0;
    },
  });
  Object.defineProperty(el, "innerHTML", {
    get() {
      return this._html;
    },
    set(v) {
      this._html = String(v);
      this.children.length = 0;
    },
  });
  return el;
}

const byId = new Map();
const document = {
  readyState: "complete",
  getElementById(id) {
    if (!byId.has(id)) byId.set(id, makeEl("div"));
    return byId.get(id);
  },
  createElement(tag) {
    return makeEl(tag);
  },
  querySelector(sel) {
    // 支援 client.js 用到的 `.foe[data-id="xxx"]` 與 `[data-hearts="xxx"]`
    const m = String(sel || "").match(/\[data-(\w+)="([^"]+)"\]/);
    if (!m) return null;
    const key = m[1] === "id" ? "id" : m[1];
    const value = m[2];
    const pools = [
      document.getElementById("opponents"),
      document.getElementById("itemsGrid"),
      document.getElementById("me"),
    ];
    for (const pool of pools) {
      const found = (pool.children || []).find(
        (c) => (c.dataset && c.dataset[key] === value) || c.getAttribute && c.getAttribute("data-" + key) === value
      );
      if (found) return found;
    }
    return null;
  },
  addEventListener() {},
};

// ------------------------------------------------------------------ socket stub
const handlers = {};
const acks = {};
const emissions = [];
const socket = {
  on(type, fn) {
    (handlers[type] = handlers[type] || []).push(fn);
  },
  emit(type, payload, ack) {
    emissions.push({ type, payload });
    acks[type] = ack;
  },
};
function fire(type, payload) {
  (handlers[type] || []).forEach((fn) => fn(payload));
}

const store = new Map();
let intervalId = 0;
const intervals = new Map();
const innerWidth = 1280;
const innerHeight = 800;
const window = {
  innerWidth,
  innerHeight,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  setInterval(fn) {
    intervalId += 1;
    intervals.set(intervalId, fn);
    return intervalId;
  },
  clearInterval(id) {
    intervals.delete(id);
  },
};
// 手動跑所有還活著的 setInterval（模擬時間流逝）
function tick(n) {
  for (let i = 0; i < (n || 1); i += 1) {
    Array.from(intervals.values()).forEach((fn) => fn());
  }
}

const sandbox = {
  document,
  window,
  io: () => socket,
  setTimeout,
  clearTimeout,
  console,
};
sandbox.globalThis = sandbox;
sandbox.Date = Date;
// 瀏覽器裡 setInterval / clearInterval 是全域函式，client.js 直接裸呼，沙箱要補上
sandbox.setInterval = window.setInterval;
sandbox.clearInterval = window.clearInterval;
sandbox.innerWidth = innerWidth;
sandbox.innerHeight = innerHeight;

const vm = require("vm");
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "client.js" });

// client.js 是在沙箱裡跑的，它看到的 Date / setInterval 也在沙箱裡；
// 讓它跟測試共用同一個（假的）時鐘
sandbox.Date = Date;

// ------------------------------------------------------------------ 測試
let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log("  ✓ " + name);
  } else {
    fail += 1;
    console.log("  ✗ " + name + (extra ? " → " + JSON.stringify(extra) : ""));
  }
}

function player(id, name, hp, extra) {
  return Object.assign(
    { id, name, hp, maxHp: 4, dead: false, itemCount: 2, isAi: false, is_ai: false },
    extra || {}
  );
}

function update(players, activeId, youId) {
  updateWith(players, activeId, youId, 0);
}

function updateWith(players, activeId, youId, deadlineMs) {
  fire("room:update", {
    code: "ABCD",
    hostId: "p1",
    youId,
    seats: players.map((p) => ({ id: p.id, name: p.name, ready: true })),
    game: {
      public: {
        phase: "playing",
        round: 2,
        activeId,
        activeName: (players.find((p) => p.id === activeId) || {}).name || "",
        winnerId: null,
        players,
        log: [],
        remaining: { live: 2, blank: 1, total: 3 },
      },
      private: {
        playerId: youId,
        items: [
          { id: "CIGARETTE", name: "香菸", icon: "🚬", desc: "回復 1 點生命。" },
          { id: "HANDSAW", name: "手鋸", icon: "🪚", desc: "傷害 +1" },
        ],
        mods: {},
        intel: [],
      },
    },
    revealUntil: 0,
    revealMs: 0,
    serverNow: Date.now(),
    turnDeadline: deadlineMs,
  });
}

const foes = () => document.getElementById("opponents");
document.getElementById("itemCard").hidden = true;
document.getElementById("itemTooltip").hidden = true;

console.log("1) 單人局（1 個對手）");
update([player("p1", "你", 4), player("ai1", "DeepSeek 娘", 3, { isAi: true })], "p1", "p1");
check("對手卡片 1 張", foes().children.length === 1, foes().children.length);
check("--n = 1（置中單欄）", foes().style["--n"] === "1", foes().style["--n"]);
check("不是我的回合前也能正確渲染", document.getElementById("turnLabel").textContent.includes("你的回合"));
check("btnSelf 可按", document.getElementById("btnSelf").disabled === false);
check("btnEnemy 可按", document.getElementById("btnEnemy").disabled === false);
check("敵人副標顯示目標名", document.getElementById("enemySub").textContent.includes("DeepSeek 娘"));

console.log("2) 三人局（2 個對手並排）");
update(
  [player("p1", "你", 4), player("p2", "阿明", 2), player("p3", "阿華", 4)],
  "p2",
  "p1"
);
check("對手卡片 2 張", foes().children.length === 2, foes().children.length);
check("--n = 2", foes().style["--n"] === "2", foes().style["--n"]);
check("不是我的回合 → btnSelf 變灰", document.getElementById("btnSelf").disabled === true);
check("不是我的回合 → btnEnemy 變灰", document.getElementById("btnEnemy").disabled === true);
check("回合文字是別人的", document.getElementById("turnLabel").textContent.includes("阿明"));

console.log("3) 四人局（3 個對手並排）＋ 選目標");
update(
  [player("p1", "你", 4), player("p2", "阿明", 2), player("p3", "阿華", 4), player("p4", "小李", 1)],
  "p1",
  "p1"
);
check("對手卡片 3 張", foes().children.length === 3, foes().children.length);
check("--n = 3", foes().style["--n"] === "3", foes().style["--n"]);
check("我的回合 → btnSelf 可按", document.getElementById("btnSelf").disabled === false);
check("多對手選擇列出現", document.getElementById("targets").hidden === false);
check("選擇列 3 顆按鈕", document.getElementById("targets").children.length === 3);
const before = document.getElementById("enemySub").textContent;
check("未鎖定時副標提示先選", before.includes("先選"), before);

// 點第二張卡 → 鎖定目標（第一次點不開槍）
const card = foes().children[1];
card.click();
check("點卡片鎖定目標", document.getElementById("enemySub").textContent.includes("阿華"));
check("鎖定後卡片有 is-selected", foes().children[1].classList.contains("is-selected"));

// 死亡對手不能點
update(
  [
    player("p1", "你", 4),
    player("p2", "阿明", 0, { dead: true }),
    player("p3", "阿華", 4),
    player("p4", "小李", 1),
  ],
  "p1",
  "p1"
);
check("死亡的對手標記 is-dead", foes().children[0].classList.contains("is-dead"));
check("選擇列只剩活著的 2 人", document.getElementById("targets").children.length === 2);

console.log("4) 回合倒數（turnTimer）");
const timerWrap = document.getElementById("turnTimerWrap");
const timerRing = document.getElementById("turnTimer");

// 現在是我的回合、伺服器給了 20 秒期限
updateWith([player("p1", "你", 4), player("p2", "阿明", 2)], "p1", "p1", Date.now() + 20000);
check("我的回合 → 倒數出現", timerWrap.hidden === false);
check("顯示 20", timerRing.textContent === "20", timerRing.textContent);
tick(1);
check("每秒重算後仍是 20", timerRing.textContent === "20", timerRing.textContent);

// 往前撥 15 秒 → 應該剩 5 秒並轉紅
updateWith([player("p1", "你", 4), player("p2", "阿明", 2)], "p1", "p1", Date.now() + 5000);
check("剩 5 秒顯示 5", timerRing.textContent === "5", timerRing.textContent);
check("剩 5 秒以內標記 is-danger", timerRing.classList.contains("is-danger"));

// 期限到了 → 「時間到」
updateWith([player("p1", "你", 4), player("p2", "阿明", 2)], "p1", "p1", Date.now() - 10);
check("歸零顯示「時間到」", timerRing.textContent === "時間到", timerRing.textContent);
check("歸零標記 is-over", timerRing.classList.contains("is-over"));

// 不是我的回合 → 隱藏
updateWith([player("p1", "你", 4), player("p2", "阿明", 2)], "p2", "p1", Date.now() + 20000);
check("別人的回合 → 倒數隱藏", timerWrap.hidden === true);

// 回到我 → 再次出現
updateWith([player("p1", "你", 4), player("p2", "阿明", 2)], "p1", "p1", Date.now() + 20000);
check("輪到我 → 倒數再出現", timerWrap.hidden === false);

console.log("5) 道具提示框（itemTooltip）");
const tip = document.getElementById("itemTooltip");
const slots = document.getElementById("itemsGrid").children;
check("道具格渲染 2 個", slots.length >= 2, slots.length);
slots[0]._listeners.mouseenter[0]({ clientX: 100, clientY: 200 });
check("mouseenter 後提示框出現", tip.hidden === false);
check("提示框有道具名稱", tip.innerHTML.includes("香菸"));
check("提示框有說明文字", tip.innerHTML.includes("回復 1 點生命。"));
slots[0]._listeners.mousemove[0]({ clientX: 300, clientY: 400 });
check("mousemove 後跟著滑鼠移動", tip.style.left === "314px" && tip.style.top === "414px", [tip.style.left, tip.style.top]);
slots[0]._listeners.mouseleave[0]({});
check("mouseleave 後提示框隱藏", tip.hidden === true);

// 貼近右下角時要往旁邊翻，不能噴出畫面
slots[1]._listeners.mouseenter[0]({ clientX: innerWidth - 5, clientY: innerHeight - 5 });
const tx = parseInt(tip.style.left, 10);
check("靠近右邊界時往左翻轉", tx < innerWidth - 5, { left: tip.style.left, innerWidth });
slots[1]._listeners.mouseleave[0]({});

console.log("6) 道具可用條件（回合權限）");
// 幫 makeEl 補上 disabled 預設值，方便判斷
function itemSlots() {
  // stub 元素的 className 是字串，但 client.js 用 classList 標記；
  // 這裡兩種都接受，避免測試環境差異造成誤判。
  return Array.prototype.filter.call(
    document.getElementById("itemsGrid").children,
    function (n) {
      var isSlot =
        (n.classList && n.classList.contains("slot")) ||
        String(n.className || "").indexOf("slot") !== -1;
      var isEmpty =
        (n.classList && n.classList.contains("slot--empty")) ||
        String(n.className || "").indexOf("slot--empty") !== -1;
      return isSlot && !isEmpty;
    }
  );
}

// 送一份帶指定 activeId / itemsThisTurn / revealUntil / roundPauseUntil 的狀態並回傳道具格
function sendState(activeId, itemsThisTurn, revealUntil, roundPauseUntil) {
  fire("room:update", {
    code: "ABCD",
    hostId: "p1",
    youId: "p1",
    seats: [{ id: "p1", name: "你", ready: true }, { id: "p2", name: "阿明", ready: true }],
    game: {
      public: {
        phase: "playing", round: 2, activeId: activeId, activeName: activeId === "p1" ? "你" : "阿明",
        winnerId: null,
        players: [player("p1", "你", 4), player("p2", "阿明", 2)], log: [],
        remaining: { live: 2, blank: 1, total: 3 },
      },
      private: {
        playerId: "p1",
        items: [{ id: "CIGARETTE", name: "香菸", icon: "🚬", desc: "回復 1 點生命。" }],
        mods: {}, intel: [], itemsThisTurn: itemsThisTurn || 0,
      },
    },
    revealUntil: revealUntil || 0,
    roundPauseUntil: roundPauseUntil || 0,
    revealMs: revealUntil ? 3000 : 0,
    serverNow: Date.now(),
    turnDeadline: Date.now() + 20000,
  });
  return itemSlots();
}

// (a) 不是我的回合 → 道具必須全部 disabled
let its = sendState("p2", 0, 0);
check("別人的回合 → 道具全部 disabled", its.length > 0 && its.every((b) => b.disabled === true),
  its.map((b) => b.disabled));

// (b) 輪到我 → 道具解鎖
its = sendState("p1", 0, 0);
check("我的回合 → 道具可點", its.length > 0 && its.every((b) => b.disabled === false),
  its.map((b) => b.disabled));
its[0].click();
check("第一次點道具只鎖定並顯示說明", its[0].classList.contains("is-armed") && !document.getElementById("itemCard").hidden,
  { armed: its[0].classList.contains("is-armed"), hidden: document.getElementById("itemCard").hidden, disabled: its[0].disabled });
its = sendState("p2", 0, 0);
check("換成別人的回合立即清除選中與說明", document.getElementById("itemCard").hidden &&
  !its.some((b) => b.classList.contains("is-armed")));
its = sendState("p1", 0, 0);
its[0].click();
its[0].click();
check("再次點同一道具才送出 game:item", emissions.some((entry) => entry.type === "game:item"));
if (acks["game:item"]) acks["game:item"]({ ok: true });

// (c) 裝填鎖期間（revealUntil 在未來）→ 道具 disabled
its = sendState("p1", 0, Date.now() + 3000);
check("裝填鎖期間 → 道具 disabled", its.every((b) => b.disabled === true), its.map((b) => b.disabled));

// (d) 本輪結束緩衝期間 → 道具 disabled
its = sendState("p1", 0, 0, Date.now() + 2200);
check("每輪結束緩衝期間 → 道具 disabled", its.every((b) => b.disabled === true), its.map((b) => b.disabled));

// (e) 次數上限為 0 時不限制同回合道具數
its = sendState("p1", 99, 0);
check("不限次使用 → 已用多件道具仍可點", its.every((b) => b.disabled === false), its.map((b) => b.disabled));

console.log("7) 道具欄 8 件硬上限");

// 伺服器就算送出 11 件，前端也只能畫 8 件（避免把版面撐壞）
const many = [];
for (let i = 0; i < 11; i += 1) {
  many.push({ id: "CIGARETTE", name: "香菸" + i, icon: "🚬", desc: "測試 " + i });
}
fire("room:update", {
  code: "ABCD",
  hostId: "p1",
  youId: "p1",
  seats: [{ id: "p1", name: "你", ready: true }, { id: "p2", name: "阿明", ready: true }],
  game: {
    public: {
      phase: "playing", round: 1, activeId: "p1", activeName: "你", winnerId: null,
      players: [player("p1", "你", 4), player("p2", "阿明", 2)], log: [],
      remaining: { live: 2, blank: 1, total: 3 },
    },
    private: { playerId: "p1", items: many, mods: {}, intel: [], itemsThisTurn: 0 },
  },
  revealUntil: 0, revealMs: 0, serverNow: Date.now(), turnDeadline: Date.now() + 20000,
});
const allSlots = document.getElementById("itemsGrid").children;
check("送出 11 件時只渲染 8 格", allSlots.length === 8, allSlots.length);
// stub 的 classList.contains 在這個情境回傳陣列，用 className 字串判斷最可靠
const filled = allSlots.filter((n) => String(n.className || "").indexOf("slot") !== -1);
check("其中 8 格都是有道具的", filled.length === 8, filled.length);

console.log("8) 🍺 啤酒退彈與 ⛓️ 手銬視覺");
// runActions 是 Promise 佇列，動作用 async 播放；等一輪 microtask 再檢查
function afterActions(fn) {
  return sandbox.setTimeout(fn, 0);
}

// (a) EJECT 動作 → 退殼提示出現且顯示「實彈」
fire("game:action", {
  code: "ABCD",
  actions: [
    { type: "ITEM_USED", playerId: "p1", itemName: "啤酒" },
    { type: "EJECT", playerId: "p1", shell: "LIVE", remaining: { live: 1, blank: 2, total: 3 } },
  ],
});

afterActions(() => {
  const toast = document.getElementById("ejectToast");
  check("退彈提示出現", toast.hidden === false);
  check("退彈提示顯示實彈", toast.innerHTML.indexOf("實彈") !== -1, String(toast.innerHTML).slice(0, 80));
  check("退彈提示有紅色彈殼樣式", toast.innerHTML.indexOf("eject-toast__shell--live") !== -1);
  check("剩餘彈數同步更新", document.getElementById("hint").textContent.indexOf("剩餘") !== -1,
    document.getElementById("hint").textContent);

  // (b) 空包彈退彈
  fire("game:action", {
    code: "ABCD",
    actions: [{ type: "EJECT", playerId: "p1", shell: "BLANK", remaining: { live: 1, blank: 1, total: 2 } }],
  });
  afterActions(() => {
    check("退彈提示顯示空包彈", toast.innerHTML.indexOf("空包彈") !== -1, String(toast.innerHTML).slice(0, 80));
    check("空包彈用藍灰樣式", toast.innerHTML.indexOf("eject-toast__shell--blank") !== -1);

    // (c) 手銬狀態
    fire("room:update", handcuffState());
    const foeCards = document.getElementById("opponents").children;
    const cuffed = foeCards.filter((c) => c.classList && c.classList.contains("is-cuffed"));
    check("被上銬的對手卡片標記 is-cuffed", cuffed.length === 1, cuffed.length);
    const badge = cuffed.length
      ? cuffed[0].children.filter((c) => c.className === "cuffed-badge")
      : [];
    check("顯示 ⛓️ 已上銬 徽章", badge.length === 1 && badge[0].textContent.indexOf("已上銬") !== -1,
      badge.map((b) => b.textContent));

    // (d) SKIP_TURN 動作 → 座位震動
    fire("game:action", {
      code: "ABCD",
      actions: [{ type: "SKIP_TURN", playerId: "p2", playerName: "阿明", skipsLeft: 0 }],
    });
    afterActions(() => {
      const hit = document.getElementById("opponents").children.filter(
        (c) => c.classList && c.classList.contains("is-cuffed-hit")
      );
      check("跳過回合時座位播放鎖鏈震動", hit.length === 1, hit.length);
      check("提示寫出被封鎖跳過", document.getElementById("hint").textContent.indexOf("跳過本回合") !== -1,
        document.getElementById("hint").textContent);

      console.log("9) 鎖定後道具必須能恢復（不能永久 disabled）");

// 送一份「開槍揭曉鎖」狀態，再送一份解鎖狀態，道具要能重新按
fire("room:update", {
  code: "ABCD",
  hostId: "p1",
  youId: "p1",
  seats: [{ id: "p1", name: "你", ready: true }, { id: "p2", name: "阿明", ready: true }],
  game: {
    public: {
      phase: "playing", round: 2, activeId: "p1", activeName: "你", winnerId: null,
      players: [player("p1", "你", 4), player("p2", "阿明", 2)], log: [],
      remaining: { live: 2, blank: 1, total: 3 },
    },
    private: {
      playerId: "p1",
      items: [{ id: "CIGARETTE", name: "香菸", icon: "🚬", desc: "回復 1 點生命。" }],
      mods: {}, intel: [], itemsThisTurn: 0,
    },
  },
  revealUntil: 0, revealMs: 0,
  actionPauseUntil: Date.now() + 3000, // 開槍鎖
  serverNow: Date.now(), turnDeadline: Date.now() + 20000,
});
let lockSlots = itemSlots();
check("開槍鎖期間 → 道具 disabled", lockSlots.every((b) => b.disabled === true),
  lockSlots.map((b) => b.disabled));

// 解鎖（伺服器推一份 actionPauseUntil = 0）
fire("room:update", {
  code: "ABCD",
  hostId: "p1",
  youId: "p1",
  seats: [{ id: "p1", name: "你", ready: true }, { id: "p2", name: "阿明", ready: true }],
  game: {
    public: {
      phase: "playing", round: 2, activeId: "p1", activeName: "你", winnerId: null,
      players: [player("p1", "你", 4), player("p2", "阿明", 2)], log: [],
      remaining: { live: 2, blank: 1, total: 3 },
    },
    private: {
      playerId: "p1",
      items: [{ id: "CIGARETTE", name: "香菸", icon: "🚬", desc: "回復 1 點生命。" }],
      mods: {}, intel: [], itemsThisTurn: 0,
    },
  },
  revealUntil: 0, revealMs: 0,
  actionPauseUntil: 0,
  serverNow: Date.now(), turnDeadline: Date.now() + 20000,
});
lockSlots = itemSlots();
check("解鎖後 → 道具恢復可按", lockSlots.every((b) => b.disabled === false),
  lockSlots.map((b) => b.disabled));

// busy 卡住的自癒：模擬 busyAt 很久以前
fire("room:update", {
  code: "ABCD",
  hostId: "p1",
  youId: "p1",
  seats: [{ id: "p1", name: "你", ready: true }, { id: "p2", name: "阿明", ready: true }],
  game: {
    public: {
      phase: "playing", round: 2, activeId: "p1", activeName: "你", winnerId: null,
      players: [player("p1", "你", 4), player("p2", "阿明", 2)], log: [],
      remaining: { live: 2, blank: 1, total: 3 },
    },
    private: {
      playerId: "p1",
      items: [{ id: "CIGARETTE", name: "香菸", icon: "🚬", desc: "回復 1 點生命。" }],
      mods: {}, intel: [], itemsThisTurn: 0,
    },
  },
  revealUntil: 0, revealMs: 0, actionPauseUntil: 0,
  serverNow: Date.now(), turnDeadline: Date.now() + 20000,
});
lockSlots = itemSlots();
check("多次狀態更新後道具仍可按", lockSlots.every((b) => b.disabled === false),
  lockSlots.map((b) => b.disabled));

console.log("10) 開局前（房間階段）");
      runFinalSection();
    });
  });
});

function handcuffState() {
  return {
    code: "ABCD",
    hostId: "p1",
    youId: "p1",
    seats: [
      { id: "p1", name: "你", ready: true },
      { id: "p2", name: "阿明", ready: true },
    ],
    game: {
      public: {
        phase: "playing", round: 2, activeId: "p1", activeName: "你", winnerId: null,
        players: [player("p1", "你", 4), player("p2", "阿明", 2, { skips: 1 })],
        log: [], remaining: { live: 2, blank: 1, total: 3 },
      },
      private: {
        playerId: "p1", items: [{ id: "CIGARETTE", name: "香菸", icon: "🚬", desc: "回復 1 點生命。" }],
        mods: {}, intel: [], itemsThisTurn: 0,
      },
    },
    revealUntil: 0, revealMs: 0, serverNow: Date.now(), turnDeadline: Date.now() + 20000,
  };
}

function runFinalSection() {
fire("room:update", {
  code: "ABCD",
  hostId: "p1",
  youId: "p1",
  seats: [
    { id: "p1", name: "你", ready: true },
    { id: "p2", name: "阿明", ready: false },
  ],
  game: null,
  revealUntil: 0,
  revealMs: 0,
  serverNow: Date.now(),
  turnDeadline: 0,
});
check("用座位名單頂著顯示 1 個對手", foes().children.length === 1, foes().children.length);
  check("回合文字等待開局", document.getElementById("turnLabel").textContent.includes("等待開局"));
  check("btnSelf 變灰", document.getElementById("btnSelf").disabled === true);

  console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
  process.exit(fail === 0 ? 0 : 1);
}

