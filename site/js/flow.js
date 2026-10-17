// "How it works": a request travels identity provider → UNIORA → authorization → your app.
// It plays on its own while visible, and the visitor can send an allowed or a denied request.
import { RT } from "./i18n.js";
import { $, $$, reduced } from "./fx.js";

export function initFlow({ getLang }) {
  const root = $("#flow"); if (!root) return { redraw() {} };
  const nodes = $$(".fnode", root), wires = $$(".fwire", root), verdict = $("#flowVerdict"), log = $("#flowLog"), core = $("#flowCore");
  const ctl = $$(".flow-ctl .chip");
  let running = false, visible = false, manual = false, timer = 0, lastKind = null;
  const wait = (ms) => new Promise((r) => setTimeout(r, reduced ? Math.min(ms, 60) : ms));
  const t = (o) => o[getLang()];

  function paint(kind) {
    const word = kind === "allow" ? "ALLOW" : kind === "deny" ? "DENY" : "";
    log.innerHTML = kind ? RT[kind === "allow" ? "flowAllow" : "flowDeny"][getLang()](t(kind === "allow" ? RT.flowOk : RT.flowNo)) : t(RT.flowIdle);
    verdict.textContent = word;
  }

  function reset() {
    nodes.forEach((n) => n.classList.remove("lit", "denied", "blocked"));
    wires.forEach((w) => w.classList.remove("go", "bad"));
    verdict.classList.remove("show", "bad");
  }

  async function run(kind) {
    if (running) return; running = true; lastKind = kind;
    reset(); paint(null);
    ctl.forEach((c) => c.classList.toggle("active", c.dataset.send === kind));
    nodes[0].classList.add("lit"); await wait(450);
    wires[0].classList.add("go"); await wait(650);
    core.classList.add("lit"); await wait(500);
    if (kind === "deny") {
      core.classList.remove("lit"); core.classList.add("denied");
      verdict.classList.add("show", "bad"); paint("deny");
      wires[1].classList.add("go", "bad"); nodes[2].classList.add("blocked"); nodes[3].classList.add("blocked");
      await wait(1800);
    } else {
      wires[1].classList.add("go"); await wait(650);
      nodes[2].classList.add("lit"); await wait(450);
      wires[2].classList.add("go"); await wait(650);
      nodes[3].classList.add("lit");
      verdict.classList.add("show"); paint("allow"); await wait(1800);
    }
    running = false;
    if (!manual && visible) timer = setTimeout(() => run(lastKind === "allow" && Math.random() < 0.4 ? "deny" : "allow"), 900);
  }

  ctl.forEach((c) => c.addEventListener("click", () => { manual = true; clearTimeout(timer); const go = () => (running ? setTimeout(go, 120) : run(c.dataset.send)); go(); }));
  new IntersectionObserver((es) => {
    visible = es[0].isIntersecting;
    if (visible && !running && !manual) run("allow");
    if (!visible) clearTimeout(timer);
  }, { threshold: 0.35 }).observe(root);

  paint(null);
  return { redraw() { paint(running ? null : lastKind); } };
}
