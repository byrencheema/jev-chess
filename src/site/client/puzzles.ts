import type { SiteData, SitePuzzle } from "../data.ts";
import { escapeHtml, promptName, themeName } from "../format.ts";
import { Board, type Arrow } from "./board.ts";
import { renderProbs, type ProbRow } from "./probs.ts";
import { checkSquare, squaresOf } from "./replay.ts";

function state(p: SitePuzzle): "solved" | "first" | "failed" {
  return p.solved ? "solved" : p.first ? "first" : "failed";
}

function statusText(p: SitePuzzle): string {
  if (p.solved) return p.steps.length > 1 ? `Solved, all ${p.steps.length} moves.` : "Solved.";
  const at = p.steps.findIndex((s) => !s.ok);
  if (at > 0) return `First move right, then missed move ${at + 1} of ${Math.max(p.moves, at + 1)}.`;
  return "Failed on the first move.";
}

export function mountPuzzles(root: HTMLElement, data: SiteData) {
  const waffle = root.querySelector<HTMLElement>(".waffle")!;
  const detail = root.querySelector<HTMLElement>(".puzzle-detail")!;
  const puzzles = data.puzzles;
  if (!puzzles.length) {
    root.hidden = true;
    return;
  }
  const bands = new Map<number, number[]>();
  puzzles.forEach((p, i) => {
    const b = Math.floor(p.rating / data.puzzleBand) * data.puzzleBand;
    bands.set(b, [...(bands.get(b) ?? []), i]);
  });
  const rank = { solved: 0, first: 1, failed: 2 };
  for (const idx of bands.values()) idx.sort((a, b) => rank[state(puzzles[a]!)] - rank[state(puzzles[b]!)] || puzzles[a]!.rating - puzzles[b]!.rating);
  const widest = Math.max(...[...bands.values()].map((b) => b.length));
  waffle.style.setProperty("--cols-d", String(widest));
  waffle.style.setProperty("--cols-m", String(widest > 25 ? Math.ceil(widest / 2) : widest));
  waffle.innerHTML = [...bands]
    .map(([band, idx]) => {
      const solved = idx.filter((i) => puzzles[i]!.solved).length;
      const cells = idx
        .map((i) => {
          const p = puzzles[i]!;
          return `<button type="button" role="gridcell" class="cell ${state(p)}" data-p="${i}" tabindex="-1" aria-label="Puzzle ${p.id}, rating ${p.rating}, ${state(p) === "first" ? "first move right" : state(p)}"></button>`;
        })
        .join("");
      return `<div class="band" role="row"><span class="band-label" role="rowheader">${band}</span><span class="band-cells">${cells}</span><span class="band-n">${solved}/${idx.length}</span></div>`;
    })
    .join("");

  detail.innerHTML = `<div class="pd-head"><p class="pd-title"></p><p class="pd-status"></p></div>
<div class="pd-board"></div>
<p class="legend pd-legend"><span class="li"><span class="key key-jev" aria-hidden="true"></span>Jev's top 3</span><span class="li"><span class="key key-good" aria-hidden="true"></span>Solution</span></p>
<div class="pd-steps" role="group" aria-label="Moves in this puzzle"></div>
<p class="probs-cap">Jev's options</p>
<ol class="probs"></ol>
<p class="pd-alt"></p>
<p class="pd-link"></p>`;
  const board = new Board(detail.querySelector<HTMLElement>(".pd-board")!);
  const cells = Array.from(waffle.querySelectorAll<HTMLElement>(".cell"));
  let sel = -1;
  let step = 0;

  const show = () => {
    const p = puzzles[sel]!;
    const s = p.steps[step];
    detail.querySelector(".pd-title")!.innerHTML = `<span class="pd-rating">${p.rating}</span> ${escapeHtml(p.themes.slice(0, 3).map(themeName).join(", "))}`;
    const st = detail.querySelector<HTMLElement>(".pd-status")!;
    st.textContent = statusText(p);
    st.className = `pd-status ${state(p)}`;
    detail.querySelector(".pd-steps")!.innerHTML =
      p.steps.length > 1
        ? p.steps.map((x, i) => `<button type="button" class="chip step ${x.ok ? "ok" : "miss"}" data-s="${i}" aria-pressed="${i === step}">Move ${i + 1}</button>`).join("")
        : "";
    if (!s) {
      renderProbs(detail.querySelector(".probs")!, [], "This puzzle ended in an error.");
      return;
    }
    board.setFlipped(s.fen.split(" ")[1] === "b");
    const arrows: Arrow[] = [];
    for (const [san, pr] of s.t.slice(0, 3)) {
      const sq = squaresOf(s.fen, san);
      if (sq) arrows.push({ ...sq, kind: "jev", weight: pr });
    }
    const sol = squaresOf(s.fen, s.want);
    if (sol) arrows.push({ ...sol, kind: "good", weight: 1 });
    board.set(s.fen, { arrows, check: checkSquare(s.fen), animate: false });
    const rows: ProbRow[] = s.t.map(([san, pr]) => ({
      san,
      p: pr,
      chosen: san === s.san,
      tags: [...(san === s.san ? [{ text: "picked", tone: s.ok ? ("good" as const) : ("bad" as const) }] : []), ...(san === s.want ? [{ text: "solution", tone: "good" as const }] : [])],
    }));
    const inTop = s.t.some(([san]) => san === s.want);
    renderProbs(detail.querySelector(".probs")!, rows, inTop ? "" : `The solution, ${s.want}, is not in Jev's top 5.`);
    const alts = Object.entries(p.alt).map(([label, a]) => `${promptName(label)}: picked ${escapeHtml(a.san)}, ${a.solved ? "solved" : a.first ? "first move right" : "failed"}.`);
    detail.querySelector(".pd-alt")!.textContent = alts.join(" ");
    detail.querySelector(".pd-link")!.innerHTML = `<a href="https://lichess.org/training/${encodeURIComponent(p.id)}">Open puzzle ${escapeHtml(p.id)} on Lichess</a>`;
  };

  const select = (i: number, focus = false) => {
    if (i < 0 || i >= puzzles.length) return;
    cells[sel]?.classList.remove("sel");
    cells[sel]?.setAttribute("tabindex", "-1");
    cells[sel]?.setAttribute("aria-selected", "false");
    sel = i;
    step = 0;
    const c = cells[i]!;
    c.classList.add("sel");
    c.setAttribute("tabindex", "0");
    c.setAttribute("aria-selected", "true");
    if (focus) c.focus();
    show();
  };

  waffle.addEventListener("click", (e) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>(".cell");
    if (c) select(Number(c.dataset.p));
  });
  waffle.addEventListener("keydown", (e) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>(".cell");
    if (!c) return;
    const row = c.parentElement!;
    const i = Array.from(row.children).indexOf(c);
    let next: Element | null | undefined = null;
    if (e.key === "ArrowRight") next = c.nextElementSibling;
    if (e.key === "ArrowLeft") next = c.previousElementSibling;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const band = row.closest(".band")!;
      const other = (e.key === "ArrowDown" ? band.nextElementSibling : band.previousElementSibling)?.querySelector(".band-cells");
      next = other?.children[Math.min(i, other.children.length - 1)];
    }
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    select(Number((next as HTMLElement).dataset.p), true);
  });
  detail.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-s]");
    if (!b) return;
    step = Number(b.dataset.s);
    show();
  });

  let start = puzzles.findIndex((p) => p.solved && p.steps.length > 1 && p.rating >= 1400);
  if (start < 0) start = puzzles.findIndex((p) => p.solved);
  select(Math.max(0, start));
}
