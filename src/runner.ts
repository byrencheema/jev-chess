import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { makeAgent, type AgentDeps } from "./agents.ts";
import { playGame, type GameRecord, type MoveLog } from "./game.ts";
import { openingFor } from "./openings.ts";
import { INSTRUCTIONS } from "./prompt.ts";
import { hashString } from "./rng.ts";

export interface GameRow extends GameRecord {
  id: string;
  index: number;
  a: string;
  b: string;
  aColor: "white" | "black";
  scoreA: number | null;
  seed: number;
  prompt: string;
  engines: Record<string, string>;
  startedAt: string;
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

export function appendJsonl(path: string, row: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`);
}

export function latestById<T extends { id: string }>(rows: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of rows) out.set(r.id, r);
  return out;
}

export async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>, stop?: () => boolean) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop?.()) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
}

export const PROMPT_ID = hashString(INSTRUCTIONS).toString(16);

export function scoreFor(result: string, aColor: "white" | "black"): number | null {
  if (result === "1/2-1/2") return 0.5;
  if (result === "1-0") return aColor === "white" ? 1 : 0;
  if (result === "0-1") return aColor === "black" ? 1 : 0;
  return null;
}

export interface MatchOptions {
  a: string;
  b: string;
  games: number;
  concurrency: number;
  out: string;
  seed: number;
  openings: boolean;
  maxPlies?: number;
  budgetUsd?: number;
  engines?: Record<string, string>;
  deps?: AgentDeps;
  onMove?: (id: string, move: MoveLog) => void;
  onGame?: (row: GameRow, spent: number) => void;
}

export function gameId(a: string, b: string, index: number, seed: number, openings: boolean): string {
  return `${a} vs ${b} #${index} seed ${seed}${openings ? " book" : ""}`;
}

export async function runMatch(opts: MatchOptions): Promise<GameRow[]> {
  const done = latestById(readJsonl<GameRow>(opts.out));
  const todo: number[] = [];
  for (let i = 0; i < opts.games; i++) {
    const prev = done.get(gameId(opts.a, opts.b, i, opts.seed, opts.openings));
    if (!prev || prev.error) todo.push(i);
  }
  const rows: GameRow[] = [];
  let spent = 0;
  await pool(
    todo,
    opts.concurrency,
    async (index) => {
      const id = gameId(opts.a, opts.b, index, opts.seed, opts.openings);
      const aColor = index % 2 === 0 ? "white" : "black";
      const [whiteSpec, blackSpec] = aColor === "white" ? [opts.a, opts.b] : [opts.b, opts.a];
      const white = makeAgent(whiteSpec, { ...opts.deps, seed: `${opts.seed}:${index}:w` });
      const black = makeAgent(blackSpec, { ...opts.deps, seed: `${opts.seed}:${index}:b` });
      const startedAt = new Date().toISOString();
      try {
        const game = await playGame({
          white,
          black,
          opening: opts.openings ? openingFor(opts.seed, Math.floor(index / 2)) : undefined,
          maxPlies: opts.maxPlies,
          headers: { Round: String(index + 1) },
          onMove: (m) => opts.onMove?.(id, m),
        });
        const row: GameRow = {
          id,
          index,
          a: opts.a,
          b: opts.b,
          aColor,
          scoreA: scoreFor(game.result, aColor),
          seed: opts.seed,
          prompt: PROMPT_ID,
          engines: opts.engines ?? {},
          startedAt,
          ...game,
        };
        appendJsonl(opts.out, row);
        rows.push(row);
        spent += game.costUsd;
        opts.onGame?.(row, spent);
      } finally {
        await Promise.all([white.close?.(), black.close?.()]);
      }
    },
    () => opts.budgetUsd !== undefined && spent >= opts.budgetUsd,
  );
  return rows;
}
