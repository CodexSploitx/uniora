// Cost calculator. Every figure below comes from the providers' public pricing pages (checked 2026-10-11):
//   Clerk  https://clerk.com/pricing        Enhanced B2B add-on: $100/mo, 100 monthly retained organizations (MRO) included,
//                                           then $1 (101-1,000), $0.90 (1,001-10,000), $0.75 (10,001-100,000), $0.60 (100,001+) each.
//                                           An MRO is an organization with at least 2 members, one of them retained that month.
//   Auth0  https://auth0.com/pricing        B2B Essentials monthly price by MAU tier (role management is not on the Free plan).
//   Logto  https://logto.io/pricing         Pro plan add-ons: Organizations $48/mo, RBAC $32/mo (flat, independent of MAU or organizations).
//   Descope https://descope.com/pricing     Free: 10 monthly active tenants and 7,500 MAU; Pro from $249/mo (35 tenants); Growth from $799/mo (100 tenants).
// UNIORA's license cost is $0, so what a provider would charge for organizations and roles is the cost avoided.
// Estimates use monthly list prices and assume the volume tiers are graduated.

const CLERK_ENHANCED = 100;
const CLERK_TIERS = [[100, 1000, 1], [1000, 10000, 0.9], [10000, 100000, 0.75], [100000, Infinity, 0.6]];
const AUTH0_ESSENTIALS = [[500, 150], [1000, 300], [2500, 700], [5000, 1300], [10000, 2100], [20000, 3800]];

export function clerkOverage(orgs) {
  return CLERK_TIERS.reduce((sum, [lo, hi, rate]) => sum + Math.max(0, Math.min(orgs, hi) - lo) * rate, 0);
}
export const clerkCost = (orgs) => CLERK_ENHANCED + clerkOverage(orgs);
export const auth0Cost = (idx) => AUTH0_ESSENTIALS[idx][1];
export const LOGTO_COST = 48 + 32;
export function descopeCost(tenants) {
  if (tenants <= 10) return { mo: 0, tier: 0, custom: false };
  if (tenants <= 35) return { mo: 249, tier: 1, custom: false };
  if (tenants <= 100) return { mo: 799, tier: 2, custom: false };
  return { mo: 799, tier: 3, custom: true };
}

const ORG_MIN = 10, ORG_MAX = 5000;
const orgsFromSlider = (v) => Math.round(ORG_MIN * Math.pow(ORG_MAX / ORG_MIN, v / 100) / 5) * 5;

const T = {
  clerk: { en: "Clerk", es: "Clerk" },
  auth0: { en: "Auth0", es: "Auth0" },
  logto: { en: "Logto", es: "Logto" },
  descope: { en: "Descope", es: "Descope" },
  mathClerk: {
    en: (o, base, extra) => `Enhanced B2B add-on $${base}${extra > 0 ? ` + $${fmt(extra)} for ${fmt(o - 100)} organizations above the 100 included` : ` (up to 100 organizations included)`}.`,
    es: (o, base, extra) => `Add-on Enhanced B2B $${base}${extra > 0 ? ` + $${fmt(extra)} por ${fmt(o - 100)} organizaciones sobre las 100 incluidas` : ` (hasta 100 organizaciones incluidas)`}.`,
  },
  mathAuth0: {
    en: (mau) => `B2B Essentials list price at ${fmt(mau)} MAU, the lowest plan with role management. Auth0 prices by MAU, not by organization.`,
    es: (mau) => `Precio de lista de B2B Essentials con ${fmt(mau)} MAU, el plan más bajo con gestión de roles. Auth0 cobra por MAU, no por organización.`,
  },
  mathLogto: {
    en: () => "Organizations add-on $48 + RBAC add-on $32 on the Pro plan. The price is flat: it does not change with users or organizations.",
    es: () => "Add-on Organizations $48 + add-on RBAC $32 en el plan Pro. El precio es fijo: no cambia con los usuarios ni con las organizaciones.",
  },
  mathDescope: {
    en: (o, t) => t === 0 ? `Up to 10 active tenants fit the Free plan, so there is nothing to avoid at this size.` : t === 1 ? `${fmt(o)} active tenants exceed the Free plan (10). Pro, $249/month with annual billing, includes 35. Assumes under 7,500 MAU.` : t === 2 ? `${fmt(o)} active tenants need Growth, $799/month, which includes 100. Assumes under 7,500 MAU.` : `${fmt(o)} active tenants exceed Growth (100). Descope prices that tier by quote, so $799 is the minimum.`,
    es: (o, t) => t === 0 ? `Hasta 10 tenants activos caben en el plan Free, así que a este tamaño no hay nada que evitar.` : t === 1 ? `${fmt(o)} tenants activos superan el plan Free (10). Pro, $249/mes con facturación anual, incluye 35. Supone menos de 7.500 MAU.` : t === 2 ? `${fmt(o)} tenants activos requieren Growth, $799/mes, que incluye 100. Supone menos de 7.500 MAU.` : `${fmt(o)} tenants activos superan Growth (100). Descope cotiza ese nivel a medida, por lo que $799 es el mínimo.`,
  },
  perYear: { en: "per year", es: "al año" },
  chartX: { clerk: { en: "active organizations", es: "organizaciones activas" }, auth0: { en: "monthly active users", es: "usuarios activos mensuales" }, logto: { en: "any size", es: "cualquier tamaño" }, descope: { en: "active tenants", es: "tenants activos" } },
};
let locale = "en-US";
const fmt = (n) => new Intl.NumberFormat(locale, { useGrouping: "always", maximumFractionDigits: 0 }).format(Math.round(n));

export function initSavings({ getLang, reduced }) {
  const $ = (id) => document.getElementById(id);
  const st = { prov: "clerk", mau: 1, orgsV: 45 };
  let shown = 0, raf = 0, animateNext = true;

  function tween(to) {
    cancelAnimationFrame(raf);
    if (reduced) { shown = to; $("svMo").textContent = `$${fmt(to)}${$("svMo").dataset.plus || ""}`; return; }
    const from = shown, t0 = performance.now(), dur = 520;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      shown = from + (to - from) * e; $("svMo").textContent = `$${fmt(shown)}${$("svMo").dataset.plus || ""}`;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  function chart(points, current, maxY, xLabel, animate) {
    const W = 560, H = 230, L = 52, R = 14, Tp = 16, B = 38, w = W - L - R, h = H - Tp - B;
    const x = (i) => L + (points.length === 1 ? 0 : (i / (points.length - 1)) * w);
    const y = (v) => Tp + h - (v / maxY) * h;
    const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
    const area = `${line} L${x(points.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;
    const ticks = [0, 0.5, 1].map((f) => `<g><line x1="${L}" x2="${W - R}" y1="${y(maxY * f)}" y2="${y(maxY * f)}" class="grid"/><text x="${L - 8}" y="${y(maxY * f) + 4}" text-anchor="end">$${fmt(maxY * f)}</text></g>`).join("");
    const xl = points.filter((_, i) => points.length <= 6 || i % Math.ceil(points.length / 6) === 0 || i === points.length - 1)
      .map((p) => `<text x="${x(points.indexOf(p))}" y="${H - 20}" text-anchor="middle">${p.label}</text>`).join("");
    const cx = x(current), cy = y(points[current].v);
    $("svChart").innerHTML = `
      <defs><linearGradient id="svg-a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#efb100" stop-opacity=".35"/><stop offset="1" stop-color="#efb100" stop-opacity="0"/></linearGradient></defs>
      ${ticks}${xl}
      <text x="${L + w / 2}" y="${H - 3}" text-anchor="middle" class="axis">${xLabel}</text>
      <path d="${area}" fill="url(#svg-a)" class="area"/>
      <path d="${line}" class="curve${animate ? " draw" : ""}" pathLength="1"/>
      <line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="uni"/>
      <text x="${W - R}" y="${y(0) - 7}" text-anchor="end" class="unit">UNIORA $0</text>
      <line x1="${cx}" x2="${cx}" y1="${y(0)}" y2="${cy}" class="drop"/>
      <circle cx="${cx}" cy="${cy}" r="6" class="dot"/><circle cx="${cx}" cy="${cy}" r="12" class="halo"/>`;
  }

  function draw() {
    const lang = getLang(); locale = lang === "es" ? "es-ES" : "en-US";
    const p = st.prov;
    const orgs = orgsFromSlider(st.orgsV);
    const mau = AUTH0_ESSENTIALS[st.mau][0];
    const usesOrgs = p === "clerk" || p === "descope", usesMau = p === "auth0";
    $("svOrgsOut").textContent = fmt(orgs);
    $("svMauOut").textContent = fmt(mau);
    $("svMauBox").classList.toggle("off", !usesMau);
    $("svOrgsBox").classList.toggle("off", !usesOrgs);
    $("svMau").disabled = !usesMau; $("svOrgs").disabled = !usesOrgs;

    const prov = $("svProv"); prov.innerHTML = "";
    [["clerk", "Clerk"], ["auth0", "Auth0"], ["logto", "Logto"], ["descope", "Descope"]].forEach(([id, label]) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "chip" + (id === p ? " active" : ""); b.textContent = label;
      b.addEventListener("click", () => { st.prov = id; animateNext = true; draw(); }); prov.appendChild(b);
    });

    let mo, math, custom = false;
    if (p === "clerk") { mo = clerkCost(orgs); math = T.mathClerk[lang](orgs, CLERK_ENHANCED, clerkOverage(orgs)); }
    else if (p === "auth0") { mo = auth0Cost(st.mau); math = T.mathAuth0[lang](mau); }
    else if (p === "logto") { mo = LOGTO_COST; math = T.mathLogto[lang](); }
    else { const d = descopeCost(orgs); mo = d.mo; custom = d.custom; math = T.mathDescope[lang](orgs, d.tier); }
    tween(mo);
    $("svMo").dataset.plus = custom ? "+" : "";
    $("svYr").textContent = `$${fmt(mo * 12)}${custom ? "+" : ""} ${T.perYear[lang]}`;
    $("svMath").textContent = math;
    $("svBarName").textContent = T[p][lang];
    $("svBarProvVal").textContent = `$${fmt(mo)}${custom ? "+" : ""}`;
    $("svBarProv").style.width = mo === 0 ? "3px" : "100%";
    $("svBarU").style.width = "2px";

    const xl = T.chartX[p][lang];
    if (p === "clerk") {
      const pts = Array.from({ length: 41 }, (_, i) => { const o = orgsFromSlider((i / 40) * 100); return { v: clerkCost(o), label: fmt(o) }; });
      chart(pts, Math.round((st.orgsV / 100) * 40), Math.ceil(clerkCost(ORG_MAX) / 1000) * 1000, xl, animateNext);
    } else if (p === "auth0") {
      chart(AUTH0_ESSENTIALS.map(([m, v]) => ({ v, label: fmt(m) })), st.mau, 4000, xl, animateNext);
    } else if (p === "logto") {
      chart([{ v: LOGTO_COST, label: "" }, { v: LOGTO_COST, label: "" }], 0, 100, xl, animateNext);
    } else {
      chart([{ v: 0, label: "≤10" }, { v: 249, label: "≤35" }, { v: 799, label: "≤100" }, { v: 799, label: ">100" }], descopeCost(orgs).tier, 1000, xl, animateNext);
    }
    animateNext = false;
  }

  $("svMau").addEventListener("input", (e) => { st.mau = +e.target.value; draw(); });
  $("svOrgs").addEventListener("input", (e) => { st.orgsV = +e.target.value; draw(); });
  draw();
  return { redraw: draw };
}
