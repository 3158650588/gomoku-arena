import { BOARD, BLACK, WHITE, EMPTY, checkWin, type Board, type Cell, type Move, type Rule, type Stone, idx, inBounds, opposite } from "./logic";
import { createDoubleThreeIndex, type DoubleThreeIndex } from "../../../scripts/board-rules.mjs";

const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
const windows = Uint8Array.from(Array.from({ length: BOARD * BOARD }, (_, square) => {
  const r = Math.floor(square / BOARD), c = square % BOARD;
  return directions.flatMap(([dr, dc]) => inBounds(r + 4 * dr, c + 4 * dc)
    ? Array.from({ length: 5 }, (_, step) => idx(r + step * dr, c + step * dc))
    : []);
}).flat());

interface Threats {
  wins: Set<number>;
  opposingWins: Set<number>;
  fours: Set<number>;
  opposingFour: boolean;
}

function scan(board: Board, attacker: Cell, includeFours: boolean): Threats {
  const wins = new Set<number>(), opposingWins = new Set<number>(), fours = new Set<number>();
  let opposingFour = false;
  for (let i = 0; i < windows.length; i += 5) {
    let own = 0, opposing = 0, first = -1, second = -1;
    for (let j = i; j < i + 5; j++) {
      const square = windows[j], cell = board[square];
      if (cell === attacker) own++;
      else if (cell !== EMPTY) opposing++;
      else { second = first; first = square; }
    }
    if (opposing === 4 && own === 0) opposingWins.add(first);
    if (includeFours && opposing === 3 && own === 0) opposingFour = true;
    if (opposing !== 0) continue;
    if (own === 4) wins.add(first);
    if (includeFours && own === 3) { fours.add(first); fours.add(second); }
  }
  return { wins, opposingWins, fours, opposingFour };
}

export function searchTime(board: Board, player: Cell, maximum: number, clockMs = Infinity, deepMaximum = maximum): number {
  const threats = scan(board, player, true);
  const exposed = threats.wins.size > 0 || threats.opposingWins.size > 0;
  const tense = threats.fours.size > 0 || threats.opposingFour;
  const stones = board.reduce((count, cell) => count + Number(cell !== EMPTY), 0);
  const share = exposed ? 0.26 : tense ? 1 : stones <= 8 ? 0.24 : 0.6;
  const cap = !exposed && (tense || stones > 8) ? deepMaximum : maximum;
  return Math.max(1, Math.min(Math.round(cap * share), Math.max(1, Math.floor(clockMs - 150))));
}

function forbidden(index: DoubleThreeIndex | undefined, square: number, player: Cell) {
  return player === BLACK && index?.isForbidden(Math.floor(square / BOARD), square % BOARD);
}

export function makeSearchMove(board: Board, index: DoubleThreeIndex | undefined, square: number, player: Cell) {
  if (index) index.put(square, player);
  else board[square] = player;
}

/** Prove a win by forcing a unique reply at every step. Unknown on timeout. */
export function fourAttack(
  board: Board, attacker: Cell, index: DoubleThreeIndex | undefined, turns: number, deadline: number,
  threats = scan(board, attacker, turns > 0),
): number | null | undefined {
  if (performance.now() >= deadline) return undefined;
  const immediate = threats.wins.values().next().value;
  if (immediate !== undefined) return immediate;
  if (turns === 0 || threats.opposingWins.size > 1) return null;
  const defense = threats.opposingWins.values().next().value;
  const defender = attacker === BLACK ? 2 : BLACK;
  for (const square of threats.fours) {
    if (performance.now() >= deadline) return undefined;
    if ((defense !== undefined && defense !== square) || forbidden(index, square, attacker)) continue;
    makeSearchMove(board, index, square, attacker);
    try {
      const attack = scan(board, attacker, false);
      if (attack.opposingWins.size > 0) continue;
      if (attack.wins.size > 1) return square;
      const block = attack.wins.values().next().value;
      if (block === undefined) continue;
      if (forbidden(index, block, defender)) return square;
      if (turns === 1) continue;
      makeSearchMove(board, index, block, defender);
      try {
        const continuation = fourAttack(board, attacker, index, turns - 1, deadline);
        if (continuation === undefined) return undefined;
        if (continuation !== null) return square;
      } finally {
        makeSearchMove(board, index, block, EMPTY);
      }
    } finally {
      makeSearchMove(board, index, square, EMPTY);
    }
  }
  return null;
}

export function proveFourAttack(board: Board, player: Cell, rule: Rule, turns: number, timeMs: number) {
  const index = rule === "double-three" ? createDoubleThreeIndex(board) : undefined;
  return fourAttack(board, player, index, turns, performance.now() + timeMs);
}

export function hasFourThreat(board: Board, player: Stone) {
  const threats = scan(board, player, true);
  return threats.wins.size > 0 || threats.opposingWins.size > 0 || threats.fours.size > 0 || threats.opposingFour;
}

const sixes: number[][] = [];
const through = Array.from({ length: BOARD * BOARD }, () => [] as number[][]);
for (let r = 0; r < BOARD; r++) {
  for (let c = 0; c < BOARD; c++) {
    for (const [dr, dc] of directions) {
      if (!inBounds(r + 5 * dr, c + 5 * dc)) continue;
      const line = Array.from({ length: 6 }, (_, n) => idx(r + n * dr, c + n * dc));
      sixes.push(line);
      for (let i = 1; i < 5; i++) through[line[i]].push(line);
    }
  }
}

function threePoints(board: Board, player: Stone, moves: Set<number>) {
  for (const line of sixes) {
    if (board[line[0]] || board[line[5]]) continue;
    let stones = 0, first = -1, second = -1, gaps = 0;
    for (let j = 1; j <= 4; j++) {
      const square = line[j], value = board[square];
      if (value === player) stones++;
      if (value === EMPTY) { second = first; first = square; gaps++; }
    }
    if (stones === 2 && gaps === 2) { moves.add(first); moves.add(second); }
  }
}

function openFourWitness(board: Board, player: Stone, square: number, index?: DoubleThreeIndex) {
  for (const line of through[square]) {
    const left = line[0], right = line[5];
    if (board[left] || board[right]) continue;
    let stones = 0, middle = -1;
    for (let j = 1; j <= 4; j++) {
      const value = board[line[j]];
      if (value === player) stones++;
      if (value === EMPTY) middle = line[j];
    }
    if (stones === 3 && middle !== -1 && !forbidden(index, middle, player)) return [middle, left, right] as const;
  }
}

export function hasPressure(board: Board, player: Stone) {
  const threats = scan(board, player, true);
  if (threats.wins.size || threats.opposingWins.size || threats.fours.size || threats.opposingFour) return true;
  // With only two stones a side cannot develop a four after an open-three move when the defender covers it.
  let black = 0, white = 0;
  for (const cell of board) {
    if (cell === BLACK) black++;
    if (cell === WHITE) white++;
  }
  if (Math.max(black, white) < 3) return false;
  const moves = new Set<number>();
  if (black >= 3) threePoints(board, BLACK, moves);
  if (white >= 3) threePoints(board, WHITE, moves);
  return moves.size > 0;
}

/** Bounded proof using continuous fours and open threes. It proves only a subset of all wins. */
export function mixedAttack(
  board: Board, attacker: Stone, index: DoubleThreeIndex | undefined, turns: number, deadline: number,
): number | null | undefined {
  if (performance.now() >= deadline) return undefined;
  const threats = scan(board, attacker, turns > 0);
  const immediate = threats.wins.values().next().value;
  if (immediate !== undefined) return immediate;
  if (turns === 0 || threats.opposingWins.size > 1) return null;
  const mandatory = threats.opposingWins.values().next().value;
  const defender = opposite(attacker);
  const choices = threats.fours;
  if (turns >= 2) threePoints(board, attacker, choices);
  for (const square of choices) {
    if (performance.now() >= deadline) return undefined;
    if ((mandatory !== undefined && square !== mandatory) || forbidden(index, square, attacker)) continue;
    makeSearchMove(board, index, square, attacker);
    try {
      const now = scan(board, attacker, false);
      // A counter-four left by the last reply must first be blocked, unless we can win outright.
      if (now.opposingWins.size) continue;
      if (now.wins.size > 1) return square;
      const block = now.wins.values().next().value;
      if (block !== undefined) {
        if (forbidden(index, block, defender)) return square;
        if (turns <= 1) continue;
        makeSearchMove(board, index, block, defender);
        try {
          const proof = mixedAttack(board, attacker, index, turns - 1, deadline);
          if (proof !== null) return proof === undefined ? undefined : square;
        } finally {
          makeSearchMove(board, index, block, EMPTY);
        }
        continue;
      }
      if (turns < 2) continue;
      const witness = openFourWitness(board, attacker, square, index);
      if (!witness) continue;
      const [maker, left, right] = witness;
      const counters = scan(board, defender, true).fours;
      const replies = new Set([...counters, maker, left, right]);
      // A remote reply can change recursive Black forbidden-move legality. Check it on the actual board.
      if (index && attacker === BLACK) {
        for (let i = 0; i < board.length; i++) if (board[i] === EMPTY) replies.add(i);
      }
      let holds = true;
      for (const reply of replies) {
        if (performance.now() >= deadline) return undefined;
        if (forbidden(index, reply, defender)) continue;
        makeSearchMove(board, index, reply, defender);
        try {
          // Every other reply leaves the two open ends intact and cannot make a four.
          if (!counters.has(reply) && !witness.includes(reply) && !forbidden(index, maker, attacker)) continue;
          const proof = mixedAttack(board, attacker, index, turns - 1, deadline);
          if (proof === undefined) return undefined;
          if (proof === null) { holds = false; break; }
        } finally {
          makeSearchMove(board, index, reply, EMPTY);
        }
      }
      if (holds) return square;
    } finally {
      makeSearchMove(board, index, square, EMPTY);
    }
  }
  return null;
}

/** Moves that create an immediate winning point and therefore demand a reply. */
export function counterFours(board: Board, player: Stone, index?: DoubleThreeIndex) {
  const threats = scan(board, player, true);
  if (threats.opposingWins.size > 1) return [];
  const block = threats.opposingWins.values().next().value;
  return Array.from(threats.fours).filter((square) => (block === undefined || square === block) &&
    !forbidden(index, square, player));
}

/** Use an independent opponent search to reject a proved tactical loss. */
export function reviewMove(board: Board, move: Move, player: Stone, rule: Rule, budget: number, rank: (r: number, c: number) => number): Move {
  const deadline = performance.now() + budget;
  const index = rule === "double-three" ? createDoubleThreeIndex(board) : undefined;
  const opponent = opposite(player);
  const danger = (r: number, c: number) => {
    const square = idx(r, c);
    makeSearchMove(board, index, square, player);
    try {
      if (checkWin(board, r, c, player).win) return null;
      return fourAttack(board, opponent, index, 5, deadline);
    } finally {
      makeSearchMove(board, index, square, EMPTY);
    }
  };
  if (typeof danger(move.r, move.c) !== "number") return move;

  const choices = [];
  for (let r = 0; r < BOARD; r++) {
    for (let c = 0; c < BOARD; c++) {
      const square = idx(r, c);
      if (board[square] !== EMPTY || (r === move.r && c === move.c) || forbidden(index, square, player)) continue;
      choices.push({ r, c, score: rank(r, c) });
    }
  }
  choices.sort((a, b) => b.score - a.score);
  for (const { r, c } of choices) {
    if (performance.now() >= deadline) break;
    const threat = danger(r, c);
    if (threat === undefined) break;
    if (threat === null) return { r, c, player };
  }
  return move;
}
