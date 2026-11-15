const fs = require('fs');
const raw = fs.readFileSync('public/index.html', 'utf8');
const s = raw
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => m.replace(/[^\n]/g, ''))
  .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
let m;
let depth = 0;
const stack = [];
const out = [];
while ((m = re.exec(s))) {
  const tag = m[2].toLowerCase();
  const line = s.slice(0, m.index).split('\n').length;
  if (m[1]) {
    depth -= 1;
    const expected = stack.pop();
    out.push(`C:${tag}@${line}` + (expected !== tag ? `!!${expected}` : ''));
  } else if (m[4] || VOID.has(tag)) {
    out.push(`v:${tag}@${line}`);
  } else {
    depth += 1;
    stack.push(tag);
    out.push(`O:${tag}@${line}`);
  }
  if (out.length > 400) break;
}
console.log('depth', depth, 'stack', stack.join(','));
console.log(out.filter((x) => x.startsWith('O:div@1') || x.startsWith('O:div@2') || x.startsWith('O:div@3') || x.startsWith('C:div@1') || x.startsWith('C:div@3')).join(' '));
