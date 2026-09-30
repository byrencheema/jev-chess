import { mulberry32 } from "./rng.ts";

export interface Outcome {
  rating: number;
  solved: boolean;
}

export const RATING_LOW = -1000;
export const RATING_HIGH = 4000;

export function pSolve(puzzleRating: number, rating: number): number {
  return 1 / (1 + 10 ** ((puzzleRating - rating) / 400));
}

export function logLikelihood(outcomes: Outcome[], rating: number): number {
  let ll = 0;
  for (const o of outcomes) {
    const p = pSolve(o.rating, rating);
    ll += Math.log(o.solved ? p : 1 - p);
  }
  return ll;
}

export function fitRating(outcomes: Outcome[]): number {
  if (outcomes.length === 0) return NaN;
  const gradient = (r: number) => outcomes.reduce((g, o) => g + (o.solved ? 1 : 0) - pSolve(o.rating, r), 0);
  let lo = RATING_LOW;
  let hi = RATING_HIGH;
  if (gradient(lo) <= 0) return lo;
  if (gradient(hi) >= 0) return hi;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (gradient(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function bootstrapRating(outcomes: Outcome[], samples = 1000, seed = 1): { rating: number; low: number; high: number } {
  const rating = fitRating(outcomes);
  if (outcomes.length === 0) return { rating, low: NaN, high: NaN };
  const rng = mulberry32(seed);
  const fits: number[] = [];
  for (let s = 0; s < samples; s++) {
    const resample = Array.from({ length: outcomes.length }, () => outcomes[Math.floor(rng() * outcomes.length)]!);
    fits.push(fitRating(resample));
  }
  fits.sort((a, b) => a - b);
  const at = (q: number) => fits[Math.min(fits.length - 1, Math.max(0, Math.round(q * (fits.length - 1))))]!;
  return { rating, low: at(0.025), high: at(0.975) };
}

export interface Result2 {
  a: string;
  b: string;
  scoreA: number;
}

function solveFor(player: string, games: Result2[], ratings: Map<string, number>): number {
  const gradient = (r: number) => {
    let g = 0;
    for (const x of games) {
      if (x.a === player) g += x.scoreA - pSolve(ratings.get(x.b)!, r);
      else if (x.b === player) g += 1 - x.scoreA - pSolve(ratings.get(x.a)!, r);
    }
    return g;
  };
  let lo = RATING_LOW;
  let hi = RATING_HIGH;
  if (gradient(lo) <= 0) return lo;
  if (gradient(hi) >= 0) return hi;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (gradient(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function fitRatings(games: Result2[], anchors: Record<string, number>, rounds = 200): Map<string, number> {
  const ratings = new Map<string, number>();
  for (const g of games) for (const p of [g.a, g.b]) ratings.set(p, anchors[p] ?? 1500);
  const free = [...ratings.keys()].filter((p) => !(p in anchors));
  for (let r = 0; r < rounds; r++) {
    let moved = 0;
    for (const p of free) {
      const next = solveFor(p, games, ratings);
      moved = Math.max(moved, Math.abs(next - ratings.get(p)!));
      ratings.set(p, next);
    }
    if (moved < 0.01) break;
  }
  return ratings;
}

export function bootstrapRatings(games: Result2[], anchors: Record<string, number>, samples = 500, seed = 1): Map<string, { rating: number; low: number; high: number }> {
  const point = fitRatings(games, anchors);
  const groups = new Map<string, Result2[]>();
  for (const g of games) {
    const key = [g.a, g.b].sort().join("|");
    groups.set(key, [...(groups.get(key) ?? []), g]);
  }
  const rng = mulberry32(seed);
  const draws = new Map<string, number[]>();
  for (let s = 0; s < samples; s++) {
    const resample = [...groups.values()].flatMap((gs) => Array.from({ length: gs.length }, () => gs[Math.floor(rng() * gs.length)]!));
    for (const [p, r] of fitRatings(resample, anchors, 60)) (draws.get(p) ?? draws.set(p, []).get(p)!).push(r);
  }
  const out = new Map<string, { rating: number; low: number; high: number }>();
  for (const [p, r] of point) {
    const d = (draws.get(p) ?? [r]).sort((x, y) => x - y);
    const at = (q: number) => d[Math.min(d.length - 1, Math.max(0, Math.round(q * (d.length - 1))))]!;
    out.set(p, { rating: r, low: at(0.025), high: at(0.975) });
  }
  return out;
}
