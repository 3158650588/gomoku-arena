import { evalBoard, iterativeDeepening, pointScore } from "./ai";
import { BLACK, BOARD, EMPTY, checkWin, forbiddenMove, idx, inBounds, opposite, type Board, type Move, type Rule, type Stone } from "./logic";
import { counterFours, fourAttack, makeSearchMove, mixedAttack, reviewMove } from "./tactics";
import { createDoubleThreeIndex } from "../../../scripts/board-rules.mjs";

const toMove = (square: number, player: Stone): Move => ({ r: Math.floor(square / BOARD), c: square % BOARD, player });

interface Risk {
  four: number | null | undefined;
  mixed: number | null | undefined;
  counters: number;
  worst: number;
}

/** Proof can replace any move. Positional comparisons stay within the engine's shortlist. */
export function reviewMasterMove(board: Board, move: Move, candidates: readonly Move[], player: Stone, rule: Rule, budget: number, arena = false): Move {
  if (budget < 5) return move;
  const start = performance.now(), deadline = start + budget;
  const index = rule === "double-three" ? createDoubleThreeIndex(board) : undefined;
  const opponent = opposite(player);
  const rank = (side: Stone, square: number) => {
    const { r, c } = toMove(square, side);
    return pointScore(board, r, c, side) + pointScore(board, r, c, opposite(side)) * 0.9;
  };
  const best = reviewMove(board, move, player, rule, Math.min(arena ? 145 : 55, budget * 0.32), (r, c) => rank(player, idx(r, c)));
  const ownWin = mixedAttack(board, player, index, arena ? 4 : 3, Math.min(deadline, performance.now() + budget * 0.23));
  if (ownWin != null) return toMove(ownWin, player);

  const unique = new Set([idx(best.r, best.c)]);
  const shortlist = [best];
  for (const candidate of candidates) {
    if (shortlist.length === 4 || !inBounds(candidate.r, candidate.c)) continue;
    const square = idx(candidate.r, candidate.c);
    if (unique.has(square) || board[square] !== EMPTY || forbiddenMove(board, candidate.r, candidate.c, player, rule)) continue;
    shortlist.push({ ...candidate, player });
    unique.add(square);
  }
  const inspect = (candidate: Move, until: number, scoreReplies = true): Risk => {
    const square = idx(candidate.r, candidate.c);
    makeSearchMove(board, index, square, player);
    try {
      if (checkWin(board, candidate.r, candidate.c, player).win) return { four: null, mixed: null, counters: 0, worst: Infinity };
      const four = fourAttack(board, opponent, index, arena ? 7 : 5, until);
      if (four != null) return { four, mixed: null, counters: Infinity, worst: -Infinity };
      if (four === undefined) return { four, mixed: undefined, counters: Infinity, worst: -Infinity };
      if (!scoreReplies) {
        return { four, mixed: mixedAttack(board, opponent, index, 3, until), counters: 0, worst: 0 };
      }

      const counters = counterFours(board, opponent, index);
      const counterSet = new Set(counters);
      const replies: { square: number; score: number }[] = [];
      for (let i = 0; i < board.length; i++) {
        if (board[i] !== EMPTY) continue;
        const score = rank(opponent, i);
        if (!score && !counterSet.has(i)) continue;
        if (opponent === BLACK && index?.isForbidden(Math.floor(i / BOARD), i % BOARD)) continue;
        replies.push({ square: i, score });
      }
      replies.sort((a, b) => Number(counterSet.has(b.square)) - Number(counterSet.has(a.square)) || b.score - a.score);
      let worst = Infinity;
      for (const { square: reply } of replies.slice(0, 4)) {
        makeSearchMove(board, index, reply, opponent);
        try {
          worst = Math.min(worst, evalBoard(board, player));
        } finally {
          makeSearchMove(board, index, reply, EMPTY);
        }
      }
      const mixed = mixedAttack(board, opponent, index, arena ? 3 : 2, until);
      return { four, mixed, counters: counters.length, worst };
    } finally {
      makeSearchMove(board, index, square, EMPTY);
    }
  };

  const shortlistDeadline = deadline - (arena ? budget * 0.29 : 0);
  const probe = Math.max(1, (shortlistDeadline - performance.now()) / (shortlist.length + 0.4));
  const initial = inspect(best, Math.min(shortlistDeadline, performance.now() + probe));
  let selected = best, chosen = initial;
  const verified = new Set<number>();
  const knownLoss = (risk: Risk) => typeof risk.four === "number" || typeof risk.mixed === "number";
  for (const candidate of shortlist.slice(1)) {
    if (performance.now() >= shortlistDeadline) break;
    const risk = inspect(candidate, Math.min(shortlistDeadline, performance.now() + probe));
    if (risk.four !== null || risk.mixed !== null) continue;
    verified.add(idx(candidate.r, candidate.c));
    if (knownLoss(chosen) || (chosen.four === null && chosen.mixed === null &&
        chosen.counters > 0 && risk.counters === 0 && risk.worst >= chosen.worst + 600)) {
      selected = candidate;
      chosen = risk;
    }
  }
  if (arena && knownLoss(initial)) {
    const cut = initial.four ?? initial.mixed;
    const counters = new Set(counterFours(board, player, index));
    const outside: { square: number; priority: number; score: number }[] = [];
    for (let square = 0; square < board.length; square++) {
      if (board[square] !== EMPTY || unique.has(square)) continue;
      const { r, c } = toMove(square, player);
      if (player === BLACK && index?.isForbidden(r, c)) continue;
      outside.push({ square, priority: square === cut ? 2 : Number(counters.has(square)), score: rank(player, square) });
    }
    outside.sort((a, b) => b.priority - a.priority || b.score - a.score);
    const scanUntil = performance.now() + Math.max(0, deadline - performance.now()) * 0.68;
    for (const { square } of outside.slice(0, 32)) {
      if (performance.now() >= scanUntil || verified.size >= 6) break;
      const candidate = toMove(square, player);
      const risk = inspect(candidate, Math.min(scanUntil, performance.now() + Math.max(6, probe * 0.45)), false);
      if (risk.four !== null || risk.mixed !== null) continue;
      verified.add(square);
      if (knownLoss(chosen)) {
        selected = candidate;
        chosen = risk;
      }
    }
    const leftover = deadline - performance.now();
    if (verified.size > 1 && leftover >= 12) {
      const deeper = iterativeDeepening(board, player, 10, leftover, 0, "balanced", rule, idx(selected.r, selected.c), true, verified);
      if (deeper.move && deeper.depth >= 2 && verified.has(idx(deeper.move.r, deeper.move.c))) return deeper.move;
    }
  }
  return selected;
}
