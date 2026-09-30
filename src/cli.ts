import { basename } from "node:path";
import { parseArgs } from "node:util";
import { makeAgent, sharedJev } from "./agents.ts";
import { analyzeMoves, Evaluator, summarize, type GameAnalysis } from "./analysis.ts";
import { LC0_PATH, STOCKFISH_PATH } from "./config.ts";
import type { MoveLog } from "./game.ts";
import { OPENINGS } from "./openings.ts";
import { DEFAULT_SAMPLE, samplePuzzles, solvePuzzle, type PuzzleResult } from "./puzzles.ts";
import { appendJsonl, latestById, pool, readJsonl, runMatch, type GameRow } from "./runner.ts";
import { costUsd, formatUsd } from "./stats.ts";
import { gameSummary, puzzleSummary } from "./summary.ts";
import { Engine, engineName } from "./uci.ts";

const tty = process.stdout.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);

const USAGE = `usage:
  bun run play --white jev --black stockfish:1320 [--book] [--seed N] [--max-plies N] [--out file]
  bun run eval --a jev --b stockfish:1320 --games N [--concurrency N] [--book] [--seed N] [--budget usd] [--out file]
  bun run puzzles [--agent jev] [--per-band 5] [--band 100] [--min 600] [--max 2600] [--seed 1] [--concurrency N] [--budget usd] [--out file]
  bun run analyze <results/raw/file.jsonl> [--depth 14] [--player jev] [--out file]
  bun src/cli.ts summary <file.jsonl>...
agents: jev, random[:seed], stockfish[:elo | skill=N,movetime=ms,nodes=N,depth=N], maia:1100|1500|1900`;

function pct(p: number | undefined): string {
  return p === undefined ? "-" : `${Math.round(p * 100)}%`;
}

function slug(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
}

export function formatMove(m: MoveLog, spent: number): string {
  const n = m.color === "w" ? `${m.moveNumber}.` : `${m.moveNumber}...`;
  const head = `${n.padStart(5)} ${bold(m.san.padEnd(7))} ${dim(m.player.padEnd(16))}`;
  if (m.book) return `${head} ${dim("book")}`;
  if (m.forced) return `${head} ${dim("only legal move")}`;
  const parts: string[] = [];
  if (m.top) parts.push(`top ${m.top.slice(0, 3).map((t) => `${t.move} ${pct(t.p)}`).join(", ")}`, `conf ${pct(m.confidence)}`);
  if (m.invalid) parts.push(`returned ${m.invalid}, not legal`);
  if (m.score) parts.push("cp" in m.score ? `eval ${m.score.cp}` : `mate ${m.score.mate}`);
  if (m.calls) parts.push(`${m.legal} options`, `${m.inputTokens} tok`, `${((m.requestMs ?? m.latencyMs ?? 0) / 1000).toFixed(2)}s`, `total ${formatUsd(spent)}`);
  return `${head} ${dim(parts.join("  "))}`;
}

async function engines(specs: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (specs.some((s) => s.startsWith("stockfish"))) out.stockfish = await engineName([STOCKFISH_PATH]);
  if (specs.some((s) => s.startsWith("maia"))) out.lc0 = await engineName([LC0_PATH]);
  return out;
}

const COMMON = {
  model: { type: "string" },
  "base-url": { type: "string" },
  seed: { type: "string", default: "1" },
  concurrency: { type: "string", default: "4" },
  budget: { type: "string" },
  out: { type: "string" },
} as const;

async function play(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { ...COMMON, white: { type: "string", default: "jev" }, black: { type: "string", default: "random" }, book: { type: "boolean", default: false }, "max-plies": { type: "string" } },
  });
  const seed = Number(values.seed);
  const eng = await engines([values.white!, values.black!]);
  console.log(`${bold(values.white!)} ${dim("vs")} ${bold(values.black!)}  ${dim(Object.values(eng).join(", "))}`);
  let tokens = 0;
  const [row] = await runMatch({
    a: values.white!,
    b: values.black!,
    games: 1,
    concurrency: 1,
    seed,
    openings: values.book!,
    maxPlies: values["max-plies"] ? Number(values["max-plies"]) : undefined,
    out: values.out ?? "results/raw/play.jsonl",
    engines: eng,
    deps: { jev: sharedJev({ model: values.model, baseUrl: values["base-url"] }) },
    onMove: (_id, m) => {
      tokens += m.inputTokens ?? 0;
      console.log(formatMove(m, costUsd(tokens)));
    },
  });
  if (!row) {
    console.log("this game is already in the results file; pass --seed or --out to play another");
    return;
  }
  console.log(`\n${bold(`${row.result} by ${row.termination.replace("_", " ")}`)}  ${dim(`${row.plies} plies, ${row.jevCalls} jev calls, ${row.inputTokens.toLocaleString()} input tokens, ${formatUsd(row.costUsd)}, model ${row.model ?? "-"}`)}`);
  if (row.error) console.log(`error: ${row.error}`);
  console.log(row.pgn);
}

async function evalCmd(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { ...COMMON, a: { type: "string", default: "jev" }, b: { type: "string" }, games: { type: "string", default: "2" }, book: { type: "boolean", default: false }, "max-plies": { type: "string" }, verbose: { type: "boolean", default: false } },
  });
  if (!values.b) throw new Error("--b is required");
  const out = values.out ?? `results/raw/${slug(values.a!)}_vs_${slug(values.b)}.jsonl`;
  const eng = await engines([values.a!, values.b]);
  console.log(`${bold(values.a!)} vs ${bold(values.b)}, ${values.games} games${values.book ? `, openings from a ${OPENINGS.length}-line book` : ""} -> ${out}`);
  await runMatch({
    a: values.a!,
    b: values.b,
    games: Number(values.games),
    concurrency: Number(values.concurrency),
    seed: Number(values.seed),
    openings: values.book!,
    maxPlies: values["max-plies"] ? Number(values["max-plies"]) : undefined,
    budgetUsd: values.budget ? Number(values.budget) : undefined,
    out,
    engines: eng,
    deps: { jev: sharedJev({ model: values.model, baseUrl: values["base-url"] }) },
    onMove: values.verbose ? (id, m) => console.log(dim(`[${id}]`), formatMove(m, 0)) : undefined,
    onGame: (r, spent) =>
      console.log(`#${r.index} ${r.white} - ${r.black}  ${bold(r.result)} ${r.termination} in ${r.plies} plies  ${dim(`${r.jevCalls} calls, ${formatUsd(r.costUsd)}, run total ${formatUsd(spent)}`)}${r.error ? ` error: ${r.error}` : ""}`),
  });
  console.log(gameSummary(readJsonl<GameRow>(out)));
}

async function puzzles(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      ...COMMON,
      agent: { type: "string", default: "jev" },
      "per-band": { type: "string" },
      band: { type: "string" },
      min: { type: "string" },
      max: { type: "string" },
      "max-rd": { type: "string" },
      "min-plays": { type: "string" },
    },
  });
  const d = DEFAULT_SAMPLE;
  const opts = {
    seed: Number(values.seed),
    perBand: Number(values["per-band"] ?? d.perBand),
    band: Number(values.band ?? d.band),
    minRating: Number(values.min ?? d.minRating),
    maxRating: Number(values.max ?? d.maxRating),
    maxRd: Number(values["max-rd"] ?? d.maxRd),
    minPlays: Number(values["min-plays"] ?? d.minPlays),
  };
  const t0 = performance.now();
  const sample = await samplePuzzles(opts);
  console.log(dim(`${sample.length} puzzles sampled in ${((performance.now() - t0) / 1000).toFixed(1)}s`));
  const out = values.out ?? `results/raw/puzzles-${slug(values.agent!)}-seed${opts.seed}-${opts.minRating}-${opts.maxRating}x${opts.perBand}.jsonl`;
  const done = latestById(readJsonl<PuzzleResult>(out));
  const todo = sample.filter((p) => !done.get(p.id) || done.get(p.id)!.error);
  const jev = sharedJev({ model: values.model, baseUrl: values["base-url"] });
  const budget = values.budget ? Number(values.budget) : Infinity;
  let spent = 0;
  let n = 0;
  await pool(
    todo,
    Number(values.concurrency),
    async (p) => {
      const agent = makeAgent(values.agent!, { jev, seed: `${opts.seed}:${p.id}` });
      try {
        const r = await solvePuzzle(agent, p);
        appendJsonl(out, { ...r, agent: values.agent, seed: opts.seed });
        spent += costUsd(r.inputTokens);
        n++;
        const line = r.steps.map((s) => (s.correct ? s.san : `${s.san} (want ${s.expectedSan})`)).join(" ");
        console.log(`${String(n).padStart(4)} ${p.id} ${String(p.rating).padStart(4)} ${r.solved ? bold("solved") : "failed"}  ${line}  ${dim(`total ${formatUsd(spent)}`)}${r.error ? ` error: ${r.error}` : ""}`);
      } finally {
        await agent.close?.();
      }
    },
    () => spent >= budget,
  );
  console.log(puzzleSummary(readJsonl<PuzzleResult>(out)));
}

async function analyze(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { depth: { type: "string", default: "14" }, nodes: { type: "string" }, player: { type: "string", default: "jev" }, out: { type: "string" } },
  });
  const file = positionals[0];
  if (!file) throw new Error("give a results/raw/*.jsonl file");
  const out = values.out ?? `results/analysis/${basename(file)}`;
  const limits = values.nodes ? { nodes: Number(values.nodes) } : { depth: Number(values.depth) };
  const rows = [...latestById(readJsonl<GameRow>(file)).values()].filter((r) => !r.error);
  const done = latestById(readJsonl<GameAnalysis>(out));
  const engine = await new Engine([STOCKFISH_PATH]).init({ Threads: 4, Hash: 256 });
  const evaluator = new Evaluator(engine, limits);
  for (const r of rows) {
    for (const color of ["w", "b"] as const) {
      const name = color === "w" ? r.white : r.black;
      if (name !== values.player || done.has(`${r.id}|${color}`)) continue;
      const a = summarize(r.id, name, color, await analyzeMoves(evaluator, r.moves, (m) => m.color === color));
      appendJsonl(out, a);
      done.set(a.id, a);
      console.log(`${r.id} (${color === "w" ? "white" : "black"})  acpl ${a.acpl.toFixed(0)}  blunders ${a.blunders}/${a.moves.length}  best-move matches ${a.bestMatches}`);
    }
  }
  await engine.quit();
  const all = [...done.values()].filter((a) => rows.some((r) => r.id === a.game)).flatMap((a) => a.moves);
  const loss = all.reduce((s, m) => s + m.loss, 0);
  console.log(
    `\n${values.player}: ${all.length} moves, acpl ${(loss / all.length).toFixed(0)}, blunders ${all.filter((m) => m.blunder).length} (${pct(all.filter((m) => m.blunder).length / all.length)}), matches stockfish's best move ${pct(all.filter((m) => m.san === m.best).length / all.length)}  ${dim(`${engine.name}, ${JSON.stringify(limits)}`)}`,
  );
}

async function summary(args: string[]) {
  for (const file of args) {
    const rows = readJsonl<{ steps?: unknown }>(file);
    console.log(bold(file));
    console.log(rows[0] && "steps" in rows[0] ? puzzleSummary(rows as unknown as PuzzleResult[]) : gameSummary(rows as unknown as GameRow[]));
  }
}

const [cmd, ...rest] = Bun.argv.slice(2);
const commands: Record<string, (args: string[]) => Promise<void>> = { play, eval: evalCmd, puzzles, analyze, summary };
const run = cmd ? commands[cmd] : undefined;
if (!run) {
  console.error(USAGE);
  process.exit(2);
}
await run(rest);
