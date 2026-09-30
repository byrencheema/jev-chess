import { Chess } from "chess.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Agent } from "./agents.ts";
import { positionOf, type MoveLog } from "./game.ts";
import { readLines } from "./lines.ts";
import { hashString } from "./rng.ts";

export const PUZZLE_DB = "data/lichess_db_puzzle.csv.zst";

export interface Puzzle {
  id: string;
  fen: string;
  moves: string[];
  rating: number;
  rd: number;
  popularity: number;
  plays: number;
  themes: string[];
  url: string;
}

export function parsePuzzle(line: string): Puzzle | null {
  const f = line.split(",");
  if (f.length < 9 || f[0] === "PuzzleId") return null;
  return {
    id: f[0]!,
    fen: f[1]!,
    moves: f[2]!.split(" "),
    rating: Number(f[3]),
    rd: Number(f[4]),
    popularity: Number(f[5]),
    plays: Number(f[6]),
    themes: f[7] ? f[7].split(" ") : [],
    url: f[8]!,
  };
}

export interface SampleOptions {
  seed: number;
  perBand: number;
  band: number;
  minRating: number;
  maxRating: number;
  maxRd: number;
  minPlays: number;
}

export const DEFAULT_SAMPLE: SampleOptions = { seed: 1, perBand: 5, band: 100, minRating: 600, maxRating: 2600, maxRd: 80, minPlays: 500 };

export interface PuzzleSet {
  sample: Partial<SampleOptions>;
  dir: string;
  exclude?: string;
}

export const PUZZLE_SETS: Record<string, PuzzleSet> = {
  eval: { sample: { seed: 1, perBand: 50 }, dir: "results/raw" },
  dev: { sample: { seed: 2, perBand: 15 }, dir: "results/dev", exclude: "eval" },
};

export function bandOf(rating: number, band: number): number {
  return Math.floor(rating / band) * band;
}

export class Sampler {
  private bands = new Map<number, { key: number; puzzle: Puzzle }[]>();
  seen = 0;
  eligible = 0;

  constructor(
    readonly opts: SampleOptions,
    readonly exclude: Set<string> = new Set(),
  ) {}

  add(p: Puzzle) {
    this.seen++;
    const o = this.opts;
    if (this.exclude.has(p.id)) return;
    if (!(p.rd < o.maxRd && p.plays > o.minPlays && p.rating >= o.minRating && p.rating < o.maxRating)) return;
    this.eligible++;
    const b = bandOf(p.rating, o.band);
    const key = hashString(`${o.seed}:${p.id}`);
    const kept = this.bands.get(b) ?? [];
    if (kept.length >= o.perBand && key >= kept.at(-1)!.key) return;
    let i = kept.length;
    while (i > 0 && kept[i - 1]!.key > key) i--;
    kept.splice(i, 0, { key, puzzle: p });
    if (kept.length > o.perBand) kept.pop();
    this.bands.set(b, kept);
  }

  result(): Puzzle[] {
    return [...this.bands.keys()].sort((a, b) => a - b).flatMap((b) => this.bands.get(b)!.map((k) => k.puzzle));
  }
}

export function samplePath(o: SampleOptions): string {
  return `data/puzzles-seed${o.seed}-${o.minRating}-${o.maxRating}-band${o.band}x${o.perBand}-rd${o.maxRd}-plays${o.minPlays}.json`;
}

export async function samplePuzzles(o: SampleOptions, exclude: Puzzle[] = [], db = PUZZLE_DB): Promise<Puzzle[]> {
  const cached = exclude.length ? samplePath(o).replace(/\.json$/, `-excluding${hashString(exclude.map((p) => p.id).join()).toString(16)}.json`) : samplePath(o);
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, "utf8")) as Puzzle[];
  if (!existsSync(db)) throw new Error(`${db} not found; download https://database.lichess.org/lichess_db_puzzle.csv.zst`);
  const proc = Bun.spawn(["zstd", "-dc", db], { stdout: "pipe" });
  const sampler = new Sampler(o, new Set(exclude.map((p) => p.id)));
  await readLines(proc.stdout, (l) => {
    const p = parsePuzzle(l);
    if (p) sampler.add(p);
  });
  const puzzles = sampler.result();
  mkdirSync(dirname(cached), { recursive: true });
  writeFileSync(cached, JSON.stringify(puzzles));
  return puzzles;
}

export interface PuzzleStep extends Omit<MoveLog, "player" | "book"> {
  expected: string;
  expectedSan: string;
  correct: boolean;
  mateAlternative?: boolean;
}

export interface PuzzleResult {
  id: string;
  rating: number;
  rd: number;
  plays: number;
  themes: string[];
  solved: boolean;
  firstMoveCorrect: boolean;
  solverMoves: number;
  steps: PuzzleStep[];
  jevCalls: number;
  inputTokens: number;
  model?: string;
  prompt?: string;
  error?: string;
}

export async function solvePuzzle(agent: Agent, p: Puzzle): Promise<PuzzleResult> {
  const chess = new Chess(p.fen);
  const history = [chess.move(p.moves[0]!).san];
  const steps: PuzzleStep[] = [];
  let jevCalls = 0;
  let inputTokens = 0;
  let model: string | undefined;
  let solved = true;
  let error: string | undefined;
  try {
    for (let i = 1; i < p.moves.length; i += 2) {
      const expected = p.moves[i]!;
      const expectedSan = new Chess(chess.fen()).move(expected).san;
      const pos = positionOf(chess, p.fen, history);
      const moveNumber = chess.moveNumber();
      const d = await agent.choose(pos);
      jevCalls += agent.kind === "jev" ? d.calls : 0;
      inputTokens += d.inputTokens;
      if (d.model) model = d.model;
      const m = chess.move(d.san);
      history.push(m.san);
      const mate = chess.isCheckmate();
      const correct = m.lan === expected || mate;
      const { san: _san, ...rest } = d;
      steps.push({
        ply: history.length,
        moveNumber,
        color: m.color,
        fen: pos.fen,
        san: m.san,
        uci: m.lan,
        legal: pos.legal.length,
        expected,
        expectedSan,
        correct,
        ...(mate && m.lan !== expected ? { mateAlternative: true } : {}),
        ...rest,
      });
      if (!correct) {
        solved = false;
        break;
      }
      if (mate) break;
      const reply = p.moves[i + 1];
      if (reply) history.push(chess.move(reply).san);
    }
  } catch (err) {
    solved = false;
    error = err instanceof Error ? err.message : String(err);
  }
  return {
    id: p.id,
    rating: p.rating,
    rd: p.rd,
    plays: p.plays,
    themes: p.themes,
    solved,
    firstMoveCorrect: steps[0]?.correct ?? false,
    solverMoves: Math.floor(p.moves.length / 2),
    steps,
    jevCalls,
    inputTokens,
    model,
    prompt: agent.prompt,
    error,
  };
}
