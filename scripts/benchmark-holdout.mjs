import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { BOARD, idx, inBounds, isBlackDoubleThree, winningLine } from "./board-rules.mjs";

const current = new URL("../src/game/gomoku/ai-worker.ts", import.meta.url);
const { outputFiles } = await build({ entryPoints: [fileURLToPath(current)], bundle: true, write: false, platform: "node", format: "esm" });
const freshURL = `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`;
const arena = process.argv.includes("--arena");
const baselineUrl = new URL(arena ? "./baselines/v5.9-worker.mjs" : "./baselines/v5.8-worker.mjs", import.meta.url).href;
const openings = arena ? [
  { rule: "freestyle", points: [113, 129, 127, 111, 97, 143] },
  { rule: "double-three", points: [111, 126, 98, 97, 125] },
  { rule: "freestyle", points: [96, 111, 127, 112, 140, 145] },
  { rule: "double-three", points: [98, 113, 82, 81, 129, 99] },
] : JSON.parse(await readFile(new URL("./holdout-openings.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
const timeMs = Number(args.find((arg) => !arg.startsWith("--")) ?? 140);
const referenceMs = Number(args.find((arg) => arg.startsWith("--reference-ms="))?.slice("--reference-ms=".length) ?? timeMs);
assert([timeMs, referenceMs].every((ms) => Number.isFinite(ms) && ms >= 25), "Use move budgets of at least 25 ms.");

async function loadWorker(specifier) {
  let reply;
  const scope = { postMessage(message) { reply = message; } };
  globalThis.self = scope;
  try {
    await import(specifier);
  } finally {
    delete globalThis.self;
  }
  return (data) => {
    reply = undefined;
    scope.onmessage({ data });
    assert.equal(reply?.token, data.token);
    return reply.move;
  };
}

const decode = (square) => [Math.floor(square / BOARD), square % BOARD];
const count = () => ({ wins: 0, draws: 0, losses: 0 });
const scores = count();
const byRule = { freestyle: count(), "double-three": count() };
const byColor = { black: count(), white: count() };
let game = 0;
for (const [opening, { rule, points }] of openings.entries()) {
  const initial = new Uint8Array(BOARD * BOARD);
  for (const [ply, square] of points.entries()) {
    const [r, c] = decode(square);
    const side = ply % 2 + 1;
    assert(inBounds(r, c) && initial[square] === 0);
    if (side === 1 && rule === "double-three") assert(!isBlackDoubleThree(initial, r, c));
    initial[square] = side;
    assert(!winningLine(initial, r, c, side));
  }
  for (const currentSide of [1, 2]) {
    game++;
    const old = await loadWorker(`${baselineUrl}?game=${game}`);
    const newSearch = await loadWorker(`${freshURL}#${game}`);
    const board = initial.slice();
    let winner = 0, played = points.length;
    for (let ply = points.length; ply < board.length; ply++) {
      const player = ply % 2 + 1;
      const engine = player === currentSide ? newSearch : old;
      const move = engine({ token: ply, board, ai: player, maxDepth: 8, timeMs: player === currentSide ? timeMs : referenceMs, variant: 0,
        style: "balanced", rule, review: true, exact: true,
        arena: arena && player === currentSide, deep: arena && player === currentSide });
      if (!move) {
        const noLegal = rule === "double-three" && player === 1 && !board.some((cell, square) =>
          cell === 0 && !isBlackDoubleThree(board, ...decode(square)));
        assert(noLegal, `Game ${game} returned no move at ply ${ply}`);
        winner = 2;
        break;
      }
      const { r, c } = move;
      assert(move.player === player && inBounds(r, c) && board[idx(r, c)] === 0, `Illegal move in game ${game}`);
      if (player === 1 && rule === "double-three") assert(!isBlackDoubleThree(board, r, c));
      board[idx(r, c)] = player;
      played++;
      if (winningLine(board, r, c, player)) {
        winner = player;
        break;
      }
    }
    const result = winner === currentSide ? "wins" : winner ? "losses" : "draws";
    scores[result]++;
    byRule[rule][result]++;
    byColor[currentSide === 1 ? "black" : "white"][result]++;
    console.log(JSON.stringify({ game, opening: opening + 1, rule, currentSide, result, plies: played }));
  }
}
console.log(JSON.stringify({ timeMs, referenceMs, baseline: arena ? "5.9" : "5.8", games: game, ...scores, byRule, byColor }));
