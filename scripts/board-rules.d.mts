export const BOARD: 15;
export function idx(r: number, c: number): number;
export function inBounds(r: number, c: number): boolean;
export function winningLine(board: Uint8Array, r: number, c: number, player: number): [number, number][] | undefined;
export function isBlackDoubleThree(board: Uint8Array, r: number, c: number): boolean;
export interface DoubleThreeIndex {
  put(square: number, player: number): void;
  isForbidden(r: number, c: number): boolean;
}
export function createDoubleThreeIndex(board: Uint8Array): DoubleThreeIndex;
