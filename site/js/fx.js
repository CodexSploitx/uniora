// Small shared effects and helpers.

export const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
export const fine = matchMedia("(pointer: fine)").matches;
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ALLOW spark burst
export function sparks(el) {
  if (reduced) return;
  for (let i = 0; i < 16; i++) {
    const s = document.createElement("i"); s.className = "spark";
    const ang = (Math.PI * 2 * i) / 16 + Math.random() * 0.4, d = 40 + Math.random() * 60;
    s.style.setProperty("--dx", `${Math.cos(ang) * d}px`); s.style.setProperty("--dy", `${Math.sin(ang) * d}px`);
    el.appendChild(s); setTimeout(() => s.remove(), 900);
  }
}

// Syntax highlighting for the code samples (single-line tokens only, so lines can be split safely).
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function highlight(src) {
  const re = /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*")|\b(import|from|const|await|new|return|if|export)\b|\b([A-Za-z_]\w*)(?=\()|(\b\d+\b)|(<\/?[A-Z]\w*)/g;
  let out = "", last = 0, m;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    const cls = m[1] ? "tk-c" : m[2] ? "tk-s" : m[3] ? "tk-k" : m[4] ? "tk-f" : m[5] ? "tk-n" : "tk-f";
    out += `<span class="${cls}">${esc(m[0])}</span>`; last = m.index + m[0].length;
  }
  return out + esc(src.slice(last));
}
export { esc };
