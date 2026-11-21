import { BLACK, WHITE, EMPTY, BOARD, createBoard, idx, inBounds, checkWin, isFull, opposite, forbiddenMove, type Board, type Cell, type Move, type Stone, type Rule } from "./logic";
import { DIFFICULTIES, type Difficulty } from "./ai";
import { INITIAL_TIME, INCREMENT, type Clock } from "../../../scripts/chess-clock.mjs";

export const STYLES = ["balanced", "attack", "defense"] as const;
export type Style = typeof STYLES[number];
export type Mode = "solo" | "local" | "challenge" | "puzzle" | "practice" | "handicap";

export interface InitialPosition {
  stones: Move[];
  turn: Stone;
}

export interface Setup {
  mode: Mode;
  playerColor: Stone;
  difficulty: Difficulty;
  style: Style;
  preset?: string;
  daily?: string;
  firstScore?: number;
  initial?: InitialPosition;
  quick?: boolean;
  rule?: Rule;
}

export interface SavedMatch {
  setup: Setup;
  moves: Move[];
  lockedPly: number;
  clock?: Clock;
}

export interface RecordEntry {
  id: string;
  timestamp: number;
  match: SavedMatch;
  winner: Cell;
}

export interface Score {
  player: number;
  ai: number;
  draw: number;
}

export interface Position {
  board: Board;
  moves: Move[];
  winner: Cell;
  line?: [number, number][];
  full: boolean;
  turn: Stone;
}

type Point = [number, number];

function alternate(black: Point[], white: Point[]): Move[] {
  const moves: Move[] = [];
  for (const [i, [r, c]] of black.entries()) {
    moves.push({ r, c, player: BLACK });
    const next = white[i];
    if (next) moves.push({ r: next[0], c: next[1], player: WHITE });
  }
  return moves;
}

export const OPENINGS = [
  { id: "diagonal", title: "斜邻开局", moves: alternate([[7, 7], [7, 8]], [[8, 8], [7, 9]]) },
  { id: "offset", title: "斜向争中", moves: alternate([[7, 7], [8, 7]], [[6, 8], [9, 7]]) },
  { id: "wide", title: "拉开两翼", moves: alternate([[7, 7], [8, 5]], [[7, 8], [9, 7]]) },
] as const;

interface Puzzle {
  id: string;
  title: string;
  prompt: string;
  player: Stone;
  moves: Move[];
  goal: { kind: "block"; at: Point } | { kind: "win"; maxMoves: number };
}

const spare: Point[] = [[0, 0], [1, 11], [11, 2], [12, 10], [3, 12]];

export const PUZZLES: readonly Puzzle[] = [
  { id: "edge", title: "边线救急", prompt: "执白，找出唯一能挡住黑棋成五的位置。", player: WHITE,
    moves: alternate([[0, 2], [1, 2], [2, 2], [3, 2], spare[4]], spare.slice(0, 4)),
    goal: { kind: "block", at: [4, 2] } },
  { id: "gap", title: "跳四漏点", prompt: "执白，黑棋下一手就能成五，找出唯一的挡点。", player: WHITE,
    moves: alternate([[7, 2], [7, 3], [7, 5], [7, 6], spare[4]], spare.slice(0, 4)),
    goal: { kind: "block", at: [7, 4] } },
  { id: "diagonal-block", title: "斜线上封口", prompt: "执白，封住从角落出发的斜线。", player: WHITE,
    moves: alternate([[0, 14], [1, 13], [2, 12], [3, 11], [5, 3]], spare.slice(0, 4)),
    goal: { kind: "block", at: [4, 10] } },
  { id: "one", title: "一手成五", prompt: "执黑，一手取胜。", player: BLACK,
    moves: alternate([[5, 3], [5, 4], [5, 6], [5, 7]], spare.slice(0, 4)),
    goal: { kind: "win", maxMoves: 1 } },
  { id: "fork", title: "双四夹击", prompt: "执黑，两手内取胜。找两条都能成五的线。", player: BLACK,
    moves: alternate([[6, 3], [6, 4], [6, 5], [3, 6], [4, 6], [5, 6]], [[6, 2], [2, 6], ...spare.slice(0, 4)]),
    goal: { kind: "win", maxMoves: 2 } },
  { id: "forcing", title: "连续冲四", prompt: "执黑，三手内取胜。先找能迫使白棋应对的落点。", player: BLACK,
    moves: alternate([[7, 4], [7, 5], [7, 6], [5, 7], [6, 7]], [[7, 3], ...spare.slice(0, 4)]),
    goal: { kind: "win", maxMoves: 3 } },
];

export const HANDICAPS = [
  { id: "four", title: "先得四连", own: [[7, 6], [7, 7], [7, 8], [7, 9]], rival: [[7, 5], [8, 8]] },
  { id: "three", title: "先占活三", own: [[7, 6], [7, 7], [7, 8], [8, 7]], rival: [[6, 6], [8, 9], [9, 7]] },
  { id: "center", title: "先占中腹", own: [[7, 6], [7, 7], [8, 7]], rival: [[6, 8], [8, 9]] },
] as const;

export function handicapPosition(index: number, player: Stone): InitialPosition {
  const { own, rival } = HANDICAPS[index];
  const pack = (cells: readonly (readonly [number, number])[], side: Stone) => cells.map(([r, c]) => ({ r, c, player: side }));
  return { stones: [...pack(own, player), ...pack(rival, opposite(player))], turn: player };
}

const dailyPool: readonly Puzzle[] = [
  ...PUZZLES.filter((puzzle) => puzzle.goal.kind === "win"),
  { id: "white-gap", title: "补上跳五", prompt: "执白，一手取胜。", player: WHITE,
    moves: alternate(spare, [[8, 2], [8, 3], [8, 5], [8, 6]]), goal: { kind: "win", maxMoves: 1 } },
  { id: "white-open", title: "直四两头", prompt: "执白，两手内取胜。", player: WHITE,
    moves: alternate(spare.slice(0, 4), [[5, 9], [6, 9], [7, 9]]), goal: { kind: "win", maxMoves: 2 } },
  { id: "broken-fork", title: "两条缺口", prompt: "执黑，两手内取胜。", player: BLACK,
    moves: alternate([[6, 2], [6, 3], [6, 5], [2, 4], [3, 4], [5, 4]],
      [[6, 1], [1, 4], ...spare.slice(0, 4)]), goal: { kind: "win", maxMoves: 2 } },
];

export function dailyKey(date = new Date()) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part) => String(part).padStart(2, "0")).join("-");
}

export function dailyPuzzle(day: string): Puzzle | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const date = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== day) return undefined;
  const cycle = 8 * dailyPool.length;
  const slot = ((Math.floor(+date / 86_400_000) % cycle) + cycle) % cycle;
  const puzzle = dailyPool[slot % dailyPool.length], transform = Math.floor(slot / dailyPool.length);
  return {
    ...puzzle,
    title: "每日一题",
    moves: puzzle.moves.map(({ r, c, player }) => {
      if (transform & 1) [r, c] = [c, r];
      if (transform & 2) r = BOARD - 1 - r;
      if (transform & 4) c = BOARD - 1 - c;
      return { r, c, player };
    }),
  };
}

export function puzzleFor(setup: Setup) {
  if (setup.mode !== "puzzle") return undefined;
  return setup.daily ? dailyPuzzle(setup.daily) : PUZZLES.find(({ id }) => id === setup.preset);
}

export function readInitial(input: unknown): InitialPosition | null {
  if (!input || typeof input !== "object") return null;
  const { stones, turn } = input as InitialPosition;
  if ((turn !== BLACK && turn !== WHITE) || !Array.isArray(stones) || stones.length >= BOARD * BOARD) return null;
  const board = createBoard();
  const placed: Move[] = [];
  for (const stone of stones) {
    if (!stone || (stone.player !== BLACK && stone.player !== WHITE) ||
        !Number.isInteger(stone.r) || !Number.isInteger(stone.c) ||
        !inBounds(stone.r, stone.c) || board[idx(stone.r, stone.c)] !== EMPTY) return null;
    const { r, c, player } = stone;
    board[idx(r, c)] = player;
    if (checkWin(board, r, c, player).win) return null;
    placed.push({ r, c, player });
  }
  return { stones: placed, turn };
}

export function readPosition(input: unknown, initial?: InitialPosition, rule: Rule = "freestyle"): Position | null {
  if (!Array.isArray(input) || input.length > BOARD * BOARD) return null;
  const board = createBoard();
  const moves: Move[] = [];
  let winner: Cell = EMPTY;
  let line: Position["line"];
  let turn: Stone = initial?.turn ?? BLACK;
  for (const { r, c, player } of initial?.stones ?? []) board[idx(r, c)] = player;
  for (const move of input) {
    if (winner || !move || move.player !== turn || !Number.isInteger(move.r) ||
        !Number.isInteger(move.c) || !inBounds(move.r, move.c) || board[idx(move.r, move.c)] !== EMPTY) return null;
    const { r, c } = move;
    if (forbiddenMove(board, r, c, turn, rule)) return null;
    board[idx(r, c)] = turn;
    moves.push({ r, c, player: turn });
    const result = checkWin(board, r, c, turn);
    if (result.win) {
      winner = turn;
      line = result.line;
    }
    turn = opposite(turn);
  }
  return { board, moves, winner, line, full: isFull(board), turn };
}

export function readSavedMatch(input: unknown): SavedMatch | null {
  if (!input || typeof input !== "object") return null;
  const { setup, moves, lockedPly, clock } = input as SavedMatch;
  // Earlier LAN recordings now open as local replays.
  const mode = String(setup?.mode) === "lan" ? "local" : setup?.mode;
  if (!setup || !["solo", "local", "challenge", "puzzle", "practice", "handicap"].includes(mode) ||
      (setup.playerColor !== WHITE && setup.playerColor !== BLACK) ||
      !DIFFICULTIES.includes(setup.difficulty) || !STYLES.includes(setup.style) ||
      (setup.rule !== undefined && setup.rule !== "freestyle" && setup.rule !== "double-three")) return null;
  const initial = setup.initial === undefined ? undefined : readInitial(setup.initial);
  if (initial === null) return null;
  if (clock && (!setup.quick || !Array.isArray(clock.left) || clock.left.length !== 2 ||
      clock.left.some((value) => !Number.isFinite(value) || value < 0 || value > INITIAL_TIME + BOARD * BOARD * INCREMENT) ||
      (clock.startedAt !== null && !Number.isFinite(clock.startedAt)))) return null;
  const position = readPosition(moves, initial, setup.rule);
  if (!position || !Number.isInteger(lockedPly) || lockedPly < 0 || lockedPly > moves.length) return null;
  if (setup.mode === "puzzle") {
    const puzzle = puzzleFor(setup);
    if (!puzzle || puzzle.id !== setup.preset || lockedPly !== puzzle.moves.length || setup.playerColor !== puzzle.player) return null;
  }
  if (setup.mode === "handicap" && (!initial || !HANDICAPS.some(({ id }) => id === setup.preset))) return null;
  if (setup.mode === "challenge" && !OPENINGS.some((item) => item.id === setup.preset)) return null;
  if (setup.firstScore !== undefined &&
      (setup.mode !== "challenge" || ![0, 0.5, 1].includes(setup.firstScore))) return null;
  return { setup: { ...setup, mode, initial }, moves: position.moves, lockedPly, clock };
}

export function exportReplay(match: SavedMatch): string {
  const { playerColor, difficulty, mode } = match.setup;
  return JSON.stringify({ format: "gomoku-replay", version: 1, playerColor, difficulty,
    local: mode === "local", initial: match.setup.initial, rule: match.setup.rule, moves: match.moves }, null, 2);
}

export function importReplay(text: string): SavedMatch | null {
  if (text.length > 48_000) return null;
  try {
    const data = JSON.parse(text);
    if (data?.format !== "gomoku-replay" || data.version !== 1 ||
        (!data.moves?.length && !data.initial?.stones?.length)) return null;
    return readSavedMatch({
      setup: { playerColor: data.playerColor, difficulty: data.difficulty, style: "balanced",
        mode: data.local === true ? "local" : "practice", initial: data.initial, rule: data.rule },
      moves: data.moves, lockedPly: 0,
    });
  } catch {
    return null;
  }
}
