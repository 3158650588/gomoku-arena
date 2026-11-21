/**
 * logic.ts — 五子棋纯规则层（无渲染依赖，可被 AI 与场景共用）。
 */

import { BOARD, inBounds, idx, isBlackDoubleThree, winningLine } from "../../../scripts/board-rules.mjs";
export { BOARD, idx, inBounds } from "../../../scripts/board-rules.mjs";
export const EMPTY = 0;
export const BLACK = 1; // 黑棋先行
export const WHITE = 2;

export type Stone = typeof BLACK | typeof WHITE;
export type Cell = typeof EMPTY | Stone;
export type Board = Uint8Array;
export type Rule = "freestyle" | "double-three";

export function createBoard(): Board {
  return new Uint8Array(BOARD * BOARD);
}

export const opposite = (stone: Stone): Stone => stone === BLACK ? WHITE : BLACK;

export interface Move {
  r: number;
  c: number;
  player: Cell;
}

/** 返回最后落子是否构成五连；若胜，给出连线两端点用于高亮。 */
export function checkWin(b: Board, r: number, c: number, player: Cell): { win: boolean; line?: [number, number][] } {
  const line = winningLine(b, r, c, player);
  return line ? { win: true, line } : { win: false };
}

export function isFull(b: Board): boolean {
  for (let i = 0; i < b.length; i++) if (b[i] === EMPTY) return false;
  return true;
}

export function forbiddenMove(board: Board, r: number, c: number, player: Cell, rule: Rule): boolean {
  return rule === "double-three" && player === BLACK && isBlackDoubleThree(board, r, c);
}

export function hasLegalMove(board: Board, player: Cell, rule: Rule): boolean {
  for (let r = 0; r < BOARD; r++) {
    for (let c = 0; c < BOARD; c++) {
      if (board[idx(r, c)] === EMPTY && !forbiddenMove(board, r, c, player, rule)) return true;
    }
  }
  return false;
}
