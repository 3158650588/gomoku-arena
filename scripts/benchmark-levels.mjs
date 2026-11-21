// Compare adjacent difficulty settings with identical openings, swapping colors.
import { chromium } from "playwright";
import { createServer } from "vite";

const from = process.argv[2];
const server = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage();
  await page.route("**/level-benchmark", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>Difficulty benchmark</title>" }));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/level-benchmark`);
  await page.exposeFunction("reportPair", (summary) => console.log(JSON.stringify(summary)));
  await page.evaluate(async (from) => {
    const { DIFFICULTIES, RAPFI_LEVELS, usesRapfi } = await import("/src/game/gomoku/ai.ts");
    const { BLACK, WHITE, EMPTY, checkWin, createBoard, idx, inBounds } = await import("/src/game/gomoku/logic.ts");
    const aiUrl = new URL("/src/game/gomoku/ai.ts", location.href).href;
    const localScript = URL.createObjectURL(new Blob([`
      import { bestMove } from ${JSON.stringify(aiUrl)};
      self.onmessage = ({ data }) => {
        const { history, player, difficulty, seed } = data;
        const board = new Uint8Array(225);
        for (const { r, c, player: stone } of history) board[r * 15 + c] = stone;
        const rand = () => {
          const state = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          return state / 4294967296;
        };
        self.postMessage({ type: "move", move: bestMove(board, player, difficulty, rand) });
      };
    `], { type: "text/javascript" }));

    const openings = [
      [[7, 7], [8, 8], [7, 8], [7, 9]],
      [[7, 7], [6, 8], [8, 7], [9, 7]],
      [[7, 7], [7, 8], [8, 5], [9, 7]],
      [[6, 8], [7, 6], [6, 6], [6, 7]],
    ];
    const pairs = DIFFICULTIES.slice(1).map((higher, i) => [DIFFICULTIES[i], higher]);
    if (from && !pairs.some(([lower]) => lower === from)) throw new Error("Unknown starting tier: " + from);

    const ask = (worker, data) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Engine timeout for " + data.difficulty)), 25000);
      worker.onerror = (error) => {
        clearTimeout(timer);
        reject(new Error(error.message));
      };
      worker.onmessage = ({ data }) => {
        if (data.type === "ready") return;
        clearTimeout(timer);
        if (data.type === "error") reject(new Error(data.message));
        else resolve(data.move);
      };
      worker.postMessage(data);
    });

    async function duel(lower, higher, opening, openingId, higherColor) {
      const levels = higherColor === BLACK ? [lower, higher, lower] : [lower, lower, higher];
      const workers = [BLACK, WHITE].map((color) => usesRapfi(levels[color])
        ? new Worker("/rapfi/worker.js")
        : new Worker(localScript, { type: "module" }));
      try {
        const board = createBoard();
        const history = opening.map(([r, c], i) => ({ r, c, player: i % 2 ? WHITE : BLACK }));
        for (const { r, c, player } of history) board[idx(r, c)] = player;
        while (history.length < board.length) {
          const player = history.length % 2 ? WHITE : BLACK;
          const difficulty = levels[player];
          const move = await ask(workers[player - 1], {
            history, player, difficulty,
            seed: Math.imul(openingId + 1, 10007) ^ Math.imul(history.length, 65537),
            ...RAPFI_LEVELS[difficulty],
          });
          if (!move || move.player !== player || !inBounds(move.r, move.c) ||
              board[idx(move.r, move.c)] !== EMPTY) {
            throw new Error(`Illegal move from ${difficulty}: ${JSON.stringify(move)}`);
          }
          history.push(move);
          board[idx(move.r, move.c)] = player;
          if (checkWin(board, move.r, move.c, player).win) {
            return { higherColor, result: player === higherColor ? "win" : "loss", plies: history.length };
          }
        }
        return { higherColor, result: "draw", plies: history.length };
      } finally {
        workers.forEach((worker) => worker.terminate());
      }
    }

    for (const [lower, higher] of pairs) {
      if (from && lower !== from) continue;
      const games = await Promise.all(openings.flatMap((opening, i) =>
        [BLACK, WHITE].map((color) => duel(lower, higher, opening, i, color))));
      await window.reportPair({
        lower, higher,
        higherWins: games.filter((game) => game.result === "win").length,
        draws: games.filter((game) => game.result === "draw").length,
        games,
      });
    }
    URL.revokeObjectURL(localScript);
  }, from);
} finally {
  await browser?.close();
  await server.close();
}
