import { BLACK, BOARD, EMPTY, checkWin, forbiddenMove, opposite, type Board, type Move, type Rule, type Stone } from "./logic";

export const ENDGAME_LIMIT = 10;
const MATE = 100;

export type EndgameResult = { kind: "exact"; winner: Stone | null; plies: number | null; winnerMoves: number | null; move: Move | null }
  | { kind: "too-many" | "timeout" };

/** Full-width search on the remaining intersections. Score encodes distance to victory. */
export function solveEndgame(board: Board, turn: Stone, rule: Rule, budget = 220): EndgameResult {
  const blank: number[] = [];
  for (let i = 0; i < board.length; i++) if (board[i] === EMPTY) blank.push(i);
  if (blank.length > ENDGAME_LIMIT) return { kind: "too-many" };
  const weights = blank.map((_, i) => 3 ** i);
  const memo = new Map<number, number>();
  const deadline = performance.now() + budget;
  let root: Move | null = null;

  function search(player: Stone, code: number, remaining: number): number | undefined {
    if (remaining === 0) return 0;
    if (performance.now() >= deadline) return undefined;
    const key = code * 2 + player - 1;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let best = -MATE;
    for (let j = 0; j < blank.length; j++) {
      const square = blank[j], r = Math.floor(square / BOARD), c = square % BOARD;
      if (board[square] !== EMPTY || forbiddenMove(board, r, c, player, rule)) continue;
      board[square] = player;
      const child = checkWin(board, r, c, player).win
        ? -MATE : search(opposite(player), code + player * weights[j], remaining - 1);
      board[square] = EMPTY;
      if (child === undefined) return undefined;
      const score = -child + Math.sign(child);
      if (score <= best) continue;
      best = score;
      if (code === 0) root = { r, c, player };
      if (best === MATE - 1) break;
    }
    memo.set(key, best);
    return best;
  }

  const score = search(turn, 0, blank.length);
  if (score === undefined) return { kind: "timeout" };
  const plies = score === 0 ? null : MATE - Math.abs(score);
  const winner = score === 0 ? null : score > 0 ? turn : opposite(turn);
  const winnerMoves = plies === null ? null : Math.floor((plies + Number(turn === winner)) / 2);
  return { kind: "exact", winner, plies, winnerMoves, move: root };
}
