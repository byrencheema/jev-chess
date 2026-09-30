import { seeded, shuffle } from "./rng.ts";

export interface Opening {
  name: string;
  moves: string[];
}

const LINES: [string, string][] = [
  ["Ruy Lopez, Morphy defence", "e4 e5 Nf3 Nc6 Bb5 a6"],
  ["Ruy Lopez, Berlin defence", "e4 e5 Nf3 Nc6 Bb5 Nf6"],
  ["Italian, Giuoco Piano", "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6"],
  ["Two knights defence", "e4 e5 Nf3 Nc6 Bc4 Nf6"],
  ["Scotch game", "e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6"],
  ["Petrov defence", "e4 e5 Nf3 Nf6"],
  ["Four knights game", "e4 e5 Nf3 Nc6 Nc3 Nf6"],
  ["Vienna game", "e4 e5 Nc3 Nf6"],
  ["Sicilian, open with d6", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6"],
  ["Sicilian, Taimanov", "e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6"],
  ["Sicilian, Alapin", "e4 c5 c3 Nf6"],
  ["Sicilian, closed", "e4 c5 Nc3 Nc6 g3 g6"],
  ["French, Tarrasch", "e4 e6 d4 d5 Nd2 Nf6"],
  ["Caro-Kann, classical", "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5"],
  ["Caro-Kann, advance", "e4 c6 d4 d5 e5 Bf5"],
  ["Queen's gambit declined", "d4 d5 c4 e6 Nc3 Nf6"],
  ["Queen's gambit accepted", "d4 d5 c4 dxc4 Nf3 Nf6"],
  ["Slav defence", "d4 d5 c4 c6 Nf3 Nf6"],
  ["Semi-Slav defence", "d4 d5 c4 c6 Nf3 Nf6 Nc3 e6"],
  ["Nimzo-Indian defence", "d4 Nf6 c4 e6 Nc3 Bb4"],
  ["Queen's Indian defence", "d4 Nf6 c4 e6 Nf3 b6"],
  ["Bogo-Indian defence", "d4 Nf6 c4 e6 Nf3 Bb4+"],
  ["King's Indian defence", "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6"],
  ["Grunfeld defence", "d4 Nf6 c4 g6 Nc3 d5"],
  ["Catalan opening", "d4 Nf6 c4 e6 g3 d5"],
  ["London system", "d4 d5 Bf4 Nf6 e3 e6"],
  ["Torre attack", "d4 Nf6 Nf3 e6 Bg5 c5"],
  ["Dutch defence", "d4 f5 g3 Nf6 Bg2 e6"],
  ["English, symmetrical", "c4 c5 Nc3 Nc6 g3 g6"],
  ["English, reversed Sicilian", "c4 e5 Nc3 Nf6"],
  ["English, four knights", "c4 Nf6 Nc3 e5 Nf3 Nc6"],
  ["Reti opening", "Nf3 d5 c4 e6"],
  ["King's Indian attack", "Nf3 Nf6 g3 g6 Bg2 Bg7"],
  ["Philidor defence", "e4 e5 Nf3 d6 d4 exd4"],
];

export const OPENINGS: Opening[] = LINES.map(([name, moves]) => ({ name, moves: moves.split(" ") }));

export function openingFor(seed: number, pair: number, book: Opening[] = OPENINGS): Opening {
  const order = shuffle(book, seeded(`openings:${seed}`));
  return order[pair % order.length]!;
}
