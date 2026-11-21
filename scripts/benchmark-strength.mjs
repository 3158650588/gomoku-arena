import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { BOARD, idx, isBlackDoubleThree, winningLine } from "./board-rules.mjs";

const [{ text }] = (await build({
  entryPoints: [fileURLToPath(new URL("../src/game/gomoku/ai.ts", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "esm",
})).outputFiles;
const freshURL = `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const baselineURL = new URL("./baselines/v5.6-engine.mjs", import.meta.url);
const timeMs = Number(process.argv[2] ?? 120);
assert(Number.isFinite(timeMs) && timeMs >= 15, "Give both engines at least 15 ms per move.");
const result = { wins: 0, draws: 0, losses: 0, winsAsBlack: 0, winsAsWhite: 0 };
const openings = [
  [112, 128, 113, 114], [112, 98, 127, 142], [112, 113, 125, 142],
  [98, 111, 96, 97], [112, 126, 127, 128], [112, 110, 96, 113],
];
const rule = "double-three";
const depth = 8;
for (const [opening, sequence] of openings.entries()) {
  for (const currentSide of [1, 2]) {
    const id = opening * 2 + currentSide;
    const baseline = await import(`${baselineURL.href}?game=${id}`);
    const fresh = await import(`${freshURL}#${id}`);
    const board = new Uint8Array(BOARD * BOARD);
    const used = { baseline: 0, current: 0 };
    sequence.forEach((square, ply) => { board[square] = ply % 2 + 1; });
    let winner = 0;
    let played = sequence.length;
    for (let ply = sequence.length; ply < board.length; ply++) {
      const player = ply % 2 + 1;
      const engine = player === currentSide ? fresh : baseline;
      const started = performance.now();
      const { move } = engine.iterativeDeepening(board, player, depth, timeMs, 0, "balanced", rule);
      used[player === currentSide ? "current" : "baseline"] += performance.now() - started;
      if (!move) {
        if (player === 1 && !board.some((cell, point) => cell === 0 &&
            !isBlackDoubleThree(board, Math.floor(point / BOARD), point % BOARD))) {
          winner = 2;
          break;
        }
        throw Error(`Missing move for player ${player} in game ${id}`);
      }
      const { r, c } = move;
      assert.equal(move.player, player);
      assert.equal(board[idx(r, c)], 0);
      if (player === 1) assert.equal(isBlackDoubleThree(board, r, c), false);
      board[idx(r, c)] = player;
      played++;
      if (winningLine(board, r, c, player)) {
        winner = player;
        break;
      }
    }
    let outcome = "draw";
    if (winner === currentSide) {
      outcome = "win";
      result.wins++;
      if (currentSide === 1) result.winsAsBlack++;
      else result.winsAsWhite++;
    } else if (winner) {
      outcome = "loss";
      result.losses++;
    } else {
      result.draws++;
    }
    console.log(JSON.stringify({ id, opening: opening + 1, currentSide, outcome, plies: played,
      currentMs: Math.round(used.current), baselineMs: Math.round(used.baseline) }));
  }
}
console.log(JSON.stringify({ timeMs, depth, rule, ...result }));
