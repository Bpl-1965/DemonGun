/* 檢查 index.html 的標籤嵌套與重複 id（開發用） */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'public', 'index.html');
const raw = fs.readFileSync(file, 'utf8');

// 內嵌的 <script> 與註解裡的範例標籤（例如 <canvas>）不算真正的標籤：檢查時先挖掉（保留行數）
const s = raw
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => m.replace(/[^\n]/g, ''))
  .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const OPEN = /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const CLOSE = /<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>/g;

/** 把註解挖成空白（保留換行，行號才不會跑掉） */
function blank(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

const clean = s;
const lineOf = (index) => clean.slice(0, index).split('\n').length;

const opens = [];
const closes = [];
for (const m of clean.matchAll(OPEN)) {
  if (m[3]) continue; // 自閉合
  opens.push({ tag: m[1].toLowerCase(), index: m.index, line: lineOf(m.index) });
}
for (const m of clean.matchAll(CLOSE)) {
  closes.push({ tag: m[1].toLowerCase(), index: m.index, line: lineOf(m.index) });
}

const events = opens.concat(closes).sort((a, b) => a.index - b.index);

let depth = 0;
const problems = [];
const stack = [];

for (const ev of events) {
  const isClose = ev.index === (closes.find((c) => c.index === ev.index) || {}).index;
  if (isClose) {
    depth -= 1;
    const expected = stack.pop();
    if (expected !== ev.tag) problems.push(`line ${ev.line}: 關閉 </${ev.tag}>，期待 </${expected}>`);
  } else if (VOID.has(ev.tag)) {
    // 空元素：不進堆疊
  } else {
    depth += 1;
    stack.push(ev.tag);
  }
}

const ids = [...raw.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
void blank;

console.log('最終嵌套深度:', depth, depth === 0 ? '✅' : '❌');
console.log('未關閉:', stack.length ? stack.join(',') : '（無）✅');
console.log('標籤錯誤:', problems.length ? problems.join(' | ') : '（無）✅');
console.log('id 總數:', ids.length, '重複:', dup.length ? dup.join(',') : '（無）✅');
if (depth !== 0 || problems.length || dup.length) process.exitCode = 1;
