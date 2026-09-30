import { Chess } from "chess.js";
import { LC0_PATH, MAIA_DIR, STOCKFISH_PATH, jevConfig, type JevOptions } from "./config.ts";
import { JevClient, type ChoiceQuestion, type Criterion } from "./jev.ts";
import { describeMove, describeMoveObject, HEADLINE, promptId, renderState, VARIANTS, X3_STATES, type Position, type PromptVariant } from "./prompt.ts";
import { seeded, shuffle, type Rng } from "./rng.ts";
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
  prompt?: string;
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

export interface JevRead {
  probabilities: Record<string, number>;
  choice: string;
  confidence: number;
  inputTokens: number;
  latencyMs: number;
  requestMs: number;
  model?: string;
  stateVariant: number;
  invalid?: string;
}

export async function askJev(client: JevClient, variant: PromptVariant, pos: Position): Promise<JevRead> {
  const moves = variant.shuffle ? shuffle(pos.moves, seeded(`order:${pos.fen}`)) : pos.moves;
  const sanOf = new Map(moves.map((m) => [variant.keys === "uci" ? m.uci : m.san, m.san]));
  const criteria: Record<string, Criterion> = {};
  for (const m of moves) criteria[variant.keys === "uci" ? m.uci : m.san] = variant.describe === "object" ? describeMoveObject(m) : variant.describe ? describeMove(m) : null;
  const questions: Record<string, ChoiceQuestion> = {};
  variant.instructions.forEach((instructions, i) => (questions[`q${i}`] = { type: "choice", instructions, criteria }));
  const r = await client.ask(renderState(pos, variant.state), questions);
  const answers = Object.values(r.answers);
  const probabilities: Record<string, number> = {};
  let invalid: string | undefined;
  for (const a of answers) {
    for (const [key, p] of Object.entries(a.probabilities)) {
      const san = sanOf.get(key);
      if (san) probabilities[san] = (probabilities[san] ?? 0) + p / answers.length;
    }
    if (!sanOf.has(a.choice)) invalid = a.choice;
  }
  const single = answers.length === 1 ? sanOf.get(answers[0]!.choice) : undefined;
  const choice = single ?? topProbabilities(probabilities, 1)[0]?.move ?? pos.legal[0]!;
  const confidence = answers.reduce((c, a) => c + a.confidence, 0) / answers.length;
  return { probabilities, choice, confidence, inputTokens: r.inputTokens, latencyMs: r.latencyMs, requestMs: r.requestMs, model: r.model, stateVariant: r.stateVariant, invalid };
}

function decisionFrom(r: JevRead, calls: number): Decision {
  return {
    san: r.choice,
    calls,
    inputTokens: r.inputTokens,
    latencyMs: r.latencyMs,
    requestMs: r.requestMs,
    top: topProbabilities(r.probabilities),
    confidence: r.confidence,
    model: r.model,
    stateVariant: r.stateVariant,
    invalid: r.invalid,
  };
}

export class JevAgent implements Agent {
  readonly kind = "jev";

  constructor(
    readonly client: JevClient,
    readonly variant: PromptVariant = VARIANTS[HEADLINE]!,
    readonly name = "jev",
  ) {}

  get prompt(): string {
    return promptId(this.variant);
  }

  async choose(pos: Position): Promise<Decision> {
    if (pos.legal.length === 1) return forced(pos.legal[0]!);
    return decisionFrom(await askJev(this.client, this.variant, pos), 1);
  }
}

export class JevEnsembleAgent implements Agent {
  readonly kind = "jev";

  constructor(
    readonly client: JevClient,
    readonly variants: PromptVariant[],
    readonly name: string,
  ) {}

  get prompt(): string {
    return this.variants.map(promptId).join("+");
  }

  async choose(pos: Position): Promise<Decision> {
    if (pos.legal.length === 1) return forced(pos.legal[0]!);
    const reads = await Promise.all(this.variants.map((v) => askJev(this.client, v, pos)));
    const probabilities: Record<string, number> = {};
    for (const r of reads) for (const [san, p] of Object.entries(r.probabilities)) probabilities[san] = (probabilities[san] ?? 0) + p / reads.length;
    const merged: JevRead = {
      probabilities,
      choice: topProbabilities(probabilities, 1)[0]?.move ?? pos.legal[0]!,
      confidence: reads.reduce((c, r) => c + r.confidence, 0) / reads.length,
      inputTokens: reads.reduce((t, r) => t + r.inputTokens, 0),
      latencyMs: Math.max(...reads.map((r) => r.latencyMs)),
      requestMs: Math.max(...reads.map((r) => r.requestMs)),
      model: reads[0]!.model,
      stateVariant: Math.max(...reads.map((r) => r.stateVariant)),
      invalid: reads.find((r) => r.invalid)?.invalid,
    };
    return decisionFrom(merged, reads.length);
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
    case "jev": {
      const client = deps.jev?.() ?? new JevClient(jevConfig());
      if (!params) return new JevAgent(client);
      const v = VARIANTS[params];
      if (!v) throw new Error(`unknown jev variant ${params}; one of ${Object.keys(VARIANTS).join(", ")}`);
      return new JevAgent(client, v, spec);
    }
    case "jev-v0":
      return new JevAgent(deps.jev?.() ?? new JevClient(jevConfig()), VARIANTS.v0!, "jev-v0");
    case "jev-x3": {
      const base = VARIANTS.v0!;
      return new JevEnsembleAgent(deps.jev?.() ?? new JevClient(jevConfig()), X3_STATES.map((state, i) => ({ ...base, name: `x3-${i}`, state })), "jev-x3");
    }
    case "random":
      return new RandomAgent(`${params ?? "0"}:${deps.seed ?? ""}`);
    case "stockfish":
      return new EngineAgent("stockfish", spec, stockfishSpec(params));
    case "maia":
      return new EngineAgent("maia", spec, maiaSpec(params));
    default:
      throw new Error(`unknown agent ${spec}; use jev, jev-v0, jev-x3, jev:<variant>, random[:seed], stockfish[:elo|skill=N,movetime=ms,nodes=N,depth=N] or maia:1100|1500|1900`);
  }
}

export function sharedJev(opts: JevOptions = {}): () => JevClient {
  let client: JevClient | undefined;
  return () => (client ??= new JevClient(jevConfig(opts)));
}
