import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createDoubleThreeIndex, winningLine } from "./board-rules.mjs";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const { outputFiles } = await build({ stdin: { contents: `
  export { counterFours, fourAttack, mixedAttack, searchTime } from "./src/game/gomoku/tactics.ts";
  export { reviewMasterMove } from "./src/game/gomoku/master.ts";
`, resolveDir: cwd }, bundle: true, platform: "node", format: "esm", write: false });
const { counterFours, fourAttack, mixedAttack, searchTime, reviewMasterMove } =
  await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`);

const blank = () => new Uint8Array(225);
const ends = (board, player) => Array.from(board.keys()).filter((i) => !board[i] &&
  winningLine(board, Math.floor(i / 15), i % 15, player));
const cut = () => performance.now() + 1200;
const cross = blank();
for (const square of [111, 113, 97, 127]) cross[square] = 1;
const pristine = cross.slice();
assert.equal(fourAttack(cross, 1, undefined, 3, cut()), null);
assert.equal(mixedAttack(cross, 1, undefined, 2, cut()), 112);
assert.deepEqual(cross, pristine);

// Verify every possible White reply against the double-three attack by direct enumeration.
cross[112] = 1;
let replies = 0;
for (let reply = 0; reply < cross.length; reply++) {
  if (cross[reply]) continue;
  cross[reply] = 2;
  let unstopped = false;
  for (let candidate = 0; candidate < cross.length && !unstopped; candidate++) {
    if (cross[candidate]) continue;
    cross[candidate] = 1;
    unstopped = ends(cross, 1).length > 1 && ends(cross, 2).length === 0;
    cross[candidate] = 0;
  }
  assert(unstopped, `An actual White defense was overlooked at ${reply}`);
  cross[reply] = 0;
  replies++;
}
cross[112] = 0;
assert.equal(mixedAttack(cross, 1, createDoubleThreeIndex(cross), 3, cut()), null);
assert.equal(mixedAttack(cross, 1, undefined, 3, performance.now() - 10), undefined);
assert.deepEqual(cross, pristine);

const refutation = cross.slice();
for (const square of [32, 33, 34]) refutation[square] = 2;
assert(counterFours(refutation, 2).includes(35));
assert.equal(mixedAttack(refutation, 1, undefined, 3, cut()), null);
refutation[112] = 1;
refutation[35] = 2;
assert.deepEqual(ends(refutation, 2), [31, 36]);
assert.equal(mixedAttack(refutation, 1, undefined, 2, cut()), null);

// White has a single mandatory reply to the opening four, then Black can switch to threes.
const combo = blank();
for (const point of [113, 97, 127, 141, 156, 171]) combo[point] = 1;
for (const point of [186, 99, 128]) combo[point] = 2;
assert.equal(fourAttack(combo, 1, undefined, 4, cut()), null);
assert.equal(mixedAttack(combo, 1, undefined, 3, cut()), 111);
const reversed = Uint8Array.from(combo, (side) => side ? 3 - side : 0);
assert.equal(mixedAttack(reversed, 2, createDoubleThreeIndex(reversed), 3, cut()), 111);
combo[111] = 1;
assert.deepEqual(ends(combo, 1), [126]);
combo[126] = 2;
assert.equal(fourAttack(combo, 1, undefined, 2, cut()), null);
assert.equal(mixedAttack(combo, 1, undefined, 2, cut()), 112);

// The original move survives a four-only check but loses to the newly proved mixed attack.
const bad = { r: 0, c: 0, player: 2 }, good = { r: 7, c: 7, player: 2 };
cross[0] = 2;
assert.equal(fourAttack(cross, 1, undefined, 5, cut()), null);
assert.equal(mixedAttack(cross, 1, undefined, 2, cut()), 112);
cross[0] = 0;
const move = reviewMasterMove(cross, bad, [bad, good], 2, "freestyle", 700);
assert.deepEqual(move, good);
assert.deepEqual(cross, pristine);

const tense = blank();
tense.set([1, 1, 1], 110);
assert.equal(searchTime(tense, 2, 3500, Infinity, 6000), 6000);
assert.equal(searchTime(tense, 2, 2200, Infinity, 4200), 4200);
assert.equal(searchTime(tense, 2, 3500, 450, 6000), 300);
assert.equal(searchTime(blank(), 2, 3500, Infinity, 6000), 840);
tense[113] = 1;
assert.equal(searchTime(tense, 2, 3500, Infinity, 6000), 910);

console.log(JSON.stringify({ forcedRepliesChecked: replies, mixedSequence: true, counterFourRejected: true, shortlistDefense: true, deepBudget: true }));
