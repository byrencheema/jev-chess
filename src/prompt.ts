import type { Instructions } from "./jev.ts";
import { hashString } from "./rng.ts";

export interface LegalMove {
  san: string;
  uci: string;
  piece: string;
  from: string;
  to: string;
  captured?: string;
  promotion?: string;
  flags: string;
}

export interface Position {
  fen: string;
  board: string;
  turn: "w" | "b";
  history: string[];
  startFen: string;
  legal: string[];
  moves: LegalMove[];
}

export type StateInput = Omit<Position, "legal" | "moves">;

export const INSTRUCTIONS = "Which of these legal moves is the strongest move for the side to move?";

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

const PIECE_NAMES: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const PIECE_ORDER = ["k", "q", "r", "b", "n", "p"];

export function pieceLists(fen: string): { white: string; black: string } {
  const squares: Record<string, string[]> = {};
  const rows = fen.split(" ")[0]!.split("/");
  rows.forEach((row, r) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        file += Number(ch);
        continue;
      }
      const sq = `${"abcdefgh"[file]}${8 - r}`;
      (squares[ch] ??= []).push(sq);
      file++;
    }
  });
  const side = (upper: boolean) =>
    PIECE_ORDER.flatMap((p) => {
      const key = upper ? p.toUpperCase() : p;
      const list = (squares[key] ?? []).sort();
      if (!list.length) return [];
      const name = PIECE_NAMES[p]!;
      return [`${list.length > 1 ? `${name}s` : name} ${list.join(" ")}`];
    }).join(", ");
  return { white: side(true), black: side(false) };
}

export interface StateSpec {
  fen: boolean;
  board: boolean;
  pieces: boolean;
  history: boolean;
  json: boolean;
}

export const V0_STATE: StateSpec = { fen: true, board: true, pieces: false, history: true, json: false };

function sideName(turn: "w" | "b") {
  return turn === "w" ? "White" : "Black";
}

function renderText(pos: StateInput, spec: StateSpec, history: string | null): string {
  const lines: string[] = [];
  if (spec.fen) lines.push(`FEN: ${pos.fen}`);
  lines.push(`Side to move: ${sideName(pos.turn)}`);
  if (spec.board) lines.push("Board (uppercase is White, lowercase is Black):", pos.board.trimEnd());
  if (spec.pieces) {
    const p = pieceLists(pos.fen);
    lines.push(`White pieces: ${p.white}`, `Black pieces: ${p.black}`);
  }
  if (history !== null) lines.push(history);
  return lines.join("\n");
}

function renderJson(pos: StateInput, spec: StateSpec, history: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (spec.fen) out.fen = pos.fen;
  out.side_to_move = sideName(pos.turn).toLowerCase();
  if (spec.board) out.board = pos.board.trimEnd().split("\n");
  if (spec.pieces) {
    const p = pieceLists(pos.fen);
    out.white_pieces = p.white;
    out.black_pieces = p.black;
  }
  if (history !== null) out.moves_so_far = history;
  return out;
}

export function renderState(pos: StateInput, spec: StateSpec): unknown[] {
  const render = (h: string | null) => (spec.json ? renderJson(pos, spec, h) : renderText(pos, spec, h));
  const variants: unknown[] = [];
  if (spec.history) {
    const full = pos.history.length ? formatMoves(pos.history, pos.startFen) : "(none)";
    variants.push(render(spec.json ? full : `Moves so far: ${full}`));
    if (pos.history.length > HISTORY_TAIL) {
      const tail = `... ${formatMoves(pos.history, pos.startFen, pos.history.length - HISTORY_TAIL)}`;
      variants.push(render(spec.json ? tail : `Last moves: ${tail}`));
    }
  }
  variants.push(render(null));
  const minimal = `FEN: ${pos.fen}\nSide to move: ${sideName(pos.turn)}`;
  if (!variants.some((v) => v === minimal)) variants.push(minimal);
  return variants;
}

export function stateVariants(pos: StateInput): string[] {
  return renderState(pos, V0_STATE) as string[];
}

export function describeMove(m: LegalMove): string {
  const check = m.san.endsWith("#") ? ", checkmate" : m.san.endsWith("+") ? ", check" : "";
  if (m.flags.includes("k")) return `king castles kingside${check}`;
  if (m.flags.includes("q")) return `king castles queenside${check}`;
  const piece = PIECE_NAMES[m.piece]!;
  const action = m.captured ? `takes ${PIECE_NAMES[m.captured]} ${m.to}${m.flags.includes("e") ? " en passant" : ""}` : `to ${m.to}`;
  const promo = m.promotion ? `, promotes to ${PIECE_NAMES[m.promotion]}` : "";
  return `${piece} ${m.from} ${action}${promo}${check}`;
}

export function describeMoveObject(m: LegalMove): Record<string, string> {
  const out: Record<string, string> = {};
  if (m.flags.includes("k") || m.flags.includes("q")) out.castles = m.flags.includes("k") ? "kingside" : "queenside";
  else {
    out.piece = PIECE_NAMES[m.piece]!;
    out.from = m.from;
    out.to = m.to;
  }
  if (m.captured) out.captures = PIECE_NAMES[m.captured]!;
  if (m.promotion) out.promotes_to = PIECE_NAMES[m.promotion]!;
  if (m.san.endsWith("#")) out.gives = "checkmate";
  else if (m.san.endsWith("+")) out.gives = "check";
  return out;
}

export interface PromptVariant {
  name: string;
  instructions: Instructions[];
  state: StateSpec;
  keys: "san" | "uci";
  describe: boolean | "object";
  shuffle: boolean;
}

const V0: PromptVariant = { name: "v0", instructions: [INSTRUCTIONS], state: V0_STATE, keys: "san", describe: false, shuffle: false };

const GRANDMASTER = "You are a chess grandmaster playing the side to move. Which move do you play?";
const STRUCTURED = {
  question: "Which move is best for the side to move?",
  focus: "Look for checkmate first, then moves that win material, then moves that improve the position without giving material away.",
};

function variant(name: string, change: Partial<PromptVariant>): PromptVariant {
  return { ...V0, ...change, name };
}

export const VARIANTS: Record<string, PromptVariant> = Object.fromEntries(
  [
    V0,
    variant("grandmaster", { instructions: [GRANDMASTER] }),
    variant("structured", { instructions: [STRUCTURED] }),
    variant("fen-only", { state: { ...V0_STATE, board: false, history: false } }),
    variant("no-history", { state: { ...V0_STATE, history: false } }),
    variant("no-fen", { state: { ...V0_STATE, fen: false } }),
    variant("pieces", { state: { ...V0_STATE, pieces: true } }),
    variant("pieces-no-board", { state: { ...V0_STATE, board: false, pieces: true } }),
    variant("json", { state: { ...V0_STATE, json: true } }),
    variant("uci", { keys: "uci" }),
    variant("describe", { describe: true }),
    variant("shuffle", { shuffle: true }),
    variant("three-questions", { instructions: [INSTRUCTIONS, GRANDMASTER, STRUCTURED] }),
    variant("describe-object", { describe: "object" }),
    variant("describe-pieces", { describe: true, state: { ...V0_STATE, pieces: true } }),
    variant("describe-pieces-no-board", { describe: true, state: { ...V0_STATE, board: false, pieces: true } }),
    variant("describe-structured", { describe: true, instructions: [STRUCTURED] }),
    variant("describe-structured-pieces-no-board", { describe: true, instructions: [STRUCTURED], state: { ...V0_STATE, board: false, pieces: true } }),
    variant("describe-three-questions", { describe: true, instructions: [INSTRUCTIONS, GRANDMASTER, STRUCTURED] }),
  ].map((v) => [v.name, v]),
);

export const HEADLINE = "v0";

export function promptId(v: PromptVariant): string {
  return hashString(JSON.stringify({ ...v, name: undefined })).toString(16);
}

export const X3_STATES: StateSpec[] = [V0_STATE, { ...V0_STATE, board: false, pieces: true }, { ...V0_STATE, json: true }];
