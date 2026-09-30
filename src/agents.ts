import { Chess } from "chess.js";
import { LC0_PATH, MAIA_DIR, STOCKFISH_PATH, jevConfig, type JevOptions } from "./config.ts";
import { JevClient } from "./jev.ts";
import { INSTRUCTIONS, stateVariants, type Position } from "./prompt.ts";
import { seeded, type Rng } from "./rng.ts";
import { Engine, type Score, type SearchLimits } from "./uci.ts";

export interface Decision {
  san: string;
  calls: number;
  inputTokens: number;
  latencyMs: number;
  requestMs?: number;
  top?: { move: string; p: number }[];
  confidence?: number;
  model?: string;
  stateVariant?: number;
  invalid?: string;
  forced?: boolean;
  score?: Score;
}

export interface Agent {
  name: string;
  kind: "jev" | "random" | "stockfish" | "maia";
  choose(pos: Position): Promise<Decision>;
  close?(): Promise<void>;
}

export const TOP_N = 5;

export function topProbabilities(probs: Record<string, number>, n = TOP_N): { move: string; p: number }[] {
  return Object.entries(probs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([move, p]) => ({ move, p }));
}

function forced(san: string): Decision {
  return { san, calls: 0, inputTokens: 0, latencyMs: 0, forced: true };
}

export class JevAgent implements Agent {
  readonly kind = "jev";
  readonly name = "jev";

  constructor(readonly client: JevClient) {}

  async choose(pos: Position): Promise<Decision> {
    if (pos.legal.length === 1) return forced(pos.legal[0]!);
    const c = await this.client.choose(stateVariants(pos), INSTRUCTIONS, pos.legal);
    const top = topProbabilities(c.probabilities);
    let san = c.choice;
    let invalid: string | undefined;
    if (!pos.legal.includes(san)) {
      invalid = san;
      san = topProbabilities(c.probabilities, Infinity).find((t) => pos.legal.includes(t.move))?.move ?? pos.legal[0]!;
    }
    return {
      san,
      calls: 1,
      inputTokens: c.inputTokens,
      latencyMs: c.latencyMs,
      requestMs: c.requestMs,
      top,
      confidence: c.confidence,
      model: c.model,
      stateVariant: c.stateVariant,
      invalid,
    };
  }
}

export class RandomAgent implements Agent {
  readonly kind = "random";
  readonly name: string;
  private rng: Rng;

  constructor(seed: string) {
    this.name = "random";
    this.rng = seeded(`random:${seed}`);
  }

  async choose(pos: Position): Promise<Decision> {
    const san = pos.legal[Math.floor(this.rng() * pos.legal.length)]!;
    return { san, calls: 0, inputTokens: 0, latencyMs: 0 };
  }
}

export interface EngineSpec {
  cmd: string[];
  options: Record<string, string | number | boolean>;
  limits: SearchLimits;
}

export class EngineAgent implements Agent {
  private engine?: Promise<Engine>;

  constructor(
    readonly kind: "stockfish" | "maia",
    readonly name: string,
    readonly spec: EngineSpec,
  ) {}

  private start(): Promise<Engine> {
    this.engine ??= new Engine(this.spec.cmd).init(this.spec.options).then(async (e) => {
      await e.newGame();
      return e;
    });
    return this.engine;
  }

  async choose(pos: Position): Promise<Decision> {
    const engine = await this.start();
    const t0 = performance.now();
    const r = await engine.go(pos.fen, this.spec.limits);
    const move = new Chess(pos.fen).move(r.bestmove);
    return { san: move.san, calls: 0, inputTokens: 0, latencyMs: performance.now() - t0, score: r.score };
  }

  async close() {
    if (this.engine) await (await this.engine).quit();
  }
}

export function parseParams(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s) return out;
  for (const part of s.split(",")) {
    const [k, v] = part.split("=");
    if (v === undefined) out.elo = k!;
    else out[k!] = v;
  }
  return out;
}

function limitsFrom(p: Record<string, string>, fallback: SearchLimits): SearchLimits {
  const limits: SearchLimits = {};
  if (p.movetime) limits.movetime = Number(p.movetime);
  if (p.nodes) limits.nodes = Number(p.nodes);
  if (p.depth) limits.depth = Number(p.depth);
  return Object.keys(limits).length ? limits : fallback;
}

export function stockfishSpec(params: string | undefined): EngineSpec {
  const p = parseParams(params);
  const options: Record<string, string | number | boolean> = { Threads: 1, Hash: 16 };
  if (p.elo) {
    options.UCI_LimitStrength = true;
    options.UCI_Elo = Number(p.elo);
  }
  if (p.skill) options["Skill Level"] = Number(p.skill);
  return { cmd: [STOCKFISH_PATH], options, limits: limitsFrom(p, { movetime: 100 }) };
}

export function maiaSpec(params: string | undefined): EngineSpec {
  const p = parseParams(params);
  const rating = p.elo ?? "1500";
  return {
    cmd: [LC0_PATH],
    options: { WeightsFile: `${MAIA_DIR}/maia-${rating}.pb.gz`, Threads: 1 },
    limits: limitsFrom(p, { nodes: 1 }),
  };
}

export interface AgentDeps {
  jev?: () => JevClient;
  seed?: string;
}

export function makeAgent(spec: string, deps: AgentDeps = {}): Agent {
  const [kind, params] = spec.split(/:(.*)/s) as [string, string | undefined];
  switch (kind) {
    case "jev":
      return new JevAgent(deps.jev?.() ?? new JevClient(jevConfig()));
    case "random":
      return new RandomAgent(`${params ?? "0"}:${deps.seed ?? ""}`);
    case "stockfish":
      return new EngineAgent("stockfish", spec, stockfishSpec(params));
    case "maia":
      return new EngineAgent("maia", spec, maiaSpec(params));
    default:
      throw new Error(`unknown agent ${spec}; use jev, random[:seed], stockfish[:elo|skill=N,movetime=ms,nodes=N,depth=N] or maia:1100|1500|1900`);
  }
}

export function sharedJev(opts: JevOptions = {}): () => JevClient {
  let client: JevClient | undefined;
  return () => (client ??= new JevClient(jevConfig(opts)));
}
