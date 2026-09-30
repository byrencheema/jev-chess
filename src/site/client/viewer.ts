import type { Opponent, SiteGame } from "../data.ts";
import { int, pawns, resultText, TERMINATIONS, usd, winShare } from "../format.ts";
import { costUsd } from "../../stats.ts";
import { Board, type Arrow } from "./board.ts";
import { renderProbs, type ProbRow } from "./probs.ts";
import { replay, squaresOf, type Replay } from "./replay.ts";

const SVG = "http://www.w3.org/2000/svg";

export interface ViewerOptions {
  full: boolean;
  auto: boolean;
  reduced: boolean;
  opponents: Map<string, Opponent>;
}

function $(root: Element, sel: string): HTMLElement {
  return root.querySelector(sel) as HTMLElement;
}

export class Viewer {
  readonly board: Board;
  readonly anchor: HTMLElement;
  game: SiteGame | null = null;
  private rp: Replay | null = null;
  private cumTok: number[] = [];
  private evFilled: number[] = [];
  k = 0;
  private playing = false;
  private visible = true;
  private timer = 0;
  private graphCursor: SVGLineElement | null = null;

  constructor(
    readonly root: HTMLElement,
    readonly opts: ViewerOptions,
  ) {
    this.board = new Board($(root, ".board"));
    this.anchor = $(root, ".board-col");
    root.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) =>
      b.addEventListener("click", () => {
        const act = b.dataset.act!;
        if (act === "play") return this.toggle();
        this.pause();
        if (act === "prev") this.step(-1);
        if (act === "next") this.step(1);
        if (act === "first") this.go(0, false);
        if (act === "last") this.go(this.game?.plies ?? 0, false);
        if (act === "flip") this.board.setFlipped(!this.board.isFlipped);
        this.updateEvalBar();
      }),
    );
    new IntersectionObserver(([e]) => {
      this.visible = !!e?.isIntersecting;
      if (this.visible) this.schedule();
      else window.clearTimeout(this.timer);
    }).observe(this.anchor);
    document.addEventListener("visibilitychange", () => (document.hidden ? window.clearTimeout(this.timer) : this.schedule()));
    const graph = root.querySelector<HTMLElement>(".evalgraph");
    if (graph) {
      const seek = (e: PointerEvent) => {
        if (!this.game) return;
        const r = graph.getBoundingClientRect();
        const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        this.pause();
        this.go(Math.round(f * this.game.plies), false);
      };
      graph.addEventListener("pointerdown", (e) => {
        graph.setPointerCapture(e.pointerId);
        seek(e);
      });
      graph.addEventListener("pointermove", (e) => {
        if (e.buttons) seek(e);
      });
    }
    const list = root.querySelector<HTMLElement>(".movelist");
    list?.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
      if (!b) return;
      this.pause();
      this.go(Number(b.dataset.i) + 1, false);
    });
  }

  firstDecision(game: SiteGame): number {
    const i = game.j.findIndex((x, i) => x !== null && i >= game.book);
    return i >= 0 ? i : game.book;
  }

  label(side: "w" | "b"): string {
    const g = this.game!;
    const isJev = g.jev === "wb" || g.jev === side;
    if (g.jev === "wb") return `Jev (${side === "w" ? "White" : "Black"})`;
    return isJev ? "Jev" : this.opts.opponents.get(g.opp)?.label ?? g.opp;
  }

  load(game: SiteGame, k = 0) {
    window.clearTimeout(this.timer);
    this.game = game;
    this.rp = replay(game.san);
    this.cumTok = [0];
    game.j.forEach((x, i) => this.cumTok.push(this.cumTok[i]! + (x?.k ?? 0)));
    let last = 0;
    this.evFilled = Array.from({ length: game.plies + 1 }, (_, i) => (last = game.ev?.[i] ?? last));
    this.board.setFlipped(game.jev === "b");
    $(this.root, ".t-ev-label").textContent = game.jev === "wb" ? "Eval for White" : "Eval for Jev";
    $(this.root, ".now-game").innerHTML = `<span class="${game.jev !== "b" ? "is-jev" : ""}">${this.label("w")}</span> <span class="vs">vs</span> <span class="${game.jev !== "w" ? "is-jev" : ""}">${this.label("b")}</span>`;
    if (this.opts.full) {
      this.renderMoves();
      this.renderGraph();
    }
    this.go(k, false);
  }

  private moveLabel(i: number): string {
    return `${Math.floor(i / 2) + 1}${i % 2 ? "..." : "."} ${this.game!.san[i]}`;
  }

  go(k: number, animate: boolean) {
    const g = this.game;
    const rp = this.rp;
    if (!g || !rp) return;
    this.k = Math.max(0, Math.min(g.plies, k));
    k = this.k;
    const pending = k < g.plies && g.j[k] ? k : -1;
    let d = pending;
    if (d < 0) for (let i = k - 1; i >= 0; i--) if (g.j[i]) {
      d = i;
      break;
    }
    const arrows: Arrow[] = [];
    if (pending >= 0) {
      for (const [san, p] of g.j[pending]!.t.slice(0, 3)) {
        const sq = squaresOf(rp.fens[pending]!, san);
        if (sq) arrows.push({ ...sq, kind: "jev", weight: p });
      }
      const best = g.a?.[pending]?.b;
      if (best && best !== g.san[pending]) {
        const sq = squaresOf(rp.fens[pending]!, best);
        if (sq) arrows.push({ ...sq, kind: "engine", weight: 1 });
      }
    }
    const last = k > 0 ? rp.moves[k - 1]! : null;
    this.board.set(rp.fens[k]!, { last: last ? [last.from, last.to] : null, check: rp.checks[k], arrows, animate: animate && !this.opts.reduced });
    this.renderNow(pending, d);
    this.updateEvalBar();
    const tokens = this.cumTok[pending >= 0 ? pending + 1 : k]!;
    $(this.root, ".t-usd").textContent = usd(costUsd(tokens));
    $(this.root, ".t-tok").textContent = int(tokens);
    $(this.root, ".t-lat").textContent = d >= 0 ? `${int(g.j[d]!.l)} ms` : "-";
    if (this.opts.full) this.syncMoves();
  }

  private renderNow(pending: number, d: number) {
    const g = this.game!;
    const k = this.k;
    const nowMove = $(this.root, ".now-move");
    const cap = $(this.root, ".probs-cap");
    if (k >= g.plies) {
      const self = g.jev === "wb";
      const how = TERMINATIONS[g.termination] ?? g.termination;
      nowMove.textContent = `${resultText(g.outcome, g.result, self)} by ${how} after ${Math.ceil(g.plies / 2)} moves.`;
    } else {
      const side = k % 2 === 0 ? "w" : "b";
      const who = this.label(side);
      nowMove.textContent = k < g.book ? `Move ${Math.floor(k / 2) + 1}. Opening book.` : `Move ${Math.floor(k / 2) + 1}. ${who} to play.`;
    }
    if (d < 0) {
      cap.textContent = "Jev's options";
      renderProbs($(this.root, ".probs"), [], k < g.book ? "Both sides play book moves first." : "Jev has not moved yet.");
      return;
    }
    cap.textContent = pending >= 0 ? "Jev's options now" : `Jev's options for ${this.moveLabel(d)}`;
    const an = g.a?.[d] ?? null;
    const played = g.san[d];
    const rows: ProbRow[] = g.j[d]!.t.map(([san, p]) => ({
      san,
      p,
      chosen: san === played,
      tags: [
        ...(san === played ? [{ text: pending >= 0 ? "picks" : "played", tone: "ink" as const }] : []),
        ...(san === played && an?.x ? [{ text: "blunder", tone: "bad" as const }] : []),
        ...(an && an.b === san ? [{ text: "Stockfish", tone: "engine" as const }] : []),
      ],
    }));
    const inTop = an ? g.j[d]!.t.some(([s]) => s === an.b) : true;
    renderProbs($(this.root, ".probs"), rows, an && !inTop && an.b ? `Stockfish's best, ${an.b}, is not in Jev's top 5.` : "", "engine");
  }

  private updateEvalBar() {
    const g = this.game;
    if (!g) return;
    const bar = $(this.root, ".evalbar");
    const has = !!g.ev;
    bar.classList.toggle("na", !has);
    const cp = has ? this.evFilled[this.k]! : 0;
    const share = winShare(cp);
    bar.classList.toggle("flipped", this.board.isFlipped);
    ($(this.root, ".evalbar-fill") as HTMLElement).style.transform = `scaleY(${share.toFixed(4)})`;
    const ev = this.root.querySelector(".t-ev");
    const sign = g.jev === "b" ? -1 : 1;
    if (ev) ev.textContent = has ? pawns(sign * cp) : "-";
  }

  private renderMoves() {
    const g = this.game!;
    const list = $(this.root, ".movelist");
    const jevSide = (i: number) => g.jev === "wb" || (i % 2 === 0 ? g.jev === "w" : g.jev === "b");
    let html = "";
    for (let i = 0; i < g.plies; i += 2) {
      const cell = (j: number) => {
        if (j >= g.plies) return `<span></span>`;
        const cls = ["mv", jevSide(j) ? "jev" : "opp", j < g.book ? "book" : "", g.a?.[j]?.x ? "blunder" : ""].filter(Boolean).join(" ");
        return `<button type="button" class="${cls}" data-i="${j}">${g.san[j]}${g.a?.[j]?.x ? `<span class="bl" aria-label="blunder">??</span>` : ""}</button>`;
      };
      html += `<span class="mn">${i / 2 + 1}</span>${cell(i)}${cell(i + 1)}`;
    }
    list.innerHTML = html;
  }

  private syncMoves() {
    const list = this.root.querySelector<HTMLElement>(".movelist");
    if (!list) return;
    list.querySelector(".cur")?.classList.remove("cur");
    const b = list.querySelector<HTMLElement>(`[data-i="${this.k - 1}"]`);
    if (b) {
      b.classList.add("cur");
      const top = b.offsetTop - list.offsetTop;
      if (top < list.scrollTop + 8 || top > list.scrollTop + list.clientHeight - 40) list.scrollTop = top - list.clientHeight / 2;
    } else if (this.k === 0) list.scrollTop = 0;
    const g = this.game!;
    if (this.graphCursor) {
      const x = ((this.k / Math.max(1, g.plies)) * 1000).toFixed(1);
      this.graphCursor.setAttribute("x1", x);
      this.graphCursor.setAttribute("x2", x);
    }
    const graph = this.root.querySelector(".evalgraph");
    graph?.setAttribute("aria-valuenow", String(this.k));
    graph?.setAttribute("aria-valuetext", this.k ? this.moveLabel(this.k - 1) : "Start");
  }

  private renderGraph() {
    const g = this.game!;
    const host = $(this.root, ".evalgraph");
    host.setAttribute("aria-valuemin", "0");
    host.setAttribute("aria-valuemax", String(g.plies));
    host.replaceChildren();
    const el = (tag: string, attrs: Record<string, string | number>) => {
      const e = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      return e;
    };
    const s = el("svg", { viewBox: "0 0 1000 100", preserveAspectRatio: "none", "aria-hidden": "true" });
    host.append(s);
    if (!g.ev) {
      host.classList.add("na");
      const p = document.createElement("p");
      p.className = "graph-na";
      p.textContent = "Not analyzed yet.";
      host.append(p);
      this.graphCursor = null;
      return;
    }
    host.classList.remove("na");
    const sign = g.jev === "b" ? -1 : 1;
    const n = Math.max(1, g.plies);
    const pts = this.evFilled.map((cp, i) => [(i / n) * 1000, 100 - winShare(sign * cp) * 100] as const);
    const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
    const area = `M0,50${pts.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join("")}L1000,50Z`;
    const id = `${this.root.id}-clip`;
    const defs = el("defs", {});
    const up = el("clipPath", { id: `${id}-up` });
    up.append(el("rect", { x: 0, y: 0, width: 1000, height: 50 }));
    const down = el("clipPath", { id: `${id}-down` });
    down.append(el("rect", { x: 0, y: 50, width: 1000, height: 50 }));
    defs.append(up, down);
    s.append(defs);
    s.append(el("path", { d: area, class: "g-up", "clip-path": `url(#${id}-up)` }));
    s.append(el("path", { d: area, class: "g-down", "clip-path": `url(#${id}-down)` }));
    s.append(el("line", { x1: 0, x2: 1000, y1: 50, y2: 50, class: "g-mid" }));
    if (g.book) s.append(el("rect", { x: 0, y: 0, width: (g.book / n) * 1000, height: 100, class: "g-book" }));
    s.append(el("path", { d: line, class: "g-line" }));
    g.a?.forEach((a, i) => {
      if (a?.x) s.append(el("line", { x1: ((i + 1) / n) * 1000, x2: ((i + 1) / n) * 1000, y1: 0, y2: 14, class: "g-blunder" }));
    });
    this.graphCursor = el("line", { x1: 0, x2: 0, y1: 0, y2: 100, class: "g-cursor" }) as SVGLineElement;
    s.append(this.graphCursor);
  }

  step(dir: number) {
    this.go(this.k + dir, dir === 1);
  }

  private delay(): number {
    const g = this.game!;
    if (this.k >= g.plies) return this.opts.auto ? 5000 : 0;
    if (this.k < g.book) return 450;
    return g.j[this.k] ? 1500 : 750;
  }

  private schedule() {
    window.clearTimeout(this.timer);
    if (!this.playing || !this.visible || document.hidden || !this.game) return;
    const g = this.game;
    if (this.k >= g.plies && !this.opts.auto) return this.pause();
    this.timer = window.setTimeout(() => {
      if (this.k >= g.plies) this.go(this.opts.auto ? this.firstDecision(g) : 0, false);
      else this.step(1);
      this.schedule();
    }, this.delay());
  }

  play() {
    if (!this.game) return;
    if (this.k >= this.game.plies && !this.opts.auto) this.go(0, false);
    this.playing = true;
    this.root.classList.add("playing");
    this.root.querySelector("[data-act=play]")?.setAttribute("aria-label", "Pause");
    this.schedule();
  }

  pause() {
    this.playing = false;
    window.clearTimeout(this.timer);
    this.root.classList.remove("playing");
    this.root.querySelector("[data-act=play]")?.setAttribute("aria-label", "Play");
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }
}
