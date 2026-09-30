import { Chess } from "chess.js";

export interface Replay {
  fens: string[];
  moves: { from: string; to: string; color: "w" | "b" }[];
  checks: (string | null)[];
}

function kingSquare(chess: Chess): string | null {
  const turn = chess.turn();
  for (const row of chess.board()) for (const p of row) if (p && p.type === "k" && p.color === turn) return p.square;
  return null;
}

export function replay(sans: string[], startFen?: string): Replay {
  const chess = startFen ? new Chess(startFen) : new Chess();
  const fens = [chess.fen()];
  const checks: (string | null)[] = [null];
  const moves: Replay["moves"] = [];
  for (const san of sans) {
    const m = chess.move(san);
    moves.push({ from: m.from, to: m.to, color: m.color });
    fens.push(chess.fen());
    checks.push(chess.inCheck() ? kingSquare(chess) : null);
  }
  return { fens, moves, checks };
}

const cache = new Map<string, { from: string; to: string } | null>();

export function squaresOf(fen: string, san: string): { from: string; to: string } | null {
  const key = `${fen}|${san}`;
  if (cache.has(key)) return cache.get(key)!;
  let out: { from: string; to: string } | null = null;
  try {
    const m = new Chess(fen).move(san);
    out = { from: m.from, to: m.to };
  } catch {
    out = null;
  }
  cache.set(key, out);
  return out;
}

export function checkSquare(fen: string): string | null {
  const chess = new Chess(fen);
  return chess.inCheck() ? kingSquare(chess) : null;
}
