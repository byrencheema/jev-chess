import { Chess } from "chess.js";
import type { Agent, Decision } from "./agents.ts";
import { MAX_PLIES } from "./config.ts";
import type { Opening } from "./openings.ts";
import type { Position } from "./prompt.ts";
import { costUsd } from "./stats.ts";

export type Termination = "checkmate" | "stalemate" | "threefold" | "fifty_move" | "insufficient_material" | "move_cap" | "error";
export type Result = "1-0" | "0-1" | "1/2-1/2" | "*";

export interface MoveLog extends Partial<Omit<Decision, "san">> {
  ply: number;
  moveNumber: number;
  color: "w" | "b";
  player: string;
  fen: string;
  san: string;
  uci: string;
  legal: number;
  book?: boolean;
}

export interface GameRecord {
  white: string;
  black: string;
  result: Result;
  termination: Termination;
  plies: number;
  pgn: string;
  opening?: string;
  jevCalls: number;
  inputTokens: number;
  costUsd: number;
  model?: string;
  durationMs: number;
  moves: MoveLog[];
  error?: string;
}

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function positionOf(chess: Chess, startFen: string, history: string[]): Position {
  return {
    fen: chess.fen(),
    board: chess.ascii(),
    turn: chess.turn(),
    history: [...history],
    startFen,
    legal: chess.moves(),
    moves: chess.moves({ verbose: true }).map((m) => ({ san: m.san, uci: m.lan, piece: m.piece, from: m.from, to: m.to, captured: m.captured, promotion: m.promotion, flags: m.flags })),
  };
}

export function terminationOf(chess: Chess): Termination | null {
  if (chess.isCheckmate()) return "checkmate";
  if (chess.isStalemate()) return "stalemate";
  if (chess.isInsufficientMaterial()) return "insufficient_material";
  if (chess.isThreefoldRepetition()) return "threefold";
  if (chess.isDrawByFiftyMoves()) return "fifty_move";
  return null;
}

export interface PlayOptions {
  white: Agent;
  black: Agent;
  opening?: Opening;
  maxPlies?: number;
  headers?: Record<string, string>;
  onMove?: (move: MoveLog, game: { inputTokens: number; jevCalls: number }) => void;
}

export async function playGame(opts: PlayOptions): Promise<GameRecord> {
  const t0 = performance.now();
  const maxPlies = opts.maxPlies ?? MAX_PLIES;
  const chess = new Chess();
  const history: string[] = [];
  const moves: MoveLog[] = [];
  let jevCalls = 0;
  let inputTokens = 0;
  let model: string | undefined;
  let termination: Termination | null = null;
  let error: string | undefined;

  const apply = (san: string, player: string, extra: Partial<MoveLog> = {}) => {
    const fen = chess.fen();
    const legal = chess.moves().length;
    const moveNumber = chess.moveNumber();
    const m = chess.move(san);
    history.push(m.san);
    const log: MoveLog = { ply: history.length, moveNumber, color: m.color, player, fen, san: m.san, uci: m.lan, legal, ...extra };
    moves.push(log);
    opts.onMove?.(log, { inputTokens, jevCalls });
  };

  for (const san of opts.opening?.moves ?? []) apply(san, "book", { book: true });

  try {
    while (!(termination = terminationOf(chess))) {
      if (history.length >= maxPlies) {
        termination = "move_cap";
        break;
      }
      const agent = chess.turn() === "w" ? opts.white : opts.black;
      const d = await agent.choose(positionOf(chess, START_FEN, history));
      jevCalls += agent.kind === "jev" ? d.calls : 0;
      inputTokens += d.inputTokens;
      if (d.model) model = d.model;
      const { san, ...rest } = d;
      apply(san, agent.name, rest);
    }
  } catch (err) {
    termination = "error";
    error = err instanceof Error ? err.message : String(err);
  }

  const result: Result =
    termination === "checkmate" ? (chess.turn() === "w" ? "0-1" : "1-0") : termination === "error" ? "*" : "1/2-1/2";
  const headers: Record<string, string> = {
    Event: "jev-chess",
    Date: new Date().toISOString().slice(0, 10).replaceAll("-", "."),
    White: opts.white.name,
    Black: opts.black.name,
    Result: result,
    Termination: termination,
    ...(opts.opening ? { Opening: opts.opening.name } : {}),
    ...opts.headers,
  };
  for (const [k, v] of Object.entries(headers)) chess.setHeader(k, v);
  return {
    white: opts.white.name,
    black: opts.black.name,
    result,
    termination,
    plies: history.length,
    pgn: chess.pgn(),
    opening: opts.opening?.name,
    jevCalls,
    inputTokens,
    costUsd: costUsd(inputTokens),
    model,
    durationMs: performance.now() - t0,
    moves,
    error,
  };
}
