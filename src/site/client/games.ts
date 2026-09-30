import type { Opponent, SiteData, SiteGame } from "../data.ts";
import { escapeHtml, int, resultText } from "../format.ts";
import type { Viewer } from "./viewer.ts";

type OutcomeFilter = "all" | "win" | "draw" | "loss";

const OUTCOMES: [OutcomeFilter, string][] = [
  ["all", "All results"],
  ["win", "Jev won"],
  ["draw", "Draw"],
  ["loss", "Jev lost"],
];

function matchesOutcome(g: SiteGame, f: OutcomeFilter): boolean {
  if (f === "all") return true;
  if (g.outcome === "decisive") return f !== "draw";
  return g.outcome === f;
}

export function mountBrowser(root: HTMLElement, data: SiteData, viewer: Viewer, opponents: Map<string, Opponent>) {
  const oppChips = root.querySelector<HTMLElement>('[data-filter="opp"]')!;
  const outChips = root.querySelector<HTMLElement>('[data-filter="outcome"]')!;
  const list = root.querySelector<HTMLElement>(".gamelist")!;
  const count = root.querySelector<HTMLElement>(".gamecount")!;
  let opp = "all";
  let outcome: OutcomeFilter = "all";
  let current = data.games[data.featured] ?? data.games[0];

  const counts = new Map<string, number>();
  for (const g of data.games) counts.set(g.opp, (counts.get(g.opp) ?? 0) + 1);
  const chip = (value: string, label: string, n?: number) =>
    `<button type="button" class="chip" data-v="${escapeHtml(value)}" aria-pressed="false">${escapeHtml(label)}${n !== undefined ? `<span class="chip-n">${n}</span>` : ""}</button>`;
  oppChips.innerHTML = chip("all", "All opponents", data.games.length) + data.opponents.map((o) => chip(o.key, o.group === "jev" ? "Itself" : o.label, counts.get(o.key))).join("");
  outChips.innerHTML = OUTCOMES.map(([v, l]) => chip(v, l)).join("");

  const sync = () => {
    oppChips.querySelectorAll<HTMLElement>(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.v === opp)));
    outChips.querySelectorAll<HTMLElement>(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.v === outcome)));
  };

  const render = () => {
    const shown = data.games.filter((g) => (opp === "all" || g.opp === opp) && matchesOutcome(g, outcome));
    count.textContent = `${int(shown.length)} ${shown.length === 1 ? "game" : "games"}`;
    list.innerHTML = shown.length
      ? shown
          .map((g) => {
            const i = data.games.indexOf(g);
            const o = opponents.get(g.opp);
            const self = g.jev === "wb";
            const tone = self ? "neutral" : g.outcome === "win" ? "good" : g.outcome === "loss" ? "bad" : "neutral";
            const side = self ? "Both sides" : g.jev === "w" ? "Jev as White" : "Jev as Black";
            const meta = [side, `${Math.ceil(g.plies / 2)} moves`, g.opening].filter(Boolean).map((x) => escapeHtml(String(x))).join(" · ");
            const loss = g.acpl !== null ? `<span class="gi-loss">avg loss ${int(g.acpl)}</span>` : "";
            return `<li><button type="button" class="game-item" data-g="${i}" aria-current="${g === current}"><span class="gi-top"><span class="gi-opp">${escapeHtml(self ? "Jev vs itself" : `vs ${o?.label ?? g.opp}`)}</span><span class="gi-res ${tone}">${resultText(g.outcome, g.result, self)}</span></span><span class="gi-meta">${meta}</span>${loss}</button></li>`;
          })
          .join("")
      : `<li class="empty">No games match these filters.</li>`;
  };

  oppChips.addEventListener("click", (e) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>(".chip");
    if (!c) return;
    opp = c.dataset.v!;
    sync();
    render();
  });
  outChips.addEventListener("click", (e) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>(".chip");
    if (!c) return;
    outcome = c.dataset.v as OutcomeFilter;
    sync();
    render();
  });
  list.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".game-item");
    if (!b) return;
    const g = data.games[Number(b.dataset.g)];
    if (!g) return;
    current = g;
    list.querySelectorAll(".game-item").forEach((x) => x.setAttribute("aria-current", String(x === b)));
    viewer.pause();
    viewer.load(g, viewer.firstDecision(g));
    if (window.matchMedia("(max-width: 1099px)").matches) viewer.root.scrollIntoView({ block: "start", behavior: viewer.opts.reduced ? "auto" : "smooth" });
  });

  sync();
  render();
  if (current) viewer.load(current, viewer.firstDecision(current));
}
