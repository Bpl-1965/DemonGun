/* 修復被 PowerShell Set-Content 二次亂碼化的 UTF-8 文字（全 repo 掃描） */
const fs = require('fs');
const path = require('path');
const iconv = null;

const root = path.join(__dirname, '..');
const TARGETS = [
  'public/index.html',
  'public/client.js',
  'public/style.css',
  'public/scene3d.js',
  'server.js',
  'config/gameConfig.js',
  'logic/gameEngine.js',
  'logic/aiLogic.js',
  'logic/dialogue.js',
  'scripts/smoke.js',
  'scripts/e2e.js',
  'scripts/test-dialogue.js',
  'scripts/check-dom.js',
  'scripts/check-html.js',
  'README.md',
];

/** 常見的 UTF-8 被當成 CP1252/CP437 解碼後的特徵字元 */
const MOJIBAKE_HINTS = /[鎯杓妲鍠澶闁姣鏈闁紝鑿鍦鏄鈥鈽锛銆]/g;

function score(text) {
  const hits = (text.match(MOJIBAKE_HINTS) || []).length;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return { hits, cjk, ratio: hits / Math.max(1, cjk) };
}

module.exports = { score };

if (require.main === module) {
  // 只做診斷：列出每個檔案的亂碼比例
  for (const rel of TARGETS) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const s = score(text);
    console.log(`${rel}: cjk=${s.cjk} mojibake=${s.hits} ratio=${s.ratio.toFixed(3)}`);
  }
  void iconv;
}
