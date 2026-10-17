import { ES, RT } from "./i18n.js";
import { PKG, CODE, LIC } from "./data.js";
import { initPlayground } from "./engine-demo.js";
import { initSavings } from "./savings.js";
import { initModes } from "./modes.js";
import { initStudio } from "./studio.js";
import { initFlow } from "./flow.js";
import { initHero } from "./hero.js";
import { initLasers } from "./lasers.js";
import { $, $$, reduced, fine, store, highlight, esc } from "./fx.js";

const REPO = "CodexSploitx/uniora";

/* ───────────────── i18n (English by default; Spanish is opt-in and remembered) ───────────────── */
const EN = new Map();
$$("[data-i18n]").forEach((el) => EN.set(el, el.innerHTML));
const saved = store.get("uniora-lang");
let lang = saved === "es" ? "es" : "en";
const getLang = () => lang;
const pick = (v) => (typeof v === "object" && v && "en" in v ? v[lang] : v);
const onLang = [];

function applyLang() {
  document.documentElement.lang = lang;
  $$("[data-i18n]").forEach((el) => { el.innerHTML = lang === "es" && ES[el.dataset.i18n] ? ES[el.dataset.i18n] : EN.get(el); });
  $$("#lang button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
  document.title = RT.meta[lang].title;
  $('meta[name="description"]').setAttribute("content", RT.meta[lang].desc);
  onLang.forEach((f) => f());
}
$("#lang").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-lang]"); if (!b || b.dataset.lang === lang) return;
  lang = b.dataset.lang; store.set("uniora-lang", lang); applyLang();
});

/* ───────────────── nav / progress ───────────────── */
const nav = $("#nav"), bar = $("#progress");
function onScroll() {
  const y = scrollY, h = document.documentElement.scrollHeight - innerHeight;
  nav.classList.toggle("scrolled", y > 24);
  bar.style.transform = `scaleX(${h > 0 ? y / h : 0})`;
}
addEventListener("scroll", onScroll, { passive: true }); onScroll();
const burger = $("#burger"), links = $("#navLinks");
burger.addEventListener("click", () => { const o = links.classList.toggle("open"); burger.setAttribute("aria-expanded", String(o)); });
links.addEventListener("click", (e) => { if (e.target.closest("a")) { links.classList.remove("open"); burger.setAttribute("aria-expanded", "false"); } });
// the nav link whose section is on screen lights up (some sections share a link)
const NAV_OF = { hero: "top", trust: "top", how: "features", features: "features", audience: "features", playground: "features", studio: "features", security: "features", architecture: "architecture", savings: "savings", license: "savings", opensource: "opensource", start: "opensource", cta: "opensource" };
const secObs = new IntersectionObserver((es) => es.forEach((e) => {
  if (!e.isIntersecting) return;
  const target = NAV_OF[e.target.id] || "top";
  $$("#navLinks a").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + target));
}), { rootMargin: "-45% 0px -50% 0px" });
$$("main > section[id]").forEach((s) => secObs.observe(s));

/* ───────────────── reveal + counters ───────────────── */
$$(".reveal").forEach((el) => {
  const sibs = $$(":scope > .reveal", el.parentElement);
  if (sibs.length > 1) el.style.setProperty("--d", `${sibs.indexOf(el) * 90}ms`);
});
const ease = (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));
function countTo(el, to, { suffix = "", plus = false } = {}) {
  const fmt = (n) => Math.round(n).toLocaleString(lang === "es" ? "es-ES" : "en-US") + suffix + (plus ? "+" : "");
  if (reduced) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 1600;
  const step = (now) => { const k = Math.min(1, (now - t0) / dur); el.textContent = fmt(to * ease(k)); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
const io = new IntersectionObserver((es) => es.forEach((e) => {
  if (!e.isIntersecting) return;
  const el = e.target; io.unobserve(el);
  el.classList.add("in");
  setTimeout(() => el.classList.add("settled"), 1000);
  $$("[data-count][data-to]", el).forEach((c) => countTo(c, +c.dataset.to, { suffix: c.dataset.suffix || "", plus: "plus" in c.dataset }));
}), { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
$$(".reveal").forEach((el) => io.observe(el));

/* ───────────────── tilt / magnetic buttons ───────────────── */
if (fine && !reduced) {
  $$(".tilt").forEach((el) => {
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      el.style.setProperty("--mx", `${x * 100}%`); el.style.setProperty("--my", `${y * 100}%`);
      el.style.transform = `perspective(900px) rotateX(${(0.5 - y) * 6}deg) rotateY(${(x - 0.5) * 8}deg) translateZ(0)`;
    });
    el.addEventListener("pointerleave", () => { el.style.transform = ""; });
  });
  $$(".magnetic").forEach((el) => {
    el.addEventListener("pointermove", (e) => { const r = el.getBoundingClientRect(); el.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * 0.16}px,${(e.clientY - r.top - r.height / 2) * 0.26}px)`; });
    el.addEventListener("pointerleave", () => { el.style.transform = ""; });
  });
}

/* ───────────────── copy buttons ───────────────── */
async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const t = document.createElement("textarea"); t.value = text; t.style.position = "fixed"; t.style.opacity = "0"; document.body.appendChild(t); t.select();
    try { return document.execCommand("copy"); } catch { return false; } finally { t.remove(); }
  }
}
function wireCopy(el, text) {
  const run = async () => {
    if (!(await copy(typeof text === "function" ? text() : text))) return;
    const hint = $(".copy-hint", el) || el; const old = hint.textContent;
    el.classList.add("copied"); hint.textContent = lang === "es" ? "¡copiado!" : "copied!";
    setTimeout(() => { el.classList.remove("copied"); hint.textContent = lang === "es" ? "copiar" : "copy"; if (hint === el) hint.textContent = old; }, 1400);
  };
  el.addEventListener("click", run);
  el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); run(); } });
}
$$("[data-copy]").forEach((el) => wireCopy(el, el.dataset.copy));

/* ───────────────── hero, lasers, flow, playground, studio, modes, savings ───────────────── */
initHero();
initLasers($("#lasersFeat"), { seed: 29, density: 0.5, focus: { x: 0.9, y: 0.5 }, calmLeft: 0.5, intensity: 0.6, reduced });
initLasers($("#lasersSec"), { seed: 53, density: 0.5, focus: { x: 0.82, y: 0.3 }, calmLeft: 0.45, intensity: 0.7, reduced });
initLasers($("#lasersCta"), { seed: 77, density: 0.9, focus: { x: 0.8, y: 0.5 }, calmLeft: 0.3, intensity: 0.9, reduced });

const flow = initFlow({ getLang }); onLang.push(() => flow.redraw());
const pg = initPlayground({ getLang }); onLang.push(() => pg.redraw());
const studio = initStudio({ getLang }); onLang.push(() => studio.redraw());
const modes = initModes({ getLang }); onLang.push(() => modes.redraw());
const savings = initSavings({ getLang, reduced }); onLang.push(() => savings.redraw());

/* ───────────────── architecture ───────────────── */
let curPkg = "core";
function showPkg(id) {
  curPkg = id; const p = PKG[id];
  $$(".node").forEach((n) => n.classList.toggle("active", n.dataset.pkg === id));
  $$("#archLines [data-pkg]").forEach((l) => l.classList.toggle("on", l.dataset.pkg === id));
  $("#pkgName").textContent = p.n; $("#pkgDesc").textContent = pick(p.d); $("#pkgInstall").textContent = p.i;
}
$$(".node").forEach((n) => n.addEventListener("click", () => showPkg(n.dataset.pkg)));
wireCopy($("#pkgCopy"), () => PKG[curPkg].i);
onLang.push(() => showPkg(curPkg));
const NS = "http://www.w3.org/2000/svg";
function drawLines() {
  const arch = $("#arch"), svg = $("#archLines"); if (getComputedStyle(svg).display === "none") return;
  const a = arch.getBoundingClientRect(), core = $("#archCore").getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${a.width} ${a.height}`);
  svg.innerHTML = "";
  $$(".node:not(.core-node)").forEach((n, i) => {
    const r = n.getBoundingClientRect(); const left = r.left < core.left - 4, same = Math.abs(r.left - core.left) < 6;
    let d;
    if (same) { const x = core.left - a.left + core.width / 2, y1 = (r.top < core.top ? r.bottom : r.top) - a.top, y2 = (r.top < core.top ? core.top : core.bottom) - a.top; d = `M${x},${y1} L${x},${y2}`; }
    else {
      const x1 = (left ? r.right : core.right) - a.left, y1 = (left ? r.top + r.height / 2 : core.top + core.height / 2) - a.top;
      const x2 = (left ? core.left : r.left) - a.left, y2 = (left ? core.top + core.height / 2 : r.top + r.height / 2) - a.top;
      const dx = (x2 - x1) * 0.5; d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
    }
    const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); p.dataset.pkg = n.dataset.pkg; svg.appendChild(p);
    if (!reduced) {
      const c = document.createElementNS(NS, "circle"), m = document.createElementNS(NS, "animateMotion");
      c.setAttribute("r", "3.2"); c.setAttribute("class", "pk"); c.dataset.pkg = n.dataset.pkg;
      m.setAttribute("dur", `${2.4 + (i % 4) * 0.35}s`); m.setAttribute("begin", `${(i * 0.37) % 2}s`); m.setAttribute("repeatCount", "indefinite"); m.setAttribute("path", d);
      c.appendChild(m); svg.appendChild(c);
    }
  });
  showPkg(curPkg);
}
addEventListener("resize", () => requestAnimationFrame(drawLines));
document.fonts?.ready.then(() => requestAnimationFrame(drawLines));
drawLines();

/* ───────────────── code samples ───────────────── */
let curCode = "core";
function showCode(id) {
  curCode = id; const c = CODE[id];
  $$("#codeTabs button").forEach((b) => b.classList.toggle("active", b.dataset.code === id));
  $("#codeView code").innerHTML = highlight(c.c).split("\n").map((l, i) => `<span class="ln" style="--i:${i}">${l || " "}</span>`).join("");
  $("#codeView").scrollTop = 0;
  $("#codeNote").textContent = pick(c.n);
}
$("#codeTabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-code]"); if (b) showCode(b.dataset.code); });
onLang.push(() => { const y = $("#codeView").scrollTop; $("#codeNote").textContent = pick(CODE[curCode].n); $("#codeView").scrollTop = y; });
showCode("core");

/* ───────────────── license checker ───────────────── */
let licSel = null;
function drawLic() {
  for (const side of ["yes", "no"]) {
    const box = $(side === "yes" ? "#licYes" : "#licNo"); box.innerHTML = "";
    LIC[side].forEach(([id, label]) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "chip" + (licSel === id ? " active" : ""); b.textContent = pick(label);
      b.addEventListener("click", () => { licSel = id; drawLic(); }); box.appendChild(b);
    });
  }
  const v = $("#licVerdict"), found = [...LIC.yes.map((x) => ["yes", ...x]), ...LIC.no.map((x) => ["no", ...x])].find((x) => x[1] === licSel);
  v.className = "lic-verdict" + (found ? " " + found[0] : "");
  $(".lv-mark", v).textContent = found ? (found[0] === "yes" ? "✓" : "✕") : "?";
  if (found) { $("b", v).removeAttribute("data-i18n"); $("b", v).textContent = pick(found[2]); $("p", v).textContent = pick(found[3]); }
  else { $("b", v).setAttribute("data-i18n", "lic.pick"); $("b", v).innerHTML = lang === "es" ? ES["lic.pick"] : "Select a use to check it against the license."; $("p", v).textContent = ""; }
}
onLang.push(drawLic); drawLic();

/* ───────────────── live GitHub data ───────────────── */
const FALLBACK_RELEASES = [["v0.10.1", "2026-10-16"], ["v0.10.0", "2026-10-11"], ["v0.9.0", "2026-10-10"], ["v0.8.0", "2026-10-10"], ["v0.7.0", "2026-10-09"], ["v0.6.1", "2026-10-09"]].map(([tag_name, d]) => ({ tag_name, published_at: d, html_url: `https://github.com/${REPO}/releases/tag/${tag_name}` }));
const FALLBACK_LANGS = { TypeScript: 4488480, JavaScript: 212667, PLpgSQL: 61420, CSS: 11858 };
const COLORS = ["#f7c325", "#8e51ff", "#19d49a", "#38bdf8", "#f472b6", "#ff6467"];

async function gh(path, ttl = 600000) {
  const key = "uniora-gh:" + path, now = Date.now();
  let cached = null; try { cached = JSON.parse(store.get(key)); } catch { /* none */ }
  if (cached && now - cached.t < ttl) return cached.v;
  try {
    const res = await fetch(`https://api.github.com${path}`, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(String(res.status));
    const v = await res.json(); store.set(key, JSON.stringify({ t: now, v })); return v;
  } catch (err) { if (cached) return cached.v; throw err; }
}
const state = { stars: null };
function setStars(n) {
  state.stars = n;
  $$("[data-stars]").forEach((el) => {
    if (el.matches("[data-count]")) countTo(el, n); else el.textContent = n.toLocaleString(lang === "es" ? "es-ES" : "en-US");
  });
  $("#starCta").textContent = n === 0 ? pick(RT.starFirst) : pick(RT.starThanks);
}
function relTime(iso) {
  const diff = (new Date(iso) - Date.now()) / 1000, rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  for (const [u, s] of [["day", 86400], ["hour", 3600], ["minute", 60]]) if (Math.abs(diff) >= s || u === "minute") return rtf.format(Math.round(diff / s), u);
}
function drawDonut(langs) {
  const entries = Object.entries(langs), total = entries.reduce((a, [, v]) => a + v, 0), svg = $("#donut"), C = 2 * Math.PI * 48;
  svg.innerHTML = `<circle class="bg" cx="60" cy="60" r="48"/>`; $("#langLegend").innerHTML = "";
  if (!total) { $("#langLegend").innerHTML = `<li>${pick(RT.noLang)}</li>`; return; }
  let acc = 0;
  entries.sort((a, b) => b[1] - a[1]).forEach(([name, v], i) => {
    const frac = v / total, len = Math.max(0, frac * C - 2), color = COLORS[i % COLORS.length];
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", 60); c.setAttribute("cy", 60); c.setAttribute("r", 48); c.style.stroke = color;
    c.style.strokeDasharray = `0 ${C}`; c.style.strokeDashoffset = String(-acc * C); svg.appendChild(c);
    requestAnimationFrame(() => setTimeout(() => { c.style.strokeDasharray = `${len} ${C - len}`; }, 200 + i * 150));
    acc += frac;
    $("#langLegend").insertAdjacentHTML("beforeend", `<li><i style="background:${color}"></i>${esc(name)}<span>${(frac * 100).toFixed(1)}%</span></li>`);
  });
}
function drawTimeline(rels) {
  $("#timeline").innerHTML = rels.slice(0, 8).map((r) => `<li><a href="${esc(r.html_url)}" target="_blank" rel="noopener"><b>${esc(r.tag_name)}</b></a><time datetime="${esc(r.published_at)}">${new Date(r.published_at).toLocaleDateString(lang === "es" ? "es-ES" : "en-US", { year: "numeric", month: "short", day: "numeric" })}</time></li>`).join("");
}
let repoData = null, gazers = [];
function drawGazers() {
  const box = $("#avatars"); box.innerHTML = "";
  if (state.stars > 0 && !gazers.length) {
    $("#gazNote").innerHTML = `<a href="https://github.com/${REPO}/stargazers" target="_blank" rel="noopener" style="color:var(--accent)">${pick(RT.gazLink)}</a>`; return;
  }
  if (state.stars === 0 || !gazers.length) {
    for (let i = 0; i < 14; i++) box.insertAdjacentHTML("beforeend", `<span class="ph${i === 0 ? " first" : ""}" style="--d:${i * 0.25}s">${i === 0 ? "★" : ""}</span>`);
    $("#gazNote").textContent = pick(RT.gazNone);
  } else {
    gazers.forEach((u) => box.insertAdjacentHTML("beforeend", `<a href="${esc(u.html_url)}" target="_blank" rel="noopener" title="${esc(u.login)}"><img src="${esc(u.avatar_url)}&s=88" alt="${esc(u.login)}" width="44" height="44" loading="lazy"></a>`));
    $("#gazNote").textContent = pick(RT.gazSome)(gazers.length);
  }
}
async function loadRepo() {
  const [repo, langs, rels, gz] = await Promise.allSettled([gh(`/repos/${REPO}`), gh(`/repos/${REPO}/languages`, 3600000), gh(`/repos/${REPO}/releases?per_page=8`, 1800000), gh(`/repos/${REPO}/stargazers?per_page=24`, 900000)]);
  if (repo.status === "fulfilled") {
    repoData = repo.value; setStars(repoData.stargazers_count);
    $("#stForks").dataset.to = repoData.forks_count; $("#stIssues").dataset.to = repoData.open_issues_count; $("#stWatch").dataset.to = repoData.subscribers_count ?? 0;
    ["#stForks", "#stIssues", "#stWatch"].forEach((s) => countTo($(s), +$(s).dataset.to));
    $("#stPush").textContent = relTime(repoData.pushed_at);
  } else { setStars(0); $$("[data-stars]").forEach((el) => { if (!el.matches("[data-count]")) el.textContent = "★"; }); }
  drawDonut(langs.status === "fulfilled" ? langs.value : FALLBACK_LANGS);
  const releases = rels.status === "fulfilled" && rels.value.length ? rels.value : FALLBACK_RELEASES;
  drawTimeline(releases); $$("[data-version]").forEach((el) => { el.textContent = releases[0].tag_name; });
  gazers = gz.status === "fulfilled" ? gz.value : []; drawGazers();
  if (repo.status === "rejected") console.warn(pick(RT.apiFail));
}
onLang.push(() => { if (state.stars !== null) { $("#starCta").textContent = state.stars === 0 ? pick(RT.starFirst) : pick(RT.starThanks); drawGazers(); if (repoData) $("#stPush").textContent = relTime(repoData.pushed_at); } });

/* ───────────────── boot ───────────────── */
applyLang();
loadRepo();
