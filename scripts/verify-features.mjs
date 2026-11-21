import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { preview } from "vite";
import { winningLine } from "./board-rules.mjs";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const [{ contents }] = (await build({ stdin: { contents: `
  export { dailyPuzzle, readPosition } from "./src/game/gomoku/match.ts";
  export { solveEndgame } from "./src/game/gomoku/endgame.ts";
  export { proveFourAttack } from "./src/game/gomoku/tactics.ts";
`, resolveDir: cwd }, bundle: true, platform: "node", format: "esm", write: false })).outputFiles;
const { dailyPuzzle, readPosition, solveEndgame, proveFourAttack } = await import(`data:text/javascript;base64,${Buffer.from(contents).toString("base64")}`);

const movesFrom = (black, white) => black.flatMap(([r, c], ply) => [
  { r, c, player: 1 }, ...white[ply] ? [{ r: white[ply][0], c: white[ply][1], player: 2 }] : [],
]);
const banned = movesFrom([[7, 6], [7, 8], [6, 7], [8, 7], [7, 7]], [[0, 0], [2, 3], [4, 12], [12, 11]]);
const loss = movesFrom([[0, 0], [1, 2], [3, 4], [11, 1], [12, 13]], [[7, 3], [7, 4], [7, 5], [7, 6], [7, 7]]);
const review = movesFrom([[7, 1], [7, 2], [7, 3], [7, 4]], [[7, 0], [11, 2], [1, 5]]);

const board = Uint8Array.from({ length: 225 }, (_, square) => (Math.floor(square / 15) + 2 * (square % 15)) % 4 < 2 ? 1 : 2);
const gaps = [0, 39, 74, 96, 112];
const drawing = board.slice();
for (const square of gaps) drawing[square] = 0;
assert.equal(solveEndgame(drawing, 1, "freestyle").winner, null);
for (const square of [1, 2, 3, 4]) board[square] = 1;
for (const square of gaps) board[square] = 0;
const stones = [];
board.forEach((player, square) => {
  if (!player) return;
  const move = { r: Math.floor(square / 15), c: square % 15, player };
  assert.equal(winningLine(board, move.r, move.c, player), undefined);
  stones.push(move);
});
const position = board.slice();
const solved = solveEndgame(board, 1, "double-three");
assert.deepEqual(solved, { kind: "exact", winner: 1, plies: 1, winnerMoves: 1, move: { r: 0, c: 0, player: 1 } });
assert.deepEqual(board, position);
assert.equal(solveEndgame(new Uint8Array(225), 1, "freestyle").kind, "too-many");
assert.equal(solveEndgame(board, 1, "freestyle", 0).kind, "timeout");
assert.equal(dailyPuzzle("2026-02-30"), undefined);
let today;
const variations = new Set();
for (let n = 0; n < 48; n++) {
  const date = new Date(Date.UTC(2026, 10, 1 + n)).toISOString().slice(0, 10);
  const puzzle = dailyPuzzle(date);
  variations.add(JSON.stringify(puzzle.moves));
  const b = readPosition(puzzle.moves);
  const target = puzzle.goal.maxMoves;
  const proof = proveFourAttack(b.board, puzzle.player, "freestyle", target - 1, 1500);
  assert.equal(typeof proof, "number", date);
  if (target > 1) assert.equal(proveFourAttack(b.board, puzzle.player, "freestyle", target - 2, 1500), null, date);
  if (!today && target === 1) today = { date, r: Math.floor(proof / 15), c: proof % 15 };
}
assert.equal(variations.size, 48);

const server = await preview({ root: cwd, preview: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
let browser;
const errors = [];
try {
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
  const open = async (options = {}) => {
    const page = await browser.newPage(options);
    page.on("pageerror", (error) => errors.push(error.message));
    return page;
  };
  const button = (page, name) => page.getByRole("button", { name, exact: true });
  const snapshot = (page) => page.evaluate(() => window.__gomoku.snap());
  const point = (page, r, c) => page.evaluate(([row, col]) => window.__gomoku.screenPos(row, col), [r, c]);
  const place = (page, r, c) => page.evaluate(([row, col]) => window.__gomoku.place(row, col), [r, c]);
  const back = async (page) => {
    await button(page, "暂停").click();
    await button(page, "返回标题").click();
  };
  const mobile = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.goto(url);
  await button(mobile, "设置").tap();
  await button(mobile, "先预览、再确认").tap();
  await button(mobile, "深算").tap();
  await button(mobile, "试落子 A1").tap();
  await mobile.getByRole("status").filter({ hasText: "预览棋" }).waitFor();
  await button(mobile, "试落子 A1").tap();
  await mobile.getByRole("status").filter({ hasText: "已落子" }).waitFor();
  await mobile.getByRole("checkbox", { name: /大师落子复核/ }).uncheck();
  await mobile.getByRole("checkbox", { name: /残局精算/ }).uncheck();
  if (process.env.GOMOKU_SETTINGS_SCREENSHOT) await mobile.screenshot({ path: process.env.GOMOKU_SETTINGS_SCREENSHOT });
  await mobile.reload();
  await button(mobile, "设置").tap();
  assert.equal(await button(mobile, "先预览、再确认").getAttribute("aria-pressed"), "true");
  assert.equal(await button(mobile, "深算").getAttribute("aria-pressed"), "true");
  assert.equal(await mobile.getByRole("checkbox", { name: /大师落子复核/ }).isChecked(), false);
  assert.equal(await mobile.getByRole("checkbox", { name: /残局精算/ }).isChecked(), false);
  await button(mobile, "开局").tap();
  await button(mobile, "本地双人").tap();
  await button(mobile, "俯视").tap();
  const p = await point(mobile, 7, 7), q = await point(mobile, 7, 8);
  await mobile.touchscreen.tap(p.x, p.y);
  assert.equal((await snapshot(mobile)).moveCount, 0);
  assert.deepEqual((await snapshot(mobile)).touchPreview, { r: 7, c: 7 });
  const cdp = await mobile.context().newCDPSession(mobile);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...p, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...q, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await mobile.waitForFunction(() => window.__gomoku.snap().touchPreview?.c === 8);
  assert.equal((await snapshot(mobile)).moveCount, 0);
  await button(mobile, "确认落子").tap();
  await mobile.waitForFunction(() => window.__gomoku.snap().lastMove?.c === 8);
  await mobile.touchscreen.tap(p.x, p.y);
  await button(mobile, "取消").tap();
  assert.equal((await snapshot(mobile)).touchPreview, null);
  await mobile.touchscreen.tap(p.x, p.y);
  await mobile.touchscreen.tap(p.x, p.y);
  await mobile.waitForFunction(() => window.__gomoku.snap().moveCount === 2);
  await button(mobile, "暂停").tap();
  await button(mobile, "设置").tap();
  await button(mobile, "轻点直接下").tap();
  await button(mobile, "返回暂停").tap();
  await button(mobile, "继续（Esc）").tap();
  const direct = await point(mobile, 8, 7);
  await mobile.touchscreen.tap(direct.x, direct.y);
  await mobile.waitForFunction(() => window.__gomoku.snap().moveCount === 3);
  await mobile.close();

  const training = await open({ timezoneId: "Asia/Shanghai" });
  await training.clock.setFixedTime(new Date(`${today.date}T02:00:00Z`));
  await training.addInitScript((moves) => localStorage.setItem("game.gomoku.replays", JSON.stringify([{
    id: "lost", timestamp: Date.now(), winner: 2,
    match: { setup: { mode: "solo", playerColor: 1, style: "balanced", difficulty: "normal" }, moves, lockedPly: 0 },
  }])), loss);
  await training.goto(url);
  await button(training, "训练").click();
  await button(training, "挑战今日残局").click();
  assert.equal((await snapshot(training)).daily.day, today.date);
  assert(await place(training, today.r, today.c));
  await training.getByText(/今日最佳 1 手/).waitFor();
  await button(training, "返回标题").click();
  await button(training, "先得四连").click();
  assert.equal((await snapshot(training)).playerColor, 2);
  assert(await place(training, 7, 10));
  await button(training, "下一关 · 先占活三").click();
  assert.equal((await snapshot(training)).handicap.index, 1);
  await back(training);
  await button(training, "练习最近一盘败局").click();
  await button(training, "练习防守").click();
  assert.equal((await snapshot(training)).playerColor, 1);
  assert.equal((await snapshot(training)).mode, "practice");
  await back(training);
  await button(training, "练习最近一盘败局").click();
  await button(training, "换边练杀").click();
  assert.equal((await snapshot(training)).playerColor, 2);
  assert.equal((await snapshot(training)).turn, 2);
  await training.close();

  const replays = await open();
  await replays.goto(url);
  const importReplay = async (data) => {
    await button(replays, "棋谱").click();
    await replays.getByLabel("导入棋谱").setInputFiles({
      name: "fixture.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ format: "gomoku-replay", version: 1, playerColor: 1, difficulty: "normal", ...data })),
    });
  };
  await importReplay({ local: true, moves: banned });
  await button(replays, "对照禁双三").click();
  await replays.getByRole("status").filter({ hasText: "第 9 手黑棋 H8 违规" }).waitFor();
  assert.equal((await snapshot(replays)).replayPly, 8);
  await button(replays, "从这手重下").click();
  assert.equal((await snapshot(replays)).rule, "double-three");
  assert.equal(await place(replays, 7, 7), false);
  await back(replays);
  await importReplay({ moves: [], initial: { stones, turn: 1 }, rule: "double-three" });
  await button(replays, "残局精算").click();
  await replays.getByRole("status").filter({ hasText: /黑棋需 1 手取胜.*A1/ }).waitFor();
  await replays.close();

  const tactics = await open();
  await tactics.addInitScript((moves) => localStorage.setItem("game.gomoku.active", JSON.stringify({
    setup: { mode: "solo", playerColor: 1, style: "balanced", difficulty: "hard" }, moves, lockedPly: 0,
  })), review);
  await tactics.route("**/rapfi/worker.js", (route) => route.fulfill({
    contentType: "text/javascript", body: `self.postMessage({type:"ready"});
      self.onmessage = ({data}) => self.postMessage({ type:"move", token:data.token, move:{r:0,c:1,player:data.player} });`,
  }));
  await tactics.goto(url);
  await button(tactics, "继续上次对局").click();
  await tactics.waitForFunction(() => window.__gomoku.snap().moveCount === 8);
  assert.deepEqual((await snapshot(tactics)).lastMove, { r: 7, c: 5, player: 2 });
  await tactics.close();

  const tenseMoves = movesFrom([[7, 1], [7, 2], [7, 3]], [[12, 12], [10, 1]]);
  for (const rule of ["freestyle", "double-three"]) {
    for (const deep of [false, true]) {
      const budgets = await open();
      await budgets.addInitScript(({ rule, moves }) => {
        localStorage.setItem("game.gomoku.active", JSON.stringify({
          setup: { mode: "solo", playerColor: 1, style: "balanced", difficulty: "hard", rule }, moves, lockedPly: 0,
        }));
        const post = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function (message, ...rest) {
          if (message.token > 0 && (message.history?.length === 5 ||
              (message.kind === undefined && message.board?.filter(Boolean).length === 5))) {
            window.__masterRequest = { timeMs: message.timeMs, depth: message.maxDepth, multiple: message.multiple };
          }
          return post.call(this, message, ...rest);
        };
      }, { rule, moves: tenseMoves });
      await budgets.route("**/rapfi/worker.js", (route) => route.fulfill({
        contentType: "text/javascript", body: 'self.postMessage({type:"ready"});',
      }));
      await budgets.goto(url);
      await button(budgets, "设置").click();
      if (deep) await button(budgets, "深算").click();
      else assert.equal(await button(budgets, "标准").getAttribute("aria-pressed"), "true");
      await button(budgets, "开局").click();
      await button(budgets, "继续上次对局").click();
      await budgets.waitForFunction(() => window.__masterRequest);
      const request = await budgets.evaluate(() => window.__masterRequest);
      if (rule === "freestyle") {
        assert.equal(request.multiple, true);
        assert.equal(request.timeMs, deep ? 5480 : 3260);
      } else {
        assert.equal(request.timeMs, deep ? 4200 : 2200);
        assert.equal(request.depth, deep ? 16 : 12);
      }
      await budgets.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log("VERIFY OK: touchscreen confirmation, settings persistence, standard and deep budgets, tactical recheck, exact endgame, daily layouts, handicap, rule replay and loss lessons.");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
