import type { SiteData } from "./data.ts";
import { escapeHtml as esc, int, pct, promptName, promptShort, usd } from "./format.ts";

export const REPO = "https://github.com/byrencheema/jev-chess";

function stat(label: string, value: string, sub: string, tone = ""): string {
  return `<div class="stat${tone ? ` ${tone}` : ""}"><dt>${label}</dt><dd><span class="stat-value">${value}</span><span class="stat-sub">${sub}</span></dd></div>`;
}

function stats(d: SiteData): string {
  const h = d.headline;
  const opps = d.opponents.filter((o) => o.group !== "jev").length;
  const self = d.opponents.some((o) => o.group === "jev");
  const out: string[] = [];
  if (h.puzzle) out.push(stat("Puzzle rating", int(h.puzzle.rating), `95% CI ${int(h.puzzle.low)} to ${int(h.puzzle.high)}, ${int(h.puzzle.n)} puzzles`));
  out.push(stat("Games played", int(h.games), `against ${opps} ${opps === 1 ? "opponent" : "opponents"}${self ? " and itself" : ""}`));
  out.push(stat("Test cost", usd(h.costUsd), `${int(h.tokens)} input tokens, all games and puzzles`));
  out.push(stat("Illegal moves", int(h.illegal), `in ${int(h.calls)} calls`, h.illegal === 0 ? "good" : "bad"));
  return `<dl class="stats">${out.join("")}</dl>`;
}

function dash(x: number | null, f: (x: number) => string): string {
  return x === null || Number.isNaN(x) ? `<span class="na">-</span>` : f(x);
}

function bar(x: number, tone = "jev"): string {
  return `<span class="cell-bar" aria-hidden="true"><span class="cell-fill ${tone}" style="width:${(x * 100).toFixed(1)}%"></span></span>`;
}

function resultsTable(d: SiteData): string {
  const byKey = new Map(d.opponents.map((o) => [o.key, o]));
  const multi = new Set(d.results.map((r) => r.prompt)).size > 1;
  const rows = d.results
    .map((r) => {
      const o = byKey.get(r.opp);
      const self = o?.group === "jev";
      return `<tr>
<th scope="row">${esc(self ? "Jev vs itself" : o?.label ?? r.opp)}${multi ? `<span class="inline-prompt">${esc(promptName(r.prompt))}</span>` : ""}</th>
${multi ? `<td class="txt opt">${esc(promptName(r.prompt))}</td>` : ""}
<td class="opt">${int(r.games)}</td>
<td>${int(r.w)}</td><td>${int(r.d)}</td><td>${int(r.l)}</td>
<td class="with-bar">${dash(r.score, (x) => `${bar(x, x >= 0.5 ? "good" : "bad")}<span>${pct(x)}</span>`)}</td>
<td class="opt">${dash(r.acpl, (x) => int(x))}</td>
<td class="opt">${dash(r.blundersPerGame, (x) => x.toFixed(1))}</td>
<td class="opt">${dash(r.bestMatch, (x) => pct(x))}</td>
</tr>`;
    })
    .join("");
  const self = d.results.some((r) => byKey.get(r.opp)?.group === "jev");
  return `<div class="table-wrap"><table class="data">
<thead><tr><th scope="col" class="txt">Opponent</th>${multi ? `<th scope="col" class="txt opt">Prompt</th>` : ""}<th scope="col" class="opt">Games</th><th scope="col">Won</th><th scope="col">Drew</th><th scope="col">Lost</th><th scope="col">Score</th><th scope="col" class="opt">Avg loss</th><th scope="col" class="opt">Blunders per game</th><th scope="col" class="opt">Matched Stockfish</th></tr></thead>
<tbody>${rows}</tbody></table></div>
<p class="note">Avg loss is centipawns lost per Jev move by Stockfish 19 at depth 14. A blunder loses 300 or more.${self ? " Against itself, won and lost count White and Black wins." : ""} A dash means the games are not analyzed yet.</p>`;
}

function bandsTable(d: SiteData): string {
  const sets = d.puzzleSets;
  if (!sets.length) return "";
  const head = sets.map((s) => `<th scope="col"><span class="long">${esc(promptName(s.prompt))}</span><span class="short">${esc(promptShort(s.prompt))}</span></th>`).join("");
  const rows = d.bands
    .map((b) => {
      const n = Math.max(...sets.map((s) => b.sets[s.prompt]?.n ?? 0));
      const cells = sets
        .map((s) => {
          const c = b.sets[s.prompt];
          return `<td class="with-bar">${c ? `${bar(c.solved / c.n, s.prompt === d.primaryPrompt ? "jev" : "muted")}<span>${pct(c.solved / c.n)}</span>` : `<span class="na">-</span>`}</td>`;
        })
        .join("");
      return `<tr><th scope="row">${b.band} to ${b.band + d.bandSize - 1}</th><td class="opt">${int(n)}</td>${cells}</tr>`;
    })
    .join("");
  const total = sets.map((s) => `<td class="with-bar">${bar(s.solved / s.n, s.prompt === d.primaryPrompt ? "jev" : "muted")}<span>${pct(s.solved / s.n)}</span></td>`).join("");
  const fits = sets.map((s) => `<td><strong>${int(s.fit.rating)}</strong><span class="ci">${int(s.fit.low)} to ${int(s.fit.high)}</span></td>`).join("");
  return `<div class="table-wrap"><table class="data bands">
<thead><tr><th scope="col" class="txt">Rating</th><th scope="col" class="opt">Puzzles</th>${head}</tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><th scope="row">All</th><td class="opt">${int(Math.max(...sets.map((s) => s.n)))}</td>${total}</tr><tr><th scope="row">Fitted rating</th><td class="opt"></td>${fits}</tr></tfoot>
</table></div>
<p class="note">Share of puzzles solved. The fitted rating is where Jev would solve half of the puzzles, with a 95% bootstrap interval.</p>`;
}

const ICONS = {
  prev: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5"/></svg>`,
  next: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 4.5 13 10l-5.5 5.5"/></svg>`,
  first: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M14 4.5 8.5 10l5.5 5.5M5.5 4.5v11"/></svg>`,
  last: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4.5 11.5 10 6 15.5M14.5 4.5v11"/></svg>`,
  play: `<svg viewBox="0 0 20 20" aria-hidden="true" class="i-play"><path d="M7 4.8v10.4L15.2 10z"/></svg>`,
  pause: `<svg viewBox="0 0 20 20" aria-hidden="true" class="i-pause"><path d="M7 5v10M13 5v10"/></svg>`,
  flip: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3.5v13M6 16.5 3.5 14M6 16.5 8.5 14M14 16.5v-13M14 3.5 11.5 6M14 3.5 16.5 6"/></svg>`,
};

function controls(full: boolean): string {
  return `<div class="controls">
${full ? `<button type="button" class="icon-btn" data-act="first" aria-label="First move">${ICONS.first}</button>` : ""}
<button type="button" class="icon-btn" data-act="prev" aria-label="Previous move">${ICONS.prev}</button>
<button type="button" class="icon-btn play" data-act="play" aria-label="Play">${ICONS.play}${ICONS.pause}</button>
<button type="button" class="icon-btn" data-act="next" aria-label="Next move">${ICONS.next}</button>
${full ? `<button type="button" class="icon-btn" data-act="last" aria-label="Last move">${ICONS.last}</button><button type="button" class="icon-btn" data-act="flip" aria-label="Flip board">${ICONS.flip}</button>` : ""}
</div>`;
}

function legend(): string {
  return `<p class="legend"><span class="li"><span class="key key-jev" aria-hidden="true"></span>Jev's top 3, thicker is likelier</span><span class="li"><span class="key key-engine" aria-hidden="true"></span>Stockfish's best, when different</span></p>`;
}

function viewer(id: string, full: boolean): string {
  return `<div class="viewer${full ? " full" : " compact"}" id="${id}">
<div class="board-col">
<div class="board-frame"><div class="evalbar" aria-hidden="true"><span class="evalbar-fill"></span></div><div class="board" role="img" aria-label="Chess board"></div></div>
${full ? `<div class="evalgraph" role="slider" tabindex="0" aria-label="Evaluation across the game"></div>` : ""}
${controls(full)}
</div>
<div class="panel">
<div class="now"><p class="now-game"></p><p class="now-move"></p></div>
<p class="probs-cap"></p>
<ol class="probs"></ol>
${legend()}
<dl class="ticker">
<div><dt>Spent so far</dt><dd class="t-usd">$0</dd></div>
<div><dt>Input tokens</dt><dd class="t-tok">0</dd></div>
<div><dt>This call</dt><dd class="t-lat">-</dd></div>
<div><dt class="t-ev-label">Eval for Jev</dt><dd class="t-ev">-</dd></div>
</dl>
${full ? `<div class="movelist" tabindex="-1"></div>` : ""}
</div>
</div>`;
}

export function renderPage(d: SiteData, assets: { js: string; css: string }): string {
  const h = d.headline;
  const json = JSON.stringify(d).replace(/</g, "\\u003c");
  const description = `TypeSafe's System One classifier plays chess by picking one of the legal moves each turn. ${h.puzzle ? `Puzzle rating ${int(h.puzzle.rating)}, ` : ""}${int(h.games)} games, ${usd(h.costUsd)} for the whole test, 0 illegal moves.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jev plays chess</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="Jev plays chess">
<meta property="og:description" content="${esc(description)}">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="8" height="8" fill="#2f3ce0"/><rect x="8" y="8" width="8" height="8" fill="#2f3ce0"/></svg>`)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@400;500&family=Newsreader:opsz,wght@6..72,400;6..72,500&family=Schibsted+Grotesk:wght@400;500;600&display=swap">
<style>${assets.css}</style>
</head>
<body>
<a class="skip" href="#games">Skip to games</a>
<header class="top wrap">
<a class="wordmark" href="#">Jev plays chess</a>
<nav aria-label="Sections"><a href="#games">Games</a><a href="#puzzles">Puzzles</a><a href="#results">Results</a><a href="${REPO}">Code</a></nav>
</header>
<main>
<section class="hero wrap" aria-labelledby="pitch">
<div class="hero-copy">
<h1 id="pitch">Jev sees every legal move and picks one.</h1>
<p class="lede">Each turn, TypeSafe's System One classifier gets the position and every legal move in one call, and returns a probability for each. No search, no move filter.</p>
</div>
${viewer("hero-viewer", false)}
${stats(d)}
</section>

<section class="section wrap" id="games" aria-labelledby="games-h">
<h2 id="games-h">Every game, move by move.</h2>
<div class="filters">
<div class="chips" role="group" aria-label="Opponent" data-filter="opp"></div>
<div class="chips" role="group" aria-label="Result" data-filter="outcome"></div>
</div>
<div class="browser">
<div class="gamelist-wrap"><p class="gamecount" aria-live="polite"></p><ul class="gamelist" aria-label="Games"></ul></div>
${viewer("game-viewer", true)}
</div>
<p class="note keys">Left and right step through moves. Space plays and pauses.</p>
</section>

<section class="section wrap" id="puzzles" aria-labelledby="puzzles-h">
<h2 id="puzzles-h">${int(d.puzzles.length)} puzzles from Lichess.</h2>
<p class="sub">Each row is a 100-point rating band. Each square is one puzzle.</p>
<p class="legend waffle-legend"><span class="li"><span class="sw sw-solved" aria-hidden="true"></span>Solved</span><span class="li"><span class="sw sw-first" aria-hidden="true"></span>First move right</span><span class="li"><span class="sw sw-failed" aria-hidden="true"></span>Failed</span></p>
<div class="puzzles">
<div class="waffle" role="grid" aria-label="Puzzles by rating"></div>
<div class="puzzle-detail" aria-live="polite"></div>
</div>
</section>

<section class="section wrap" id="results" aria-labelledby="results-h">
<h2 id="results-h">Results by opponent.</h2>
${resultsTable(d)}
<h2 class="h2-follow">Puzzles by rating.</h2>
${bandsTable(d)}
</section>

<section class="section wrap" id="api" aria-labelledby="api-h">
<h2 id="api-h">One call per move.</h2>
<p class="sub">This is the request for the featured game's first move out of the book, and what came back.</p>
<div class="code-pair">
<figure><figcaption>Request</figcaption><pre><code>${esc(d.request)}</code></pre></figure>
<figure><figcaption>Response</figcaption><pre><code>${esc(d.response)}</code></pre></figure>
</div>
</section>
</main>
<footer class="foot wrap">
<a class="repo" href="${REPO}">github.com/byrencheema/jev-chess</a>
<p>Model ${esc(h.models.join(", ") || "unknown")}. Median request ${int(h.medianLatencyMs)} ms. Built ${esc(d.generatedAt.slice(0, 10))}. Pieces: Celtic by Maurizio Monge, MIT.</p>
</footer>
<script id="site-data" type="application/json">${json}</script>
<script type="module">${assets.js.replace(/<\/script/gi, "<\\/script")}</script>
</body>
</html>
`;
}
