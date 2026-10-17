// Deployment modes: embedded library vs standalone server (tabs, animated diagram, comparison table).
import { $, $$, esc } from "./fx.js";

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

const ROWS = [
  [{ en: "Runs", es: "Se ejecuta" }, { en: "Inside your backend process", es: "Dentro del proceso de tu backend" }, { en: "As a separate service you operate", es: "Como un servicio aparte que tú operas" }],
  [{ en: "How you call it", es: "Cómo se invoca" }, { en: "Function call: uniora.can()", es: "Llamada a función: uniora.can()" }, { en: "HTTPS and an API key: POST /v1/check", es: "HTTPS y una API key: POST /v1/check" }],
  [{ en: "Network hop", es: "Salto de red" }, { en: "None", es: "Ninguno" }, { en: "One request per decision", es: "Una solicitud por decisión" }],
  [{ en: "Languages", es: "Lenguajes" }, { en: "TypeScript and Node.js", es: "TypeScript y Node.js" }, { en: "Any language over REST (OpenAPI); typed client for TypeScript", es: "Cualquier lenguaje por REST (OpenAPI); cliente tipado para TypeScript" }],
  [{ en: "Data", es: "Datos" }, { en: "Your application database, dedicated uniora.* schema", es: "La base de datos de tu aplicación, esquema uniora.* dedicado" }, { en: "Its own dedicated database (PostgreSQL or SQLite)", es: "Su propia base de datos dedicada (PostgreSQL o SQLite)" }],
  [{ en: "Access control", es: "Control de acceso" }, { en: "Your application code decides who can call it", es: "El código de tu aplicación decide quién puede llamarlo" }, { en: "API clients with scopes and organization lists", es: "API clients con scopes y listas de organizaciones" }],
  [{ en: "Best for", es: "Ideal para" }, { en: "One application or a monolith", es: "Una aplicación o un monolito" }, { en: "Several backends, services or teams", es: "Varios backends, servicios o equipos" }],
];

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
  const wire = (id, d, color, dur, begin) => `<path id="${id}" d="${d}" class="dg-wire"/><circle r="4.5" fill="${color}" class="dg-pk" style="color:${color}"><animateMotion dur="${dur}s" begin="${begin}s" repeatCount="indefinite" path="${d}"/></circle>`;
  if (mode === "lib") {
    return `<svg viewBox="0 18 720 288" class="dg">
      <rect x="196" y="36" width="330" height="248" rx="16" class="dg-zone"/><text x="211" y="60" class="dg-z">${t("Your backend · one process", "Tu backend · un proceso")}</text>
      ${box(8, 125, 112, 70, "Browser", t("user session", "sesión del usuario"))}
      ${box(222, 120, 120, 80, t("Your code", "Tu código"), "routes · actions")}
      ${box(392, 120, 112, 80, "@uniora/core", "uniora.can()", "hl")}
      ${db(580, 112, 132, 96, t("Your database", "Tu base de datos"), "uniora.* schema")}
      ${box(222, 222, 120, 44, t("Auth provider", "Proveedor de auth"), "", "mut")}
      ${wire("w1", "M120 160 H222", "#fafafa", 2.2, 0)}
      ${wire("w2", "M342 160 H392", "#f7c325", 1.6, 0.4)}
      ${wire("w3", "M504 160 H580", "#19d49a", 2, 0.9)}
      ${wire("w4", "M282 222 V200", "#8e51ff", 2.4, 0.2)}
      <text x="367" y="150" text-anchor="middle" class="dg-c">${t("function call", "llamada a función")}</text>
    </svg>`;
  }
  return `<svg viewBox="0 18 720 288" class="dg">
    ${box(8, 30, 160, 62, "Backend A", "Node.js")}
    ${box(8, 130, 160, 62, "Backend B", t("any language", "cualquier lenguaje"))}
    ${box(8, 230, 160, 62, "Worker", "jobs · cron")}
    ${box(332, 56, 176, 208, "", "", "hl")}
    <text x="420" y="96" text-anchor="middle" class="dg-t">@uniora/server</text>
    <text x="420" y="116" text-anchor="middle" class="dg-s">AuthorizationEngine</text>
    <text x="420" y="232" text-anchor="middle" class="dg-s">API keys · scopes</text>
    <text x="420" y="248" text-anchor="middle" class="dg-s">${t("organization lists", "listas de organizaciones")}</text>
    ${db(582, 112, 132, 96, t("Own database", "Base propia"), "Postgres · SQLite")}
    ${wire("s1", "M168 61 C250 61 250 120 332 120", "#fafafa", 2.4, 0)}
    ${wire("s2", "M168 161 H332", "#f7c325", 2, 0.5)}
    ${wire("s3", "M168 261 C250 261 250 200 332 200", "#fafafa", 2.6, 1)}
    ${wire("s4", "M332 150 H168", "#19d49a", 2.2, 0.9)}
    ${wire("s5", "M508 160 H582", "#19d49a", 1.8, 0.3)}
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
    $("#modeDiagram").innerHTML = diagram(mode, lang) + `<ul class="mode-facts">${ROWS.slice(0, 3).map((r) => `<li><span>${r[0][lang]}</span><b>${r[col][lang]}</b></li>`).join("")}</ul>`;
    $("#modeInfo").innerHTML = `<h3>${m.title[lang]}</h3><p>${esc(m.desc[lang])}</p><ul class="ticks">${m.points.map((p) => `<li>${esc(p[lang])}</li>`).join("")}</ul>
      <div class="mode-install"><code>${esc(m.install)}</code><button type="button" class="mini" data-c="${esc(m.install)}">${lang === "es" ? "copiar" : "copy"}</button></div>
      <pre class="mini-code"><code>${hlTs(m.code)}</code></pre><p class="fine">${esc(m.best[lang])}</p>`;
    $("#modeInfo .mini").addEventListener("click", async (e) => { try { await navigator.clipboard.writeText(e.target.dataset.c); e.target.textContent = lang === "es" ? "¡copiado!" : "copied!"; } catch { /* clipboard unavailable */ } });
    const head = `<thead><tr><th></th><th>${MODE.lib.tab[lang]}</th><th>${MODE.srv.tab[lang]}</th></tr></thead>`;
    $("#modeTable").innerHTML = head + `<tbody>${ROWS.map(([a, b, c]) => `<tr><th scope="row">${a[lang]}</th><td>${b[lang]}</td><td>${c[lang]}</td></tr>`).join("")}</tbody>`;
  };
  tabs.addEventListener("click", (e) => { const b = e.target.closest("button[data-mode]"); if (!b || b.dataset.mode === mode) return; mode = b.dataset.mode; draw(); });
  draw();
  return { redraw: draw };
}
