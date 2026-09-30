export const INSTRUCTIONS = "Which of these legal moves is the strongest move for the side to move?";

export interface Position {
  fen: string;
  board: string;
  turn: "w" | "b";
  history: string[];
  startFen: string;
  legal: string[];
}

const HISTORY_TAIL = 40;

export function formatMoves(history: string[], startFen: string, from = 0): string {
  const [, side, , , , full] = startFen.split(" ");
  const blackFirst = side === "b";
  const startNumber = Number(full) || 1;
  const parts: string[] = [];
  for (let i = from; i < history.length; i++) {
    const ply = i + (blackFirst ? 1 : 0);
    const number = startNumber + Math.floor(ply / 2);
    if (ply % 2 === 0) parts.push(`${number}. ${history[i]}`);
    else parts.push(i === from ? `${number}... ${history[i]}` : history[i]!);
  }
  return parts.join(" ");
}

export function stateVariants(pos: Omit<Position, "legal">): string[] {
  const head = [
    `FEN: ${pos.fen}`,
    `Side to move: ${pos.turn === "w" ? "White" : "Black"}`,
    "Board (uppercase is White, lowercase is Black):",
    pos.board.trimEnd(),
  ].join("\n");
  const full = pos.history.length ? formatMoves(pos.history, pos.startFen) : "(none)";
  const variants = [`${head}\nMoves so far: ${full}`];
  if (pos.history.length > HISTORY_TAIL) {
    variants.push(`${head}\nLast moves: ... ${formatMoves(pos.history, pos.startFen, pos.history.length - HISTORY_TAIL)}`);
  }
  variants.push(head, `FEN: ${pos.fen}\nSide to move: ${pos.turn === "w" ? "White" : "Black"}`);
  return variants;
}
