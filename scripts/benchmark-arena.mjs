import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { preview } from "vite";
import { createNativeEngine, readEnginePosition } from "./rapfi-native.mjs";
import { BOARD, idx, inBounds, winningLine } from "./board-rules.mjs";

const timeMs = Number(process.argv[2] ?? 320);
const browserMs = Number(process.argv[3] ?? timeMs);
assert([timeMs, browserMs].every((budget) => Number.isInteger(budget) && budget >= 100 && budget <= 5000));
const native = createNativeEngine();
assert(native, "The benchmark needs the bundled Windows x64 engine.");
const openings = JSON.parse(await readFile(new URL("./holdout-openings.json", import.meta.url), "utf8"))
  .filter(({ rule }) => rule === "freestyle").filter((_, i) => i === 0 || i === 3);
const server = await preview({ preview: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
  const score = { win: 0, loss: 0, draw: 0, unfinished: 0 };
  const byColor = { black: { ...score }, white: { ...score } };
  let game = 0;
  for (const { points } of openings) {
    for (const nativeSide of [1, 2]) {
      const page = await browser.newPage();
      const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
      await page.route("**/arena-benchmark", (route) => route.fulfill({ contentType: "text/html", body: "<title>Arena benchmark</title>" }));
      await page.goto(`${origin}/arena-benchmark`);
      const history = points.map((point, ply) => ({ r: Math.floor(point / BOARD), c: point % BOARD, player: ply % 2 + 1 }));
      const board = new Uint8Array(BOARD * BOARD);
      for (const { r, c, player } of history) board[idx(r, c)] = player;
      let winner = 0, durationNative = 0, durationBrowser = 0, nativeMoves = 0, browserMoves = 0;
      while (history.length < 84) {
        const player = history.length % 2 + 1;
        const payload = { history, player, timeMs: player === nativeSide ? timeMs : browserMs };
        const start = performance.now();
        const move = player === nativeSide ? await native.move(readEnginePosition(payload)) :
          await page.evaluate((data) => new Promise((resolve, reject) => {
            const worker = window.engine ??= new Worker("/rapfi/worker.js");
            const timeout = setTimeout(() => reject(Error("Browser Rapfi timed out")), 25000);
            worker.onmessage = ({ data }) => {
              if (data.type === "ready") return;
              clearTimeout(timeout);
              if (data.type === "error") reject(Error(data.message));
              else resolve(data.move);
            };
            worker.onerror = (event) => { clearTimeout(timeout); reject(Error(event.message)); };
            worker.postMessage({ ...data, token: data.history.length });
          }), payload);
        if (player === nativeSide) { durationNative += performance.now() - start; nativeMoves++; }
        else { durationBrowser += performance.now() - start; browserMoves++; }
        assert(move?.player === player && inBounds(move.r, move.c) && board[idx(move.r, move.c)] === 0);
        history.push(move);
        board[idx(move.r, move.c)] = player;
        if (winningLine(board, move.r, move.c, player)) { winner = player; break; }
      }
      await page.close();
      const result = winner === nativeSide ? "win" : winner ? "loss" : board.includes(0) ? "unfinished" : "draw";
      score[result]++;
      byColor[nativeSide === 1 ? "black" : "white"][result]++;
      console.log(JSON.stringify({ game: ++game, nativeSide, result, plies: history.length,
        averageNativeMs: Math.round(durationNative / Math.max(1, nativeMoves)),
        averageBrowserMs: Math.round(durationBrowser / Math.max(1, browserMoves)) }));
    }
  }
  console.log(JSON.stringify({ nativeMs: timeMs, browserMs, threads: native.threads, ...score, byColor }));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
