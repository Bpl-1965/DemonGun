/* =========================================================
   惡魔輪盤 · 純視覺外掛 fx.js
   只做三件事，完全不碰 client.js 的 socket / 狀態：
     1. 監聽 DOM 變化 → 血量下降就震動 + 血紅閃光 + 槍口火光
     2. 裝填提示出現 → 立體子彈進場、彈巢轉動
     3. 按鈕按壓 → 板機下沉手感（純 CSS :active 為主，這裡補觸發音效級特效）
   任何找不到元素的情況都靜默跳過，絕不丟錯中斷遊戲。
   ========================================================= */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const reduceMotion = () =>
    !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  // ------------------------------------------------------------------ 血量追蹤
  // client.js 會用 innerHTML 重繪 myHearts 與對手的 .hearts，
  // 所以這裡只讀「❤️ 的數量」，不寫入任何元素，避免互相覆蓋。
  const lastHp = new Map();

  function countHearts(node) {
    if (!node) return null;
    const full = node.querySelectorAll(".heart:not(.is-lost)").length;
    return node.querySelector(".heart") ? full : null;
  }

  function watchHearts() {
    const me = $("myHearts");
    if (!me) return;
    const hp = countHearts(me);
    if (hp === null) return;
    const prev = lastHp.get("me");
    lastHp.set("me", hp);
    if (prev !== undefined && hp < prev) {
      hit(prev - hp, "me");
    }
  }

  // ------------------------------------------------------------------ 特效
  let shakeTimer = null;
  let bloodTimer = null;
  let muzzleTimer = null;
  let reloadTimer = null;
  let ammoTimer = null;
  let revealRetry = null;
  // 防重入鎖：避免換輪時 observer 與 renderRevealShells 同時觸發同一段動畫
  let spinLock = false;
  let rackRunning = false;

  function bodyShake() {
    const body = document.body;
    body.classList.remove("is-shaking");
    void body.offsetWidth; // 強制 reflow，讓動畫能重播
    body.classList.add("is-shaking");
    clearTimeout(shakeTimer);
    shakeTimer = setTimeout(() => body.classList.remove("is-shaking"), 460);
  }

  function bloodFlash() {
    const node = $("fxBlood");
    if (!node) return;
    node.classList.remove("is-hot");
    void node.offsetWidth;
    node.classList.add("is-hot");
    clearTimeout(bloodTimer);
    bloodTimer = setTimeout(() => node.classList.remove("is-hot"), 700);
  }

  // 動畫結束就收掉 class：不依賴 timer，分頁切到背景或 headless 也不會卡住
  function bindAnimationReset(node, cls) {
    if (!node) return;
    node.addEventListener("animationend", () => node.classList.remove(cls));
  }

  function muzzleFlash() {
    const node = $("fxMuzzle");
    if (node) {
      node.classList.remove("is-fire");
      void node.offsetWidth;
      node.classList.add("is-fire");
      clearTimeout(muzzleTimer);
      muzzleTimer = setTimeout(() => node.classList.remove("is-fire"), 320);
    }
    // 槍枝上的槍口火光
    const gunMuzzle = $("gunMuzzle");
    if (gunMuzzle) {
      gunMuzzle.setAttribute("opacity", "1");
      setTimeout(() => gunMuzzle.setAttribute("opacity", "0"), 180);
    }
  }

  /**
   * 有人被實彈打中。
   *
   * ⚠ 只有「自己」被打中才播全螢幕的紅色閃光與震動（那是玩家受傷的回饋）；
   *   敵人 / 其他人受傷時只做該座位卡片的心跳脈動，
   *   否則畫面上會一直紅一片，看起來像自己一直被打。
   */
  function hit(damage, who) {
    if (reduceMotion()) return;
    // watchHearts() 一律用 "me" 當自己的 key，其他都是對手
    const isMe = who === "me";
    if (isMe) {
      bodyShake();
      bloodFlash();
      muzzleFlash();
      const me = $("me");
      if (me) {
        me.classList.add("is-hit");
        setTimeout(() => me.classList.remove("is-hit"), 500);
      }
      return;
    }
    // 別人受傷：只讓那個座位縮一下，不動整個畫面
    if (who) {
      const card = document.querySelector('.foe[data-id="' + who + '"]');
      if (card) {
        card.classList.add("is-hurt");
        setTimeout(() => card.classList.remove("is-hurt"), 520);
      }
    }
  }

  // ------------------------------------------------------------------ 換輪 / 換彈動畫
  // 槍枝上抬轉向 → 彈巢甩開自轉 → 甩回定位。純 class 驅動，CSS 負責演出。
  function reloadCycle() {
    const gun = $("gun");
    const cyl = $("gunCylinder");
    if (!gun) return;
    gun.classList.remove("is-reloading");
    void gun.offsetWidth; // 強制 reflow 讓動畫重播
    gun.classList.add("is-reloading");
    if (cyl) {
      cyl.classList.remove("is-spinning");
      void cyl.getBoundingClientRect();
      cyl.classList.add("is-spinning");
    }
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      gun.classList.remove("is-reloading");
      if (cyl) cyl.classList.remove("is-spinning");
    }, reduceMotion() ? 0 : 1600);
  }

  // ------------------------------------------------------------------ 彈藥庫
  // 開局 / 每輪換彈時顯示本輪「實彈幾發、空包幾發」，倒數結束自動收起。
  let pumpTimer = null;
  let cylTimer = null;

  function spinCylinder() {
    // 防重入：同一個動畫在跑的時候就不要再重設，避免每輪累積計時器與強制 reflow
    if (spinLock) return;
    spinLock = true;
    clearTimeout(cylTimer);

    const gunCyl = $("gunCylinder");
    if (gunCyl) {
      gunCyl.classList.remove("is-spinning");
      void gunCyl.getBoundingClientRect();
      gunCyl.classList.add("is-spinning");
      cylTimer = setTimeout(() => {
        gunCyl.classList.remove("is-spinning");
        spinLock = false;
      }, reduceMotion() ? 0 : 1000);
    } else {
      spinLock = false;
    }

    // 散彈槍的泵動護木：換彈時前後抽送
    const pump = $("gunPump");
    if (pump) {
      clearTimeout(pumpTimer);
      pump.classList.remove("is-pumping");
      void pump.getBoundingClientRect();
      pump.classList.add("is-pumping");
      pumpTimer = setTimeout(() => pump.classList.remove("is-pumping"), reduceMotion() ? 0 : 1100);
    }
  }

  function showAmmoBank(live, blank, ms) {
    const bank = $("cylinder");
    if (!bank) return;
    const set = (kind, n) => {
      const node = bank.querySelector('[data-ammo="' + kind + '"]');
      if (node) node.textContent = String(n);
    };
    set("live", live);
    set("blank", blank);
    bank.classList.toggle("is-blank", live === 0);
    bank.classList.toggle("is-empty", live === 0 && blank === 0);
    bank.classList.remove("is-open");
    void bank.offsetWidth;
    bank.classList.add("is-open");
    clearTimeout(ammoTimer);
    // 倒數結束就關閉彈藥庫，畫面回到遊戲
    if (ms > 0) ammoTimer = setTimeout(hideAmmoBank, ms);
  }

  function hideAmmoBank() {
    clearTimeout(ammoTimer);
    const bank = $("cylinder");
    if (bank) bank.classList.remove("is-open");
  }

  // ------------------------------------------------------------------ 子彈（12 號霰彈殼）
  // 結構由 shellAt() 直接產生（帶 --i / --lit-delay / --fire-delay），
  // 立體感：彈身圓柱高光、彈頭收口、底火金屬環，全部是靜態漸層，不做動畫。

  function readCount(id) {
    const node = $(id);
    if (!node) return 0;
    const n = parseInt(String(node.textContent || "").trim(), 10);
    return Number.isFinite(n) ? Math.max(0, Math.min(12, n)) : 0;
  }

  // 裝彈動畫的計時器（換輪時要全部清掉，避免舊動畫干擾新一輪）
  let rackTimers = [];

  function clearRackTimers() {
    rackTimers.forEach((t) => clearTimeout(t));
    rackTimers = [];
  }

  function later(fn, ms) {
    rackTimers.push(setTimeout(fn, ms));
  }

  /** 洗牌：模擬子彈被隨機推入槍膛 */
  function shuffled(list, rng) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const t = out[i];
      out[i] = out[j];
      out[j] = t;
    }
    return out;
  }

  /**
   * 三段式裝彈（總長 3.0s），全程交給 CSS：
   *   0.0 ~ 1.4s  亮彈記憶：實彈與空包分左右並排，依序上彈亮起
   *   1.4 ~ 2.8s  推進槍膛：一顆顆彈起、洗牌順序、向右滑入進彈口消失
   *   2.8 ~ 3.0s  空槽向下收起淡出
   *
   * ⚡ 效能：不再用 setTimeout 逐一改 class（那會造成大量 reflow 與卡頓）。
   *    生成元素時就寫入行內 CSS 變數 --i（索引）與 --fire-delay（進膛延遲），
   *    「亮起 / 彈起 / 滑入」全部由 @keyframes + animation-delay 執行，
   *    動畫只碰 transform / opacity，整段交給 GPU 合成。
   */
  function runRackSequence(live, blank) {
    const groove = $("revealShells");
    const card = $("revealCard");
    const receiver = $("rackReceiver");
    const portGlow = $("rackPortGlow");
    if (!groove) return;

    // 防重入：同一輪的裝彈動畫還在跑就不要重開（會中斷 CSS 動畫並累積計時器）
    if (rackRunning) return;
    rackRunning = true;

    clearRackTimers();

    const total = live + blank;
    let html = "";
    let index = 0;

    // 固定種子洗牌：同一輪的重播順序一致，但每顆的進膛時間不同
    let seed = total * 9301 + 49297;
    const rng = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    const order = shuffled(
      Array.from({ length: total }, (_, i) => i),
      rng
    );
    // order[k] = 第 k 個進膛的「彈藥架位置」
    const fireDelayOf = {};
    const FIRE_START = 1400;
    const FIRE_SPAN = 900;
    const step = total > 0 ? Math.max(60, FIRE_SPAN / total) : 0;
    order.forEach((slotIndex, k) => {
      fireDelayOf[slotIndex] = Math.round(FIRE_START + k * step);
    });

    const shellAt = (kind, i) => {
      const litDelay = Math.round(Math.min(1200, i * 90));
      const fireDelay = fireDelayOf[i] != null ? fireDelayOf[i] : FIRE_START + i * step;
      return (
        '<span class="shellfx shellfx--' + kind + '" data-i="' + i + '"' +
        ' style="--i:' + i + ";--lit-delay:" + litDelay + "ms;--fire-delay:" + fireDelay + 'ms">' +
        '<i class="shellfx__tube"></i>' +
        '<i class="shellfx__shine"></i>' +
        '<i class="shellfx__cap"></i>' +
        '<i class="shellfx__primer"></i>' +
        "</span>"
      );
    };

    // 左半：實彈；右半：空包彈（並排，方便一眼記住紅藍數量）
    for (let i = 0; i < live; i += 1) html += shellAt("live", index++);
    if (live && blank) html += '<span class="rack__gap"></span>';
    for (let i = 0; i < blank; i += 1) html += shellAt("blank", index++);

    // 一次寫入，避免逐顆 appendChild 造成的多次 reflow
    groove.innerHTML = html;
    // ⚠ 不要動 groove.dataset.sig：那是外層防止重播用的標記

    // 重播用：清掉舊狀態後只讀一次 offsetWidth 觸發一次 reflow
    [card, groove, receiver, portGlow].forEach((n) => {
      if (!n) return;
      n.classList.remove("is-racking", "is-firing", "is-closing", "is-lit", "is-slotted");
    });
    void groove.offsetWidth;

    if (total === 0) {
      if (card) card.classList.add("is-racking");
      rackRunning = false;
      return;
    }

    // 用戶要求「減少動態」時只顯示靜態子彈，不做時序動畫
    if (reduceMotion()) {
      if (card) card.classList.add("is-racking");
      rackRunning = false;
      return;
    }

    // 只加一個 class，其餘全由 CSS keyframes + animation-delay 演出
    if (card) card.classList.add("is-racking");
    if (groove) groove.classList.add("is-racking");

    // 槍機微震 / 進彈口閃光、收槽：這兩個是「整體」事件，用少量計時器即可
    if (receiver) later(() => receiver.classList.add("is-firing"), FIRE_START);
    later(() => {
      if (receiver) receiver.classList.remove("is-firing");
    }, 2800);
    if (portGlow) {
      later(() => portGlow.classList.add("is-lit"), FIRE_START);
      later(() => portGlow.classList.remove("is-lit"), 2800);
    }

    // ── 階段 3：2.8 ~ 3.0s 空槽向下收起淡出 ──
    later(() => {
      if (card) card.classList.add("is-closing");
    }, 2800);

    // 動畫結束用 animationend 收尾（比計時器可靠：分頁切到背景也不會卡住狀態），
    // 計時器只當作保險。finish 可能被兩邊各叫一次，用 done 旗標避免重複。
    let done = false;
    const finish = (event) => {
      if (event && event.animationName && event.animationName !== "rackClose") return;
      if (done) return;
      done = true;
      if (card) card.classList.remove("is-closing");
      if (receiver) receiver.classList.remove("is-firing");
      if (portGlow) portGlow.classList.remove("is-lit");
      if (groove) groove.classList.remove("is-racking");
      clearRackTimers();
      rackRunning = false;
      if (card) card.removeEventListener("animationend", finish);
    };
    if (card) card.addEventListener("animationend", finish, { once: true });
    later(finish, 3060);
  }

  function renderRevealShells() {
    const box = $("revealShells");
    if (!box) return;
    const reveal = $("reveal");
    const live = readCount("revealLive");
    const blank = readCount("revealBlank");

    // 提示框收起來就清空，下一次打開才會重播動畫
    if (!live && !blank) {
      if (box.innerHTML) {
        box.innerHTML = "";
        delete box.dataset.sig;
        clearRackTimers();
        const card = $("revealCard");
        if (card) card.classList.remove("is-racking", "is-closing");
      }
      hideAmmoBank();
      return;
    }

    // ⚠ client.js 的 showReveal() 是一行一行寫的：
    //   先寫 revealRound → revealLive → revealBlank → 最後才 reveal.hidden = false。
    // 如果在 hidden 還是 true 時就開跑，會拿「只寫了一半」的數字（例如 2/0），
    // 而且 sig 已經記住，真正完整的數字就永遠不會重畫。
    // 所以一律等到提示框真的顯示了才處理；還沒顯示就排進下一幀再試。
    if (reveal && reveal.hidden) {
      if (!revealRetry) {
        revealRetry = setTimeout(() => {
          revealRetry = null;
          renderRevealShells();
        }, 60);
      }
      return;
    }

    // 彈藥庫（中央面板）同步顯示本輪數量
    showAmmoBank(live, blank, 3000);

    // 內容沒變就不重播（避免同一輪被多次觸發）
    const sig = live + "/" + blank;
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;

    reloadCycle();
    runRackSequence(live, blank);
    spinCylinder();
  }

  // ------------------------------------------------------------------ 觀察 DOM
  function startObservers() {
    const pending = [];
    let queued = false;

    const flush = () => {
      queued = false;
      while (pending.length) {
        const id = pending.shift();
        if (id === "myHearts") watchHearts();
        else if (id === "revealShells") renderRevealShells();
      }
    };

    const queue = (id) => {
      if (pending.indexOf(id) === -1) pending.push(id);
      if (queued) return;
      queued = true;
      (window.requestAnimationFrame || setTimeout)(flush);
    };

    const foes = $("opponents");
    const me = $("myHearts");
    const revealLive = $("revealLive");
    const revealBlank = $("revealBlank");
    const reveal = $("reveal");
    const watched = [me, revealLive, revealBlank, foes, reveal].filter(Boolean);

    const scanFoeHearts = () => {
      if (foes) {
        foes.querySelectorAll("[data-hearts]").forEach((node) => {
          const id = node.getAttribute("data-hearts");
          const hp = countHearts(node);
          if (hp === null) return;
          const prev = lastHp.get(id);
          lastHp.set(id, hp);
          if (prev !== undefined && hp < prev) hit(prev - hp, id);
        });
      }
    };

    const observer = new MutationObserver((records) => {
      if (!records || !records.length) {
        watchHearts();
        renderRevealShells();
        scanFoeHearts();
        if (reveal && !reveal.hidden) spinCylinder();
        return;
      }

      const within = (root, target) =>
        root === target || Boolean(root && typeof root.contains === "function" && root.contains(target));
      if (records.some((record) => within(me, record.target))) watchHearts();
      if (
        records.some((record) =>
          within(revealLive, record.target) ||
          within(revealBlank, record.target) ||
          (record.target === reveal && record.attributeName === "hidden")
        )
      ) {
        queue("revealShells");
      }
      if (records.some((record) => within(foes, record.target))) scanFoeHearts();
      if (
        reveal &&
        !reveal.hidden &&
        records.some((record) => record.target === reveal && record.attributeName === "hidden")
      ) {
        spinCylinder();
      }
    });

    watched.forEach((node) => {
      const isReveal = node === reveal;
      observer.observe(node, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: isReveal,
        attributeFilter: isReveal ? ["hidden"] : undefined,
      });
    });
  }

  // ------------------------------------------------------------------ 板機按壓
  // 只加 class（純視覺），不阻止任何事件，client.js 的 click 照常觸發
  function bindTriggerFeel() {
    ["btnSelf", "btnEnemy"].forEach((id) => {
      const node = $(id);
      if (!node) return;
      node.addEventListener("pointerdown", () => {
        if (reduceMotion()) return;
        node.classList.remove("is-armed");
        void node.offsetWidth;
        node.classList.add("is-armed");
      });
      node.addEventListener("pointerup", () => node.classList.remove("is-armed"));
      node.addEventListener("pointerleave", () => node.classList.remove("is-armed"));
    });

  }

  function boot() {
    // 初次同步既有血量，之後只看變化
    ["myHearts"].forEach((id) => {
      const hp = countHearts($(id));
      if (hp !== null) lastHp.set("me", hp);
    });
    // 動畫播完就把特效 class 收掉，避免任何殘留樣式
    bindAnimationReset($("fxBlood"), "is-hot");
    bindAnimationReset($("fxMuzzle"), "is-fire");
    bindAnimationReset(document.body, "is-shaking");
    startObservers();
    bindTriggerFeel();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
