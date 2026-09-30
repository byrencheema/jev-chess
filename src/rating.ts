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
