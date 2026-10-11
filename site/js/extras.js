// Motion graphics and interactive details: request-flow animation, animated SVG for each principle,
// moving packets on the architecture map, hotspots over the real Studio screenshots, word-by-word headings,
// section dots and the ALLOW spark burst. No dependencies; every animation is skipped under reduced motion.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const NS = "http://www.w3.org/2000/svg";

/* ───────────────── request flow (Provider → UNIORA → Decision) ───────────────── */
const FLOW_TEXT = {
  start: { en: (w) => `${w} → identity resolved`, es: (w) => `${w} → identidad resuelta` },
  check: { en: "UNIORA → membership · role · permission · feature", es: "UNIORA → membresía · rol · permiso · feature" },
  allow: { en: "ALLOW · reason: evaluated", es: "ALLOW · razón: evaluated" },
  deny: { en: "DENY · reason: permission_denied", es: "DENY · razón: permission_denied" },
};
const WHO = ["supabase:u_ana", "clerk:u_marco", "auth0:u_lena", "better-auth:u_kenji"];

export function initFlow({ getLang }) {
  const flow = $("#flow"), packet = $("#flowPacket"), log = $("#flowLog");
  if (!flow) return { redraw() {} };
  const [nProv, nCore, nOut] = $$(".flow-node", flow);
  const verdictBox = $(".verdict", nOut);
  let kind = "allow", busy = false, last = 0, visible = false;

  const center = (el) => { const f = flow.getBoundingClientRect(), r = el.getBoundingClientRect(); return { x: r.left - f.left + r.width / 2, y: r.top - f.top + r.height / 2 }; };
  const at = (p, s = 1, o = 1) => `translate(${p.x - 8}px, ${p.y - 8}px) scale(${s})`;
  const color = (c) => { packet.style.background = c; packet.style.boxShadow = `0 0 18px 4px ${c}`; };
  const say = (t) => { log.textContent = t; log.classList.remove("tick"); void log.offsetWidth; log.classList.add("tick"); };
  const setVerdict = (v) => { nOut.dataset.v = v || ""; };

  async function run(k) {
    if (busy) return;
    busy = true; kind = k; last = performance.now();
    const lang = getLang();
    $$("[data-send]").forEach((b) => b.classList.toggle("active", b.dataset.send === k));
    const a = center(nProv), b = center(nCore), c = center(nOut);
    setVerdict("");
    say(FLOW_TEXT.start[lang](WHO[(Math.random() * WHO.length) | 0]));
    if (reduced) { say(FLOW_TEXT[k][lang]); setVerdict(k); busy = false; return; }
    packet.style.opacity = 1; color("#efb100");
    const go = (from, to, ms, extra = {}) => packet.animate([{ transform: at(from) }, { transform: at(to) }], { duration: ms, easing: "cubic-bezier(.6,0,.2,1)", fill: "forwards", ...extra }).finished;
    await go(a, b, 750);
    nCore.classList.add("scan"); say(FLOW_TEXT.check[lang]); await wait(650); nCore.classList.remove("scan");
    if (k === "allow") {
      color("#00bc7d"); await go(b, c, 700); nOut.classList.add("hit");
    } else {
      color("#ff6467");
      const mid = { x: b.x + (c.x - b.x) * 0.42, y: b.y + (c.y - b.y) * 0.42 };
      await go(b, mid, 380); nCore.classList.add("block"); await go(mid, b, 380); nCore.classList.remove("block");
      await go(b, c, 520); nOut.classList.add("hit");
    }
    setVerdict(k); say(FLOW_TEXT[k][lang]);
    packet.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, fill: "forwards" });
    await wait(1800); nOut.classList.remove("hit"); busy = false;
  }

  $$("[data-send]").forEach((b) => b.addEventListener("click", () => run(b.dataset.send)));
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible && !last) setTimeout(() => run("allow"), 600); }, { threshold: 0.4 }).observe(flow);
  setInterval(() => { if (visible && !busy && performance.now() - last > 6500) run(kind === "allow" ? "deny" : "allow"); }, 1200);
  return { redraw() { if (nOut.dataset.v) say(FLOW_TEXT[nOut.dataset.v][getLang()]); } };
}

/* ───────────────── pillar motion graphics ───────────────── */
const A = (inner) => `<svg viewBox="0 0 240 96" class="art" aria-hidden="true">${inner}</svg>`;
const anim = (attr, values, dur, extra = "") => `<animate attributeName="${attr}" values="${values}" dur="${dur}s" repeatCount="indefinite" ${extra}/>`;
const ART = {
  deny: A(`
    <path d="M120 8 L152 21 V48 C152 67 137 80 120 88 C103 80 88 67 88 48 V21 Z" class="shield"/>
    <path d="M108 48 l9 9 l16 -18" class="check"/>
    <circle cy="30" r="4" fill="#ff6467">${anim("cx", "6;82;40;6", 3.4, 'keyTimes="0;.42;.7;1"')}${anim("opacity", "1;1;.2;1", 3.4)}</circle>
    <circle cy="66" r="4" fill="#ff6467">${anim("cx", "6;82;40;6", 3.4, 'keyTimes="0;.42;.7;1" begin="1.1s"')}</circle>
    <circle cy="48" r="4" fill="#00bc7d">${anim("cx", "6;234", 3.4, 'begin=".5s"')}${anim("opacity", "0;1;1;0", 3.4, 'begin=".5s"')}</circle>
    <text x="172" y="30" class="lbl bad">DENY</text><text x="172" y="72" class="lbl ok">ALLOW</text>`),
  owner: A(`
    ${[60, 100, 140, 180].map((x, i) => `<circle cx="${x}" cy="52" r="14" class="${i ? "mem" : "own"}"/><circle cx="${x}" cy="47" r="4" class="face"/><path d="M${x - 8} 62 q8 -9 16 0" class="face"/>`).join("")}
    <circle cx="60" cy="52" r="14" class="ring"><animate attributeName="r" values="14;26" dur="2.4s" repeatCount="indefinite"/><animate attributeName="opacity" values=".7;0" dur="2.4s" repeatCount="indefinite"/></circle>
    <text x="60" y="22" text-anchor="middle" class="crown">★</text>
    <text x="60" y="14" text-anchor="middle" class="lbl bad" opacity="0">✕${anim("opacity", "0;0;1;1;0", 3.4, 'keyTimes="0;.3;.4;.8;1"')}</text>
    <text x="120" y="88" text-anchor="middle" class="lbl">last owner · protected</text>`),
  audit: A(`
    ${[14, 70, 126, 182].map((x, i) => `<rect x="${x}" y="26" width="44" height="40" rx="7" class="blk" ${i === 2 ? 'id="aud3"' : ""}>${i === 2 ? anim("stroke", "#efb100;#efb100;#ff6467;#ff6467;#efb100", 6, 'keyTimes="0;.45;.5;.88;1"') : ""}</rect><text x="${x + 22}" y="50" text-anchor="middle" class="hash">${["a3f", "9c1", "7be", "2d0"][i]}</text>`).join("")}
    ${[58, 114, 170].map((x, i) => `<path d="M${x} 46 H${x + 12}" class="link ${i >= 2 ? "l3" : ""}"/>`).join("")}
    <circle cy="46" r="3" fill="#efb100">${anim("cx", "36;92;148;204", 3, "")}</circle>
    <text x="148" y="84" text-anchor="middle" class="lbl bad" opacity="0">verifyIntegrity() ✕${anim("opacity", "0;0;1;1;0", 6, 'keyTimes="0;.45;.5;.88;1"')}</text>`),
  quota: A(`
    ${[["seats", 22, 96, "#efb100"], ["reports", 48, 150, "#8e51ff"], ["api", 74, 150, "#00bc7d"]].map(([n, y, w, c], i) => `<text x="8" y="${y + 9}" class="lbl">${n}</text><rect x="62" y="${y}" width="150" height="12" rx="6" class="track"/><rect x="62" y="${y}" height="12" rx="6" fill="${c}"><animate attributeName="width" values="0;${w};${w};0" keyTimes="0;.5;.9;1" dur="${4 + i * 0.6}s" repeatCount="indefinite"/>${i === 2 ? anim("fill", "#00bc7d;#00bc7d;#ff6467;#ff6467;#00bc7d", 5.2, 'keyTimes="0;.45;.5;.9;1"') : ""}</rect>`).join("")}
    <text x="222" y="83" class="lbl bad" opacity="0">max${anim("opacity", "0;0;1;1;0", 5.2, 'keyTimes="0;.45;.5;.9;1"')}</text>`),
  core: A(`
    <circle cx="120" cy="48" r="20" class="coreA"/><text x="120" y="55" text-anchor="middle" class="u">U</text>
    <circle cx="120" cy="48" r="34" class="orbit"><animateTransform attributeName="transform" type="rotate" from="0 120 48" to="360 120 48" dur="14s" repeatCount="indefinite"/></circle>
    <circle cx="120" cy="48" r="46" class="orbit o2"><animateTransform attributeName="transform" type="rotate" from="360 120 48" to="0 120 48" dur="22s" repeatCount="indefinite"/></circle>
    <g><circle cx="154" cy="48" r="4" fill="#8e51ff"/><circle cx="86" cy="48" r="4" fill="#00bc7d"/><animateTransform attributeName="transform" type="rotate" from="0 120 48" to="360 120 48" dur="14s" repeatCount="indefinite"/></g>
    <g><circle cx="120" cy="2" r="3" fill="#efb100"/><circle cx="120" cy="94" r="3" fill="#fafafa"/><animateTransform attributeName="transform" type="rotate" from="360 120 48" to="0 120 48" dur="22s" repeatCount="indefinite"/></g>`),
  server: A(`
    <rect x="10" y="14" width="84" height="64" rx="8" class="box"/><rect x="10" y="14" width="84" height="12" rx="6" class="boxbar"/>
    <rect x="26" y="40" width="52" height="18" rx="5" class="btn"><animate attributeName="opacity" values="1;1;.35;1" dur="4s" repeatCount="indefinite"/></rect><text x="52" y="52" text-anchor="middle" class="lbl">Delete</text>
    <rect x="146" y="14" width="84" height="64" rx="8" class="box srv"/><path d="M188 30 l16 6 v12 c0 10 -7 16 -16 20 c-9 -4 -16 -10 -16 -20 v-12 z" class="shield"/>
    <circle cy="49" r="4" fill="#efb100">${anim("cx", "98;142;142;98", 4, 'keyTimes="0;.3;.7;1"')}</circle>
    <text x="120" y="42" text-anchor="middle" class="lbl bad" opacity="0">403${anim("opacity", "0;0;1;1;0", 4, 'keyTimes="0;.45;.55;.95;1"')}</text>
    <text x="120" y="92" text-anchor="middle" class="lbl">UI hides · server decides</text>`),
};
export function initArt() { $$(".pillar[data-art]").forEach((p) => { if (!$(".art", p)) p.insertAdjacentHTML("afterbegin", ART[p.dataset.art] || ""); }); }

/* ───────────────── architecture: packets travelling along the wires ───────────────── */
export function decoratePaths(svg) {
  if (reduced) return;
  $$("path[data-pkg]", svg).forEach((p, i) => {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("r", "3.2"); c.setAttribute("class", "pk"); c.dataset.pkg = p.dataset.pkg;
    const m = document.createElementNS(NS, "animateMotion");
    m.setAttribute("dur", `${2.4 + (i % 4) * 0.35}s`); m.setAttribute("begin", `${(i * 0.37) % 2}s`); m.setAttribute("repeatCount", "indefinite"); m.setAttribute("path", p.getAttribute("d"));
    c.appendChild(m); svg.appendChild(c);
  });
}

/* ───────────────── Studio hotspots over the real screenshots ───────────────── */
const SPOTS = {
  overview: [
    [28, 29, { en: "Live totals for organizations, members, roles, permissions and features.", es: "Totales en vivo de organizaciones, miembros, roles, permisos y features." }],
    [82.5, 56, { en: "Recent activity is read from the append-only audit log.", es: "La actividad reciente se lee del log de auditoría solo-añadir." }],
    [8.8, 94.4, { en: "Local database. Data never leaves this machine.", es: "Base de datos local. Los datos nunca salen de esta máquina." }],
  ],
  members: [
    [46, 54, { en: "The Owner role is protected: it is created with the organization.", es: "El rol Owner está protegido: se crea junto con la organización." }],
    [94, 54, { en: "The last Owner cannot be removed, blocked or demoted.", es: "El último Owner no puede eliminarse, bloquearse ni degradarse." }],
    [92.7, 37, { en: "Add a member and assign one or more roles.", es: "Añade un miembro y asigna uno o más roles." }],
  ],
  roles: [
    [26.5, 69, { en: "Owner has full access to the organization.", es: "El Owner tiene acceso completo a la organización." }],
    [54, 57.8, { en: "Permissions are granted per role. billing.manage is not granted to Administrator.", es: "Los permisos se conceden por rol. billing.manage no está concedido a Administrator." }],
    [24.4, 37, { en: "Create custom roles for each organization.", es: "Crea roles personalizados para cada organización." }],
  ],
  permissions: [
    [76, 34, { en: "Shows how many roles hold each permission.", es: "Muestra cuántos roles tienen cada permiso." }],
    [75.8, 45, { en: "billing.manage is registered but granted to no role yet.", es: "billing.manage está registrado pero aún no se concede a ningún rol." }],
    [90, 23.6, { en: "Register a permission in the global catalog.", es: "Registra un permiso en el catálogo global." }],
  ],
  features: [
    [78.8, 35, { en: "Adoption of each feature across organizations.", es: "Adopción de cada feature entre las organizaciones." }],
    [78.8, 49.8, { en: "api_access is enabled in all five organizations.", es: "api_access está habilitada en las cinco organizaciones." }],
    [22, 23.6, { en: "Features are capabilities an organization can unlock.", es: "Las features son capacidades que una organización puede desbloquear." }],
  ],
  activity: [
    [22.5, 29, { en: "Each change is written to the audit log in the same transaction.", es: "Cada cambio se escribe en el log de auditoría en la misma transacción." }],
    [43, 19, { en: "Studio is the only writer of these entries.", es: "Studio es el único que escribe estas entradas." }],
    [8.8, 94.4, { en: "Everything shown is stored in your own database.", es: "Todo lo que se muestra está almacenado en tu propia base de datos." }],
  ],
};
let spotLang = () => "en", activeShot = "overview";
export function initSpots({ getLang }) { spotLang = getLang; drawSpots(); }
export function showSpots(id) { activeShot = id; $$(".spots").forEach((s) => s.classList.toggle("active", s.dataset.shot === id)); }
export function drawSpots() {
  const screen = $("#deviceScreen"); if (!screen) return;
  $$(".spots", screen).forEach((s) => s.remove());
  const lang = spotLang();
  Object.entries(SPOTS).forEach(([shot, list]) => {
    const wrap = document.createElement("div"); wrap.className = "spots" + (shot === activeShot ? " active" : ""); wrap.dataset.shot = shot;
    list.forEach(([x, y, text], i) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "spot" + (x > 55 ? " left" : "") + (y > 70 ? " up" : "");
      b.style.left = `${x}%`; b.style.top = `${y}%`; b.style.setProperty("--i", i);
      b.setAttribute("aria-label", text[lang]);
      b.innerHTML = `<span class="tip">${text[lang]}</span>`;
      b.addEventListener("click", (e) => { e.stopPropagation(); const open = b.classList.contains("open"); $$(".spot.open", wrap).forEach((o) => o.classList.remove("open")); if (!open) b.classList.add("open"); });
      wrap.appendChild(b);
    });
    screen.appendChild(wrap);
  });
}

/* ───────────────── headings revealed word by word ───────────────── */
export function splitHeadings() {
  $$(".sec-head h2").forEach((h) => {
    let n = 0;
    const walk = (node) => {
      [...node.childNodes].forEach((c) => {
        if (c.nodeType === 3) {
          const frag = document.createDocumentFragment();
          c.textContent.split(/(\s+)/).forEach((part) => {
            if (!part) return;
            if (/^\s+$/.test(part)) frag.appendChild(document.createTextNode(" "));
            else { const w = document.createElement("span"), i = document.createElement("span"); w.className = "w"; i.textContent = part; i.style.setProperty("--i", n++); w.appendChild(i); frag.appendChild(w); }
          });
          c.replaceWith(frag);
        } else if (c.nodeType === 1 && !c.classList.contains("w")) walk(c);
      });
    };
    if (!$(".w", h)) walk(h);
  });
}

/* ───────────────── section dots ───────────────── */
export function initDots() {
  const ids = ["hero", "what", "modes", "playground", "mission", "pillars", "savings", "architecture", "studio", "code", "metrics", "license", "roadmap", "start"];
  const nav = document.createElement("nav"); nav.className = "dots"; nav.setAttribute("aria-label", "Sections");
  ids.forEach((id) => { const a = document.createElement("a"); a.href = `#${id === "hero" ? "top" : id}`; a.dataset.id = id; a.innerHTML = "<i></i><span></span>"; nav.appendChild(a); });
  document.body.appendChild(nav);
  const label = () => ids.forEach((id) => { const el = document.getElementById(id), a = $(`a[data-id="${id}"] span`, nav); if (!a) return; const e = el && $(".eyebrow span", el); a.textContent = id === "hero" ? "UNIORA" : (e ? e.textContent : id); });
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) $$("a", nav).forEach((a) => a.classList.toggle("on", a.dataset.id === e.target.id)); }), { rootMargin: "-45% 0px -50% 0px" });
  ids.forEach((id) => { const el = document.getElementById(id); if (el) io.observe(el); });
  label();
  return { redraw: label };
}

/* ───────────────── ALLOW spark burst ───────────────── */
export function sparks(el) {
  if (reduced) return;
  for (let i = 0; i < 16; i++) {
    const s = document.createElement("i"); s.className = "spark";
    const ang = (Math.PI * 2 * i) / 16 + Math.random() * 0.4, d = 40 + Math.random() * 60;
    s.style.setProperty("--dx", `${Math.cos(ang) * d}px`); s.style.setProperty("--dy", `${Math.sin(ang) * d}px`);
    el.appendChild(s); setTimeout(() => s.remove(), 900);
  }
}

/* ───────────────── deployment modes: embedded library vs standalone server ───────────────── */
const MODE = {
  lib: {
    tab: { en: "Embedded library", es: "Biblioteca embebida" },
    title: { en: "UNIORA inside your backend", es: "UNIORA dentro de tu backend" },
    desc: { en: "@uniora/core runs in your backend process with a storage adapter for PostgreSQL or SQLite. Authorization is a function call: no extra service and no network hop.", es: "@uniora/core se ejecuta en el proceso de tu backend con un adaptador de almacenamiento para PostgreSQL o SQLite. Autorizar es una llamada a función: sin servicio adicional y sin salto de red." },
    points: [
      { en: "One import and one call: uniora.can()", es: "Un import y una llamada: uniora.can()" },
      { en: "Reads and writes your own database, in a dedicated uniora.* schema", es: "Lee y escribe tu propia base de datos, en un esquema uniora.* dedicado" },
      { en: "Guards for Express and Next.js and helpers for React included", es: "Incluye guards para Express y Next.js y helpers para React" },
    ],
    best: { en: "Best for a single application or a monolith.", es: "Ideal para una sola aplicación o un monolito." },
    install: "npm install @uniora/core @uniora/postgres pg",
    code: `const uniora = createAuthorizationEngine(storage);

const allowed = await uniora.can({
  identity: { provider: "supabase", subject: userId },
  organizationId: orgId,
  permission: "vehicles.delete",
});`,
  },
  srv: {
    tab: { en: "Standalone server", es: "Servidor independiente" },
    title: { en: "UNIORA as a service your backends call", es: "UNIORA como servicio al que llaman tus backends" },
    desc: { en: "@uniora/server is the same engine behind an HTTP API. You run it as a separate service with its own database. Your backends call it with an API key: from TypeScript with @uniora/client, or from any language over REST.", es: "@uniora/server es el mismo motor detrás de una API HTTP. Lo ejecutas como un servicio aparte con su propia base de datos. Tus backends lo llaman con una API key: desde TypeScript con @uniora/client, o desde cualquier lenguaje por REST." },
    points: [
      { en: "API keys with scopes and organization lists; rotation without downtime", es: "API keys con scopes y listas de organizaciones; rotación sin downtime" },
      { en: "Typed client and an OpenAPI contract for any language", es: "Cliente tipado y contrato OpenAPI para cualquier lenguaje" },
      { en: "Changes on behalf of an end user, with anti-escalation rules applied to that user", es: "Cambios en nombre de un usuario final, con reglas anti-escalada aplicadas a ese usuario" },
    ],
    best: { en: "Best for several services or teams sharing one authorization model. You host it: there is no UNIORA cloud, and each deployment runs its own server and database.", es: "Ideal para varios servicios o equipos que comparten un mismo modelo de autorización. Lo hospedas tú: no existe una nube de UNIORA y cada despliegue ejecuta su propio servidor y su propia base de datos." },
    install: "npx uniora server start",
    code: `import { createUnioraClient } from "@uniora/client";

const uniora = createUnioraClient({ baseUrl: process.env.UNIORA_URL!, apiKey: process.env.UNIORA_API_KEY! });

const { allowed } = await uniora.decisions.check({
  identity: { subject: user.id },
  organizationId,
  permission: "vehicles.delete",
});
// any language: POST /v1/check with Authorization: Bearer uniora_sk_…`,
  },
};
const MODE_ROWS = [
  [{ en: "Runs", es: "Se ejecuta" }, { en: "Inside your backend process", es: "Dentro del proceso de tu backend" }, { en: "As a separate service you operate", es: "Como un servicio aparte que tú operas" }],
  [{ en: "How you call it", es: "Cómo se invoca" }, { en: "Function call: uniora.can()", es: "Llamada a función: uniora.can()" }, { en: "HTTPS and an API key: POST /v1/check", es: "HTTPS y una API key: POST /v1/check" }],
  [{ en: "Network hop", es: "Salto de red" }, { en: "None", es: "Ninguno" }, { en: "One request per decision", es: "Una solicitud por decisión" }],
  [{ en: "Languages", es: "Lenguajes" }, { en: "TypeScript and Node.js", es: "TypeScript y Node.js" }, { en: "Any language over REST (OpenAPI); typed client for TypeScript", es: "Cualquier lenguaje por REST (OpenAPI); cliente tipado para TypeScript" }],
  [{ en: "Data", es: "Datos" }, { en: "Your application database, dedicated uniora.* schema", es: "La base de datos de tu aplicación, esquema uniora.* dedicado" }, { en: "Its own dedicated database (PostgreSQL or SQLite)", es: "Su propia base de datos dedicada (PostgreSQL o SQLite)" }],
  [{ en: "Access control", es: "Control de acceso" }, { en: "Your application code decides who can call it", es: "El código de tu aplicación decide quién puede llamarlo" }, { en: "API clients with scopes and organization lists", es: "API clients con scopes y listas de organizaciones" }],
  [{ en: "Best for", es: "Ideal para" }, { en: "One application or a monolith", es: "Una aplicación o un monolito" }, { en: "Several backends, services or teams", es: "Varios backends, servicios o equipos" }],
];
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function hlTs(src) {
  const re = /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*")|\b(import|from|const|await|new)\b|\b([A-Za-z_]\w*)(?=\()/g;
  let out = "", last = 0, m;
  while ((m = re.exec(src))) { out += esc(src.slice(last, m.index)); out += `<span class="${m[1] ? "tk-c" : m[2] ? "tk-s" : m[3] ? "tk-k" : "tk-f"}">${esc(m[0])}</span>`; last = m.index + m[0].length; }
  return out + esc(src.slice(last));
}
function diagram(mode, lang) {
  const t = (en, es) => (lang === "es" ? es : en);
  const box = (x, y, w, h, title, sub, cls = "") => `<g class="dg-box ${cls}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/><text x="${x + w / 2}" y="${y + h / 2 - (sub ? 4 : -4)}" text-anchor="middle" class="dg-t">${title}</text>${sub ? `<text x="${x + w / 2}" y="${y + h / 2 + 14}" text-anchor="middle" class="dg-s">${sub}</text>` : ""}</g>`;
  const db = (x, y, w, h, title, sub) => `<g class="dg-box db"><path d="M${x} ${y + 12} v${h - 24} c0 14 ${w} 14 ${w} 0 v-${h - 24}" fill="none"/><ellipse cx="${x + w / 2}" cy="${y + 12}" rx="${w / 2}" ry="12"/><text x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle" class="dg-t">${title}</text><text x="${x + w / 2}" y="${y + h / 2 + 20}" text-anchor="middle" class="dg-s">${sub}</text></g>`;
  const wire = (id, d, color, dur, begin, rev = false) => `<path id="${id}" d="${d}" class="dg-wire"/><circle r="4.5" fill="${color}" class="dg-pk"><animateMotion dur="${dur}s" begin="${begin}s" repeatCount="indefinite" ${rev ? 'keyPoints="1;0" keyTimes="0;1" calcMode="linear"' : ""} path="${d}"/></circle>`;
  if (mode === "lib") {
    return `<svg viewBox="0 18 720 288" class="dg">
      <rect x="196" y="36" width="330" height="248" rx="16" class="dg-zone"/><text x="211" y="60" class="dg-z">${t("Your backend · one process", "Tu backend · un proceso")}</text>
      ${box(8, 125, 112, 70, "Browser", t("user session", "sesión del usuario"))}
      ${box(222, 120, 120, 80, t("Your code", "Tu código"), "routes · actions")}
      ${box(392, 120, 112, 80, "@uniora/core", "uniora.can()", "hl")}
      ${db(580, 112, 132, 96, t("Your database", "Tu base de datos"), "uniora.* schema")}
      ${box(222, 222, 120, 44, t("Auth provider", "Proveedor de auth"), "", "mut")}
      ${wire("w1", "M120 160 H222", "#fafafa", 2.2, 0)}
      ${wire("w2", "M342 160 H392", "#efb100", 1.6, 0.4)}
      ${wire("w3", "M504 160 H580", "#00bc7d", 2, 0.9)}
      ${wire("w4", "M282 222 V200", "#8e51ff", 2.4, 0.2)}
      <text x="367" y="150" text-anchor="middle" class="dg-c">${t("function call", "llamada a función")}</text>
    </svg>`;
  }
  return `<svg viewBox="0 18 720 288" class="dg">
    ${box(8, 30, 160, 62, "Backend A", "Node.js")}
    ${box(8, 130, 160, 62, "Backend B", t("any language", "cualquier lenguaje"))}
    ${box(8, 230, 160, 62, "Worker", t("jobs · cron", "jobs · cron"))}
    ${box(332, 56, 176, 208, "", "", "hl")}
    <text x="420" y="96" text-anchor="middle" class="dg-t">@uniora/server</text>
    <text x="420" y="232" text-anchor="middle" class="dg-s">${t("API keys · scopes", "API keys · scopes")}</text>
    <text x="420" y="248" text-anchor="middle" class="dg-s">${t("organization lists", "listas de organizaciones")}</text>
    <text x="420" y="116" text-anchor="middle" class="dg-s">AuthorizationEngine</text>
    ${db(582, 112, 132, 96, t("Own database", "Base propia"), "Postgres · SQLite")}
    ${wire("s1", "M168 61 C250 61 250 120 332 120", "#fafafa", 2.4, 0)}
    ${wire("s2", "M168 161 H332", "#efb100", 2, 0.5)}
    ${wire("s3", "M168 261 C250 261 250 200 332 200", "#fafafa", 2.6, 1)}
    ${wire("s4", "M332 150 H168", "#00bc7d", 2.2, 0.9, false)}
    ${wire("s5", "M508 160 H582", "#00bc7d", 1.8, 0.3)}
    <text x="250" y="150" text-anchor="middle" class="dg-c">HTTPS · API key</text>
    <text x="250" y="178" text-anchor="middle" class="dg-c ok">{ "allowed": true }</text>
  </svg>`;
}
export function initModes({ getLang }) {
  const tabs = $("#modeTabs"); if (!tabs) return { redraw() {} };
  let mode = "lib";
  const draw = () => {
    const lang = getLang(), m = MODE[mode];
    $("#modeTabLib").textContent = MODE.lib.tab[lang]; $("#modeTabSrv").textContent = MODE.srv.tab[lang];
    $$("button", tabs).forEach((b) => { b.classList.toggle("active", b.dataset.mode === mode); b.setAttribute("aria-selected", String(b.dataset.mode === mode)); });
    const col = mode === "lib" ? 1 : 2;
    $("#modeDiagram").innerHTML = diagram(mode, lang) + `<ul class="mode-facts">${MODE_ROWS.slice(0, 3).map((r) => `<li><span>${r[0][lang]}</span><b>${r[col][lang]}</b></li>`).join("")}</ul>`;
    $("#modeInfo").innerHTML = `<h3>${m.title[lang]}</h3><p>${esc(m.desc[lang])}</p><ul class="ticks">${m.points.map((p) => `<li>${esc(p[lang])}</li>`).join("")}</ul>
      <div class="mode-install"><code>${esc(m.install)}</code><button type="button" class="mini" data-c="${esc(m.install)}">${lang === "es" ? "copiar" : "copy"}</button></div>
      <pre class="code mini-code"><code>${hlTs(m.code)}</code></pre><p class="fine">${esc(m.best[lang])}</p>`;
    $("#modeInfo .mini").addEventListener("click", async (e) => { try { await navigator.clipboard.writeText(e.target.dataset.c); e.target.textContent = lang === "es" ? "¡copiado!" : "copied!"; } catch { /* clipboard unavailable */ } });
    const head = `<thead><tr><th></th><th>${MODE.lib.tab[lang]}</th><th>${MODE.srv.tab[lang]}</th></tr></thead>`;
    $("#modeTable").innerHTML = head + `<tbody>${MODE_ROWS.map(([a, b, c]) => `<tr><th scope="row">${a[lang]}</th><td>${b[lang]}</td><td>${c[lang]}</td></tr>`).join("")}</tbody>`;
  };
  tabs.addEventListener("click", (e) => { const b = e.target.closest("button[data-mode]"); if (!b || b.dataset.mode === mode) return; mode = b.dataset.mode; draw(); });
  draw();
  return { redraw: draw };
}
