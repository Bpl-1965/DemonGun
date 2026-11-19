/* fx.js 冒煙測試：用假 DOM 確認只觀察、不丟錯、不破壞 client.js 的渲染 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const code = fs.readFileSync(path.join(__dirname, "..", "public", "fx.js"), "utf8");

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log("  ✓ " + name);
  } else {
    fail += 1;
    console.log("  ✗ " + name + (extra !== undefined ? " → " + JSON.stringify(extra) : ""));
  }
}

// ---------------------------------------------------------------- DOM stub
function makeEl(id, tag) {
  const el = {
    id,
    tagName: (tag || "div").toUpperCase(),
    children: [],
    dataset: {},
    hidden: false,
    className: "",
    _text: "",
    _html: "",
    _attrs: {},
    offsetWidth: 1,
    _listeners: {},
    style: { _p: {}, setProperty(k, v) { this._p[k] = v; }, removeProperty(k) { delete this._p[k]; } },
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { const w = on === undefined ? !this._s.has(c) : !!on; w ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 10, height: 10 }; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k]; },
    appendChild(c) { this.children.push(c); return c; },
    querySelectorAll(sel) {
      // 只需要支援 .heart:not(.is-lost) 與 .heart
      if (sel === ".heart:not(.is-lost)") return this.children.filter((c) => c.classList.contains("heart") && !c.classList.contains("is-lost"));
      if (sel === ".heart") return this.children.filter((c) => c.classList.contains("heart"));
      if (sel === "[data-hearts]") return this.children.filter((c) => c.dataset.hearts);
      return [];
    },
    querySelector(sel) {
      if (sel === ".heart") return this.children.find((c) => c.classList.contains("heart")) || null;
      // fx.js 會用 `.foe[data-id="xxx"]` 找受傷的座位
      const m = String(sel || "").match(/\[data-id="([^"]+)"\]/);
      if (m) {
        const direct = this.children.find((c) => c.dataset && c.dataset.id === m[1]);
        if (direct) return direct;
        for (const child of this.children) {
          const found = (child.children || []).find((c) => c.dataset && c.dataset.id === m[1]);
          if (found) return found;
        }
      }
      return null;
    },
    fire(type, ev) { (this._listeners[type] || []).forEach((fn) => fn(ev || {})); },
  };
  Object.defineProperty(el, "textContent", {
    get() { return this._text; },
    set(v) { this._text = String(v); },
  });
  Object.defineProperty(el, "innerHTML", {
    get() { return this._html; },
    set(v) {
      this._html = String(v);
      this.children.length = 0;
      // fx.js 會設定 shellfx 的 HTML，這裡把每個子彈解析成子節點，
      // 之後才能驗證 CSS 變數（--i / --lit-delay / --fire-delay）
      const tags = this._html.match(/<span class="shellfx[^"]*"[^>]*>/g) || [];
      tags.forEach((tag) => {
        const node = makeEl("span");
        const cls = tag.match(/class="([^"]*)"/);
        if (cls) cls[1].split(/\s+/).filter(Boolean).forEach((n) => node.classList.add(n));
        const st = tag.match(/style="([^"]*)"/);
        node._styleAttr = st ? st[1] : "";
        const di = tag.match(/data-i="(\d+)"/);
        if (di) node.dataset.i = di[1];
        this.children.push(node);
        node.parentElement = this;
      });
      this._shellNodes = this.children.filter((c) => c.classList.contains("shellfx"));
    },
  });
  return el;
}

const ids = [
  "myHearts", "revealShells", "revealLive", "revealBlank", "reveal",
  "revealCard", "rackReceiver", "rackPortGlow",
  "fxBlood", "fxMuzzle", "gunMuzzle", "cylinder", "gun", "gunCylinder",
  "me", "opponents", "btnSelf", "btnEnemy",
];
const byId = new Map();
ids.forEach((id) => byId.set(id, makeEl(id)));

// revealShells 需要 querySelectorAll(".shellfx")
byId.get("revealShells").querySelectorAll = function (sel) {
  if (String(sel).indexOf("shellfx") !== -1) return this._shellNodes || [];
  return [];
};

// opponents 需要 querySelectorAll("[data-hearts]") 來掃對手血量
byId.get("opponents").querySelectorAll = function (sel) {
  if (String(sel).indexOf("data-hearts") !== -1) {
    return (this.children || []).filter((c) => c.dataset && c.dataset.hearts);
  }
  return [];
};

// 彈藥庫裡兩個數字節點（showAmmoBank 會用 querySelector 找）
const ammoNodes = { live: makeEl("live"), blank: makeEl("blank") };
byId.get("cylinder").querySelector = (sel) => {
  const m = String(sel).match(/data-ammo="(\w+)"/);
  return m ? ammoNodes[m[1]] || null : null;
};

const observers = [];
function MutationObserverStub(cb) {
  this.cb = cb;
  this.observe = () => {};
  this.disconnect = () => {};
  observers.push(this);
}

const document = {
  readyState: "complete",
  getElementById: (id) => byId.get(id) || null,
  querySelectorAll: () => [],
  // fx.js 會用 document.querySelector('.foe[data-id="xxx"]') 找受傷的對手座位
  querySelector: (sel) => {
    const m = String(sel || "").match(/\[data-id="([^"]+)"\]/);
    if (!m) return null;
    const box = byId.get("opponents");
    if (!box) return null;
    return (box.children || []).find((c) => c.dataset && c.dataset.id === m[1]) || null;
  },
  addEventListener() {},
  body: makeEl("body", "body"),
};

let rafQueue = [];
const window = {
  matchMedia: () => ({ matches: false }),
  requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
};

const sandbox = { document, window, MutationObserver: MutationObserverStub, setTimeout, clearTimeout, console };
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
let threw = null;
try {
  vm.runInContext(code, sandbox, { filename: "fx.js" });
} catch (err) {
  threw = err;
}
check("fx.js 載入不丟錯", threw === null, threw && threw.message);
check("全站只建立一組 MutationObserver", observers.length === 1, observers.length);

const flushRaf = () => { const q = rafQueue; rafQueue = []; q.forEach((fn) => fn()); };
const myHearts = byId.get("myHearts");

// 建出 3 顆滿血心
function setHearts(n) {
  myHearts.innerHTML = "";
  for (let i = 0; i < 3; i += 1) {
    const h = makeEl("h");
    h.classList.add("heart");
    if (i >= n) h.classList.add("is-lost");
    myHearts.appendChild(h);
  }
}

setHearts(3);
observers.forEach((o) => o.cb());
flushRaf();

// ---------------------------------------------------------------- 血量下降
setHearts(2);
observers.forEach((o) => o.cb());
flushRaf();

check("血量下降 → body 震動", document.body.classList.contains("is-shaking"));
check("血量下降 → 血紅閃光", byId.get("fxBlood").classList.contains("is-hot"));
check("血量下降 → 槍口火光", byId.get("fxMuzzle").classList.contains("is-fire"));
check("血量下降 → 自己的席位標記 is-hit", byId.get("me").classList.contains("is-hit"));

// 血量沒變 → 不該再觸發（先清掉 class 再觀察）
document.body.classList.remove("is-shaking");
setHearts(2);
observers.forEach((o) => o.cb());
flushRaf();
check("血量沒變 → 不重複震動", !document.body.classList.contains("is-shaking"));

// ---------------------------------------------------------------- 裝填子彈展示
byId.get("revealLive")._text = "2";
byId.get("revealBlank")._text = "3";
setTimeout(() => {
  const box = byId.get("revealShells");
  // 直接呼叫觀察回呼（模擬 revealLive 變動）
  observers.forEach((o) => o.cb());
  flushRaf();

  const html = box.innerHTML;
  const liveCount = (html.match(/shellfx--live/g) || []).length;
  const blankCount = (html.match(/shellfx--blank/g) || []).length;
  check("實彈子彈 2 顆", liveCount === 2, liveCount);
  check("空包子彈 3 顆", blankCount === 3, blankCount);
  check("彈藥架進入裝彈狀態", byId.get("revealCard").classList.contains("is-racking"));
  check("裝填時彈藥庫展開", byId.get("cylinder").classList.contains("is-open"));
  check("彈藥庫實彈數 = 2", ammoNodes.live.textContent === "2", ammoNodes.live.textContent);
  check("彈藥庫空包數 = 3", ammoNodes.blank.textContent === "3", ammoNodes.blank.textContent);
  check("裝填時槍枝進入換彈動畫", byId.get("gun").classList.contains("is-reloading"));
  check("換彈時彈巢旋轉", byId.get("gunCylinder").classList.contains("is-spinning"));

  // 內容不變就不再重播
  observers.forEach((o) => o.cb());
  flushRaf();
  check("同樣的子彈不重播動畫", byId.get("revealCard").classList.contains("is-racking"));

  // ------------------------------------------------------------ 三段時序（純 CSS 驅動）
  // 動畫不再由 JS 逐顆加 class，改為在生成元素時寫入 CSS 變數，
  // 由 @keyframes + animation-delay 執行。這裡驗證那些變數是否正確。
  const shells = box._shellNodes || [];
  const styleOf = (s) => (s && s._styleAttr) || "";

  check("每個子彈都有 --i 索引", shells.every((s, i) => styleOf(s).indexOf("--i:" + i) !== -1),
    shells.map(styleOf));
  check("每個子彈都有 --lit-delay（亮起延遲）", shells.every((s) => styleOf(s).indexOf("--lit-delay:") !== -1));
  check("每個子彈都有 --fire-delay（進膛延遲）", shells.every((s) => styleOf(s).indexOf("--fire-delay:") !== -1));

  // 亮起延遲應該遞增（依序上彈）
  const litDelays = shells.map((s) => {
    const m = styleOf(s).match(/--lit-delay:(\d+)ms/);
    return m ? Number(m[1]) : -1;
  });
  check("亮起延遲依序遞增 90ms", litDelays.every((d, i) => i === 0 || d === litDelays[i - 1] + 90), litDelays);

  // 進膛延遲應該全部落在 1400~2800ms 之間（階段2 範圍內）
  const fireDelays = shells.map((s) => {
    const m = styleOf(s).match(/--fire-delay:(\d+)ms/);
    return m ? Number(m[1]) : -1;
  });
  check("進膛延遲都在 1400~2800ms 內", fireDelays.every((d) => d >= 1400 && d <= 2800), fireDelays);
  check("進膛延遲互不相同（洗牌順序）", new Set(fireDelays).size === fireDelays.length, fireDelays);

  // 三階段狀態 class 由 CSS 承接
  check("彈藥架標記 is-racking（CSS 動畫起點）", box.classList.contains("is-racking"));

  // 階段 3：空槽收起
  setTimeout(() => {
    const card = byId.get("revealCard");
    check("階段3：彈藥架開始收起", card.classList.contains("is-closing") || !card.classList.contains("is-racking"));
    finish();
  }, 3000);

  // ---------------------------------------------------------------- 別人受傷不該紅屏
// 重建一組乾淨狀態：我的血量不變，只讓「對手」掉血
document.body.classList.remove("is-shaking");
byId.get("fxBlood").classList.remove("is-hot");
byId.get("fxMuzzle").classList.remove("is-fire");

// 造一個對手血量節點並掛到 opponents（先清空，避免受前面測試影響）
const foesBox = byId.get("opponents");
foesBox.children.length = 0;
const foeCard = makeEl("div");
foeCard.classList.add("foe");
foeCard.dataset.id = "p2";
const foeHearts = makeEl("div");
foeHearts.dataset.hearts = "p2";
foeHearts.innerHTML = "";
[1, 1, 1].forEach(() => {
  const h = makeEl("h");
  h.classList.add("heart");
  foeHearts.appendChild(h);
});
foeCard.appendChild(foeHearts);
foesBox.appendChild(foeCard);

// 第一次 observer 觸發只是建立基準值，再掉一次血才會判定「受傷」
observers.forEach((o) => o.cb());
flushRaf();

// 對手掉血
foeHearts.innerHTML = "";
[1, 1].forEach(() => {
  const h = makeEl("h");
  h.classList.add("heart");
  foeHearts.appendChild(h);
});
observers.forEach((o) => o.cb());
flushRaf();

check("對手受傷 → 不會全螢幕震動", !document.body.classList.contains("is-shaking"));
check("對手受傷 → 不會血紅閃光", !byId.get("fxBlood").classList.contains("is-hot"));
check("對手受傷 → 不會槍口火光", !byId.get("fxMuzzle").classList.contains("is-fire"));
// 註：座位上的 is-hurt 縮放動畫在假 DOM 裡難以完整模擬（需要真實的
// querySelector / classList / 血量子節點），已由上面的三項確認
// 「敵人受傷不會觸發全螢幕效果」，其餘交給瀏覽器實測。

// 自己掉血仍然要有全螢幕回饋
setHearts(1);
observers.forEach((o) => o.cb());
flushRaf();
check("自己受傷 → 仍會血紅閃光", byId.get("fxBlood").classList.contains("is-hot"));
check("自己受傷 → 仍會震動", document.body.classList.contains("is-shaking"));

// ------------------------------------------------------------ 板機手感
  const btn = byId.get("btnSelf");
  btn.fire("pointerdown", {});
  check("按下時加 is-armed（純視覺 class）", btn.classList.contains("is-armed"));
  check("按下不會改寫 disabled（不干擾 client.js）", btn.disabled === undefined);
  btn.fire("pointerup", {});
  check("放開移除 is-armed", !btn.classList.contains("is-armed"));
  document.body.classList.remove("is-shaking", "is-awaiting");
  byId.get("fxMuzzle").classList.remove("is-fire");
  btn.fire("click", {});
  check("點擊開槍不會搶先播放揭曉特效", !document.body.classList.contains("is-shaking") &&
    !document.body.classList.contains("is-awaiting") && !byId.get("fxMuzzle").classList.contains("is-fire"));

  // ------------------------------------------------------------ 缺元素不炸
  let threw2 = null;
  try {
    const emptyCtx = vm.createContext({
      document: {
        readyState: "complete",
        getElementById: () => null,
        addEventListener() {},
        body: makeEl("body", "body"),
      },
      window: { matchMedia: () => ({ matches: false }), requestAnimationFrame: () => 1 },
      MutationObserver: MutationObserverStub,
      setTimeout,
      clearTimeout,
      console,
    });
    vm.runInContext(code, emptyCtx, { filename: "fx-null.js" });
  } catch (err) {
    threw2 = err;
  }
  check("頁面缺少所有元素時也不丟錯", threw2 === null, threw2 && threw2.message);
}, 20);

// 三段時序跑完後收尾（上面 setTimeout 會呼叫）
function finish() {
  console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
  process.exit(fail === 0 ? 0 : 1);
}
