export function int(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function usd(x: number): string {
  if (x === 0) return "$0";
  if (x < 0.001) return `$${x.toFixed(6)}`;
  if (x < 1) return `$${x.toFixed(4)}`;
  return `$${x.toFixed(2)}`;
}

export function pct(x: number, digits = 0): string {
  return `${(x * 100).toFixed(digits)}%`;
}

export function pawns(cp: number): string {
  const v = cp / 100;
  return `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(v).toFixed(1)}`;
}

export function winShare(cp: number): number {
  return 1 / (1 + 10 ** (-cp / 400));
}

export function promptShort(p: string): string {
  return p === "final" ? "Final" : p;
}

export function promptName(p: string): string {
  return p === "final" ? "Final prompt" : p === "v0" ? "First prompt (v0)" : `Prompt ${p}`;
}

export function themeName(t: string): string {
  return t
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .toLowerCase();
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function resultText(outcome: string, result: string, self: boolean): string {
  if (self) return result === "1-0" ? "White won" : result === "0-1" ? "Black won" : "Draw";
  return outcome === "win" ? "Jev won" : outcome === "loss" ? "Jev lost" : "Draw";
}

export const TERMINATIONS: Record<string, string> = {
  checkmate: "checkmate",
  stalemate: "stalemate",
  threefold: "threefold repetition",
  fifty_move: "fifty-move rule",
  insufficient_material: "insufficient material",
  move_cap: "300-ply cap",
};
