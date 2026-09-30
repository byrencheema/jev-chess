export interface JevConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  rps?: number;
}

export interface JevOptions {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export function jevConfig(opts: JevOptions = {}, env = process.env): JevConfig {
  return {
    baseUrl: (opts.baseUrl ?? env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai").replace(/\/+$/, ""),
    apiKey: opts.apiKey ?? env.TYPESAFE_API_KEY ?? "",
    model: opts.model ?? env.TYPESAFE_MODEL ?? "jev-latest",
    rps: Number(env.JEV_RPS ?? 15),
  };
}

export const STOCKFISH_PATH = process.env.STOCKFISH_PATH ?? "stockfish";
export const MAX_PLIES = 300;
export const BLUNDER_CP = 300;
export const LC0_PATH = process.env.LC0_PATH ?? "lc0";
export const MAIA_DIR = process.env.MAIA_DIR ?? "data/maia";
