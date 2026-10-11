// A faithful miniature of @uniora/core's AuthorizationEngine for the landing page.
// Same order of checks and the same reason codes as packages/core/src/authorization/engine.ts:
//   malformed_input → membership_inactive → organization_inactive → permission_denied
// (+ a feature gate for access.check). Owners pass every REGISTERED permission; nobody passes an unregistered one.

const REGISTERED = ["vehicles.read", "vehicles.delete", "assistant.use", "billing.manage"];

const ROLES = {
  owner: { all: true },
  admin: { perms: ["vehicles.read", "vehicles.delete", "assistant.use"] },
  editor: { perms: ["vehicles.read", "assistant.use"] },
  viewer: { perms: ["vehicles.read"] },
};

const PEOPLE = [
  { id: "ana", provider: "supabase", subject: "u_ana", label: "Ana", memberships: { acme: "owner", northwind: "viewer" } },
  { id: "marco", provider: "clerk", subject: "u_marco", label: "Marco", memberships: { acme: "admin" } },
  { id: "lena", provider: "auth0", subject: "u_lena", label: "Lena", memberships: { acme: "editor", northwind: "admin" } },
  { id: "kenji", provider: "better-auth", subject: "u_kenji", label: "Kenji", memberships: { acme: "viewer" } },
  { id: "x", provider: "supabase", subject: "u_stranger", label: { en: "Stranger", es: "Desconocido" }, memberships: {} },
];

const ORGS = [
  { id: "acme", label: "Acme Motors", slug: "acme-motors" },
  { id: "northwind", label: "Northwind Logistics", slug: "northwind-logistics" },
];

const PERMS = [
  { key: "vehicles.read" },
  { key: "vehicles.delete" },
  { key: "assistant.use" },
  { key: "billing.manage" },
  { key: "vehicles.fly", note: { en: "unregistered", es: "no registrado" } },
  { key: "VehiclesDelete", note: { en: "malformed", es: "mal formado" } },
];

const FEATS = [
  { key: null, label: { en: "none", es: "ninguna" } },
  { key: "ai_assistant", label: "ai_assistant" },
  { key: "advanced_reports", label: "advanced_reports" },
];

import { sparks } from "./extras.js";

const L = {
  who: { en: "Identity resolved", es: "Identidad resuelta" },
  wellformed: { en: "Permission key is well-formed", es: "La clave de permiso está bien formada" },
  member: { en: "Membership is not blocked or suspended", es: "La membresía no está bloqueada ni suspendida" },
  org: { en: "Organization is active", es: "La organización está activa" },
  perm: { en: "A role grants the permission", es: "Un rol concede el permiso" },
  feat: { en: "Feature enabled for the organization", es: "Feature habilitada para la organización" },
  ok: { en: "passed", es: "superado" },
  skipped: { en: "skipped", es: "omitido" },
  allowAll: { en: "reason: evaluated", es: "razón: evaluated" },
  owner: { en: "Owner passes every registered permission", es: "El Owner pasa todo permiso registrado" },
  roleHas: { en: (r) => `role “${r}” holds it`, es: (r) => `el rol “${r}” lo tiene` },
  roleLacks: { en: (r) => `role “${r}” doesn't hold it`, es: (r) => `el rol “${r}” no lo tiene` },
  noMember: { en: "no membership found — userId + org alone is never enough", es: "no hay membresía — userId + org por sí solos nunca bastan" },
  blocked: { en: "member is blocked (even an Owner is denied)", es: "el miembro está bloqueado (incluso un Owner es denegado)" },
  suspended: { en: "organization suspended — everyone is denied, Owner included", es: "organización suspendida — todos son denegados, Owner incluido" },
  unreg: { en: "not in the permission catalog — deny, never a silent fallback", es: "no está en el catálogo — deny, nunca un fallback silencioso" },
  malformed: { en: "must be lowercase segments joined by dots", es: "deben ser segmentos en minúscula unidos por puntos" },
  featOff: { en: "the organization hasn't unlocked it", es: "la organización no la ha desbloqueado" },
};

const tx = (v, lang) => (typeof v === "string" ? v : v[lang]);
const WELL = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

export function evaluate(sel, lang) {
  const person = PEOPLE.find((p) => p.id === sel.who);
  const org = ORGS.find((o) => o.id === sel.org);
  const roleKey = person.memberships[org.id] ?? null;
  const steps = [];
  const s = (key, detail) => ({ key, name: tx(L[key], lang), detail });
  let verdict = null;

  const run = (key, ok, passDetail, failDetail, reason) => {
    if (verdict) { steps.push({ ...s(key), status: "skip", detail: tx(L.skipped, lang) }); return; }
    if (ok) steps.push({ ...s(key), status: "ok", detail: passDetail });
    else { steps.push({ ...s(key), status: "fail", detail: failDetail }); verdict = { allowed: false, reason }; }
  };

  steps.push({ ...s("who"), status: "ok", detail: `${person.provider}:${person.subject}` });
  run("wellformed", WELL.test(sel.perm), "", tx(L.malformed, lang), "malformed_input");
  const memberOk = !(roleKey && sel.blocked);
  run("member", memberOk, roleKey ? `role: ${roleKey}` : "—", tx(L.blocked, lang), "membership_inactive");
  run("org", !sel.suspended, "active", tx(L.suspended, lang), "organization_inactive");

  const registered = REGISTERED.includes(sel.perm);
  const role = roleKey ? ROLES[roleKey] : null;
  const grants = !!role && registered && (role.all || role.perms.includes(sel.perm));
  let permPass = "", permFail = "";
  if (!role) permFail = tx(L.noMember, lang);
  else if (!registered) permFail = tx(L.unreg, lang);
  else if (role.all) permPass = tx(L.owner, lang);
  else if (grants) permPass = L.roleHas[lang](roleKey);
  else permFail = L.roleLacks[lang](roleKey);
  run("perm", grants, permPass, permFail, "permission_denied");

  if (sel.feat) run("feat", !!sel.featOn, sel.feat, `${sel.feat}: ${tx(L.featOff, lang)}`, "feature_disabled");

  if (!verdict) verdict = { allowed: true, reason: "evaluated" };
  return { steps, verdict, person, org, roleKey };
}

// tiny highlighter for the equivalent-code box
function hl(code) {
  return code
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/(\/\/.*)$/gm, '<span class="tk-c">$1</span>')
    .replace(/("[^"]*")/g, '<span class="tk-s">$1</span>')
    .replace(/\b(await|const)\b/g, '<span class="tk-k">$1</span>')
    .replace(/\b(can|check)\b(?=\()/g, '<span class="tk-f">$1</span>');
}

export function initPlayground({ getLang }) {
  const $ = (id) => document.getElementById(id);
  const sel = { who: "marco", org: "acme", perm: "vehicles.delete", feat: null, suspended: false, blocked: false, featOn: false };
  const featState = {}; // `${org}:${feat}` → boolean (the chaos switch)
  featState["acme:ai_assistant"] = true;

  const chip = (container, items, current, render, onPick) => {
    container.innerHTML = "";
    items.forEach((it) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (it.id === current ? " active" : "");
      b.innerHTML = render(it);
      b.addEventListener("click", () => onPick(it.id));
      container.appendChild(b);
    });
  };

  function draw() {
    const lang = getLang();
    sel.featOn = sel.feat ? !!featState[`${sel.org}:${sel.feat}`] : false;
    $("swFeature").checked = sel.featOn;
    $("swFeature").disabled = !sel.feat;
    $("swFeature").closest(".switch").style.opacity = sel.feat ? 1 : 0.4;

    chip($("pgWho"), PEOPLE.map((p) => ({ id: p.id, p })), sel.who, (it) => `${tx(it.p.label, lang)}<small>${it.p.provider}</small>`, (id) => { sel.who = id; sel.blocked = false; $("swMember").checked = false; draw(); });
    chip($("pgOrg"), ORGS, sel.org, (o) => o.label, (id) => { sel.org = id; sel.suspended = false; $("swOrg").checked = false; draw(); });
    chip($("pgPerm"), PERMS.map((p) => ({ id: p.key, p })), sel.perm, (it) => `${it.p.key}${it.p.note ? `<small>${tx(it.p.note, lang)}</small>` : ""}`, (id) => { sel.perm = id; draw(); });
    chip($("pgFeat"), FEATS.map((f) => ({ id: f.key ?? "", f })), sel.feat ?? "", (it) => tx(it.f.label, lang), (id) => { sel.feat = id || null; draw(); });

    const r = evaluate(sel, lang);
    const call = sel.feat
      ? `const decision = await uniora.access.check({\n  identity: { provider: "${r.person.provider}", subject: "${r.person.subject}" },\n  organizationId: "${r.org.slug}",\n  permission: "${sel.perm}",\n  feature: "${sel.feat}",\n});`
      : `const allowed = await uniora.can({\n  identity: { provider: "${r.person.provider}", subject: "${r.person.subject}" },\n  organizationId: "${r.org.slug}",\n  permission: "${sel.perm}",\n});`;
    $("pgCode").innerHTML = hl(call);

    const ol = $("pgTrace");
    ol.innerHTML = "";
    r.steps.forEach((st, i) => {
      const li = document.createElement("li");
      li.className = st.status === "fail" ? "fail" : st.status === "skip" ? "skip" : "";
      li.style.animationDelay = `${i * 90}ms`;
      const icon = st.status === "ok" ? "✓" : st.status === "fail" ? "✕" : "–";
      li.innerHTML = `<span class="st">${icon}</span><span class="tn">${st.name}<span class="td">${st.detail ?? ""}</span></span>`;
      ol.appendChild(li);
    });

    const v = $("pgVerdict");
    const was = v.className;
    v.className = "verdict-big " + (r.verdict.allowed ? "allow" : "deny");
    v.querySelector(".vb-word").textContent = r.verdict.allowed ? "ALLOW" : "DENY";
    v.querySelector(".vb-reason").textContent = `reason: ${r.verdict.reason}`;
    if (was.includes("deny") && !r.verdict.allowed) { v.style.animation = "none"; void v.offsetWidth; v.style.animation = ""; }
    if (r.verdict.allowed && !was.includes("allow")) sparks(v);
  }

  $("swOrg").addEventListener("change", (e) => { sel.suspended = e.target.checked; draw(); });
  $("swMember").addEventListener("change", (e) => { sel.blocked = e.target.checked; draw(); });
  $("swFeature").addEventListener("change", (e) => { if (sel.feat) featState[`${sel.org}:${sel.feat}`] = e.target.checked; draw(); });

  draw();
  return { redraw: draw };
}
