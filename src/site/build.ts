import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { readJsonl } from "../runner.ts";
import { buildSiteData, type GameFile, type PuzzleFile } from "./data.ts";
import { renderPage } from "./page.ts";

export type ResultSet = "eval" | "smoke" | "all";

export interface Selection {
  games: string[];
  puzzles: string[];
}

function matches(name: string, pattern: string): boolean {
  return new Bun.Glob(pattern).match(name);
}

export function selectFiles(names: string[], set: ResultSet): Selection {
  const jsonl = names.filter((n) => n.endsWith(".jsonl")).sort();
  const isPuzzle = (n: string) => n.startsWith("puzzles-");
  const isEval = (n: string) => n.startsWith("eval-") || n.startsWith("puzzles-eval-");
  const skip = (n: string) => n.startsWith("anchors") || n.startsWith("play");
  const pick = (n: string) => !skip(n) && (set === "all" || (set === "eval") === isEval(n));
  return {
    games: jsonl.filter((n) => pick(n) && !isPuzzle(n)),
    puzzles: jsonl.filter((n) => pick(n) && isPuzzle(n)),
  };
}

export function defaultSet(names: string[]): ResultSet {
  return names.some((n) => n.startsWith("eval-") && n.endsWith(".jsonl")) ? "eval" : "smoke";
}

async function bundle(entry: string, minify = true): Promise<string> {
  const out = await Bun.build({ entrypoints: [entry], minify, target: "browser" });
  if (!out.success) throw new Error(out.logs.map(String).join("\n"));
  return (await out.outputs[0]!.text()).trim();
}

function pieceCss(dir: string): string {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".svg"))
    .map((f) => {
      const svg = readFileSync(join(dir, f), "utf8");
      return `.pc-${basename(f, ".svg")}{background-image:url("data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}")}`;
    })
    .join("");
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      results: { type: "string", default: "results" },
      set: { type: "string" },
      games: { type: "string", multiple: true },
      puzzles: { type: "string", multiple: true },
      featured: { type: "string" },
      out: { type: "string", default: "site/index.html" },
      samples: { type: "string", default: "1000" },
    },
  });
  const raw = join(values.results!, "raw");
  const analysisDir = join(values.results!, "analysis");
  const names = existsSync(raw) ? readdirSync(raw) : [];
  const set = (values.set ?? defaultSet(names)) as ResultSet;
  if (!["eval", "smoke", "all"].includes(set)) throw new Error("--set is one of eval, smoke, all");
  const chosen = selectFiles(names, set);
  const games = values.games ? names.filter((n) => values.games!.some((p) => matches(n, p))) : chosen.games;
  const puzzles = values.puzzles ? names.filter((n) => values.puzzles!.some((p) => matches(n, p))) : chosen.puzzles;
  const gameFiles: GameFile[] = games.map((n) => ({
    file: n,
    rows: readJsonl(join(raw, n)),
    analyses: readJsonl(join(analysisDir, n)),
  }));
  const puzzleFiles: PuzzleFile[] = puzzles.map((n) => ({ file: n, rows: readJsonl(join(raw, n)) }));
  const data = buildSiteData(gameFiles, puzzleFiles, { featured: values.featured, bootstrapSamples: Number(values.samples) });
  const here = import.meta.dir;
  const [js, css] = await Promise.all([bundle(join(here, "client/main.ts")), bundle(join(here, "style.css"))]);
  const html = renderPage(data, { js, css: css + pieceCss(join(here, "pieces")) });
  mkdirSync(dirname(values.out!), { recursive: true });
  writeFileSync(values.out!, html);
  const analyzed = gameFiles.filter((f) => f.analyses.length).map((f) => f.file);
  console.log(
    [
      `${set} set: ${games.length} game files, ${puzzles.length} puzzle files, ${analyzed.length} with analysis`,
      ...games.map((g) => `  games    ${g}${analyzed.includes(g) ? " + analysis" : ""}`),
      ...puzzles.map((p) => `  puzzles  ${p}`),
      `${data.games.length} games, ${data.puzzles.length} puzzles shown, featured ${data.games[data.featured]?.id ?? "none"}`,
      `${values.out} ${(html.length / 1024).toFixed(0)} KB`,
    ].join("\n"),
  );
}

if (import.meta.main) await main();
