import { Chess } from "chess.js";
import { BLUNDER_CP } from "./config.ts";
import type { MoveLog } from "./game.ts";
import { Engine, type Score, type SearchLimits } from "./uci.ts";

export const EVAL_CAP = 1000;

export function scoreToCp(score: Score | undefined): number {
  if (!score) return 0;
  if ("mate" in score) return score.mate > 0 ? EVAL_CAP : -EVAL_CAP;
  return Math.max(-EVAL_CAP, Math.min(EVAL_CAP, score.cp));
}

export function centipawnLoss(before: number, afterForOpponent: number): number {
  return Math.max(0, before + afterForOpponent);
}

export interface MoveAnalysis {
  ply: number;
  moveNumber: number;
  san: string;
  best: string;
  cpBefore: number;
  cpAfter: number;
  loss: number;
  blunder: boolean;
}

export interface GameAnalysis {
  id: string;
  game: string;
  player: string;
  color: "w" | "b";
  moves: MoveAnalysis[];
  acpl: number;
  blunders: number;
  bestMatches: number;
}

export class Evaluator {
  private cache = new Map<string, { cp: number; best: string }>();

  constructor(
    private readonly engine: Engine,
    private readonly limits: SearchLimits,
  ) {}

  async eval(fen: string): Promise<{ cp: number; best: string }> {
    const hit = this.cache.get(fen);
    if (hit) return hit;
    const chess = new Chess(fen);
    let out: { cp: number; best: string };
    if (chess.isCheckmate()) out = { cp: -EVAL_CAP, best: "" };
    else if (chess.isStalemate() || chess.isInsufficientMaterial()) out = { cp: 0, best: "" };
    else {
      const r = await this.engine.go(fen, this.limits);
      out = { cp: scoreToCp(r.score), best: chess.move(r.bestmove).san };
    }
    this.cache.set(fen, out);
    return out;
  }
}

export async function analyzeMoves(evaluator: Evaluator, moves: MoveLog[], player: (m: MoveLog) => boolean): Promise<MoveAnalysis[]> {
  const out: MoveAnalysis[] = [];
  for (const m of moves) {
    if (m.book || !player(m)) continue;
    const before = await evaluator.eval(m.fen);
    const next = new Chess(m.fen);
    next.move(m.san);
    const after = await evaluator.eval(next.fen());
    const loss = centipawnLoss(before.cp, after.cp);
    out.push({ ply: m.ply, moveNumber: m.moveNumber, san: m.san, best: before.best, cpBefore: before.cp, cpAfter: -after.cp, loss, blunder: loss >= BLUNDER_CP });
  }
  return out;
}

export function summarize(game: string, player: string, color: "w" | "b", moves: MoveAnalysis[]): GameAnalysis {
  const total = moves.reduce((s, m) => s + m.loss, 0);
  return {
    id: `${game}|${color}`,
    game,
    player,
    color,
    moves,
    acpl: moves.length ? total / moves.length : NaN,
    blunders: moves.filter((m) => m.blunder).length,
    bestMatches: moves.filter((m) => m.san === m.best).length,
  };
}

export const WINNING_CP = 300;

export interface LooseCheck {
  id: string;
  rating: number;
  step: number;
  fen: string;
  played: string;
  expected: string;
  cpAfterPlayed: number;
  cpAfterExpected: number;
  stillWinning: boolean;
}

export async function looseCheck(evaluator: Evaluator, r: { id: string; rating: number; solved: boolean; steps: { fen: string; san: string; expectedSan: string; correct: boolean }[] }): Promise<LooseCheck | null> {
  if (r.solved) return null;
  const i = r.steps.findIndex((s) => !s.correct);
  const step = r.steps[i];
  if (!step) return null;
  const after = (san: string) => {
    const c = new Chess(step.fen);
    c.move(san);
    return c.fen();
  };
  const played = -(await evaluator.eval(after(step.san))).cp;
  const expected = -(await evaluator.eval(after(step.expectedSan))).cp;
  return { id: r.id, rating: r.rating, step: i, fen: step.fen, played: step.san, expected: step.expectedSan, cpAfterPlayed: played, cpAfterExpected: expected, stillWinning: played >= WINNING_CP };
}
