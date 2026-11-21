import assert from "node:assert/strict";
import { BOARD, idx, isBlackDoubleThree } from "./board-rules.mjs";

const cross = [[7, 6], [7, 8], [6, 7], [8, 7]];
const cases = [
  { name: "直三与直三", black: cross, forbidden: true },
  { name: "跳三与直三", black: [[7, 5], ...cross.slice(1)], forbidden: true },
  { name: "被白棋封住", black: cross, white: [[7, 5]], forbidden: false },
  { name: "边界不能形成活四", black: [[0, 1], [2, 1], [1, 0], [1, 2]], at: [1, 1], forbidden: false },
  { name: "同向的多个活三伸展点只算一条", black: [[7, 6], [7, 8]], forbidden: false },
  { name: "形成活四的唯一延伸本身是双三", black: [[7, 5], [7, 8], [6, 7], [8, 7], [6, 6], [8, 6], [6, 5]], forbidden: false },
  { name: "成五优先", black: [...cross, [5, 5], [6, 6], [8, 8], [9, 9]], forbidden: false },
  { name: "长连仍按成五处理", black: [...cross, [4, 4], [5, 5], [6, 6], [8, 8], [9, 9]], forbidden: false },
];

for (const { name, black, white = [], at = [7, 7], forbidden } of cases) {
  const board = new Uint8Array(BOARD * BOARD);
  for (const [r, c] of black) board[idx(r, c)] = 1;
  for (const [r, c] of white) board[idx(r, c)] = 2;
  const original = board.slice();
  assert.equal(isBlackDoubleThree(board, ...at), forbidden, name);
  assert.deepEqual(board, original, name + "还原棋盘");
}
console.log("VERIFY OK: 8 cases for double-three, including jumps, blocked extensions and winning moves.");
