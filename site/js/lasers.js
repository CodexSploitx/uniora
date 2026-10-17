// Gold "laser" circuit traces for the dark sections.
// 1. Isometric traces are drawn in (stroke-dash style) when the section first shows.
// 2. Bright laser pulses with glowing tails then race along them, forever.
// Canvas 2D only (no WebGL), paused off-screen and in background tabs, static under prefers-reduced-motion.

const GOLD = [247, 195, 37];
const HOT = [255, 236, 170];
const ANGLES = [30, 90, 150, 210, 270, 330].map((d) => (d * Math.PI) / 180); // isometric grid directions

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const ease = (t) => 1 - Math.pow(1 - t, 3);

function buildPaths(w, h, o, rand) {
  const area = (w * h) / 38000;
  const count = Math.max(10, Math.round(area * o.density));
  const diag = Math.hypot(w, h);
  const fx = o.focus.x * w, fy = o.focus.y * h;
  const paths = [];
  for (let i = 0; i < count; i++) {
    // start points are biased towards the focus so the busiest area frames the content
    const bias = rand() < 0.62;
    let x = bias ? fx + (rand() - 0.5) * w * 0.9 : rand() * w;
    let y = bias ? fy + (rand() - 0.5) * h * 1.1 : rand() * h;
    let ai = (rand() * 6) | 0;
    const pts = [[x, y]];
    const segs = 3 + ((rand() * 4) | 0);
    for (let s = 0; s < segs; s++) {
      const len = 90 + rand() * 260;
      x += Math.cos(ANGLES[ai]) * len;
      y += Math.sin(ANGLES[ai]) * len;
      pts.push([x, y]);
      ai = (ai + (rand() < 0.5 ? 1 : 5) + (rand() < 0.12 ? 1 : 0)) % 6; // turn ±60° (rarely ±120°)
    }
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const d = Math.hypot(mx - fx, my - fy) / diag;
    let weight = 0.3 + 0.7 * Math.exp(-(d * d) / (2 * 0.3 * 0.3));
    if (o.calmLeft && mx < w * o.calmLeft) weight *= 0.45; // keep the headline readable
    const lasers = [];
    const n = 1 + (rand() < 0.45 ? 1 : 0);
    for (let k = 0; k < n; k++) lasers.push({ s: rand() * cum[cum.length - 1], v: 150 + rand() * 260, tail: 110 + rand() * 190, pause: 0, hot: rand() < 0.25 });
    paths.push({ pts, cum, total: cum[cum.length - 1], weight, delay: rand() * 1.6 + d * 1.4, dur: 1.1 + rand() * 1.1, lasers });
  }
  return paths;
}

// the polyline between arc-length a and b of a path
function slice(p, a, b) {
  const out = [];
  const at = (s) => {
    let k = 1;
    while (k < p.cum.length - 1 && p.cum[k] < s) k++;
    const t = (s - p.cum[k - 1]) / (p.cum[k] - p.cum[k - 1] || 1);
    return [p.pts[k - 1][0] + (p.pts[k][0] - p.pts[k - 1][0]) * t, p.pts[k - 1][1] + (p.pts[k][1] - p.pts[k - 1][1]) * t];
  };
  out.push(at(a));
  for (let k = 1; k < p.pts.length - 1; k++) if (p.cum[k] > a && p.cum[k] < b) out.push(p.pts[k]);
  out.push(at(b));
  return out;
}

export function initLasers(canvas, options = {}) {
  const o = { seed: 7, density: 1, focus: { x: 0.72, y: 0.45 }, calmLeft: 0, intensity: 1, reduced: false, parallax: 14, k: 1, ...options };
  const ctx = canvas.getContext("2d");
  let w = 0, h = 0, dpr = 1, paths = [], raf = 0, running = false, visible = true, t0 = 0, last = 0;
  const ptr = { x: 0, y: 0, tx: 0, ty: 0, on: false, px: 0, py: 0 };

  function size() {
    const r = canvas.getBoundingClientRect();
    w = Math.max(1, r.width); h = Math.max(1, r.height); o.k = w < 700 ? 0.55 : 1; // calmer on phones: the text spans the whole width
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paths = buildPaths(w, h, o, rng(o.seed));
  }

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now;
    const t = (now - t0) / 1000;
    draw(t, dt);
    raf = requestAnimationFrame(frame);
  }

  function draw(t, dt) {
    ptr.px += (ptr.tx - ptr.px) * 0.06; ptr.py += (ptr.ty - ptr.py) * 0.06;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(ptr.px * o.parallax, ptr.py * o.parallax);
    ctx.lineJoin = "round"; ctx.lineCap = "round";

    // 1 · the traces (drawn in once, then idle with a slow shimmer)
    ctx.globalCompositeOperation = "source-over";
    for (const p of paths) {
      const k = o.reduced ? 1 : ease(Math.min(1, Math.max(0, (t - p.delay) / p.dur)));
      if (k <= 0) continue;
      const shimmer = 0.85 + 0.15 * Math.sin(t * 0.8 + p.total);
      ctx.strokeStyle = rgba(GOLD, 0.2 * p.weight * shimmer * (o.intensity * o.k));
      ctx.lineWidth = 1;
      ctx.beginPath();
      const poly = k >= 1 ? p.pts : slice(p, 0, p.total * k);
      ctx.moveTo(poly[0][0], poly[0][1]);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
      ctx.stroke();
      // the leading edge of a trace that is still being drawn glows
      if (k < 1) {
        const e = poly[poly.length - 1];
        ctx.fillStyle = rgba(HOT, 0.9 * p.weight);
        ctx.beginPath(); ctx.arc(e[0], e[1], 2.2, 0, 7); ctx.fill();
      }
      if (k >= 1) {
        ctx.fillStyle = rgba(GOLD, 0.45 * p.weight * (o.intensity * o.k));
        for (let i = 0; i < p.pts.length; i += 1) { ctx.beginPath(); ctx.arc(p.pts[i][0], p.pts[i][1], 1.6, 0, 7); ctx.fill(); }
      }
    }

    // 2 · the lasers
    ctx.globalCompositeOperation = "lighter";
    for (const p of paths) {
      if (!o.reduced && t < p.delay + p.dur) continue;
      for (const L of p.lasers) {
        if (!o.reduced) {
          if (L.pause > 0) { L.pause -= dt; continue; }
          L.s += L.v * dt;
          if (L.s - L.tail > p.total) { L.s = 0; L.pause = 0.2 + Math.random() * 2.2; continue; }
        }
        const head = Math.min(L.s, p.total), tail = Math.max(0, L.s - L.tail);
        if (head - tail < 2) continue;
        const poly = slice(p, tail, head);
        const a = poly[0], b = poly[poly.length - 1];
        const g = ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
        const c = L.hot ? HOT : GOLD, wgt = Math.min(1, p.weight + 0.25) * (o.intensity * o.k);
        g.addColorStop(0, rgba(c, 0)); g.addColorStop(1, rgba(c, 1 * wgt));
        const g2 = ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
        g2.addColorStop(0, rgba(GOLD, 0)); g2.addColorStop(1, rgba(GOLD, 0.32 * wgt));
        for (const [style, lw] of [[g2, 7], [g, 1.7]]) {
          ctx.strokeStyle = style; ctx.lineWidth = lw;
          ctx.beginPath(); ctx.moveTo(poly[0][0], poly[0][1]);
          for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
          ctx.stroke();
        }
        // glowing head
        const r = L.hot ? 15 : 11;
        const rg = ctx.createRadialGradient(b[0], b[1], 0, b[0], b[1], r);
        rg.addColorStop(0, rgba(HOT, 0.95 * wgt)); rg.addColorStop(0.35, rgba(GOLD, 0.45 * wgt)); rg.addColorStop(1, rgba(GOLD, 0));
        ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(b[0], b[1], r, 0, 7); ctx.fill();
      }
    }

    // 3 · a soft light that follows the pointer
    if (ptr.on) {
      const rg = ctx.createRadialGradient(ptr.x, ptr.y, 0, ptr.x, ptr.y, 220);
      rg.addColorStop(0, rgba(GOLD, 0.1 * (o.intensity * o.k))); rg.addColorStop(1, rgba(GOLD, 0));
      ctx.fillStyle = rg; ctx.fillRect(ptr.x - 220, ptr.y - 220, 440, 440);
    }
    ctx.restore();
    ctx.globalCompositeOperation = "source-over";
  }

  function start() {
    if (running || o.reduced || !visible || document.hidden) return;
    running = true; last = performance.now();
    if (!t0) t0 = last;
    raf = requestAnimationFrame(frame);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }

  size();
  if (o.reduced) { draw(99, 0); } else { t0 = performance.now(); }

  new ResizeObserver(() => { size(); if (o.reduced) draw(99, 0); }).observe(canvas);
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; visible ? start() : stop(); }, { rootMargin: "80px" }).observe(canvas);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));

  const host = canvas.parentElement;
  host.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    ptr.x = e.clientX - r.left; ptr.y = e.clientY - r.top; ptr.on = true;
    ptr.tx = (ptr.x / r.width - 0.5) * -2; ptr.ty = (ptr.y / r.height - 0.5) * -2;
  }, { passive: true });
  host.addEventListener("pointerleave", () => { ptr.on = false; ptr.tx = 0; ptr.ty = 0; });

  start();
  return {
    // a burst of extra pulses: every laser restarts at the beginning of its trace
    burst() { for (const p of paths) for (const L of p.lasers) { L.s = 0; L.pause = Math.random() * 0.35; L.v *= 1.0; } },
    stop, start,
  };
}
