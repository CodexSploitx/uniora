// Studio showcase: tabs, auto-cycling screenshots, hotspots, lightbox and a pointer-driven tilt.
import { SPOTS } from "./data.js";
import { $, $$, reduced, fine } from "./fx.js";

export function initStudio({ getLang }) {
  let active = "overview";

  function drawSpots() {
    const screen = $("#deviceScreen");
    $$(".spots", screen).forEach((s) => s.remove());
    const lang = getLang();
    Object.entries(SPOTS).forEach(([shot, list]) => {
      const wrap = document.createElement("div"); wrap.className = "spots" + (shot === active ? " active" : ""); wrap.dataset.shot = shot;
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

  const tabs = $("#studioTabs");
  tabs.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-shot]"); if (!b) return;
    active = b.dataset.shot;
    $$("button", tabs).forEach((x) => x.classList.toggle("active", x === b));
    $$(".shot").forEach((s) => s.classList.toggle("active", s.dataset.shot === active));
    $$(".spots").forEach((s) => s.classList.toggle("active", s.dataset.shot === active));
    const d = $("#device"); d.classList.remove("swap"); void d.offsetWidth; d.classList.add("swap");
  });

  const lb = $("#lightbox");
  $("#zoomBtn").addEventListener("click", () => { const s = $(".shot.active"); $("img", lb).src = s.src; $("img", lb).alt = s.alt; lb.hidden = false; });
  lb.addEventListener("click", () => { lb.hidden = true; });
  addEventListener("keydown", (e) => { if (e.key === "Escape") lb.hidden = true; });

  // auto-cycle until the visitor takes over
  const cycle = setInterval(() => {
    if (reduced || document.hidden) return;
    const list = $$("button", tabs), i = list.findIndex((t) => t.classList.contains("active")), r = $("#device").getBoundingClientRect();
    if (r.top < innerHeight && r.bottom > 0 && !$(".spot.open")) list[(i + 1) % list.length].click();
  }, 4800);
  tabs.addEventListener("pointerdown", () => clearInterval(cycle), { once: true });
  $("#device").addEventListener("pointerdown", () => clearInterval(cycle), { once: true });

  if (fine && !reduced) {
    const dev = $("#device"), stage = $(".studio");
    stage.addEventListener("pointermove", (e) => {
      const r = stage.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      dev.style.transform = `perspective(1400px) rotateY(${x * 8}deg) rotateX(${-y * 5}deg)`;
    });
    stage.addEventListener("pointerleave", () => { dev.style.transform = ""; });
  }
  drawSpots();
  return { redraw: drawSpots };
}
