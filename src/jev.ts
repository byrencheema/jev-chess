import type { JevConfig } from "./config.ts";
import { RateLimiter } from "./ratelimit.ts";

export type Instructions = string | Record<string, unknown> | unknown[];
export type Criterion = string | Record<string, unknown> | null;

export type ChoiceQuestion = {
  type: "choice";
  instructions: Instructions;
  criteria: Record<string, Criterion>;
};
export type NoulQuestion = { type: "noul"; instructions: string };
export type ScoreQuestion = { type: "score"; instructions: string; [k: string]: unknown };
export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type Answer = ChoiceAnswer | { type: "noul"; noul: number } | { type: "score"; [k: string]: unknown };

export interface SystemOneResponse {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface Asked {
  answers: Record<string, ChoiceAnswer>;
  inputTokens: number;
  latencyMs: number;
  requestMs: number;
  model?: string;
  stateVariant: number;
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface Choice {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  inputTokens: number;
  latencyMs: number;
  requestMs: number;
  model?: string;
  stateVariant: number;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
const MAX_ATTEMPTS = 7;
const MAX_RETRY_AFTER_MS = 30_000;
const REQUEST_TIMEOUT_MS = 180_000;

export function retryDelayMs(attempt: number, retryAfter: string | null, random = Math.random): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, MAX_RETRY_AFTER_MS);
  }
  const base = Math.min(500 * 2 ** attempt, 20_000);
  return base / 2 + random() * (base / 2);
}

export interface JevClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class JevClient {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly limiter?: RateLimiter;
  requests = 0;
  model?: string;
  retries = new Map<string, number>();

  constructor(
    readonly config: JevConfig,
    opts: JevClientOptions = {},
  ) {
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? Bun.sleep;
    if (config.rps && Number.isFinite(config.rps)) this.limiter = new RateLimiter(config.rps);
  }

  private retried(reason: string) {
    this.retries.set(reason, (this.retries.get(reason) ?? 0) + 1);
  }

  async systemOne(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse & { requestMs: number }> {
    const body = JSON.stringify({ model: this.config.model, state, questions });
    for (let attempt = 0; ; attempt++) {
      await this.limiter?.wait();
      this.requests++;
      let res: Response;
      const t0 = performance.now();
      try {
        res = await this.fetchFn(`${this.config.baseUrl}/v1/systemone`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            "content-type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        if (attempt + 1 >= MAX_ATTEMPTS) throw err;
        this.retried("network");
        await this.sleep(retryDelayMs(attempt, null));
        continue;
      }
      if (res.ok) {
        const data = (await res.json()) as SystemOneResponse;
        if (data.model) this.model = data.model;
        return { ...data, requestMs: performance.now() - t0 };
      }
      const text = await res.text();
      if (RETRYABLE.has(res.status) && attempt + 1 < MAX_ATTEMPTS) {
        this.retried(String(res.status));
        const delay = retryDelayMs(attempt, res.headers.get("retry-after"));
        if (res.status === 429 || res.status === 529) this.limiter?.pause(delay);
        await this.sleep(delay);
        continue;
      }
      let code: string | undefined;
      let message = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text) as { code?: string; error?: string };
        code = parsed.code;
        message = parsed.error ?? message;
      } catch {}
      throw new JevError(`systemone ${res.status}${code ? ` ${code}` : ""}: ${message}`, res.status, code);
    }
  }

  async ask(states: unknown[], questions: Record<string, ChoiceQuestion>): Promise<Asked> {
    for (let i = 0; i < states.length; i++) {
      const t0 = performance.now();
      try {
        const res = await this.systemOne(states[i]!, questions);
        const answers: Record<string, ChoiceAnswer> = {};
        for (const id of Object.keys(questions)) {
          const a = res.answers[id];
          if (!a || a.type !== "choice") throw new JevError("systemone returned no choice answer", 200);
          answers[id] = a;
        }
        return {
          answers,
          inputTokens: res.usage?.input_tokens ?? 0,
          latencyMs: performance.now() - t0,
          requestMs: res.requestMs,
          model: res.model,
          stateVariant: i,
        };
      } catch (err) {
        const truncated = err instanceof JevError && err.status === 422 && err.code === "STATE_TRUNCATED";
        if (!truncated || i + 1 >= states.length) throw err;
      }
    }
    throw new JevError("no state variants given", 0);
  }

  async choose(states: unknown[], instructions: Instructions, options: string[]): Promise<Choice> {
    const criteria: Record<string, Criterion> = {};
    for (const o of options) criteria[o] = null;
    const r = await this.ask(states, { next: { type: "choice", instructions, criteria } });
    const answer = r.answers.next!;
    return { choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence, ...r };
  }
}
