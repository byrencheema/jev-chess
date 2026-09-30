import { Chess } from "chess.js";
import { EVAL_CAP, type GameAnalysis } from "../analysis.ts";
import { positionOf, START_FEN } from "../game.ts";
import { describeMove, HEADLINE, promptId, renderState, VARIANTS } from "../prompt.ts";
import type { PuzzleResult } from "../puzzles.ts";
import { bootstrapRating } from "../rating.ts";
import type { GameRow } from "../runner.ts";
import { costUsd, mean, median } from "../stats.ts";

export type Group = "random" | "stockfish" | "maia" | "jev" | "other";
export type Outcome = "win" | "draw" | "loss" | "decisive";

export interface Opponent {
  key: string;
  label: string;
  group: Group;
  order: number;
}

export interface JevPly {
  t: [string, number][];
  c: number;
  k: number;
  l: number;
}

export interface AnPly {
  b: string;
  s: number;
  x: boolean;
}

export interface SiteGame {
  id: string;
  opp: string;
  prompt: string;
  jev: "w" | "b" | "wb";
  result: string;
  outcome: Outcome;
  termination: string;
  opening?: string;
  plies: number;
  book: number;
  cost: number;
  tokens: number;
  san: string[];
  j: (JevPly | null)[];
  a: (AnPly | null)[] | null;
  ev: (number | null)[] | null;
  acpl: number | null;
  blunders: number | null;
}

export interface PuzzleStepView {
  fen: string;
  san: string;
  want: string;
  ok: boolean;
  t: [string, number][];
  c: number;
}

export interface SitePuzzle {
  id: string;
  rating: number;
  themes: string[];
  solved: boolean;
  first: boolean;
  moves: number;
  steps: PuzzleStepView[];
  alt: Record<string, { san: string; solved: boolean; first: boolean }>;
}

export interface Fit {
  rating: number;
  low: number;
  high: number;
}

export interface PuzzleSetSummary {
  prompt: string;
  n: number;
  solved: number;
  first: number;
  fit: Fit;
  tokens: number;
}

export interface BandRow {
  band: number;
  sets: Record<string, { n: number; solved: number; first: number }>;
}

export interface ResultRow {
  opp: string;
  prompt: string;
  games: number;
  w: number;
  d: number;
  l: number;
  score: number | null;
  analyzed: number;
  acpl: number | null;
  blundersPerGame: number | null;
  bestMatch: number | null;
  tokensPerMove: number;
}

export interface Headline {
  puzzle: (Fit & { n: number; prompt: string }) | null;
  games: number;
  opponents: number;
  puzzles: number;
  costUsd: number;
  tokens: number;
  calls: number;
  illegal: number;
  medianLatencyMs: number;
  models: string[];
}

export interface SiteData {
  generatedAt: string;
  headline: Headline;
  opponents: Opponent[];
  prompts: string[];
  games: SiteGame[];
  featured: number;
  results: ResultRow[];
  puzzleSets: PuzzleSetSummary[];
  primaryPrompt: string | null;
  bands: BandRow[];
  bandSize: number;
  puzzles: SitePuzzle[];
  puzzleBand: number;
  request: string;
  response: string;
}

export interface GameFile {
  file: string;
  rows: GameRow[];
  analyses: GameAnalysis[];
}

export interface PuzzleFile {
  file: string;
  rows: (PuzzleResult & { agent?: string })[];
}

export interface BuildOptions {
  featured?: string;
  generatedAt?: string;
  bootstrapSamples?: number;
}

export const FINAL = "final";

const PROMPT_NAMES = new Map(Object.values(VARIANTS).map((v) => [promptId(v), v.name === HEADLINE ? FINAL : v.name]));

export function promptLabel(hash: string | undefined, agent?: string): string {
  if (agent === "jev-v0") return "v0";
  if (!hash) return "v0";
  return PROMPT_NAMES.get(hash) ?? hash;
}

export function isJev(name: string): boolean {
  return name === "jev" || name.startsWith("jev-") || name.startsWith("jev:");
}

export function opponentOf(spec: string): Opponent {
  const [kind, params = ""] = spec.split(/:(.*)/s) as [string, string | undefined];
  const num = Number(params.replace(/\D+/g, "")) || 0;
  if (isJev(spec)) return { key: spec, label: "Jev", group: "jev", order: 90_000 };
  if (kind === "random") return { key: spec, label: "Random", group: "random", order: 0 };
  if (kind === "stockfish") {
    const skill = /skill=(\d+)/.exec(params);
    if (skill) return { key: spec, label: `Stockfish skill ${skill[1]}`, group: "stockfish", order: 10_000 + Number(skill[1]) };
    return { key: spec, label: params ? `Stockfish ${params}` : "Stockfish", group: "stockfish", order: 10_000 + (num || 5000) };
  }
  if (kind === "maia") return { key: spec, label: `Maia ${params || 1500}`, group: "maia", order: 20_000 + (num || 1500) };
  return { key: spec, label: spec, group: "other", order: 80_000 };
}

function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function outcomeFor(result: string, jev: "w" | "b" | "wb"): Outcome {
  if (result === "1/2-1/2") return "draw";
  if (jev === "wb") return "decisive";
  const whiteWon = result === "1-0";
  return whiteWon === (jev === "w") ? "win" : "loss";
}

export function evalSeries(plies: number, analyses: GameAnalysis[], result: string, termination: string): (number | null)[] | null {
  if (!analyses.length) return null;
  const ev: (number | null)[] = Array.from({ length: plies + 1 }, () => null);
  for (const a of analyses) {
    const sign = a.color === "w" ? 1 : -1;
    for (const m of a.moves) {
      ev[m.ply - 1] = sign * m.cpBefore;
      ev[m.ply] = sign * m.cpAfter;
    }
  }
  if (ev[plies] === null) {
    if (termination === "checkmate") ev[plies] = result === "1-0" ? EVAL_CAP : -EVAL_CAP;
    else if (result === "1/2-1/2") ev[plies] = 0;
  }
  return ev;
}

function toGame(row: GameRow, analyses: GameAnalysis[]): SiteGame | null {
  const w = isJev(row.white);
  const b = isJev(row.black);
  if (!w && !b) return null;
  const jev = w && b ? "wb" : w ? "w" : "b";
  const jevName = w ? row.white : row.black;
  const opp = w && b ? row.black : w ? row.black : row.white;
  const j = row.moves.map((m): JevPly | null =>
    m.top && isJev(m.player)
      ? { t: m.top.map((x) => [x.move, round(x.p, 3)] as [string, number]), c: round(m.confidence ?? 0, 3), k: m.inputTokens ?? 0, l: Math.round(m.requestMs ?? m.latencyMs ?? 0) }
      : null,
  );
  let a: (AnPly | null)[] | null = null;
  let acpl: number | null = null;
  let blunders: number | null = null;
  if (analyses.length) {
    a = row.moves.map(() => null);
    const all = analyses.flatMap((x) => x.moves);
    for (const m of all) a[m.ply - 1] = { b: m.best, s: m.loss, x: m.blunder };
    acpl = all.length ? round(mean(all.map((m) => m.loss)), 1) : null;
    blunders = all.filter((m) => m.blunder).length;
  }
  return {
    id: row.id,
    opp,
    prompt: promptLabel(row.prompts?.[jevName]),
    jev,
    result: row.result,
    outcome: outcomeFor(row.result, jev),
    termination: row.termination,
    opening: row.opening,
    plies: row.plies,
    book: row.moves.filter((m) => m.book).length,
    cost: row.costUsd,
    tokens: row.inputTokens,
    san: row.moves.map((m) => m.san),
    j,
    a,
    ev: evalSeries(row.plies, analyses, row.result, row.termination),
    acpl,
    blunders,
  };
}

function latest<T extends { id: string }>(rows: T[]): T[] {
  const out = new Map<string, T>();
  for (const r of rows) out.set(r.id, r);
  return [...out.values()];
}

export function collectGames(files: GameFile[]): SiteGame[] {
  const games: SiteGame[] = [];
  for (const f of files) {
    const byGame = new Map<string, GameAnalysis[]>();
    for (const a of latest(f.analyses)) byGame.set(a.game, [...(byGame.get(a.game) ?? []), a]);
    for (const row of latest(f.rows)) {
      if (row.error || row.result === "*") continue;
      const g = toGame(row, byGame.get(row.id) ?? []);
      if (g) games.push(g);
    }
  }
  return games;
}

export function pickFeatured(games: SiteGame[], opponents: Map<string, Opponent>, id?: string): number {
  if (!games.length) return -1;
  if (id) {
    const i = games.findIndex((g) => g.id === id);
    if (i >= 0) return i;
  }
  const strength = (g: SiteGame) => {
    const o = opponents.get(g.opp);
    return o && o.group !== "jev" ? o.order : -1;
  };
  const score = (g: SiteGame) =>
    (g.outcome === "win" ? 4 : g.outcome === "draw" ? 1 : 0) * 1e6 +
    (g.ev ? 2e5 : 0) +
    (g.termination === "checkmate" ? 1e5 : 0) +
    (g.plies >= 30 && g.plies <= 120 ? 5e4 : 0) +
    strength(g) -
    (g.acpl ?? 500) / 1000;
  let best = 0;
  for (let i = 1; i < games.length; i++) if (score(games[i]!) > score(games[best]!)) best = i;
  return best;
}

export function resultRows(games: SiteGame[], opponents: Map<string, Opponent>): ResultRow[] {
  const prompts = new Set(games.map((g) => g.prompt));
  const groups = new Map<string, SiteGame[]>();
  for (const g of games) {
    const key = `${g.opp}|${prompts.size > 1 ? g.prompt : ""}`;
    groups.set(key, [...(groups.get(key) ?? []), g]);
  }
  const rows: ResultRow[] = [];
  for (const [key, gs] of groups) {
    const [opp, prompt] = key.split("|") as [string, string];
    const self = gs[0]!.jev === "wb";
    const w = gs.filter((g) => (self ? g.result === "1-0" : g.outcome === "win")).length;
    const l = gs.filter((g) => (self ? g.result === "0-1" : g.outcome === "loss")).length;
    const d = gs.filter((g) => g.result === "1/2-1/2").length;
    const analyzed = gs.filter((g) => g.a);
    const losses = analyzed.flatMap((g) => g.a!.flatMap((x, i) => (x ? [{ loss: x.s, blunder: x.x, match: x.b === g.san[i] }] : [])));
    const jevMoves = gs.flatMap((g) => g.j.filter((x): x is JevPly => x !== null));
    rows.push({
      opp,
      prompt: prompt || gs[0]!.prompt,
      games: gs.length,
      w,
      d,
      l,
      score: self ? null : (w + d / 2) / gs.length,
      analyzed: analyzed.length,
      acpl: losses.length ? mean(losses.map((m) => m.loss)) : null,
      blundersPerGame: analyzed.length ? losses.filter((m) => m.blunder).length / analyzed.length : null,
      bestMatch: losses.length ? losses.filter((m) => m.match).length / losses.length : null,
      tokensPerMove: jevMoves.length ? mean(jevMoves.map((m) => m.k)) : 0,
    });
  }
  const order = (r: ResultRow) => opponents.get(r.opp)?.order ?? 0;
  return rows.sort((x, y) => order(x) - order(y) || (x.prompt === FINAL ? 1 : 0) - (y.prompt === FINAL ? 1 : 0));
}

export const BAND = 100;
export const TABLE_BAND = 200;

export function puzzleViews(files: PuzzleFile[], samples: number) {
  const sets = new Map<string, (PuzzleResult & { agent?: string })[]>();
  for (const f of files) {
    for (const r of latest(f.rows)) {
      if (r.error || (r.agent && !isJev(r.agent))) continue;
      const label = promptLabel(r.prompt, r.agent);
      const list = sets.get(label) ?? [];
      list.push(r);
      sets.set(label, list);
    }
  }
  for (const [k, v] of sets) sets.set(k, latest(v));
  const labels = [...sets.keys()].sort((a, b) => (a === FINAL ? -1 : b === FINAL ? 1 : a.localeCompare(b)));
  const primary = labels[0] ?? null;
  const summaries: PuzzleSetSummary[] = labels.map((prompt) => {
    const rows = sets.get(prompt)!;
    return {
      prompt,
      n: rows.length,
      solved: rows.filter((r) => r.solved).length,
      first: rows.filter((r) => r.firstMoveCorrect).length,
      fit: bootstrapRating(rows.map((r) => ({ rating: r.rating, solved: r.solved })), samples),
      tokens: rows.reduce((s, r) => s + r.inputTokens, 0),
    };
  });
  const bandMap = new Map<number, BandRow>();
  for (const prompt of labels) {
    for (const r of sets.get(prompt)!) {
      const band = Math.floor(r.rating / TABLE_BAND) * TABLE_BAND;
      const row = bandMap.get(band) ?? { band, sets: {} };
      const s = (row.sets[prompt] ??= { n: 0, solved: 0, first: 0 });
      s.n++;
      if (r.solved) s.solved++;
      if (r.firstMoveCorrect) s.first++;
      bandMap.set(band, row);
    }
  }
  const others = labels.slice(1).map((l) => [l, new Map(sets.get(l)!.map((r) => [r.id, r]))] as const);
  const puzzles: SitePuzzle[] = primary
    ? sets
        .get(primary)!
        .sort((a, b) => a.rating - b.rating || a.id.localeCompare(b.id))
        .map((r) => {
          const alt: SitePuzzle["alt"] = {};
          for (const [label, m] of others) {
            const o = m.get(r.id);
            if (o?.steps[0]) alt[label] = { san: o.steps[0].san, solved: o.solved, first: o.firstMoveCorrect };
          }
          return {
            id: r.id,
            rating: r.rating,
            themes: r.themes,
            solved: r.solved,
            first: r.firstMoveCorrect,
            moves: r.solverMoves,
            steps: r.steps.map((s) => ({
              fen: s.fen,
              san: s.san,
              want: s.expectedSan,
              ok: s.correct,
              t: (s.top ?? []).map((x) => [x.move, round(x.p, 3)] as [string, number]),
              c: round(s.confidence ?? 0, 3),
            })),
            alt,
          };
        })
    : [];
  const bands = [...bandMap.values()].sort((a, b) => a.band - b.band);
  return { summaries, bands, puzzles, primary, all: [...sets.values()].flat() };
}

export function requestExample(game: SiteGame | undefined, model: string): { request: string; response: string } {
  const chess = new Chess();
  const history: string[] = [];
  let ply = game ? game.j.findIndex((x, i) => x !== null && i >= game.book) : -1;
  const sans = game && ply >= 0 ? game.san.slice(0, ply) : ["e4", "e5", "Nf3", "Nc6"];
  for (const s of sans) history.push(chess.move(s).san);
  const pos = positionOf(chess, START_FEN, history);
  const v = VARIANTS[HEADLINE]!;
  const state = renderState(pos, v.state)[0];
  const shown = 3;
  const criteria: Record<string, string> = Object.fromEntries(pos.moves.slice(0, shown).map((m) => [m.san, describeMove(m)]));
  if (pos.moves.length > shown) criteria["..."] = `${pos.moves.length - shown} more legal moves, one key each`;
  const body = { model, state, questions: { q0: { type: "choice", instructions: v.instructions[0], criteria } } };
  const request = ["POST https://api.typesafe.ai/v1/systemone", "Authorization: Bearer $TYPESAFE_API_KEY", "Content-Type: application/json", "", JSON.stringify(body, null, 2)].join("\n");
  const jp = game && ply >= 0 ? game.j[ply] : null;
  const top = jp?.t ?? [];
  const answer = {
    model,
    answers: {
      q0: {
        type: "choice",
        choice: game && ply >= 0 ? game.san[ply] : top[0]?.[0] ?? pos.legal[0],
        probabilities: Object.fromEntries([...top.map(([s, p]) => [s, p]), ["...", `${pos.moves.length - top.length} more, summing to 1`]]),
        confidence: jp?.c ?? 0,
      },
    },
    usage: { input_tokens: jp?.k ?? 0 },
  };
  return { request, response: JSON.stringify(answer, null, 2) };
}

export function buildSiteData(gameFiles: GameFile[], puzzleFiles: PuzzleFile[], opts: BuildOptions = {}): SiteData {
  const games = collectGames(gameFiles);
  const opponents = new Map<string, Opponent>();
  for (const g of games) if (!opponents.has(g.opp)) opponents.set(g.opp, opponentOf(g.opp));
  games.sort((a, b) => opponents.get(a.opp)!.order - opponents.get(b.opp)!.order || a.prompt.localeCompare(b.prompt) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  const p = puzzleViews(puzzleFiles, opts.bootstrapSamples ?? 1000);
  const primary = p.summaries[0];
  const gameMoves = games.flatMap((g) => g.j.filter((x): x is JevPly => x !== null));
  const allGameRows = gameFiles.flatMap((f) => latest(f.rows)).filter((r) => !r.error && r.result !== "*" && (isJev(r.white) || isJev(r.black)));
  const illegal =
    allGameRows.reduce((s, r) => s + r.moves.filter((m) => m.invalid).length, 0) + p.all.reduce((s, r) => s + r.steps.filter((x) => x.invalid).length, 0);
  const calls = allGameRows.reduce((s, r) => s + r.jevCalls, 0) + p.all.reduce((s, r) => s + r.jevCalls, 0);
  const tokens = allGameRows.reduce((s, r) => s + r.inputTokens, 0) + p.all.reduce((s, r) => s + r.inputTokens, 0);
  const latencies = [...gameMoves.map((m) => m.l), ...p.all.flatMap((r) => r.steps.map((s) => s.requestMs ?? s.latencyMs ?? 0))].filter((x) => x > 0);
  const models = [...new Set([...allGameRows.map((r) => r.model), ...p.all.map((r) => r.model)].filter((m): m is string => !!m))].sort();
  const featured = pickFeatured(games, opponents, opts.featured);
  const example = requestExample(games[featured], models.at(-1) ?? "jev-latest");
  return {
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    headline: {
      puzzle: primary ? { ...primary.fit, n: primary.n, prompt: primary.prompt } : null,
      games: games.length,
      opponents: opponents.size,
      puzzles: p.all.length,
      costUsd: costUsd(tokens),
      tokens,
      calls,
      illegal,
      medianLatencyMs: latencies.length ? Math.round(median(latencies)) : 0,
      models,
    },
    opponents: [...opponents.values()].sort((a, b) => a.order - b.order),
    prompts: [...new Set(games.map((g) => g.prompt))],
    games,
    featured,
    results: resultRows(games, opponents),
    puzzleSets: p.summaries,
    primaryPrompt: p.primary,
    bands: p.bands,
    bandSize: TABLE_BAND,
    puzzles: p.puzzles,
    puzzleBand: BAND,
    request: example.request,
    response: example.response,
  };
}
