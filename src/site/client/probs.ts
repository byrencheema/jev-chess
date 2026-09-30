import { pct } from "../format.ts";

export type Tone = "ink" | "engine" | "good" | "bad";

export interface ProbRow {
  san: string;
  p: number;
  tags: { text: string; tone: Tone }[];
  chosen?: boolean;
}

const ROWS = 5;

export function renderProbs(ol: HTMLElement, rows: ProbRow[], note = "", noteTone = "") {
  while (ol.children.length < ROWS) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="p-san"></span><span class="p-track"><span class="p-fill"></span><span class="p-tags"></span></span><span class="p-val"></span>`;
    ol.append(li);
  }
  Array.from(ol.children).forEach((li, i) => {
    const r = rows[i];
    const el = li as HTMLElement;
    el.classList.toggle("empty", !r);
    el.classList.toggle("chosen", !!r?.chosen);
    el.querySelector(".p-san")!.textContent = r?.san ?? "";
    (el.querySelector(".p-fill") as HTMLElement).style.transform = `scaleX(${r ? Math.min(1, r.p) : 0})`;
    el.querySelector(".p-val")!.textContent = r ? pct(r.p) : "";
    el.querySelector(".p-tags")!.innerHTML = (r?.tags ?? []).map((t) => `<span class="tag tag-${t.tone}">${t.text}</span>`).join("");
  });
  let n = ol.nextElementSibling as HTMLElement | null;
  if (!n?.classList.contains("probs-note")) {
    n = document.createElement("p");
    ol.after(n);
  }
  n.className = `probs-note${noteTone ? ` ${noteTone}` : ""}`;
  n.textContent = note;
}
