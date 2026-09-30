import type { Subprocess } from "bun";
import { STOCKFISH_PATH } from "./config.ts";
import { readLines } from "./lines.ts";

export type Score = { cp: number } | { mate: number };

export interface SearchLimits {
  movetime?: number;
  nodes?: number;
  depth?: number;
}

export interface SearchResult {
  bestmove: string;
  score?: Score;
  depth?: number;
}

export function parseInfo(line: string): { depth?: number; multipv?: number; score?: Score } {
  const t = line.split(" ");
  const out: { depth?: number; multipv?: number; score?: Score } = {};
  for (let i = 1; i < t.length; i++) {
    if (t[i] === "depth") out.depth = Number(t[i + 1]);
    else if (t[i] === "multipv") out.multipv = Number(t[i + 1]);
    else if (t[i] === "score") {
      const kind = t[i + 1];
      const v = Number(t[i + 2]);
      if (kind === "cp") out.score = { cp: v };
      else if (kind === "mate") out.score = { mate: v };
    } else if (t[i] === "pv") break;
  }
  return out;
}

export class Engine {
  private proc: Subprocess<"pipe", "pipe", "ignore">;
  private buffer: string[] = [];
  private waiter?: () => void;
  private closed = false;
  name = "";

  constructor(cmd: string[] = [STOCKFISH_PATH]) {
    this.proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    void this.pump();
  }

  private async pump() {
    await readLines(this.proc.stdout, (l) => {
      if (l.trim()) this.buffer.push(l.trim());
      this.waiter?.();
    });
    this.closed = true;
    this.waiter?.();
  }

  private async nextLine(): Promise<string> {
    while (this.buffer.length === 0) {
      if (this.closed) throw new Error("stockfish exited");
      await new Promise<void>((resolve) => (this.waiter = resolve));
      this.waiter = undefined;
    }
    return this.buffer.shift()!;
  }

  private async until(prefix: string, onLine?: (line: string) => void): Promise<string> {
    for (;;) {
      const line = await this.nextLine();
      if (line.startsWith(prefix)) return line;
      onLine?.(line);
    }
  }

  send(cmd: string) {
    this.proc.stdin.write(`${cmd}\n`);
    this.proc.stdin.flush();
  }

  async init(options: Record<string, string | number | boolean> = {}): Promise<this> {
    this.send("uci");
    await this.until("uciok", (l) => {
      if (l.startsWith("id name ")) this.name = l.slice(8);
    });
    for (const [k, v] of Object.entries(options)) this.send(`setoption name ${k} value ${v}`);
    await this.ready();
    return this;
  }

  async ready() {
    this.send("isready");
    await this.until("readyok");
  }

  async newGame() {
    this.send("ucinewgame");
    await this.ready();
  }

  async go(fen: string, limits: SearchLimits): Promise<SearchResult> {
    this.send(`position fen ${fen}`);
    const parts = ["go"];
    if (limits.depth) parts.push("depth", String(limits.depth));
    if (limits.nodes) parts.push("nodes", String(limits.nodes));
    if (limits.movetime) parts.push("movetime", String(limits.movetime));
    if (parts.length === 1) parts.push("depth", "10");
    this.send(parts.join(" "));
    let score: Score | undefined;
    let depth: number | undefined;
    const line = await this.until("bestmove", (l) => {
      if (!l.startsWith("info ")) return;
      const info = parseInfo(l);
      if (info.score && (info.multipv ?? 1) === 1) {
        score = info.score;
        depth = info.depth;
      }
    });
    return { bestmove: line.split(" ")[1]!, score, depth };
  }

  async quit() {
    if (this.closed) return;
    this.send("quit");
    await this.proc.exited;
  }
}

export async function engineName(cmd: string[] = [STOCKFISH_PATH]): Promise<string> {
  const e = await new Engine(cmd).init();
  await e.quit();
  return e.name;
}
