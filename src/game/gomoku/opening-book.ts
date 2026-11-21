import { BOARD, EMPTY, type Board, type Move, type Rule, type Stone, forbiddenMove, idx } from "./logic";
import lines from "./opening-lines.json";

// Each position is indexed under every rotation and reflection of the board.
const symmetries = Array.from({ length: 8 }, (_, transform) =>
  Uint8Array.from({ length: BOARD * BOARD }, (_, square) => {
    let r = Math.floor(square / BOARD), c = square % BOARD;
    if (transform & 1) [r, c] = [c, r];
    if (transform & 2) r = BOARD - 1 - r;
    if (transform & 4) c = BOARD - 1 - c;
    return idx(r, c);
  }),
);

const books = new Map<Rule, Map<string, number>>();
for (const rule of ["freestyle", "double-three"] as const) {
  const book = new Map<string, number>();
  for (const [position, reply] of lines[rule] as [number[], number][]) {
    for (const transform of symmetries) {
      const key = position.map((square) => transform[square]).join(",");
      if (!book.has(key)) book.set(key, transform[reply]);
    }
  }
  books.set(rule, book);
}

export function openingMove(board: Board, history: readonly Move[], player: Stone, rule: Rule): Move | null {
  if (history.length > 4 || history.length % 2 + 1 !== player) return null;
  const square = books.get(rule)?.get(history.map(({ r, c }) => idx(r, c)).join(","));
  if (square === undefined || board[square] !== EMPTY) return null;
  const r = Math.floor(square / BOARD), c = square % BOARD;
  if (forbiddenMove(board, r, c, player, rule)) return null;
  return { r, c, player };
}
