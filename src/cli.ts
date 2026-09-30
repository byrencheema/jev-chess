import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { parseArgs } from "node:util";
import { makeAgent, sharedJev } from "./agents.ts";
import { analyzeMoves, Evaluator, looseCheck, summarize, WINNING_CP, type GameAnalysis, type LooseCheck } from "./analysis.ts";
import { LC0_PATH, STOCKFISH_PATH } from "./config.ts";
import type { MoveLog } from "./game.ts";
import { OPENINGS } from "./openings.ts";
import { DEFAULT_SAMPLE, PUZZLE_SETS, samplePuzzles, solvePuzzle, type PuzzleResult } from "./puzzles.ts";
import { appendJsonl, latestById, pool, readJsonl, runMatch, tooManyErrors, type GameRow } from "./runner.ts";
import { bootstrapRatings } from "./rating.ts";
import { costUsd, formatUsd } from "./stats.ts";
import { compareTable, gameSummary, puzzleSummary } from "./summary.ts";
import { Engine, engineName } from "./uci.ts";

const tty = process.stdout.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);

const USAGE = `usage:
  bun run play --white jev --black stockfish:1320 [--book] [--seed N] [--max-plies N] [--out file]
  bun run eval --a jev --b stockfish:1320 --games N [--concurrency N] [--book] [--seed N] [--budget usd] [--out file]
  bun run puzzles --set dev|eval [--agent jev] [--budget usd] [--quiet]
  bun src/cli.ts compare --baseline <puzzles.jsonl> <puzzles.jsonl>... [--out table.md]
  bun run puzzles [--agent jev] [--per-band 5] [--band 100] [--min 600] [--max 2600] [--seed 1] [--concurrency N] [--budget usd] [--out file]
  bun run analyze <results/raw/file.jsonl> [--depth 14] [--player jev] [--out file]
  bun src/cli.ts summary <file.jsonl>...
  bun src/cli.ts pgn <results/raw/games.jsonl>...
  bun src/cli.ts loose <puzzles.jsonl> [--depth 16]
  bun src/cli.ts elo --anchor stockfish:1320=1320 [--anchor name=rating]... <games.jsonl>...
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
  const tokens = new Map<string, number>();
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
    onMove: values.verbose
      ? (id, m) => {
          tokens.set(id, (tokens.get(id) ?? 0) + (m.inputTokens ?? 0));
          console.log(dim(`[${id}]`), formatMove(m, costUsd(tokens.get(id)!)));
        }
      : undefined,
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
      set: { type: "string" },
      quiet: { type: "boolean", default: false },
    },
  });
  const set = values.set ? PUZZLE_SETS[values.set] : undefined;
  if (values.set && !set) throw new Error(`--set is one of ${Object.keys(PUZZLE_SETS).join(", ")}`);
  const d = { ...DEFAULT_SAMPLE, ...set?.sample };
  const opts = {
    seed: Number(set ? d.seed : values.seed),
    perBand: Number(values["per-band"] ?? d.perBand),
    band: Number(values.band ?? d.band),
    minRating: Number(values.min ?? d.minRating),
    maxRating: Number(values.max ?? d.maxRating),
    maxRd: Number(values["max-rd"] ?? d.maxRd),
    minPlays: Number(values["min-plays"] ?? d.minPlays),
  };
  const t0 = performance.now();
  const exclude = set?.exclude ? await samplePuzzles({ ...DEFAULT_SAMPLE, ...PUZZLE_SETS[set.exclude]!.sample }) : [];
  const sample = await samplePuzzles(opts, exclude);
  console.log(dim(`${sample.length} puzzles sampled in ${((performance.now() - t0) / 1000).toFixed(1)}s${exclude.length ? `, none of the ${exclude.length} ${set!.exclude} puzzles` : ""}`));
  const out =
    values.out ??
    (set ? `${set.dir}/puzzles-${values.set}-${slug(values.agent!)}.jsonl` : `results/raw/puzzles-${slug(values.agent!)}-seed${opts.seed}-${opts.minRating}-${opts.maxRating}x${opts.perBand}.jsonl`);
  const done = latestById(readJsonl<PuzzleResult>(out));
  const todo = sample.filter((p) => !done.get(p.id) || done.get(p.id)!.error);
  const jev = sharedJev({ model: values.model, baseUrl: values["base-url"] });
  const budget = values.budget ? Number(values.budget) : Infinity;
  let spent = 0;
  let n = 0;
  let errors = 0;
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
        if (r.error) errors++;
        if (values.quiet && !r.error) return;
        const line = r.steps.map((s) => (s.correct ? s.san : `${s.san} (want ${s.expectedSan})`)).join(" ");
        console.log(`${String(n).padStart(4)} ${p.id} ${String(p.rating).padStart(4)} ${r.solved ? bold("solved") : "failed"}  ${line}  ${dim(`total ${formatUsd(spent)}`)}${r.error ? ` error: ${r.error}` : ""}`);
      } finally {
        await agent.close?.();
      }
    },
    () => spent >= budget || tooManyErrors(errors, n),
  );
  if (spent >= budget || tooManyErrors(errors, n)) console.error(`stopped early: ${formatUsd(spent)} spent, ${errors} errors in ${n} puzzles`);
  console.log(`${out}\n${puzzleSummary(readJsonl<PuzzleResult>(out))}`);
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
  const mine = [...done.values()].filter((a) => a.player === values.player && rows.some((r) => r.id === a.game));
  const opponentOf = (a: GameAnalysis) => {
    const r = rows.find((x) => x.id === a.game)!;
    return a.color === "w" ? r.black : r.white;
  };
  for (const opp of [...new Set(mine.map(opponentOf))].sort()) {
    const ms = mine.filter((a) => opponentOf(a) === opp).flatMap((a) => a.moves);
    const b = ms.filter((m) => m.blunder).length;
    console.log(`  vs ${opp}: ${ms.length} moves, acpl ${(ms.reduce((t, m) => t + m.loss, 0) / ms.length).toFixed(0)}, blunders ${b} (${pct(b / ms.length)}), best move ${pct(ms.filter((m) => m.san === m.best).length / ms.length)}`);
  }
  const all = mine.flatMap((a) => a.moves);
  const loss = all.reduce((s, m) => s + m.loss, 0);
  console.log(
    `\n${values.player}: ${all.length} moves, acpl ${(loss / all.length).toFixed(0)}, blunders ${all.filter((m) => m.blunder).length} (${pct(all.filter((m) => m.blunder).length / all.length)}), matches stockfish's best move ${pct(all.filter((m) => m.san === m.best).length / all.length)}  ${dim(`${engine.name}, ${JSON.stringify(limits)}`)}`,
  );
}

async function loose(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { depth: { type: "string", default: "16" }, out: { type: "string" } } });
  const file = positionals[0];
  if (!file) throw new Error("give a puzzles jsonl file");
  const out = values.out ?? `results/analysis/${basename(file, ".jsonl")}-loose.jsonl`;
  const rows = [...latestById(readJsonl<PuzzleResult>(file)).values()].filter((r) => !r.error);
  const done = latestById(readJsonl<LooseCheck>(out));
  const engine = await new Engine([STOCKFISH_PATH]).init({ Threads: 4, Hash: 256 });
  const evaluator = new Evaluator(engine, { depth: Number(values.depth) });
  for (const r of rows) {
    if (r.solved || done.has(r.id)) continue;
    const c = await looseCheck(evaluator, r);
    if (!c) continue;
    appendJsonl(out, c);
    done.set(c.id, c);
  }
  await engine.quit();
  const checks = [...done.values()].filter((c) => rows.some((r) => r.id === c.id));
  const solved = rows.filter((r) => r.solved).length;
  const winning = checks.filter((c) => c.stillWinning).length;
  console.log(`${file}: ${rows.length} puzzles, ${solved} solved by Lichess rules; of ${checks.length} failed, ${winning} failing moves still left the solver at +${WINNING_CP} cp or better (depth ${values.depth}), loose solve rate ${pct((solved + winning) / rows.length)} (first failing move only; the rest of the line is not played out)`);
}

async function elo(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { anchor: { type: "string", multiple: true }, player: { type: "string", multiple: true }, samples: { type: "string", default: "500" } } });
  const anchors: Record<string, number> = {};
  for (const a of values.anchor ?? []) {
    const i = a.lastIndexOf("=");
    anchors[a.slice(0, i)] = Number(a.slice(i + 1));
  }
  const games = positionals.flatMap((f) => [...latestById(readJsonl<GameRow>(f)).values()]).filter((g) => g.scoreA !== null && !g.error);
  const used = games.filter((g) => !g.a.startsWith("random") && !g.b.startsWith("random") && g.a !== g.b);
  const fit = bootstrapRatings(used.map((g) => ({ a: g.a, b: g.b, scoreA: g.scoreA! })), anchors, Number(values.samples));
  for (const [p, r] of [...fit.entries()].sort((x, y) => y[1].rating - x[1].rating)) {
    if (values.player && !values.player.includes(p) && !(p in anchors)) continue;
    const n = used.filter((g) => g.a === p || g.b === p).length;
    console.log(`${p.padEnd(22)} ${p in anchors ? `${r.rating} (anchor)` : `${r.rating.toFixed(0)} (95% CI ${r.low.toFixed(0)} to ${r.high.toFixed(0)})`}  ${n} games`);
  }
}

async function spend() {
  let tokens = 0;
  const lines: string[] = [];
  for (const f of new Bun.Glob("results/{raw,dev}/*.jsonl").scanSync(".")) {
    const t = readJsonl<{ inputTokens?: number }>(f).reduce((s, r) => s + (r.inputTokens ?? 0), 0);
    if (!t) continue;
    tokens += t;
    lines.push(`${formatUsd(costUsd(t)).padStart(10)}  ${f}`);
  }
  console.log(`${lines.sort().join("\n")}\n${formatUsd(costUsd(tokens)).padStart(10)}  total, ${tokens.toLocaleString()} input tokens`);
}

async function compare(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { baseline: { type: "string" }, out: { type: "string" } } });
  const files = positionals;
  if (!values.baseline || files.length === 0) throw new Error("usage: compare --baseline <file> <files...> [--out table.md]");
  const load = (f: string) => ({ name: basename(f, ".jsonl"), rows: [...latestById(readJsonl<PuzzleResult>(f)).values()] });
  const table = compareTable(load(values.baseline), files.map(load));
  console.log(table);
  if (values.out) {
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, `${table}\n`);
  }
}

async function pgn(args: string[]) {
  for (const file of args) {
    const rows = [...latestById(readJsonl<GameRow>(file)).values()].sort((a, b) => a.index - b.index);
    const out = `results/pgn/${basename(file, ".jsonl")}.pgn`;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, rows.map((r) => r.pgn).join("\n\n") + "\n");
    console.log(`${rows.length} games -> ${out}`);
  }
}

async function summary(args: string[]) {
  for (const file of args) {
    const rows = readJsonl<{ steps?: unknown }>(file);
    console.log(bold(file));
    console.log(rows[0] && "steps" in rows[0] ? puzzleSummary(rows as unknown as PuzzleResult[]) : gameSummary(rows as unknown as GameRow[]));
  }
}

const [cmd, ...rest] = Bun.argv.slice(2);
const commands: Record<string, (args: string[]) => Promise<void>> = { play, eval: evalCmd, puzzles, analyze, loose, elo, compare, pgn, summary, spend };
const run = cmd ? commands[cmd] : undefined;
if (!run) {
  console.error(USAGE);
  process.exit(2);
}
await run(rest);
