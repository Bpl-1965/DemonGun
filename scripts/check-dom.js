'use strict';

/**
 * scripts/check-dom.js
 * 交叉檢查前端三支檔案的接縫（2D 版，不再有 Three.js）：
 *   1. client.js 用 $('#id') 取用的元素，index.html 裡都要有
 *   2. client.js / index.html 依賴的 CSS 鉤子（class / keyframes）都在 style.css
 *   3. index.html 不可以再載入任何 3D 資源（three.js / scene3d.js）
 *   4. 任務 1~4 的關鍵元素與行為都在（中央裝填提示、道具欄、兩個大按鈕、disabled 邏輯）
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const html = read('public/index.html');
const js = read('public/client.js');
const css = read('public/style.css');

let failed = false;

/* --- 1. client.js 取用的 id 都要存在 --- */
const ids = new Set();
for (const m of js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) ids.add(m[1]);
const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(html));
console.log(`client.js 引用的 id：${ids.size} 個`);
console.log(`index.html 缺少：${missing.length ? missing.join(', ') : '（無）'}`);
if (missing.length) failed = true;

/* --- 2. CSS 鉤子 --- */
const cssHooks = [
  '.ammo-reveal',
  '.ammo-reveal__card',
  '.ammo-reveal__count--live',
  '.ammo-reveal__count--blank',
  '.ammo-reveal__bar',
  '.board',
  '.board__col--hp',
  '.board__col--demon',
  '.board__col--items',
  '.turn-banner',
  '.actions-row',
  '.btn--self',
  '.btn--enemy',
  '.demon__portrait',
  '.demon__img',
  '.demon__bubble',
  '.damage-float',
  '.hearts',
  '.inventory',
  '.item',
  '.gun__label',
  '.gun__cylinder',
  'demonBreathe',
  'demonShake',
  'bubblePop',
  'damageFloat',
  'screenShake',
  'bloodSplash',
  '.is-hit',
  '.is-target',
  '.is-missing-art',
];
const cssMissing = cssHooks.filter((h) => !css.includes(h));
console.log(`style.css 缺少：${cssMissing.length ? cssMissing.join(', ') : '（無）'}`);
if (cssMissing.length) failed = true;

/* --- 3. 不能再有 3D --- */
const threeRefs = ['scene3d.js', 'three.min.js', 'vendor/three', 'window.Scene3D', 'WebGLRenderer'].filter(
  (needle) => html.includes(needle) || js.includes(needle)
);
const clientMinusCss = js.replace(/\/\*[\s\S]*?\*\//g, '');
const threeInJs = threeRefs.filter((needle) => clientMinusCss.includes(needle));
console.log(`3D 殘留（html/client.js）：${threeInJs.length ? threeInJs.join(', ') : '（無）✅'}`);
if (threeInJs.length) failed = true;

/* --- 4. 任務 1~4 的關鍵元素與行為 --- */
const requirements = [
  ['任務1 中央裝填提示容器', /id="ammoReveal"/.test(html)],
  ['任務1 實彈數量欄位', /id="revealLive"/.test(html)],
  ['任務1 空包數量欄位', /id="revealBlank"/.test(html)],
  ['任務1 倒數欄位', /id="revealCountdown"/.test(html)],
  ['任務1 前端有 3 秒自動隱藏', /setTimeout\(\(\) => \{\s*hideAmmoReveal\(\)/.test(js)],
  ['任務2 右側道具欄', /id="inventory"/.test(html) && /renderInventory/.test(js)],
  ['任務2 道具點擊送 game:item', /emit\('game:item'/.test(js)],
  ['任務3 對自己開槍按鈕', /id="btnSelf"/.test(html) && /'game:shoot'/.test(js)],
  ['任務3 對敵人開槍按鈕', /id="btnEnemy"/.test(html)],
  ['任務4 左欄生命值', /id="hpHearts"/.test(html)],
  ['任務4 大字回合提示', /id="turnBanner"/.test(html)],
  ['任務4 disabled 邏輯', /\.disabled = !canAct/.test(js) || /btn\.disabled = Boolean\(disabled\)/.test(js)],
];
let reqFailed = 0;
requirements.forEach(([name, ok]) => {
  if (!ok) reqFailed += 1;
  console.log(`  ${ok ? '✅' : '❌'} ${name}`);
});
if (reqFailed) failed = true;

if (failed) process.exit(1);
console.log('DOM / CSS / 任務鉤子全部對得上 ✅（純 2D）');
