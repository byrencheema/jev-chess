import type { MoveLog } from "./game.ts";
import type { PuzzleResult } from "./puzzles.ts";
import { bootstrapRating } from "./rating.ts";
import { latestById, type GameRow } from "./runner.ts";
import { mulberry32 } from "./rng.ts";
import { costUsd, formatUsd, median, wilson } from "./stats.ts";

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

export function callStats(moves: Pick<MoveLog, "calls" | "requestMs" | "latencyMs" | "inputTokens" | "invalid" | "stateVariant">[]): string {
  const calls = moves.filter((m) => m.calls);
  if (calls.length === 0) return "no jev calls";
  const req = calls.map((m) => m.requestMs ?? m.latencyMs ?? 0);
  const tokens = calls.map((m) => m.inputTokens ?? 0);
  const invalid = calls.filter((m) => m.invalid).length;
  const shrunk = calls.filter((m) => (m.stateVariant ?? 0) > 0).length;
  return [
    `${calls.length} calls`,
    `request latency median ${(median(req) / 1000).toFixed(2)}s, p90 ${(quantile(req, 0.9) / 1000).toFixed(2)}s`,
    `input tokens per call median ${median(tokens).toFixed(0)}`,
    `${invalid} illegal choices`,
    `${shrunk} shrunk states`,
  ].join("; ");
}

export function gameSummary(all: GameRow[]): string {
  const rows = [...latestById(all).values()];
  const groups = new Map<string, GameRow[]>();
  for (const r of rows) groups.set(`${r.a} vs ${r.b}`, [...(groups.get(`${r.a} vs ${r.b}`) ?? []), r]);
  const lines: string[] = [];
  for (const [name, games] of groups) {
    const ok = games.filter((g) => g.scoreA !== null);
    const w = ok.filter((g) => g.scoreA === 1).length;
    const d = ok.filter((g) => g.scoreA === 0.5).length;
    const l = ok.filter((g) => g.scoreA === 0).length;
    const score = ok.reduce((s, g) => s + g.scoreA!, 0);
    const terms: Record<string, number> = {};
    for (const g of games) terms[g.termination] = (terms[g.termination] ?? 0) + 1;
    const tokens = games.reduce((s, g) => s + g.inputTokens, 0);
    const cost = games.reduce((s, g) => s + g.costUsd, 0);
    const models = [...new Set(games.map((g) => g.model).filter(Boolean))].join(", ");
    lines.push(
      `${name}: ${games.length} games, ${w}W ${d}D ${l}L for ${games[0]!.a} (score ${ok.length ? pct(score / ok.length) : "-"})`,
      `  endings: ${Object.entries(terms).map(([k, v]) => `${k} ${v}`).join(", ")}; plies median ${median(games.map((g) => g.plies))}`,
      `  jev: ${callStats(games.flatMap((g) => g.moves))}`,
      `  ${tokens.toLocaleString()} input tokens, ${formatUsd(cost)}${models ? `, model ${models}` : ""}`,
    );
  }
  return lines.join("\n");
}

export const BUCKET = 400;

export function puzzleSummary(all: PuzzleResult[]): string {
  const rows = [...latestById(all).values()].filter((r) => !r.error);
  if (rows.length === 0) return "no puzzle results";
  const solved = rows.filter((r) => r.solved).length;
  const ci = wilson(solved, rows.length);
  const first = rows.filter((r) => r.firstMoveCorrect).length;
  const lines = [
    `${rows.length} puzzles: solved ${solved} (${pct(solved / rows.length)}, 95% CI ${pct(ci.low)} to ${pct(ci.high)}), first move right ${first} (${pct(first / rows.length)})`,
  ];
  const buckets = new Map<number, PuzzleResult[]>();
  for (const r of rows) {
    const b = Math.floor(r.rating / BUCKET) * BUCKET;
    buckets.set(b, [...(buckets.get(b) ?? []), r]);
  }
  for (const b of [...buckets.keys()].sort((x, y) => x - y)) {
    const rs = buckets.get(b)!;
    const s = rs.filter((r) => r.solved).length;
    lines.push(`  ${b}-${b + BUCKET - 1}: ${s}/${rs.length} solved (${pct(s / rs.length)}), first move ${rs.filter((r) => r.firstMoveCorrect).length}/${rs.length}`);
  }
  const fit = bootstrapRating(rows.map((r) => ({ rating: r.rating, solved: r.solved })));
  const bound = solved === 0 ? " (no solves, so this is the fit's lower bound)" : solved === rows.length ? " (all solved, so this is the fit's upper bound)" : "";
  lines.push(`  fitted puzzle rating ${fit.rating.toFixed(0)} (bootstrap 95% CI ${fit.low.toFixed(0)} to ${fit.high.toFixed(0)})${bound}`);
  const tokens = rows.reduce((s, r) => s + r.inputTokens, 0);
  const models = [...new Set(rows.map((r) => r.model).filter(Boolean))].join(", ");
  lines.push(`  jev: ${callStats(rows.flatMap((r) => r.steps))}`, `  ${tokens.toLocaleString()} input tokens, ${formatUsd(costUsd(tokens))}${models ? `, model ${models}` : ""}`);
  return lines.join("\n");
}

export interface Named {
  name: string;
  rows: PuzzleResult[];
}

export function pairedDiff(base: Map<string, boolean>, other: Map<string, boolean>, samples = 2000, seed = 1): { diff: number; low: number; high: number; n: number } {
  const ids = [...other.keys()].filter((id) => base.has(id));
  const d = ids.map((id) => Number(other.get(id)) - Number(base.get(id)));
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const rng = mulberry32(seed);
  const boots: number[] = [];
  for (let s = 0; s < samples; s++) boots.push(mean(Array.from({ length: d.length }, () => d[Math.floor(rng() * d.length)]!)));
  return { diff: mean(d), low: quantile(boots, 0.025), high: quantile(boots, 0.975), n: ids.length };
}

export function compareTable(baseline: Named, variants: Named[]): string {
  const solvedMap = (rows: PuzzleResult[]) => new Map(rows.filter((r) => !r.error).map((r) => [r.id, r.solved]));
  const base = solvedMap(baseline.rows);
  const signed = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}`;
  const lines = [
    "| Variant | Puzzles | Solved | 95% CI | Fitted rating (95% CI) | vs baseline, points (95% CI) | Tokens per call | Cost |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const v of variants) {
    const rows = v.rows.filter((r) => !r.error);
    const solved = rows.filter((r) => r.solved).length;
    const ci = wilson(solved, rows.length);
    const fit = bootstrapRating(rows.map((r) => ({ rating: r.rating, solved: r.solved })));
    const d = pairedDiff(base, solvedMap(rows));
    const calls = rows.reduce((s, r) => s + r.jevCalls, 0);
    const tokens = rows.reduce((s, r) => s + r.inputTokens, 0);
    lines.push(
      `| ${v.name} | ${rows.length} | ${pct(solved / rows.length)} | ${pct(ci.low)} to ${pct(ci.high)} | ${fit.rating.toFixed(0)} (${fit.low.toFixed(0)} to ${fit.high.toFixed(0)}) | ${v.name === baseline.name ? "baseline" : `${signed(d.diff)} (${signed(d.low)} to ${signed(d.high)})`} | ${calls ? Math.round(tokens / calls) : "-"} | ${formatUsd(costUsd(tokens))} |`,
    );
  }
  return lines.join("\n");
}
