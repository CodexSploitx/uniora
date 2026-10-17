// Hero: laser background, scaled product mock-up, live "decision" ticker and little loops that make it feel alive.
import { initLasers } from "./lasers.js";
import { $, $$, reduced, fine } from "./fx.js";

const WHO = ["supabase:u_ana", "clerk:u_marco", "auth0:u_lena", "better-auth:u_kenji", "supabase:u_91f2", "clerk:u_ops"];
const ORG = ["acme", "northwind", "globex", "initech"];
const PRM = ["vehicles.read", "vehicles.delete", "members.invite", "reports.export", "billing.manage"];

export function initHero() {
  const hero = $("#hero");
  const lasers = initLasers($("#lasersHero"), { seed: 11, density: 1.15, focus: { x: 0.74, y: 0.5 }, calmLeft: 0.4, intensity: 1, reduced });

  // scale the 760×620 mock-up to whatever width the column has
  const hv = $("#hv");
  const fit = () => { const s = Math.min(1.12, hv.clientWidth / 760); hv.style.setProperty("--s", s.toFixed(3)); };
  new ResizeObserver(fit).observe(hv); fit();

  // live decision ticker
  const list = $("#tickerList");
  const r = (a) => a[(Math.random() * a.length) | 0];
  const push = (allowed) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>can(${r(WHO).split(":")[1]}, ${r(ORG)}, ${r(PRM)})</span><span class="v ${allowed ? "allow" : "deny"}">${allowed ? "ALLOW" : "DENY"}</span>`;
    list.appendChild(li);
    while (list.children.length > 4) list.firstChild.remove();
  };
  for (let i = 0; i < 4; i++) push(i !== 2);
  let visible = true;
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; }).observe(hero);
  if (!reduced) setInterval(() => { if (visible && !document.hidden) push(Math.random() > 0.22); }, 1100);

  // loops inside the mock-up: the highlighted organization / permission rotates, user counts tick up
  const orgs = $$("#hvOrgs li"), perms = $$("#hvPerms li");
  let oi = 0, pi = 0;
  if (!reduced) {
    setInterval(() => { if (!visible) return; orgs[oi].classList.remove("hot"); oi = (oi + 1) % orgs.length; orgs[oi].classList.add("hot"); }, 2300);
    setInterval(() => { if (!visible) return; perms[pi].classList.remove("on"); pi = (pi + 1) % perms.length; perms[pi].classList.add("on"); }, 1700);
    setInterval(() => {
      if (!visible) return;
      const em = $$("#hvOrgs em")[(Math.random() * orgs.length) | 0];
      em.textContent = String(+em.textContent + 1);
    }, 3100);
  }

  // pointer: tilt the stage; click anywhere on the hero for a burst of laser pulses
  if (fine && !reduced) {
    const stage = $("#hvStage");
    hero.addEventListener("pointermove", (e) => {
      const b = hero.getBoundingClientRect(), x = (e.clientX - b.left) / b.width - 0.5, y = (e.clientY - b.top) / b.height - 0.5;
      stage.style.setProperty("--ry", `${-15 + x * 10}deg`); stage.style.setProperty("--rx", `${6 - y * 8}deg`);
    }, { passive: true });
    hero.addEventListener("pointerleave", () => { stage.style.removeProperty("--ry"); stage.style.removeProperty("--rx"); });
  }
  hero.addEventListener("pointerdown", (e) => {
    if (e.target.closest("a, button, .install")) return;
    lasers.burst(); for (let i = 0; i < 4; i++) setTimeout(() => push(Math.random() > 0.2), i * 140);
  });
  return lasers;
}
