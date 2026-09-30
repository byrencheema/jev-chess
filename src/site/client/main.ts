import type { Opponent, SiteData } from "../data.ts";
import { mountBrowser } from "./games.ts";
import { mountPuzzles } from "./puzzles.ts";
import { Viewer } from "./viewer.ts";

const data = JSON.parse(document.getElementById("site-data")!.textContent!) as SiteData;
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const opponents = new Map<string, Opponent>(data.opponents.map((o) => [o.key, o]));

const heroRoot = document.getElementById("hero-viewer")!;
const gameRoot = document.getElementById("game-viewer")!;
const hero = new Viewer(heroRoot, { full: false, auto: true, reduced, opponents });
const browser = new Viewer(gameRoot, { full: true, auto: false, reduced, opponents });

const featured = data.games[data.featured];
if (featured) {
  if (reduced) {
    const k = featured.j.findIndex((x, i) => x !== null && i >= featured.book + 10);
    hero.load(featured, k >= 0 ? k : featured.book);
  } else {
    hero.load(featured, hero.firstDecision(featured));
    hero.play();
  }
} else heroRoot.hidden = true;

mountBrowser(document.getElementById("games")!, data, browser, opponents);
mountPuzzles(document.getElementById("puzzles")!, data);

function visibleShare(el: HTMLElement): number {
  const r = el.getBoundingClientRect();
  const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
  return Math.max(0, h) / Math.max(1, Math.min(r.height, window.innerHeight));
}

let active: Viewer | null = null;
heroRoot.addEventListener("pointerdown", () => (active = hero));
gameRoot.addEventListener("pointerdown", () => (active = browser));
document.getElementById("games")!.addEventListener("focusin", () => (active = browser));

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target as HTMLElement;
  if (t.closest("input, textarea, select, [contenteditable], .waffle")) return;
  const candidates = [hero, browser].filter((v) => visibleShare(v.anchor) > 0.35);
  const v = active && candidates.includes(active) ? active : candidates.sort((a, b) => visibleShare(b.anchor) - visibleShare(a.anchor))[0];
  if (!v) return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    v.pause();
    v.step(e.key === "ArrowRight" ? 1 : -1);
  } else if (e.key === " " && !t.closest(".controls button, a, .chip")) {
    e.preventDefault();
    v.toggle();
  }
});
