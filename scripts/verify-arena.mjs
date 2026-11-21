import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { createDoubleThreeIndex, isBlackDoubleThree, winningLine } from "./board-rules.mjs";
import { createNativeEngine, readEnginePosition } from "./rapfi-native.mjs";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const { outputFiles } = await build({ stdin: { contents: `
  export { fourAttack, mixedAttack } from "./src/game/gomoku/tactics.ts";
  export { reviewMasterMove } from "./src/game/gomoku/master.ts";
  export { masterBudget } from "./src/game/gomoku/master-profile.ts";
`, resolveDir: cwd }, bundle: true, platform: "node", format: "esm", write: false });
const { fourAttack, mixedAttack, reviewMasterMove, masterBudget } =
  await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`);
const lost = JSON.parse(await readFile(new URL("./arena-losses.json", import.meta.url), "utf8"));
const moveAt = (point, player) => ({ r: Math.floor(point / 15), c: point % 15, player });
const square = ({ r, c }) => r * 15 + c;
const verifyThreat = (board, side, rule) => {
  const index = rule === "double-three" ? createDoubleThreeIndex(board) : undefined;
  return fourAttack(board, side, index, 7, performance.now() + 800) ??
    mixedAttack(board, side, index, 3, performance.now() + 800);
};
for (const { rule, fullGame, ply, old, defender, refutation } of lost) {
  assert.equal(fullGame[ply], old);
  assert.equal(defender, ply % 2 + 1);
  const board = new Uint8Array(225);
  const other = 3 - defender;
  for (const [i, point] of fullGame.entries()) {
    const { r, c, player } = moveAt(point, i % 2 + 1);
    assert.equal(board[point], 0);
    if (rule === "double-three" && player === 1) assert(!isBlackDoubleThree(board, r, c));
    board[point] = player;
    assert.equal(!!winningLine(board, r, c, player), i === fullGame.length - 1);
    if (i === fullGame.length - 1) assert.equal(player, other);
  }
  board.fill(0);
  fullGame.slice(0, ply + 1).forEach((point, i) => board[point] = i % 2 + 1);
  assert.equal(verifyThreat(board, other, rule), refutation);
  board[old] = 0;
  const recovered = reviewMasterMove(board, moveAt(old, defender), [], defender, rule, 1200, true);
  assert.notEqual(square(recovered), old);
  board[square(recovered)] = defender;
  assert.equal(verifyThreat(board, other, rule), null);
}
const sparse = new Uint8Array(225);
sparse[112] = 1;
assert.equal(masterBudget(sparse, 2, "freestyle", "standard", Infinity, true), 840);
assert.equal(masterBudget(sparse, 2, "freestyle", "deep", Infinity, true), 1800);
assert.equal(masterBudget(sparse, 2, "freestyle", "arena", Infinity, true), 2800);
assert.equal(masterBudget(sparse, 2, "freestyle", "arena", 500, true), 350);

const native = createNativeEngine();
assert(native);
const command = (history, player, timeMs = 320) => readEnginePosition({ history, player, timeMs });
const gaps = [[7, 2], [7, 3], [7, 5], [7, 6], [13, 3]];
const spare = [[1, 11], [11, 2], [12, 10], [3, 12]];
const position = gaps.flatMap(([r, c], i) => [{ r, c, player: 1 },
  ...spare[i] ? [{ r: spare[i][0], c: spare[i][1], player: 2 }] : []]);
assert.deepEqual(await native.move(command(position, 2)), { r: 7, c: 4, player: 2 });
assert.equal(command([moveAt(112, 1), moveAt(112, 2)], 1), null);
assert.equal(command(position, 2, 12001), null);

async function launch(root, mobile = false) {
  const child = spawn(process.execPath, ["scripts/play-local.mjs", "--port=0", "--no-open", ...(mobile ? ["--mobile"] : [])],
    { cwd: root, windowsHide: true });
  let output = "";
  const url = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { child.kill(); reject(Error(output || "Standalone launcher timed out")); }, 10000);
    const fail = (error) => { clearTimeout(deadline); reject(error); };
    child.on("exit", (code) => fail(Error(`Launcher exited with code ${code}: ${output}`)));
    child.on("error", fail);
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(mobile ? /Phone browser address: (http:\/\/[0-9.]+:\d+\/)/ :
        /ready at (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) { clearTimeout(deadline); resolve(match[1]); }
    });
  });
  return { child, url };
}

const root = process.env.GOMOKU_TEST_ROOT || cwd;
const desktop = await launch(root);
let phone, browser;
try {
  const endpoint = (base, path) => new URL(`api/arena/${path}`, base);
  const status = await fetch(endpoint(desktop.url, "status")).then((reply) => reply.json());
  assert(status.available && status.threads === native.threads);
  const forged = await fetch(endpoint(desktop.url, "move"), {
    method: "POST", headers: { Origin: "http://example.invalid", "Content-Type": "application/json" },
    body: JSON.stringify({ history: [], player: 1, timeMs: 320 }),
  });
  assert.equal(forged.status, 403);
  phone = await launch(root, true);
  assert.equal((await fetch(endpoint(phone.url, "status"))).status, 404);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
  const btn = (page, name) => page.getByRole("button", { name, exact: true });
  const choose = async (page, mode, address) => {
    await page.goto(address);
    await btn(page, "设置").click();
    await btn(page, mode).click();
    await btn(page, "开局").click();
    await btn(page, "大师 · Rapfi").click();
  };
  const begin = (page) => page.getByRole("button", { name: /开始对局/ }).click();
  for (const [address, expected, fallback] of [[desktop.url, "native", false], [desktop.url, "rapfi", true], [phone.url, "rapfi", false]]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: address === phone.url });
    if (fallback) await page.route("**/api/arena/move", (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
    await choose(page, "擂台", address);
    await begin(page);
    await page.waitForFunction(() => window.__gomoku.snap().moveCount === 1);
    assert(await page.evaluate(() => window.__gomoku.place(3, 3)));
    await page.waitForFunction((expected) => {
      const s = window.__gomoku.snap();
      return s.moveCount === 3 && s.aiEngine === expected;
    }, expected);
    await page.close();
  }
  for (const rule of ["freestyle", "double-three"]) {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const send = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, ...rest) {
        if (message.token > 0 && (message.history?.length === 1 || message.board?.filter(Boolean).length === 1)) {
          window.__openingBudget = message.timeMs;
        }
        return send.call(this, message, ...rest);
      };
    });
    await choose(page, "深算", desktop.url);
    await btn(page, "执黑").click();
    if (rule === "double-three") await btn(page, "黑棋禁双三").click();
    await begin(page);
    assert(await page.evaluate(() => window.__gomoku.place(7, 7)));
    await page.waitForFunction(() => window.__openingBudget >= 1750);
    await page.waitForFunction(() => window.__gomoku.snap().moveCount === 2);
    await page.close();
  }
  console.log(JSON.stringify({ oldLossPositionsRecovered: lost.length, loopbackRestricted: true, nativeThreads: native.threads,
    portableFallback: true, openingsRechecked: 2 }));
} finally {
  await browser?.close();
  phone?.child.kill();
  desktop.child.kill();
}
