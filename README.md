# jev-chess

Jev, TypeSafe's System One classifier, plays chess. For every move it gets the position and every legal move as the options of one `choice` question, and it plays the option it picks. The code doesn't search or filter moves, and Jev can't play an illegal move.

## Results

With the final prompt, on held-out data:

| Test | Result |
|---|---|
| Games against Stockfish and Maia | 0 wins, 14 draws, 336 losses |
| Games against random moves | 23 wins, 26 draws, 1 loss |
| Lichess puzzle rating, 1,000 puzzles | 1085 (95% CI 1038 to 1136), 996 without mate-in-one |
| Illegal moves | 0 in 13,817 calls |
| Median request time | 121 ms |
| Cost per game | about $0.001 |

Games, puzzle results and Stockfish analysis are in `results/`.

## Setup

```sh
brew install stockfish lc0 zstd
bun install
mkdir -p data/maia
curl -L -o data/lichess_db_puzzle.csv.zst https://database.lichess.org/lichess_db_puzzle.csv.zst
for r in 1100 1500 1900; do curl -L -o data/maia/maia-$r.pb.gz https://github.com/CSSLab/maia-chess/releases/download/v1.0/maia-$r.pb.gz; done
```

Put `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL` and `TYPESAFE_MODEL` in `.env`.

## Commands

```sh
bun run play --white jev --black stockfish:1320
bun run eval --a jev --b maia:1500 --games 50 --book --concurrency 8 --budget 0.20
bun run puzzles --set eval --agent jev --budget 0.10
bun run analyze results/raw/eval-jev-vs-maia.jsonl --player jev
```

Tested with Stockfish 19, Lc0 0.32.1 and jev-1.13.0. The chess pieces are the Celtic set by Maurizio Monge (MIT).
