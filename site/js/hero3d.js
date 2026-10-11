// The 3D scene behind the whole page.
// A shielded core (the AuthorizationEngine) surrounded by organization nodes. Requests fly in from the
// nodes: allowed ones (emerald) pass the shield and reach the core, denied ones (red) bounce off it.
import * as THREE from "../vendor/three.module.min.js";

const AMBER = 0xefb100;
const EMERALD = 0x00bc7d;
const RED = 0xff6467;
const VIOLET = 0x8e51ff;

function glowTexture(inner = "rgba(255,255,255,1)", outer = "rgba(255,255,255,0)") {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.25, "rgba(255,255,255,.55)");
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function fibonacciSphere(n, radius, jitter = 0) {
  const pts = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const t = golden * i;
    const k = radius * (1 + (Math.random() - 0.5) * jitter);
    pts.push(new THREE.Vector3(Math.cos(t) * r * k, y * k, Math.sin(t) * r * k));
  }
  return pts;
}

export function initScene(canvas, { reduced = false, onDecision } = {}) {
  const small = Math.min(innerWidth, innerHeight) < 700;
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: !small, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, small ? 1.5 : 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  camera.position.set(0, 0, 11);

  const root = new THREE.Group();
  scene.add(root);

  const sprite = glowTexture();
  const additive = { blending: THREE.AdditiveBlending, depthWrite: false, transparent: true };

  // ── core ──
  const core = new THREE.Group();
  root.add(core);
  const coreSolid = new THREE.Mesh(new THREE.OctahedronGeometry(0.62, 0), new THREE.MeshBasicMaterial({ color: AMBER }));
  core.add(coreSolid);
  const coreWire = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.05, 1)), new THREE.LineBasicMaterial({ color: AMBER, ...additive, opacity: 0.9 }));
  core.add(coreWire);
  const coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: sprite, color: AMBER, ...additive, opacity: 0.75 }));
  coreGlow.scale.setScalar(5.2);
  core.add(coreGlow);

  // ── shield (fresnel shell + faint lattice) ──
  const shieldR = 2.35;
  const shield = new THREE.Mesh(
    new THREE.IcosahedronGeometry(shieldR, 3),
    new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(AMBER) }, uPulse: { value: 0 } },
      vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
      fragmentShader: `uniform vec3 uColor; uniform float uPulse; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(vN,vV)), 2.6); gl_FragColor = vec4(uColor, f*(0.55+uPulse*0.9)); }`,
      ...additive, side: THREE.DoubleSide,
    })
  );
  root.add(shield);
  const lattice = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(shieldR * 1.002, 2)), new THREE.LineBasicMaterial({ color: AMBER, ...additive, opacity: 0.07 }));
  root.add(lattice);

  // ── rings ──
  const rings = [];
  [[3.3, 0.35, 0.2], [4.4, -0.9, 0.5], [5.6, 1.2, -0.3]].forEach(([r, rx, rz], i) => {
    const ring = new THREE.Mesh(new THREE.RingGeometry(r, r + 0.012, 160), new THREE.MeshBasicMaterial({ color: i === 1 ? VIOLET : AMBER, ...additive, opacity: 0.22, side: THREE.DoubleSide }));
    ring.rotation.set(Math.PI / 2 + rx, 0, rz);
    ring.userData.speed = 0.04 + i * 0.03;
    root.add(ring);
    rings.push(ring);
  });

  // ── organization nodes ──
  const N = small ? 26 : 44;
  const nodePos = fibonacciSphere(N, 5.2, 0.2);
  const nodes = new THREE.Group();
  root.add(nodes);
  const nodeMat = new THREE.MeshBasicMaterial({ color: 0xfafafa });
  nodePos.forEach((p, i) => {
    const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.06 + Math.random() * 0.06, 0), nodeMat.clone());
    m.material.color.set(i % 7 === 0 ? AMBER : i % 5 === 0 ? VIOLET : 0xd4d4d8);
    m.position.copy(p);
    m.userData.phase = Math.random() * Math.PI * 2;
    nodes.add(m);
    const g = new THREE.Sprite(new THREE.SpriteMaterial({ map: sprite, color: m.material.color, ...additive, opacity: 0.35 }));
    g.scale.setScalar(0.65);
    m.add(g);
  });
  // spokes to the core + a mesh between close neighbours
  const spokeVerts = [];
  nodePos.forEach((p) => spokeVerts.push(0, 0, 0, p.x, p.y, p.z));
  const spokes = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(spokeVerts, 3)), new THREE.LineBasicMaterial({ color: AMBER, ...additive, opacity: 0.1 }));
  root.add(spokes);
  const meshVerts = [];
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) if (nodePos[i].distanceTo(nodePos[j]) < 2.5) meshVerts.push(nodePos[i].x, nodePos[i].y, nodePos[i].z, nodePos[j].x, nodePos[j].y, nodePos[j].z);
  const mesh = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(meshVerts, 3)), new THREE.LineBasicMaterial({ color: VIOLET, ...additive, opacity: 0.1 }));
  root.add(mesh);

  // ── request packets ──
  const P = small ? 50 : 90;
  const pPos = new Float32Array(P * 3);
  const pCol = new Float32Array(P * 3);
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute("color", new THREE.BufferAttribute(pCol, 3));
  const packets = new THREE.Points(pGeo, new THREE.PointsMaterial({ size: 0.26, map: sprite, vertexColors: true, ...additive, sizeAttenuation: true }));
  packets.frustumCulled = false;
  root.add(packets);
  const state = Array.from({ length: P }, () => ({ node: 0, t: -Math.random() * 4, speed: 0.25, deny: false, done: false }));
  const cEm = new THREE.Color(EMERALD), cRed = new THREE.Color(RED);
  function respawn(s, forceNode, forceDeny) {
    s.node = forceNode ?? (Math.random() * N) | 0;
    s.deny = forceDeny ?? Math.random() < 0.22;
    s.speed = 0.22 + Math.random() * 0.2;
    s.t = 0;
    s.done = false;
  }
  state.forEach((s) => respawn(s));
  let shieldPulse = 0;
  const tmp = new THREE.Vector3();

  function updatePackets(dt) {
    for (let i = 0; i < P; i++) {
      const s = state[i];
      s.t += dt * s.speed;
      let k; // 0 = at node, 1 = at core
      if (s.t < 0) k = 0;
      else if (s.deny) {
        // goes in until it meets the shield, then bounces back out
        const hit = (5.2 - shieldR) / 5.2; // fraction of the way in where the shield sits
        const u = Math.min(s.t, 2) ;
        k = u < 1 ? u * hit : Math.max(0, hit * (2 - u));
        if (!s.done && u >= 1) { s.done = true; shieldPulse = Math.min(1, shieldPulse + 0.55); onDecision?.(false, s.node); }
        if (u >= 2) respawn(s);
      } else {
        k = Math.min(s.t, 1);
        if (!s.done && s.t >= 1) { s.done = true; shieldPulse = Math.min(1, shieldPulse + 0.25); onDecision?.(true, s.node); }
        if (s.t >= 1.15) respawn(s);
      }
      const p = nodePos[s.node];
      tmp.copy(p).multiplyScalar(1 - k);
      pPos[i * 3] = tmp.x; pPos[i * 3 + 1] = tmp.y; pPos[i * 3 + 2] = tmp.z;
      const col = s.deny ? cRed : cEm;
      const a = s.t < 0 ? 0 : 1;
      pCol[i * 3] = col.r * a; pCol[i * 3 + 1] = col.g * a; pCol[i * 3 + 2] = col.b * a;
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.color.needsUpdate = true;
  }

  // ── starfield ──
  const SC = small ? 500 : 1400;
  const sPos = new Float32Array(SC * 3);
  for (let i = 0; i < SC; i++) {
    const r = 18 + Math.random() * 40, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
    sPos[i * 3] = r * Math.sin(ph) * Math.cos(th); sPos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th); sPos[i * 3 + 2] = r * Math.cos(ph);
  }
  const stars = new THREE.Points(new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(sPos, 3)), new THREE.PointsMaterial({ size: 0.11, map: sprite, color: 0xffe9a8, ...additive, opacity: 0.7 }));
  scene.add(stars);

  // ── interaction state ──
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  addEventListener("pointermove", (e) => { pointer.tx = (e.clientX / innerWidth) * 2 - 1; pointer.ty = (e.clientY / innerHeight) * 2 - 1; }, { passive: true });
  let scrollY = scrollY0();
  function scrollY0() { return window.scrollY || 0; }
  addEventListener("scroll", () => { scrollY = scrollY0(); }, { passive: true });

  function burst() {
    let n = 0;
    for (const s of state) if (n < 16 && (s.t < 0 || s.t > 0.9 || s.done)) { respawn(s, (Math.random() * N) | 0, Math.random() < 0.2); n++; }
  }

  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  addEventListener("resize", resize);
  resize();

  // ── loop ──
  const clock = new THREE.Clock();
  let frame = 0, running = true, rootX = 0;
  document.addEventListener("visibilitychange", () => { running = !document.hidden; if (running) loop(); });

  function render(dt, time) {
    const vh = innerHeight;
    const prog = scrollY / vh; // scroll progress in viewport heights
    pointer.x += (pointer.tx - pointer.x) * 0.05;
    pointer.y += (pointer.ty - pointer.y) * 0.05;

    // desktop: push the scene to the right so the headline owns the left; wander as you scroll
    const wide = innerWidth > 1020;
    const targetX = wide ? 2.9 * Math.cos(prog * 0.9) - Math.min(prog, 4) * 0.6 : 0;
    rootX += (targetX - rootX) * 0.06;
    root.position.x = rootX;
    root.position.y = (wide ? 0 : 3.4) + Math.sin(prog * 1.2) * 0.6 + prog * 0.25;
    const s = wide ? 1 : 0.6;
    root.scale.setScalar(s * (1 + Math.min(prog, 3) * 0.06));
    root.rotation.y = time * 0.07 + pointer.x * 0.45 + prog * 0.9;
    root.rotation.x = pointer.y * 0.22 + Math.sin(prog) * 0.3;
    camera.position.z = 11 + Math.min(prog, 6) * 0.5;
    stars.rotation.y = time * 0.008 + prog * 0.05;
    stars.rotation.x = prog * 0.03;

    core.rotation.y = -time * 0.5; core.rotation.x = time * 0.3;
    const beat = 1 + Math.sin(time * 2.2) * 0.04 + shieldPulse * 0.18;
    core.scale.setScalar(beat);
    coreGlow.material.opacity = 0.55 + shieldPulse * 0.4 + Math.sin(time * 2.2) * 0.08;
    shieldPulse *= Math.pow(0.04, dt);
    shield.material.uniforms.uPulse.value = shieldPulse;
    lattice.rotation.y = time * 0.05;
    rings.forEach((r, i) => { r.rotation.z += r.userData.speed * dt * (i % 2 ? -1 : 1); });
    nodes.children.forEach((n) => { const sc = 1 + Math.sin(time * 1.6 + n.userData.phase) * 0.25; n.scale.setScalar(sc); n.rotation.y += dt; });
    updatePackets(dt);

    // the canvas fades as content takes over, but never disappears
    canvas.style.opacity = String(Math.max(0.24, (wide ? 1 : 0.85) - prog * (wide ? 0.55 : 0.8)));
    renderer.render(scene, camera);
  }

  function loop() {
    if (!running) return;
    requestAnimationFrame(loop);
    frame++;
    const dt = Math.min(clock.getDelta(), 0.05);
    if (scrollY > innerHeight * 3 && frame % 2) return; // far from the hero: half rate
    render(dt, clock.elapsedTime);
  }

  if (reduced) { for (let i = 0; i < 60; i++) updatePackets(0.05); render(0.016, 3); }
  else loop();

  return { burst, dispose: () => { running = false; renderer.dispose(); } };
}
