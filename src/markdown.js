// Minimal, safe Markdown for model text. Escapes everything first, then supports **bold**, *italic*,
// bullet lines and paragraphs. Never emits user-controlled HTML.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const inline = (t) => esc(t)
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');

export function md(text) {
  const out = [];
  let list = [];
  const flush = () => { if (list.length) { out.push(`<ul class="md">${list.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`); list = []; } };
  for (const raw of String(text ?? '').split(/\n/)) {
    const line = raw.trim();
    const bullet = line.match(/^[-*\u2022]\s+(.*)$/);
    if (bullet) list.push(bullet[1]);
    else { flush(); if (line) out.push(`<p>${inline(line.replace(/^#+\s*/, ''))}</p>`); }
  }
  flush();
  return out.join('');
}
