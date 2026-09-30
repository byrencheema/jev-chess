const SVG = "http://www.w3.org/2000/svg";

export type ArrowKind = "jev" | "engine" | "good";

export interface Arrow {
  from: string;
  to: string;
  kind: ArrowKind;
  weight: number;
}

export interface BoardState {
  last?: [string, string] | null;
  check?: string | null;
  arrows?: Arrow[];
  animate?: boolean;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export function placement(fen: string): Map<string, string> {
  const out = new Map<string, string>();
  const rows = fen.split(" ")[0]!.split("/");
  rows.forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        f += Number(ch);
        continue;
      }
      const color = ch === ch.toUpperCase() ? "w" : "b";
      out.set(`${"abcdefgh"[f]}${8 - r}`, `${color}${ch.toUpperCase()}`);
      f++;
    }
  });
  return out;
}

export class Board {
  private squares: SVGSVGElement;
  private marks: SVGGElement;
  private layer: HTMLDivElement;
  private arrows: SVGSVGElement;
  private coords: SVGGElement;
  private pieces = new Map<HTMLElement, { sq: string; code: string }>();
  private flipped = false;
  private state: { fen: string; opts: BoardState } | null = null;

  constructor(readonly el: HTMLElement) {
    el.classList.add("board");
    this.squares = svg("svg", { viewBox: "0 0 8 8", class: "b-squares", "aria-hidden": "true" });
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) this.squares.append(svg("rect", { x, y, width: 1, height: 1, class: (x + y) % 2 ? "sq-d" : "sq-l" }));
    this.marks = svg("g");
    this.coords = svg("g", { class: "b-coords" });
    this.squares.append(this.marks, this.coords);
    this.layer = document.createElement("div");
    this.layer.className = "b-pieces";
    this.arrows = svg("svg", { viewBox: "0 0 8 8", class: "b-arrows", "aria-hidden": "true" });
    el.append(this.squares, this.layer, this.arrows);
    this.drawCoords();
  }

  private xy(sq: string): [number, number] {
    const f = sq.charCodeAt(0) - 97;
    const r = Number(sq[1]);
    return this.flipped ? [7 - f, r - 1] : [f, 8 - r];
  }

  private drawCoords() {
    this.coords.replaceChildren();
    for (let i = 0; i < 8; i++) {
      const file = "abcdefgh"[this.flipped ? 7 - i : i]!;
      const rank = this.flipped ? i + 1 : 8 - i;
      const f = svg("text", { x: i + 0.94, y: 7.9, "text-anchor": "end", class: (i + 7) % 2 ? "on-d" : "on-l" });
      f.textContent = file;
      const r = svg("text", { x: 0.06, y: i + 0.22, class: i % 2 ? "on-d" : "on-l" });
      r.textContent = String(rank);
      this.coords.append(f, r);
    }
  }

  setFlipped(flipped: boolean) {
    if (flipped === this.flipped) return;
    this.flipped = flipped;
    this.drawCoords();
    if (this.state) this.set(this.state.fen, { ...this.state.opts, animate: false });
  }

  get isFlipped() {
    return this.flipped;
  }

  set(fen: string, opts: BoardState = {}) {
    this.state = { fen, opts };
    this.drawMarks(opts);
    this.placePieces(fen, !!opts.animate);
    this.drawArrows(opts.arrows ?? []);
  }

  private drawMarks(opts: BoardState) {
    this.marks.replaceChildren();
    for (const sq of opts.last ?? []) {
      const [x, y] = this.xy(sq);
      this.marks.append(svg("rect", { x, y, width: 1, height: 1, class: "hl-last" }));
    }
    if (opts.check) {
      const [x, y] = this.xy(opts.check);
      this.marks.append(svg("circle", { cx: x + 0.5, cy: y + 0.5, r: 0.48, class: "hl-check" }));
    }
  }

  private placePieces(fen: string, animate: boolean) {
    const want = placement(fen);
    const free = new Map(this.pieces);
    const todo: [string, string][] = [];
    for (const [sq, code] of want) {
      const keep = [...free].find(([, p]) => p.sq === sq && p.code === code);
      if (keep) free.delete(keep[0]);
      else todo.push([sq, code]);
    }
    const moves: [HTMLElement, string][] = [];
    const fresh: [string, string][] = [];
    for (const [sq, code] of todo) {
      const [tx, ty] = this.xy(sq);
      let best: HTMLElement | null = null;
      let dist = Infinity;
      for (const [el, p] of free) {
        if (p.code !== code) continue;
        const [x, y] = this.xy(p.sq);
        const d = Math.hypot(x - tx, y - ty);
        if (d < dist) {
          dist = d;
          best = el;
        }
      }
      if (best && animate) {
        free.delete(best);
        moves.push([best, sq]);
      } else fresh.push([sq, code]);
    }
    for (const el of free.keys()) {
      el.remove();
      this.pieces.delete(el);
    }
    this.layer.classList.toggle("instant", !animate);
    for (const [el, sq] of moves) {
      this.pieces.get(el)!.sq = sq;
      this.position(el, sq);
    }
    for (const [sq, code] of fresh) {
      const el = document.createElement("div");
      el.className = `pc pc-${code}`;
      this.pieces.set(el, { sq, code });
      this.position(el, sq);
      this.layer.append(el);
    }
    if (!animate) for (const [el, p] of this.pieces) this.position(el, p.sq);
  }

  private position(el: HTMLElement, sq: string) {
    const [x, y] = this.xy(sq);
    el.style.transform = `translate(${x * 100}%, ${y * 100}%)`;
  }

  private drawArrows(arrows: Arrow[]) {
    this.arrows.replaceChildren();
    const maxW = Math.max(0.0001, ...arrows.filter((a) => a.kind === "jev").map((a) => a.weight));
    const order = (a: Arrow) => (a.kind === "jev" ? a.weight : a.kind === "engine" ? 2 : 3);
    for (const a of [...arrows].sort((p, q) => order(p) - order(q))) {
      const [x1, y1] = this.xy(a.from).map((v) => v + 0.5) as [number, number];
      const [x2, y2] = this.xy(a.to).map((v) => v + 0.5) as [number, number];
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len === 0) continue;
      const ux = (x2 - x1) / len;
      const uy = (y2 - y1) / len;
      const nx = -uy;
      const ny = ux;
      if (a.kind === "engine") {
        const w = 0.075;
        const head = 0.3;
        const tipX = x2 - ux * 0.12;
        const tipY = y2 - uy * 0.12;
        const bx = tipX - ux * head;
        const by = tipY - uy * head;
        const g = svg("g", { class: "arrow arrow-engine" });
        g.append(svg("line", { x1, y1, x2: bx, y2: by, "stroke-width": w, "stroke-dasharray": "0.14 0.1" }));
        g.append(svg("polygon", { points: [[tipX, tipY], [bx + nx * 0.17, by + ny * 0.17], [bx - nx * 0.17, by - ny * 0.17]].map((p) => p.join(",")).join(" ") }));
        this.arrows.append(g);
        continue;
      }
      const rel = a.kind === "jev" ? a.weight / maxW : 1;
      const w = a.kind === "good" ? 0.07 : 0.06 + 0.22 * Math.sqrt(a.weight);
      const hw = Math.max(0.3, w * 2.3);
      const hl = Math.max(0.26, w * 1.8);
      const tipX = x2 - ux * 0.1;
      const tipY = y2 - uy * 0.1;
      const bx = tipX - ux * hl;
      const by = tipY - uy * hl;
      const pts = [
        [x1 + (nx * w) / 2, y1 + (ny * w) / 2],
        [bx + (nx * w) / 2, by + (ny * w) / 2],
        [bx + (nx * hw) / 2, by + (ny * hw) / 2],
        [tipX, tipY],
        [bx - (nx * hw) / 2, by - (ny * hw) / 2],
        [bx - (nx * w) / 2, by - (ny * w) / 2],
        [x1 - (nx * w) / 2, y1 - (ny * w) / 2],
      ];
      const poly = svg("polygon", { points: pts.map((p) => p.map((v) => v.toFixed(3)).join(",")).join(" "), class: `arrow arrow-${a.kind}` });
      if (a.kind === "jev") poly.style.opacity = (0.3 + 0.62 * rel).toFixed(2);
      this.arrows.append(poly);
    }
  }
}
