import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { BOARD, createDoubleThreeIndex, idx, isBlackDoubleThree, winningLine } from "./board-rules.mjs";

async function bundle(file) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(file, import.meta.url))],
    bundle: true, write: false, platform: "node", format: "esm",
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`);
}

const { iterativeDeepening } = await bundle("../src/game/gomoku/ai.ts");
const { proveFourAttack, searchTime } = await bundle("../src/game/gomoku/tactics.ts");
const { openingMove } = await bundle("../src/game/gomoku/opening-book.ts");
const book = JSON.parse(await readFile(new URL("../src/game/gomoku/opening-lines.json", import.meta.url), "utf8"));
const losses = JSON.parse(await readFile(new URL("./strength-cases.json", import.meta.url), "utf8"));
const blank = () => new Uint8Array(BOARD * BOARD);
const coords = (square) => [Math.floor(square / BOARD), square % BOARD];
const toMove = (square, player) => ({ r: coords(square)[0], c: coords(square)[1], player });

function replay(points, rule) {
  const board = blank();
  for (const [ply, square] of points.entries()) {
    const player = ply % 2 + 1;
    assert.equal(board[square], 0);
    if (rule === "double-three" && player === 1) assert.equal(isBlackDoubleThree(board, ...coords(square)), false);
    board[square] = player;
    assert.equal(winningLine(board, ...coords(square), player), undefined);
  }
  return board;
}

let randomState = 261119;
function random(limit) {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return Math.floor(randomState * limit / 2 ** 32);
}
let comparisons = 0;
let forbidden = 0;
for (let sample = 0; sample < 240; sample++) {
  const board = blank();
  for (let stone = 0; stone < (sample % 105); stone++) board[random(board.length)] = random(2) + 1;
  const index = createDoubleThreeIndex(board);
  const saved = board.slice();
  const edits = Array.from({ length: 6 }, () => random(board.length));
  const changed = edits.map((square) => {
    const previous = board[square];
    index.put(square, (previous + 1) % 3);
    return [square, previous];
  });
  for (let step = 0; step < 2; step++) {
    const snapshot = board.slice();
    for (let square = 0; square < board.length; square++) {
      const cell = coords(square);
      const expected = isBlackDoubleThree(board, ...cell);
      assert.equal(index.isForbidden(...cell), expected, `Double-three mismatch on board ${sample}, square ${square}`);
      comparisons++;
      forbidden += Number(expected);
    }
    assert.deepEqual(board, snapshot, "A legality check mutated the board");
    if (step === 0) for (const [square, previous] of changed.reverse()) index.put(square, previous);
  }
  assert.deepEqual(board, saved, "Undo lost the original position");
}
assert(forbidden > 0);

let openingChecks = 0;
for (const [rule, entries] of Object.entries(book)) {
  for (const [sequence, reply] of entries) {
    const player = sequence.length % 2 + 1;
    replay([...sequence, reply], rule);
    for (let transform = 0; transform < 8; transform++) {
      const rotated = sequence.map((point) => {
        const cell = coords(point);
        if (transform & 1) cell.reverse();
        if (transform & 2) cell[0] = BOARD - 1 - cell[0];
        if (transform & 4) cell[1] = BOARD - 1 - cell[1];
        return idx(...cell);
      });
      const board = replay(rotated, rule);
      const move = openingMove(board, rotated.map((p, ply) => toMove(p, ply % 2 + 1)), player, rule);
      assert(move, `Opening lookup failed for ${rule} on ${rotated.join(",")}`);
      assert.equal(move.player, player);
      assert.equal(board[idx(move.r, move.c)], 0);
      if (rule === "double-three" && player === 1) assert.equal(isBlackDoubleThree(board, move.r, move.c), false);
      openingChecks++;
    }
  }
}

const tense = blank();
tense.set([1, 1, 1], idx(7, 6));
assert.equal(searchTime(tense, 2, 2200), 2200);
assert(searchTime(blank(), 2, 2200) < 800);
assert(searchTime(tense, 2, 2200, 500) <= 350);
tense[idx(7, 9)] = 1;
assert(searchTime(tense, 2, 2200) < 1000);

for (const trial of losses) {
  const { history, defender, old, refutation } = trial;
  const rule = "double-three";
  const board = replay(history, rule);
  assert.equal(defender, history.length % 2 + 1);
  const attacker = 3 - defender;
  board[old] = defender;
  const proof = proveFourAttack(board, attacker, rule, 3, 2000);
  assert.equal(proof, refutation, "The recorded old move should lose to a proved sequence");
  board[old] = 0;
  const chosen = iterativeDeepening(board, defender, 8, 160, 0, "balanced", rule).move;
  const square = idx(chosen.r, chosen.c);
  assert.equal(board[square], 0);
  if (defender === 1) assert.equal(isBlackDoubleThree(board, chosen.r, chosen.c), false);
  assert(trial.alternatives.includes(square), `Repeat loss from game ${trial.opening} at ${square}`);
}

console.log(JSON.stringify({ legalityComparisons: comparisons, forbiddenSamples: forbidden, openingChecks, savedLossesDefended: losses.length }));
