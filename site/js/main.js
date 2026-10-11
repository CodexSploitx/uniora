import { ES, RT } from "./i18n.js";
import { initPlayground } from "./engine-demo.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const fine = matchMedia("(pointer: fine)").matches;
const REPO = "CodexSploitx/uniora";

/* ───────────────── i18n ───────────────── */
const EN = new Map();
$$("[data-i18n]").forEach((el) => EN.set(el, el.innerHTML));
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
const saved = store.get("uniora-lang");
let lang = saved === "es" || saved === "en" ? saved : (navigator.language || "en").toLowerCase().startsWith("es") ? "es" : "en";
const getLang = () => lang;
const pick = (v) => (typeof v === "object" && v && "en" in v ? v[lang] : v);
const onLang = [];

function applyLang() {
  document.documentElement.lang = lang;
  $$("[data-i18n]").forEach((el) => { el.innerHTML = lang === "es" && ES[el.dataset.i18n] ? ES[el.dataset.i18n] : EN.get(el); });
  $("#langBtn").textContent = lang === "es" ? "EN" : "ES";
  $$("[data-scramble-key]").forEach((el) => { el.dataset.scramble = RT.scramble[el.dataset.scrambleKey][lang]; el.textContent = el.dataset.scramble; });
  onLang.forEach((f) => f());
}
$("#langBtn").addEventListener("click", () => { lang = lang === "es" ? "en" : "es"; store.set("uniora-lang", lang); applyLang(); });

/* ───────────────── nav / progress / cursor ───────────────── */
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
const secObs = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) $$("#navLinks a").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + e.target.id)); }), { rootMargin: "-45% 0px -50% 0px" });
$$("main > section[id]").forEach((s) => secObs.observe(s));

if (fine && !reduced) {
  const g = $("#cursorGlow");
  addEventListener("pointermove", (e) => { g.classList.add("on"); g.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, { passive: true });
  document.addEventListener("pointerleave", () => g.classList.remove("on"));
}

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

/* ───────────────── text scramble ───────────────── */
function scramble(el, text, delay = 0) {
  const chars = "!<>-_\\/[]{}—=+*^?#01";
  if (reduced) { el.textContent = text; return; }
  const total = 34; let f = 0;
  setTimeout(function tick() {
    el.textContent = [...text].map((c, i) => (f > (i / text.length) * total + 6 ? c : chars[(Math.random() * chars.length) | 0])).join("");
    if (f++ < total + 10) requestAnimationFrame(tick); else el.textContent = text;
  }, delay);
}

/* ───────────────── tilt / magnetic ───────────────── */
if (fine && !reduced) {
  $$(".tilt").forEach((el) => {
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      el.style.setProperty("--mx", `${x * 100}%`); el.style.setProperty("--my", `${y * 100}%`);
      el.style.transform = `perspective(900px) rotateX(${(0.5 - y) * 7}deg) rotateY(${(x - 0.5) * 9}deg) translateZ(0)`;
    });
    el.addEventListener("pointerleave", () => { el.style.transform = ""; });
  });
  $$(".magnetic").forEach((el) => {
    el.addEventListener("pointermove", (e) => { const r = el.getBoundingClientRect(); el.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * 0.18}px,${(e.clientY - r.top - r.height / 2) * 0.28}px)`; });
    el.addEventListener("pointerleave", () => { el.style.transform = ""; });
  });
  const dev = $("#device"), stage = $(".studio");
  stage.addEventListener("pointermove", (e) => {
    const r = stage.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
    dev.style.transform = `perspective(1400px) rotateY(${x * 9}deg) rotateX(${-y * 6}deg)`;
  });
  stage.addEventListener("pointerleave", () => { dev.style.transform = ""; });
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

/* ───────────────── hero: 3D scene + live decision ticker ───────────────── */
const tickerList = $("#tickerList");
const WHO = ["supabase:u_ana", "clerk:u_marco", "auth0:u_lena", "better-auth:u_kenji", "supabase:u_91f2", "clerk:u_ops", "auth0:u_bot"];
const ORG = ["acme-motors", "northwind", "globex-fleet", "initech", "umbrella"];
const PRM = ["vehicles.read", "vehicles.delete", "members.invite", "reports.export", "billing.manage", "assistant.use"];
let lastTick = 0;
function tick(allowed) {
  const now = performance.now(); if (now - lastTick < 520) return; lastTick = now;
  const r = (a) => a[(Math.random() * a.length) | 0];
  const li = document.createElement("li");
  li.innerHTML = `<span>can(${r(WHO)}, ${r(ORG)}, ${r(PRM)})</span><span class="v ${allowed ? "allow" : "deny"}">${allowed ? "ALLOW" : "DENY"}</span>`;
  tickerList.appendChild(li);
  while (tickerList.children.length > 8) tickerList.firstChild.remove();
}
for (let i = 0; i < 6; i++) { lastTick = 0; tick(i % 4 !== 3); } // never start empty
let scene = null;
(async () => {
  try {
    const gl = document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl");
    if (!gl) throw new Error("no webgl");
    const { initScene } = await import("./hero3d.js");
    scene = initScene($("#scene"), { reduced, onDecision: tick });
  } catch (err) {
    console.warn("3D scene disabled:", err);
    document.documentElement.classList.add("no-webgl");
    setInterval(() => tick(Math.random() > 0.2), 900); // keep the ticker alive without the scene
  }
})();
$("#hero").addEventListener("pointerdown", (e) => {
  if (e.target.closest("a, button, .install, .ticker")) return;
  scene?.burst(); for (let i = 0; i < 4; i++) setTimeout(() => { lastTick = 0; tick(Math.random() > 0.2); }, i * 140);
});

/* ───────────────── playground ───────────────── */
const pg = initPlayground({ getLang });
onLang.push(() => pg.redraw());

/* ───────────────── architecture ───────────────── */
const PKG = {
  core: { n: "@uniora/core", i: "npm install @uniora/core", d: { en: "Framework-independent domain model: organizations with a protected Owner (created atomically), custom roles, permissions, features, audit logs, cross-provider identity linking, invitations and the deny-by-default AuthorizationEngine.", es: "Modelo de dominio independiente del framework: organizaciones con un Owner protegido (creado de forma atómica), roles personalizados, permisos, features, logs de auditoría, vinculación de identidades entre proveedores, invitaciones y el AuthorizationEngine deny-por-defecto." } },
  postgres: { n: "@uniora/postgres", i: "npm install @uniora/postgres pg", d: { en: "PostgreSQL storage adapter in a dedicated uniora.* schema, plus migrations — and SQL functions for row-level security in your own tables.", es: "Adaptador de almacenamiento PostgreSQL en un esquema uniora.* dedicado, más migraciones — y funciones SQL para row-level security en tus propias tablas." } },
  sqlite: { n: "@uniora/sqlite", i: "npm install @uniora/sqlite better-sqlite3", d: { en: "SQLite adapter over better-sqlite3 (uniora_* tables) for local development, tests and single-node apps — held to the same behavioural test suite as Postgres.", es: "Adaptador SQLite sobre better-sqlite3 (tablas uniora_*) para desarrollo local, tests y apps de un solo nodo — sometido a la misma suite de comportamiento que Postgres." } },
  "mailer-smtp": { n: "@uniora/mailer-smtp", i: "npm install @uniora/mailer-smtp", d: { en: "SMTP sender for invitations, configured from UNIORA_SMTP_* in .env, with professional multilingual (en/es/pt/fr/de/it), dark-mode-aware templates.", es: "Emisor SMTP para invitaciones, configurado desde UNIORA_SMTP_* en .env, con plantillas profesionales multilingües (en/es/pt/fr/de/it) compatibles con modo oscuro." } },
  supabase: { n: "@uniora/supabase", i: "npm install @uniora/supabase", d: { en: "Identity adapter for Supabase Auth: turns a session into an Identity. It only ever answers “who is this?”.", es: "Adaptador de identidad para Supabase Auth: convierte una sesión en una Identity. Solo responde “¿quién es?”." } },
  clerk: { n: "@uniora/clerk", i: "npm install @uniora/clerk", d: { en: "Identity adapter for Clerk. No hard dependency on the SDK: your app supplies the already-configured client.", es: "Adaptador de identidad para Clerk. Sin dependencia dura del SDK: tu app aporta el cliente ya configurado." } },
  auth0: { n: "@uniora/auth0", i: "npm install @uniora/auth0", d: { en: "Identity adapter for Auth0, with provider-verified e-mail helpers for invitation acceptance.", es: "Adaptador de identidad para Auth0, con helpers de correo verificado por el proveedor para aceptar invitaciones." } },
  "better-auth": { n: "@uniora/better-auth", i: "npm install @uniora/better-auth", d: { en: "Identity adapter for Better Auth, so you can self-host authentication and still get organizations and roles.", es: "Adaptador de identidad para Better Auth, para autoalojar la autenticación y aun así tener organizaciones y roles." } },
  react: { n: "@uniora/react", i: "npm install @uniora/react", d: { en: "Headless React helpers — <Can>, <Feature>, useCan, useFeature — over a server-computed AuthorizationSnapshot. UX only; never a security boundary.", es: "Helpers headless de React — <Can>, <Feature>, useCan, useFeature — sobre un AuthorizationSnapshot calculado en el servidor. Solo UX; nunca una frontera de seguridad." } },
  next: { n: "@uniora/next", i: "npm install @uniora/next", d: { en: "Next.js glue: request-scoped memoization with react.cache(), assertCan / assertAccess / authorizeRoute guards for Server Actions and Route Handlers, and invitation route helpers.", es: "Pegamento para Next.js: memoización por request con react.cache(), guards assertCan / assertAccess / authorizeRoute para Server Actions y Route Handlers, y helpers de rutas de invitación." } },
  express: { n: "@uniora/express", i: "npm install @uniora/express", d: { en: "Deny-by-default route middleware (requirePermission, requireFeature, authorize): answers 401/403 and fails closed on any error. Works with Express 4 and 5.", es: "Middleware de rutas deny-por-defecto (requirePermission, requireFeature, authorize): responde 401/403 y falla cerrado ante cualquier error. Funciona con Express 4 y 5." } },
  server: { n: "@uniora/server", i: "npm install @uniora/server", d: { en: "UNIORA as its own self-hosted HTTP API: API keys with scopes and organization lists, decisions, delegated changes on behalf of an end user, sign-up and invitations.", es: "UNIORA como su propia API HTTP autoalojada: API keys con scopes y listas de organizaciones, decisiones, cambios delegados en nombre de un usuario final, sign-up e invitaciones." } },
  client: { n: "@uniora/client", i: "npm install @uniora/client", d: { en: "The typed client of that API for your backend, with retries and a remote AuthorizationEngine for the Express and Next guards.", es: "El cliente tipado de esa API para tu backend, con reintentos y un AuthorizationEngine remoto para los guards de Express y Next." } },
  cli: { n: "@uniora/cli", i: "npm install --save-dev @uniora/cli", d: { en: "npx uniora init / check / migrate / doctor / studio — with a migration ledger, --json output and CI-friendly exit codes.", es: "npx uniora init / check / migrate / doctor / studio — con ledger de migraciones, salida --json y códigos de salida aptos para CI." } },
  studio: { n: "@uniora/studio", i: "npx uniora studio", d: { en: "UNIORA Studio: a local-first admin UI (Next.js + shadcn/ui + ReUI) to browse and manage organizations, members, roles, permissions, features and the audit log.", es: "UNIORA Studio: una UI de administración local-first (Next.js + shadcn/ui + ReUI) para explorar y gestionar organizaciones, miembros, roles, permisos, features y el log de auditoría." } },
};
let curPkg = "core";
function showPkg(id) {
  curPkg = id; const p = PKG[id];
  $$(".node").forEach((n) => n.classList.toggle("active", n.dataset.pkg === id));
  $$("#archLines path").forEach((l) => l.classList.toggle("on", l.dataset.pkg === id));
  $("#pkgName").textContent = p.n; $("#pkgDesc").textContent = pick(p.d); $("#pkgInstall").textContent = p.i;
}
$$(".node").forEach((n) => n.addEventListener("click", () => showPkg(n.dataset.pkg)));
wireCopy($("#pkgCopy"), () => PKG[curPkg].i);
onLang.push(() => showPkg(curPkg));
function drawLines() {
  const arch = $("#arch"), svg = $("#archLines"); if (getComputedStyle(svg).display === "none") return;
  const a = arch.getBoundingClientRect(), core = $("#archCore").getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${a.width} ${a.height}`);
  svg.innerHTML = "";
  $$(".node:not(.core-node)").forEach((n) => {
    const r = n.getBoundingClientRect(); const left = r.left < core.left - 4, same = Math.abs(r.left - core.left) < 6;
    let d;
    if (same) { const x = core.left - a.left + core.width / 2, y1 = (r.top < core.top ? r.bottom : r.top) - a.top, y2 = (r.top < core.top ? core.top : core.bottom) - a.top; d = `M${x},${y1} L${x},${y2}`; }
    else {
      const x1 = (left ? r.right : core.right) - a.left, y1 = (left ? r.top + r.height / 2 : core.top + core.height / 2) - a.top;
      const x2 = (left ? core.left : r.left) - a.left, y2 = (left ? core.top + core.height / 2 : r.top + r.height / 2) - a.top;
      const dx = (x2 - x1) * 0.5; d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
    }
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); p.dataset.pkg = n.dataset.pkg; svg.appendChild(p);
  });
  showPkg(curPkg);
}
addEventListener("resize", () => requestAnimationFrame(drawLines));
document.fonts?.ready.then(() => requestAnimationFrame(drawLines));
drawLines();

/* ───────────────── studio tabs + lightbox ───────────────── */
$("#studioTabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-shot]"); if (!b) return;
  $$("#studioTabs button").forEach((x) => x.classList.toggle("active", x === b));
  $$(".shot").forEach((s) => s.classList.toggle("active", s.dataset.shot === b.dataset.shot));
  const d = $("#device"); d.classList.remove("swap"); void d.offsetWidth; d.classList.add("swap");
});
const lb = $("#lightbox");
$("#zoomBtn").addEventListener("click", () => { const s = $(".shot.active"); $("img", lb).src = s.src; $("img", lb).alt = s.alt; lb.hidden = false; });
lb.addEventListener("click", () => { lb.hidden = true; });
addEventListener("keydown", (e) => { if (e.key === "Escape") lb.hidden = true; });
// auto-cycle the screenshots until the visitor takes over
let cycle = setInterval(() => { if (reduced || document.hidden) return; const tabs = $$("#studioTabs button"); const i = tabs.findIndex((t) => t.classList.contains("active")); const r = $("#device").getBoundingClientRect(); if (r.top < innerHeight && r.bottom > 0) tabs[(i + 1) % tabs.length].click(); }, 4500);
$("#studioTabs").addEventListener("pointerdown", () => clearInterval(cycle), { once: true });

/* ───────────────── code samples ───────────────── */
const CODE = {
  core: { c: `import { createAuthorizationEngine, createMemoryStorage } from "@uniora/core";
// swap createMemoryStorage() for @uniora/postgres (or @uniora/sqlite) in production

const storage = createMemoryStorage();
const uniora = createAuthorizationEngine(storage);

const canDeleteVehicle = await uniora.can({
  identity: { provider: "supabase", subject: userId },
  organizationId: orgId,
  permission: "vehicles.delete",
});

// Combined permission + feature-entitlement check
const canUseAI = await uniora.access.check({
  identity: { provider: "supabase", subject: userId },
  organizationId: orgId,
  permission: "assistant.use",
  feature: "ai_assistant",
});`, n: { en: "Permissions answer “what can this user do”; features answer “what has this organization unlocked”. Two questions, one call.", es: "Los permisos responden “qué puede hacer este usuario”; las features, “qué ha desbloqueado esta organización”. Dos preguntas, una llamada." } },
  owner: { c: `import { createOrganizationWithOwner } from "@uniora/core";

const { organization, membership } = await createOrganizationWithOwner(storage, {
  organizationId: orgId,
  organizationName: "Acme Motors",   // slug derived: "acme-motors"
  ownerRoleId: crypto.randomUUID(),
  membershipId: crypto.randomUUID(),
  ownerIdentity: { provider: "supabase", subject: userId },
});
// The Owner now passes every uniora.can(...) check for this organization.
// And the last Owner can never be removed, blocked or demoted.`, n: { en: "Every organization is born with exactly one protected Owner — created atomically, never as an afterthought.", es: "Cada organización nace con exactamente un Owner protegido — creado de forma atómica, nunca como una ocurrencia tardía." } },
  express: { c: `import { requirePermission, requireFeature } from "@uniora/express";

app.delete(
  "/orgs/:orgId/vehicles/:id",
  requirePermission(engine, "vehicles.delete", {
    // identity: whatever your auth middleware resolved
    resolve: (req) => req.identity && { identity: req.identity, organizationId: req.params.orgId },
  }),
  deleteVehicle,
);
// 401 when the caller is unknown, 403 when the engine denies,
// and any error goes to next(err): a failure never lets a request through.`, n: { en: "Fails closed. Works with Express 4 and 5 — no dependency on the express package itself.", es: "Falla cerrado. Funciona con Express 4 y 5 — sin dependencia del paquete express." } },
  next: { c: `import { assertCan, authorizeRoute } from "@uniora/next";

// Server Action — throws AuthorizationDeniedError
await assertCan(engine, { identity, organizationId, permission: "vehicles.delete" });

// Route Handler — returns a ready-to-return Response | null
const denied = await authorizeRoute(engine, { identity, organizationId, permission: "vehicles.delete" });
if (denied) return denied;`, n: { en: "Request-scoped memoization with react.cache(), plus guards for Server Actions and Route Handlers.", es: "Memoización por request con react.cache(), más guards para Server Actions y Route Handlers." } },
  react: { c: `// server: compute a bounded snapshot
const snapshot = await computeAuthorizationSnapshot(engine, storage.features, {
  identity, organizationId,
  permissions: ["vehicles.create"],
  features: ["advanced_reports"],
});

// client: just read it
<UnioraProvider snapshot={snapshot}>
  <Can permission="vehicles.create"><CreateVehicleButton /></Can>
  <Feature feature="advanced_reports"><AdvancedReportsPanel /></Feature>
</UnioraProvider>`, n: { en: "@uniora/react never talks to your database. Hiding a button is never a substitute for the server authorizing the real operation.", es: "@uniora/react nunca habla con tu base de datos. Ocultar un botón nunca sustituye a que el servidor autorice la operación real." } },
  sqlite: { c: `import Database from "better-sqlite3";
import { applyMigrations, createSqliteStorage } from "@uniora/sqlite";

const db = new Database("app.db");
db.pragma("journal_mode = WAL"); // recommended for a file shared by several processes
applyMigrations(db);             // synchronous and idempotent — safe on every start
const storage = createSqliteStorage(db);`, n: { en: "Same UnioraStorage as Postgres, held to the same behavioural suite — including the concurrency and security regressions.", es: "El mismo UnioraStorage que Postgres, sometido a la misma suite de comportamiento — incluidas las regresiones de concurrencia y seguridad." } },
};
function highlight(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const re = /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*")|\b(import|from|const|await|new|return|if|export)\b|\b([A-Za-z_]\w*)(?=\()|(\b\d+\b)|(<\/?[A-Z]\w*)/g;
  let out = "", last = 0, m;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    const cls = m[1] ? "tk-c" : m[2] ? "tk-s" : m[3] ? "tk-k" : m[4] ? "tk-f" : m[5] ? "tk-n" : "tk-f";
    out += `<span class="${cls}">${esc(m[0])}</span>`; last = m.index + m[0].length;
  }
  return out + esc(src.slice(last));
}
let curCode = "core";
function showCode(id) {
  curCode = id; const c = CODE[id];
  $$("#codeTabs button").forEach((b) => b.classList.toggle("active", b.dataset.code === id));
  $("#codeView code").innerHTML = highlight(c.c); $("#codeNote").textContent = pick(c.n);
}
$("#codeTabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-code]"); if (b) showCode(b.dataset.code); });
onLang.push(() => showCode(curCode)); showCode("core");

/* ───────────────── license checker ───────────────── */
const LIC = {
  yes: [
    ["commercial", { en: "Use it in a commercial product", es: "Usarlo en un producto comercial" }, { en: "Yes. Personal, internal or commercial use is allowed — for free.", es: "Sí. El uso personal, interno o comercial está permitido — gratis." }],
    ["saas", { en: "Build a paid SaaS that depends on it", es: "Crear un SaaS de pago que dependa de él" }, { en: "Yes. A paid SaaS or product that depends on UNIORA is fine. You just can't sell UNIORA itself.", es: "Sí. Un SaaS o producto de pago que dependa de UNIORA está bien. Solo no puedes vender UNIORA en sí." }],
    ["internal", { en: "Run it inside my company", es: "Ejecutarlo dentro de mi empresa" }, { en: "Yes. Internal tools and back-office systems are a permitted purpose.", es: "Sí. Herramientas internas y sistemas de back-office son un propósito permitido." }],
    ["modify", { en: "Read and modify the source", es: "Leer y modificar el código" }, { en: "Yes. You can make changes and new works based on the software for any permitted purpose.", es: "Sí. Puedes hacer cambios y obras nuevas basadas en el software para cualquier propósito permitido." }],
    ["redistribute", { en: "Redistribute it, keeping the license", es: "Redistribuirlo conservando la licencia" }, { en: "Yes — as long as recipients also get the license terms and the Required Notice line.", es: "Sí — siempre que quien lo reciba también obtenga los términos de la licencia y la línea Required Notice." }],
  ],
  no: [
    ["resell", { en: "Resell UNIORA", es: "Revender UNIORA" }, { en: "No. Reselling it is providing a product that competes with UNIORA.", es: "No. Revenderlo es ofrecer un producto que compite con UNIORA." }],
    ["repackage", { en: "Repackage it as my own product", es: "Reempaquetarlo como producto propio" }, { en: "No. Repackaging or offering it — or a substitute for it — as your own paid or free product or service is not allowed.", es: "No. Reempaquetarlo u ofrecerlo — o un sustituto — como producto o servicio propio, de pago o gratuito, no está permitido." }],
    ["competing", { en: "Launch a competing authorization service", es: "Lanzar un servicio de autorización competidor" }, { en: "No. Goods and services compete even through different interfaces, platforms or free of charge — a practical substitute for UNIORA is out.", es: "No. Los productos y servicios compiten incluso con interfaces o plataformas distintas, o gratis — un sustituto práctico de UNIORA queda fuera." }],
    ["strip", { en: "Remove the license or Required Notice", es: "Quitar la licencia o el Required Notice" }, { en: "No. Anyone who gets a copy from you must also get the license terms and the Required Notice lines.", es: "No. Quien reciba una copia tuya debe recibir también los términos de la licencia y las líneas Required Notice." }],
  ],
};
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
  else { $("b", v).setAttribute("data-i18n", "lic.pick"); $("b", v).innerHTML = lang === "es" ? ES["lic.pick"] : "Pick a use case above."; $("p", v).textContent = ""; }
}
onLang.push(drawLic); drawLic();

/* ───────────────── live GitHub data ───────────────── */
const FALLBACK_RELEASES = [["v0.10.0", "2026-10-11"], ["v0.9.0", "2026-10-10"], ["v0.8.0", "2026-10-10"], ["v0.7.0", "2026-10-09"], ["v0.6.1", "2026-10-09"], ["v0.6.0", "2026-10-08"]].map(([tag_name, d]) => ({ tag_name, published_at: d, html_url: `https://github.com/${REPO}/releases/tag/${tag_name}` }));
const FALLBACK_LANGS = { TypeScript: 4488480, JavaScript: 212667, PLpgSQL: 61420, CSS: 11858 };
const COLORS = ["#efb100", "#8e51ff", "#00bc7d", "#38bdf8", "#f472b6", "#ff6467"];

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
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", 60); c.setAttribute("cy", 60); c.setAttribute("r", 48); c.style.stroke = color;
    c.style.strokeDasharray = `0 ${C}`; c.style.strokeDashoffset = String(-acc * C); svg.appendChild(c);
    requestAnimationFrame(() => setTimeout(() => { c.style.strokeDasharray = `${len} ${C - len}`; }, 200 + i * 150));
    acc += frac;
    $("#langLegend").insertAdjacentHTML("beforeend", `<li><i style="background:${color}"></i>${name}<span>${(frac * 100).toFixed(1)}%</span></li>`);
  });
}
function drawTimeline(rels) {
  $("#timeline").innerHTML = rels.slice(0, 8).map((r) => `<li><a href="${r.html_url}" target="_blank" rel="noopener"><b>${r.tag_name}</b></a><time datetime="${r.published_at}">${new Date(r.published_at).toLocaleDateString(lang === "es" ? "es-ES" : "en-US", { year: "numeric", month: "short", day: "numeric" })}</time></li>`).join("");
}
let repoData = null, gazers = [];
function drawGazers() {
  const box = $("#avatars"); box.innerHTML = "";
  if (state.stars > 0 && !gazers.length) {
    $("#gazNote").innerHTML = `<a href="https://github.com/${REPO}/stargazers" target="_blank" rel="noopener" style="color:var(--amber)">${pick(RT.gazLink)}</a>`; return;
  }
  if (state.stars === 0 || !gazers.length) {
    for (let i = 0; i < 14; i++) box.insertAdjacentHTML("beforeend", `<span class="ph${i === 0 ? " first" : ""}" style="--d:${i * 0.25}s">${i === 0 ? "★" : ""}</span>`);
    $("#gazNote").textContent = pick(RT.gazNone);
  } else {
    gazers.forEach((u) => box.insertAdjacentHTML("beforeend", `<a href="${u.html_url}" target="_blank" rel="noopener" title="${u.login}"><img src="${u.avatar_url}&s=88" alt="${u.login}" width="44" height="44" loading="lazy"></a>`));
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
$$(".scramble").forEach((el, i) => scramble(el, el.dataset.scramble, 500 + i * 450));
loadRepo();
