// Run the shipped Rapfi worker against independently specified tactics and v4.
// Usage: node scripts/verify-rapfi.mjs [--full]
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const full = process.argv.includes("--full");
const tacticsOnly = process.argv.includes("--tactics-only");
const server = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
await server.listen();
let browser;
try {
  const { port } = server.httpServer.address();
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage();
  await page.route("**/engine-verification", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>Rapfi verification</title>" }));
  await page.goto(`http://127.0.0.1:${port}/engine-verification`);
  await page.exposeFunction("reportMatch", (game) => console.log(JSON.stringify(game)));
  const result = await page.evaluate(async ({ full, tacticsOnly }) => {
    const { checkWin, idx, createBoard } = await import("/src/game/gomoku/logic.ts");
    const black = 1, white = 2;
    const move = ([r, c], player) => ({ r, c, player });
    const makeHistory = (first, second) => first.flatMap((cell, i) => i < second.length
      ? [move(cell, black), move(second[i], white)]
      : [move(cell, black)]);
    const rapfiWorker = () => new Worker("/rapfi/worker.js");
    const legacyWorker = () => new Worker("/src/game/gomoku/ai-worker.ts", { type: "module" });
    let token = 0;
    const ask = (worker, payload) => new Promise((resolve, reject) => {
      const id = ++token;
      const timeout = setTimeout(() => reject(new Error("Worker timed out")), 24000);
      worker.onerror = ({ message }) => {
        clearTimeout(timeout);
        reject(new Error(message));
      };
      worker.onmessage = ({ data }) => {
        if (data.type === "ready") return;
        clearTimeout(timeout);
        if (data.type === "error") reject(new Error(data.message));
        else if (data.token !== id) reject(new Error("Incorrect worker token"));
        else resolve(data);
      };
      worker.postMessage({ ...payload, token: id });
    });

    const spare = [[1, 1], [1, 11], [11, 2], [12, 10], [3, 12], [11, 13], [13, 9]];
    const tactics = [
      { name: "成五优先于挡四", first: [[4, 1], [4, 2], [4, 3], [4, 4], spare[0]],
        second: [[12, 4], [12, 5], [12, 6], [12, 7]], expected: [[12, 3], [12, 8]] },
      { name: "封堵边界冲四", first: [[0, 2], [1, 2], [2, 2], [3, 2], spare[4]],
        second: spare.slice(0, 4), expected: [[4, 2]] },
      { name: "识别跳四空点", first: [[7, 2], [7, 3], [7, 5], [7, 6], spare[4]],
        second: spare.slice(0, 4), expected: [[7, 4]] },
      { name: "无禁手规则下以长连取胜", first: spare.slice(0, 6),
        second: [[10, 2], [10, 3], [10, 4], [10, 6], [10, 7]], expected: [[10, 5]] },
      { name: "双四夹击", first: [[6, 2], [2, 6], ...spare.slice(0, 5)],
        second: [[6, 3], [6, 4], [6, 5], [3, 6], [4, 6], [5, 6]], expected: [[6, 6]] },
      { name: "连续冲四后转活四", first: [[7, 3], ...spare.slice(0, 5)],
        second: [[7, 4], [7, 5], [7, 6], [5, 7], [6, 7]], expected: [[7, 7]] },
    ];
    const tacticalWorker = rapfiWorker();
    for (const { name, first, second, expected } of tactics) {
      const { move: response } = await ask(tacticalWorker, {
        history: makeHistory(first, second), player: white, timeMs: 3500,
      });
      if (!expected.some(([r, c]) => r === response.r && c === response.c)) {
        throw new Error(`${name}: unexpected response ${JSON.stringify(response)}`);
      }
    }
    const candidateHistory = [[7, 8], [8, 8], [8, 7], [7, 7], [10, 6], [9, 8]].map((cell, ply) =>
      move(cell, ply % 2 ? white : black));
    const multiple = await ask(tacticalWorker, { history: candidateHistory, player: black, timeMs: 800, multiple: true });
    const alternatives = new Set(multiple.alternatives.map(({ r, c }) => idx(r, c)));
    if (alternatives.size < 2 || multiple.alternatives.some(({ r, c, player }) => player !== black ||
        candidateHistory.some((stone) => stone.r === r && stone.c === c))) {
      throw new Error(`Rapfi did not return comparable legal alternatives: ${JSON.stringify(multiple)}`);
    }
    tacticalWorker.terminate();
    await window.reportMatch({ tacticsPassed: tactics.length, candidateCount: alternatives.size });
    if (tacticsOnly) return null;

    const openings = [
      [],
      [[7, 7], [8, 8], [7, 8], [7, 9]],
      [[7, 7], [6, 8], [8, 7], [9, 7]],
      [[7, 7], [7, 8], [8, 5], [9, 7]],
      [[7, 7], [6, 6], [5, 5], [8, 8]],
      [[6, 8], [7, 6], [6, 6], [6, 7]],
    ];
    const rapfiTime = full ? 3500 : 350;
    const legacyTime = full ? 3000 : 350;
    const selected = full ? openings.slice(0, 2) : openings;

    async function match(opening, game) {
      const rapfiPlayer = game % 2 ? white : black;
      const rapfi = rapfiWorker();
      const legacy = [legacyWorker(), legacyWorker()];
      const history = opening.map((cell, i) => move(cell, i % 2 ? white : black));
      const board = createBoard();
      for (const m of history) board[idx(m.r, m.c)] = m.player;
      let winner = 0;
      let maxRapfiMs = 0;
      try {
        while (history.length < board.length) {
          const player = history.length % 2 ? white : black;
          let response;
          if (player === rapfiPlayer) {
            const start = performance.now();
            response = (await ask(rapfi, { history, player, timeMs: rapfiTime })).move;
            maxRapfiMs = Math.max(maxRapfiMs, performance.now() - start);
          } else {
            const replies = await Promise.all(legacy.map((worker, variant) => ask(worker, {
              board: Array.from(board), ai: player, timeMs: legacyTime, maxDepth: 14, variant,
            })));
            response = replies.reduce((best, reply) => reply.score > best.score ? reply : best).move;
          }
          if (!response || response.player !== player || board[idx(response.r, response.c)] !== 0) {
            throw new Error(`Illegal move in game ${game}: ${JSON.stringify(response)}`);
          }
          history.push(response);
          board[idx(response.r, response.c)] = player;
          if (checkWin(board, response.r, response.c, player).win) {
            winner = player;
            break;
          }
        }
        const summary = {
          game: game + 1, opening: Math.floor(game / 2), rapfiPlayer,
          result: winner === rapfiPlayer ? "win" : winner ? "loss" : "draw",
          plies: history.length, maxRapfiMs: Math.round(maxRapfiMs),
        };
        await window.reportMatch(summary);
        return summary;
      } finally {
        rapfi.terminate();
        legacy.forEach((worker) => worker.terminate());
      }
    }

    // Process a pair at a time to keep CPU contention similar with swapped colors.
    const games = [];
    for (const [i, opening] of selected.entries()) {
      games.push(...await Promise.all([match(opening, i * 2), match(opening, i * 2 + 1)]));
    }
    return { rapfiTime, legacyTime, games };
  }, { full, tacticsOnly });
  if (result) {
    const win = result.games.filter((game) => game.result === "win").length;
    const draw = result.games.filter((game) => game.result === "draw").length;
    console.log(JSON.stringify({
      rapfiMs: result.rapfiTime,
      legacyMsPerWorker: result.legacyTime,
      win, draw, loss: result.games.length - win - draw,
    }));
    assert.ok(win + draw * 0.5 > result.games.length * 0.5, "Rapfi did not outscore v4");
  }
} finally {
  await browser?.close();
  await server.close();
}
