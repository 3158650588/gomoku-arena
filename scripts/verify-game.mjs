/**
 * verify-game.mjs — Playwright smoke self-check: serve dist → zero console errors → three-state screenshots →
 * **direction-mapping assertions** (directly targets the most frequent playtest defect). When changing the input
 * mapping you must sync the assertions here.
 *
 * Usage: npm run build && node scripts/verify-game.mjs
 * Serves dist/public when a backend has been grafted on, otherwise dist/.
 *
 * Notes:
 * - The canvas is looked up by id — CANVAS_ID below must match the <canvas id="..."> that
 *   src/pages/Home.tsx renders. Rename it in one place and you must rename it in the other.
 * - Both WebGL and 2D canvases are supported: WebGL is read through readPixels (needs
 *   preserveDrawingBuffer), a 2D canvas through getImageData.
 * - Headless falls back to SwiftShader (software GL): it proves rendering/logic correctness only,
 *   never performance. Measure fps on a real GPU separately.
 * - Screenshots land in verification-shots/ (process files: review them, then delete the dir
 *   before delivery — the deliverable must not keep process artifacts).
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isBlackDoubleThree } from "./board-rules.mjs";

// fileURLToPath, not URL.pathname: .pathname keeps percent-encoding, so a project living under a
// path with a space (or any non-ASCII character) would yield ".../My%20Games/app" and every
// existsSync() below would miss, reporting "no build output" for a build that is right there.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
// Build output location depends on whether a backend has been grafted on:
// plain game template -> dist/ ; after backend-building -> dist/public/ (dist/boot.js is the server bundle).
const DIST = existsSync(join(ROOT, "dist/public/index.html"))
  ? join(ROOT, "dist/public")
  : join(ROOT, "dist");
if (!existsSync(join(DIST, "index.html"))) {
  console.error(`VERIFY FAIL: no build output at ${DIST} — run \`npm run build\` first`);
  process.exit(1);
}
const SHOTS = join(ROOT, "verification-shots");
mkdirSync(SHOTS, { recursive: true });

// Must match <canvas id="..."> in src/pages/Home.tsx. Change both together.
const CANVAS_ID = "game-canvas";

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".wasm": "application/wasm" };

const server = createServer(async (req, res) => {
  try {
    const raw = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    // Decode: request paths are percent-encoded, so an asset named "level 1.png" arrives as
    // "level%201.png" and would 404 (surfacing later as a bogus console-error failure).
    let path;
    try { path = decodeURIComponent(raw); } catch { path = raw; }
    const file = resolve(DIST, "." + path);
    if (file !== DIST && !file.startsWith(DIST + sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});

const fail = (msg) => { console.error("VERIFY FAIL:", msg); server.close(); process.exit(1); };

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
// prefer the playwright-bundled browser; fall back to system chrome (CHROMIUM_PATH overrides)
const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  process.platform === "win32" && "C:/Program Files/Google/Chrome/Application/chrome.exe",
  process.platform === "win32" && "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/opt/gchrome/opt/google/chrome/chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
].filter(Boolean);
let browser;
for (const exe of [null, ...CANDIDATES]) {
  try {
    browser = await chromium.launch({
      executablePath: exe ?? undefined,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
    });
    break;
  } catch { /* try the next one */ }
}
if (!browser) fail("no usable browser found (playwright bundled/chrome/chromium all unavailable)");
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
// The page boots through a React shell (src/main.tsx -> src/App.tsx -> src/pages/Home.tsx),
// so the canvas only exists after the first effect runs: wait for the readiness flag the game
// raises on its first rendered frame, then fall back to a fixed delay if it never appears.
await page
  .waitForFunction(() => window.__GAME_READY__ === true, null, { timeout: 8000 })
  .catch(() => console.warn("WARN: window.__GAME_READY__ never turned true — falling back to a fixed wait (raise the flag in src/game/boot.ts)"));
await page.waitForTimeout(1200);

// 1) The canvas must actually render content (not a black screen). Judge by reading the drawing
//    buffer, not the screenshot — on headless/swiftshader the compositor may show the canvas as
//    black while the drawing buffer holds the real frame. WebGL needs preserveDrawingBuffer for
//    that read (the template's src/game/boot.ts enables it); 2D canvases go through getImageData.
const shot = await page.evaluate((id) => {
  const SAMPLES = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]];
  const el = document.getElementById(id);
  if (!el) {
    const others = Array.from(document.querySelectorAll("canvas")).map((c) => c.id || "(no id)");
    return { kind: "no-canvas", others };
  }
  if (!(el instanceof HTMLCanvasElement)) return { kind: "not-canvas", tag: el.tagName.toLowerCase() };

  const gl = el.getContext("webgl2") || el.getContext("webgl");
  if (gl) {
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    if (!w || !h) return { kind: "empty-buffer", api: "webgl", w, h };
    const px = new Uint8Array(4);
    let lit = 0;
    for (const [fx, fy] of SAMPLES) {
      gl.readPixels((w * fx) | 0, (h * fy) | 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      if (px[3] > 0 && px[0] + px[1] + px[2] > 8) lit++;
    }
    return { kind: "lit", api: "webgl", lit, total: SAMPLES.length };
  }

  const ctx = el.getContext("2d");
  if (ctx) {
    const w = el.width, h = el.height;
    if (!w || !h) return { kind: "empty-buffer", api: "2d", w, h };
    let lit = 0;
    try {
      for (const [fx, fy] of SAMPLES) {
        const d = ctx.getImageData((w * fx) | 0, (h * fy) | 0, 1, 1).data;
        if (d[3] > 0 && d[0] + d[1] + d[2] > 8) lit++;
      }
    } catch (e) {
      return { kind: "tainted", message: String(e) };
    }
    return { kind: "lit", api: "2d", lit, total: SAMPLES.length };
  }
  return { kind: "no-context" };
}, CANVAS_ID);

switch (shot.kind) {
  case "no-canvas":
    fail(
      `no element with id="${CANVAS_ID}" on the page, so the render check could not run.\n` +
      `  This script looks up document.getElementById("${CANVAS_ID}"); the template renders that id from src/pages/Home.tsx.\n` +
      (shot.others.length
        ? `  Canvases that do exist: ${shot.others.join(", ")} — you renamed the id.\n`
        : `  There is no <canvas> on the page at all — did startGame() run, or did the page throw before mounting?\n`) +
      `  Fix: keep id="${CANVAS_ID}" in the page, or change CANVAS_ID at the top of this script to the id you use.`
    );
    break;
  case "not-canvas":
    fail(`the element with id="${CANVAS_ID}" is a <${shot.tag}>, not a <canvas> — give the canvas that id (src/pages/Home.tsx), or point CANVAS_ID at the right element.`);
    break;
  case "no-context":
    fail(`#${CANVAS_ID} exposes neither a WebGL nor a 2D context — this is not a drawable canvas, so "black" cannot be judged. Check how the renderer acquires its context in src/game/boot.ts.`);
    break;
  case "tainted":
    fail(`#${CANVAS_ID} is a 2D canvas whose pixels cannot be read back (${shot.message}) — a cross-origin image tainted it. Serve textures from the project itself so the render check can run.`);
    break;
  case "empty-buffer":
    fail(`#${CANVAS_ID} has a zero-sized ${shot.api} buffer (${shot.w}x${shot.h}) — the canvas was never sized. Set renderer.setSize()/canvas.width+height in src/game/boot.ts.`);
    break;
  case "lit":
    if (shot.lit < 2) {
      fail(shot.api === "webgl"
        ? `#${CANVAS_ID} (WebGL) is black: only ${shot.lit}/${shot.total} sampled pixels carry colour. If you are sure the game has visuals, check whether the renderer disabled preserveDrawingBuffer — without it the buffer reads back empty.`
        : `#${CANVAS_ID} (2D) is blank: only ${shot.lit}/${shot.total} sampled pixels carry colour. Nothing was drawn to the 2D context by the time of the check.`);
    }
    break;
  default:
    fail(`unexpected canvas check result: ${JSON.stringify(shot)}`);
}
await page.screenshot({ path: join(SHOTS, "01-title.png") });

// 2) Enter playing
const levels = page.getByRole("group", { name: "人机难度" });
if (await levels.getByRole("button").count() !== 6) fail("expected six levels");
await page.getByRole("button", { name: "执白", exact: true, pressed: true }).waitFor();
await page.getByRole("button", { name: "执黑", exact: true }).click();
await levels.getByRole("button", { name: "大师 · Rapfi" }).click();
// Clear button focus to test the game's Space shortcut.
await page.evaluate(() => document.activeElement.blur());
await page.keyboard.press("Space");
await page.waitForTimeout(400);

// 3) Direction assertions: pressing W must move forward (moving in the z-decreasing direction), pressing D must move right (x increasing)
async function playerPos() {
  return page.evaluate(() => window.__gameProbe ? window.__gameProbe() : null);
}
async function deltaAfter(key, ms = 500) {
  const before = await playerPos();
  if (!before) return null;
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
  const after = await playerPos();
  return after ? { dx: after.x - before.x, dz: after.z - before.z } : null;
}

const probe = await page.evaluate(() => !!window.__gameProbe);
if (probe) {
  const dW = await deltaAfter("KeyW");
  if (dW && dW.dz >= -0.05) fail(`W did not move forward (dz=${dW?.dz.toFixed(3)}) — direction mapping looks reversed`);
  const dD = await deltaAfter("KeyD");
  if (dD && dD.dx <= 0.05) fail(`D did not move right (dx=${dD?.dx.toFixed(3)}) — direction mapping looks reversed`);
} else {
  console.warn("WARN: window.__gameProbe not injected, skipping direction assertions (expose a player-coordinate probe in src/game/boot.ts)");
}

// 4) Gameplay screenshot + Esc pause + restart
await page.screenshot({ path: join(SHOTS, "02-gameplay.png") });
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
await page.screenshot({ path: join(SHOTS, "03-paused.png") });

// 5) Play actual hard-mode moves, then undo and play from the restored history.
const state = (filter, arg) => page.waitForFunction(filter, arg, { timeout: 20000 });
await state(() => window.__gomoku?.snap().phase === "paused");
await page.keyboard.press("Escape");
await state(() => {
  const s = window.__gomoku?.snap();
  return s?.phase === "playing" && s.difficulty === "hard" && s.aiEngine === "rapfi";
});
for (let i = 0; i < 3; i++) {
  const blackMove = [7, 6 + i];
  if (i === 0) {
    const target = await page.evaluate(([r, c]) => window.__gomoku.screenPos(r, c), blackMove);
    await page.mouse.click(target.x, target.y);
  } else {
    // Prefer the intended line, but keep the move legal if Rapfi already blocked it.
    const placed = await page.evaluate(([r, c]) => window.__gomoku.place(r, c) ||
      window.__gomoku.place(r + 2, c) || window.__gomoku.place(r + 3, c), blackMove);
    if (!placed) fail("failed to submit a legal black move");
  }
  await state((count) => {
    const s = window.__gomoku.snap();
    return s.turn === 1 && s.moveCount === count && s.aiEngine === "rapfi";
  }, 2 * i + 2);
}
await page.getByRole("button", { name: "悔棋", exact: true }).click();
await state(() => window.__gomoku.snap().moveCount === 4);
await page.keyboard.press("Escape");
await page.getByRole("button", { name: "青瓷", exact: true }).click();
await state(() => {
  const s = window.__gomoku.snap();
  return s.skin === "celadon" && s.phase === "paused" && s.moveCount === 4;
});
await page.keyboard.press("Escape");
await page.evaluate(() => window.__gomoku.place(0, 0));
await state(() => {
  const s = window.__gomoku.snap();
  return s.moveCount === 6 && s.aiEngine === "rapfi";
});
await page.getByRole("button", { name: "重开", exact: true }).click();
await state(() => window.__gomoku.snap().moveCount === 0);
await page.reload();
await page.getByRole("button", { name: "青瓷", exact: true, pressed: true }).waitFor();
await page.getByRole("button", { name: "执黑", exact: true, pressed: true }).waitFor();
await levels.getByRole("button", { name: "大师 · Rapfi", pressed: true }).waitFor();

// Enter as White with the real Rapfi worker playing Black.
await page.getByRole("button", { name: "执白", exact: true }).click();
await page.getByRole("button", { name: "偏进攻", exact: true }).click();
await page.getByRole("button", { name: /开始对局/ }).click();
await state(() => {
  const s = window.__gomoku.snap();
  return s.turn === 2 && s.playerColor === 2 && s.moveCount === 1 && s.aiEngine === "rapfi";
});
await page.getByText("你的回合（白）", { exact: true }).waitFor();
const undo = page.getByRole("button", { name: "悔棋", exact: true });
if (!await undo.isDisabled()) fail("AI's opening stone should stay on the board");
const aiOpening = await page.evaluate(() => window.__gomoku.snap().lastMove);
const whiteTarget = await page.evaluate(({ r, c }) =>
  window.__gomoku.screenPos(0, r === 0 && c === 0 ? 14 : 0), aiOpening);
await page.mouse.click(whiteTarget.x, whiteTarget.y);
await state(() => {
  const s = window.__gomoku.snap();
  return s.turn === 2 && s.moveCount === 3 && s.aiEngine === "rapfi";
});
await undo.click();
await state(({ r, c }) => {
  const s = window.__gomoku.snap();
  return s.turn === 2 && s.moveCount === 1 && s.lastMove.r === r && s.lastMove.c === c;
}, aiOpening);
await page.getByRole("button", { name: "重开", exact: true }).click();
await state(() => {
  const s = window.__gomoku.snap();
  return s.turn === 2 && s.moveCount === 1 && s.aiEngine === "rapfi";
});

// 6) Exercise a delayed worker failure across pause/resume.
const recovery = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await recovery.route("**/rapfi/worker.js", (route) => route.fulfill({
  contentType: "text/javascript",
  body: `self.postMessage({type: "ready"});
    self.onmessage = ({ data }) => setTimeout(() => self.postMessage({
      type: "error", token: data.token, message: "verification"
    }), 1100);`,
}));
await recovery.addInitScript(() => {
  const postMessage = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (...args) {
    window.__verifyAiRequest = args[0]?.token;
    return postMessage.apply(this, args);
  };
});
await recovery.goto(`http://127.0.0.1:${port}/`);
await recovery.getByRole("button", { name: "执黑", exact: true }).click();
await recovery.getByRole("button", { name: "大师 · Rapfi" }).click();
await recovery.getByRole("button", { name: "偏防守", exact: true }).click();
await recovery.getByRole("button", { name: /开始对局/ }).click();
await recovery.evaluate(() => window.__gomoku.place(7, 7));
await recovery.waitForFunction(() => window.__verifyAiRequest);
const cancelledToken = await recovery.evaluate(() => window.__verifyAiRequest);
await recovery.getByRole("button", { name: "重开", exact: true }).click();
await recovery.waitForFunction(() => window.__gomoku.snap().aiEngine === "rapfi");
await recovery.waitForTimeout(1200);
const afterRestart = await recovery.evaluate(() => window.__gomoku.snap());
if (afterRestart.moveCount !== 0 || afterRestart.aiEngine !== "rapfi") {
  fail("a reply from the cancelled search affected the new match");
}
await recovery.evaluate(() => window.__gomoku.place(7, 8));
await recovery.waitForFunction((oldToken) =>
  window.__verifyAiRequest && window.__verifyAiRequest !== oldToken, cancelledToken);
await recovery.keyboard.press("Escape");
await recovery.waitForFunction(() => {
  const s = window.__gomoku.snap();
  return s.phase === "paused" && s.aiEngine === "fallback" && s.moveCount === 1;
});
await recovery.keyboard.press("Escape");
await recovery.waitForFunction(() => window.__gomoku.snap().moveCount === 2);
await recovery.getByRole("status").filter({ hasText: "已切换为普通 AI" }).waitFor();
await recovery.close();

// 7) Use browser touch input to exercise gestures and rotate a live match.
const mobile = await browser.newPage({
  viewport: { width: 360, height: 780 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
mobile.on("pageerror", (e) => consoleErrors.push(String(e)));
await mobile.goto(`http://127.0.0.1:${port}/`);
await mobile.getByRole("button", { name: "星夜", exact: true }).tap();
await mobile.getByRole("button", { name: /开始对局/ }).tap();
await mobile.waitForFunction(() => {
  const s = window.__gomoku.snap();
  return s.turn === 2 && s.playerColor === 2 && s.moveCount === 1;
});
await mobile.getByText("轻点落子 · 拖动旋转 · 双指缩放").waitFor();
const input = await mobile.context().newCDPSession(mobile);
const finger = (id, x, y) => ({ id, x, y });
const touch = (type, ...touchPoints) => input.send("Input.dispatchTouchEvent", { type, touchPoints });
const afterPaint = () => mobile.evaluate(() =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const project = (cells) => mobile.evaluate((list) =>
  list.map(([r, c]) => window.__gomoku.screenPos(r, c)), cells);
const widthOfBoard = async () => {
  const [a, b] = await project([[7, 4], [7, 10]]);
  return b.x - a.x;
};
await afterPaint();
const baseWidth = await widthOfBoard();
await touch("touchStart", finger(1, 120, 390), finger(2, 240, 390));
await touch("touchMove", finger(1, 90, 390), finger(2, 270, 390));
await touch("touchEnd", finger(1, 90, 390));
await touch("touchEnd");
await afterPaint();
if (await widthOfBoard() < baseWidth * 1.15) fail("pinch did not zoom in");
if (await mobile.evaluate(() => window.__gomoku.snap().moveCount) !== 1) fail("pinch placed a stone");
const reset = mobile.getByRole("button", { name: "复位视角", exact: true });
await reset.tap();
await afterPaint();
if (Math.abs(await widthOfBoard() - baseWidth) > 1) fail("reset did not restore the camera");

const beforeDrag = (await project([[0, 0]]))[0];
await touch("touchStart", finger(1, 160, 380));
await touch("touchMove", finger(1, 260, 418));
await touch("touchEnd");
await afterPaint();
const afterDrag = (await project([[0, 0]]))[0];
if (Math.hypot(afterDrag.x - beforeDrag.x, afterDrag.y - beforeDrag.y) < 10) fail("drag did not rotate");
if (await mobile.evaluate(() => window.__gomoku.snap().moveCount) !== 1) fail("drag placed a stone");
await reset.tap();
await afterPaint();
const afterReset = (await project([[0, 0]]))[0];
if (Math.hypot(afterReset.x - beforeDrag.x, afterReset.y - beforeDrag.y) > 1) fail("reset did not undo rotation");
await touch("touchStart", finger(1, 180, 390));
await touch("touchCancel");

async function checkCorners() {
  const corners = await project([[0, 0], [0, 14], [14, 0], [14, 14]]);
  const reachable = await mobile.evaluate((points) => points.every(({ x, y }) =>
    document.elementFromPoint(x, y)?.id === "game-canvas"), corners);
  if (!reachable) fail(`phone viewport obstructed a board corner: ${JSON.stringify(corners)}`);
  return corners;
}
const corners = await checkCorners();
await mobile.touchscreen.tap(corners[2].x, corners[2].y);
await mobile.waitForFunction(() => {
  const p = window.__gameProbe();
  return p.x === -7 && p.z === 7 && window.__gomoku.snap().moveCount === 3;
});
await mobile.screenshot({ path: join(SHOTS, "04-mobile-portrait.png") });
await mobile.setViewportSize({ width: 720, height: 360 });
await afterPaint();
await checkCorners();
if (await mobile.evaluate(() => window.__gomoku.snap().moveCount) !== 3) fail("rotation reset the match");
await mobile.getByRole("button", { name: "暂停", exact: true }).tap();
await mobile.getByRole("button", { name: "青瓷", exact: true }).tap();
await mobile.getByRole("button", { name: /继续/ }).tap();
await mobile.screenshot({ path: join(SHOTS, "05-mobile-landscape.png") });
await mobile.close();

// 8) Script Black's moves to verify both White wins and White losses reach the right totals.
const scoring = await browser.newPage();
await scoring.addInitScript(() => localStorage.setItem("game.gomoku.preferences", JSON.stringify({ tacticalReview: false })));
scoring.on("pageerror", (e) => consoleErrors.push(String(e)));
await scoring.route("**/rapfi/worker.js", (route) => route.fulfill({
  contentType: "text/javascript",
  body: `self.postMessage({ type: "ready" });
    let game = 0;
    self.onmessage = ({ data: { token, player, history } }) => {
      if (!history.length) game++;
      const index = history.length / 2;
      const [r, c] = game === 1 ? [[0,0],[1,3],[2,8],[4,10],[11,14]][index] : [4, index + 1];
      self.postMessage({ type: "move", token, move: { r, c, player } });
    };`,
}));
await scoring.goto(`http://127.0.0.1:${port}/`);
await scoring.getByRole("button", { name: "大师 · Rapfi" }).click();
await scoring.getByRole("button", { name: "偏防守", exact: true }).click();
await scoring.getByRole("button", { name: /开始对局/ }).click();
async function playWhite(moves) {
  for (const [i, [r, c]] of moves.entries()) {
    await scoring.waitForFunction((n) => {
      const s = window.__gomoku.snap();
      return s.turn === 2 && s.moveCount === n;
    }, 2 * i + 1);
    if (!await scoring.evaluate(({ r, c }) => window.__gomoku.place(r, c), { r, c })) {
      fail("expected a legal White move");
    }
  }
}
await playWhite([[7, 2], [7, 3], [7, 4], [7, 5], [7, 6]]);
await scoring.getByRole("heading", { name: "你赢了！", exact: true }).waitFor();
await scoring.waitForFunction(() => {
  const s = window.__gomoku.snap();
  return s.winner === 2 && s.scores.player === 1 && s.scores.ai === 0;
});
await scoring.getByRole("button", { name: /再来一局/ }).click();
await playWhite([[7, 2], [8, 5], [9, 8], [11, 10]]);
await scoring.getByRole("heading", { name: "AI 获胜", exact: true }).waitFor();
await scoring.waitForFunction(() => {
  const s = window.__gomoku.snap();
  const split = s.breakdown["hard:2"];
  return s.winner === 1 && s.scores.player === 1 && s.scores.ai === 1 && split.player === 1 && split.ai === 1;
});

// Replay, portable file round-trip, a practice branch, and recovery after reload.
await scoring.getByRole("button", { name: "复盘本局", exact: true }).click();
const slider = scoring.getByRole("slider", { name: "回放进度" });
if (!await scoring.getByRole("button", { name: "从这手重下", exact: true }).isDisabled()) {
  fail("a terminal position should not start a new branch");
}
await scoring.getByRole("button", { name: "上一步", exact: true }).click();
await scoring.waitForFunction(() => window.__gomoku.snap().replayPly === 8 && window.__gomoku.visibleStones() === 8);
await scoring.getByRole("button", { name: "下一步", exact: true }).click();
await scoring.waitForFunction(() => window.__gomoku.snap().replayPly === 9 && window.__gomoku.visibleStones() === 9);
await slider.press("Home");
await scoring.waitForFunction(() => window.__gomoku.snap().replayPly === 0 && window.__gomoku.visibleStones() === 0);
for (let i = 0; i < 5; i++) await slider.press("ArrowRight");
await scoring.waitForFunction(() => window.__gomoku.snap().replayPly === 5 && window.__gomoku.visibleStones() === 5);
const downloaded = scoring.waitForEvent("download");
await scoring.getByRole("button", { name: "导出棋谱", exact: true }).click();
const recordFile = await downloaded;
await scoring.getByRole("button", { name: "从这手重下", exact: true }).click();
await scoring.waitForFunction(() => {
  const s = window.__gomoku.snap();
  return s.phase === "playing" && s.mode === "practice" && s.turn === 2 && s.moveCount === 5;
});
await scoring.reload();
await scoring.getByRole("button", { name: "继续上次对局", exact: true }).click();
await scoring.waitForFunction(() => {
  const s = window.__gomoku.snap();
  return s.phase === "playing" && s.mode === "practice" && s.turn === 2 && s.moveCount === 5;
});
await scoring.getByRole("button", { name: "暂停", exact: true }).click();
await scoring.getByRole("button", { name: "返回标题", exact: true }).click();
await scoring.getByRole("button", { name: "战绩", exact: true }).click();
await scoring.getByRole("row", { name: /大师/ }).getByText("1 胜 1 负 0 平").waitFor();
await scoring.getByRole("button", { name: "棋谱", exact: true }).click();
const fileInput = scoring.getByLabel("导入棋谱");
await fileInput.setInputFiles({
  name: "invalid.json", mimeType: "application/json",
  buffer: Buffer.from('{"format":"gomoku-replay","version":1,"playerColor":2,"difficulty":"hard","moves":[{"r":15,"c":0,"player":1}]}'),
});
await scoring.getByRole("alert").waitFor();
await fileInput.setInputFiles(await recordFile.path());
await scoring.waitForFunction(() => {
  const s = window.__gomoku.snap();
  return s.replayFromLibrary && s.replayPly === 9 && window.__gomoku.visibleStones() === 9;
});
await scoring.getByRole("button", { name: "返回大厅", exact: true }).click();
await scoring.getByRole("button", { name: "开局", exact: true }).click();
await scoring.getByRole("button", { name: "继续上次对局", exact: true }).waitFor();
await scoring.close();

// 9) A second touch session covers local play, the hint ladder and the puzzle set.
const training = await browser.newPage({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
training.on("pageerror", (e) => consoleErrors.push(String(e)));
await training.goto(`http://127.0.0.1:${port}/`);
await training.getByRole("button", { name: "本地双人", exact: true }).tap();
await training.getByRole("button", { name: "俯视", exact: true }).tap();
const localPoint = await training.evaluate(() => window.__gomoku.screenPos(7, 7));
await training.touchscreen.tap(localPoint.x, localPoint.y);
await training.waitForFunction(() => window.__gomoku.snap().mode === "local" &&
  window.__gomoku.snap().overhead && window.__gomoku.snap().turn === 2 && window.__gomoku.snap().moveCount === 1);
await training.getByRole("button", { name: "3D 视角", exact: true }).tap();
await training.getByRole("button", { name: "悔棋", exact: true }).tap();
await training.waitForFunction(() => window.__gomoku.snap().turn === 1 && window.__gomoku.visibleStones() === 0);
await training.getByRole("button", { name: "暂停", exact: true }).tap();
await training.getByRole("button", { name: "返回标题", exact: true }).tap();
await training.getByRole("button", { name: "训练", exact: true }).tap();

const placeTraining = (r, c) => training.evaluate(([r, c]) => window.__gomoku.place(r, c), [r, c]);
const nextTrainingMove = (count) => training.waitForFunction((plies) => {
  const s = window.__gomoku.snap();
  return s.moveCount === plies && s.turn === s.playerColor;
}, count);
for (const [name, r, c] of [["边线救急", 4, 2], ["跳四漏点", 7, 4], ["斜线上封口", 4, 10], ["一手成五", 5, 5]]) {
  await training.getByRole("button", { name: new RegExp(name) }).tap();
  if (name === "边线救急") {
    await training.getByRole("button", { name: "提示", exact: true }).tap();
    await training.waitForFunction(() => window.__gomoku.snap().hintLevel === 1);
    await training.getByRole("button", { name: "看候选", exact: true }).tap();
    await training.waitForFunction(() => window.__gomoku.snap().hintLevel === 2);
    await training.getByRole("button", { name: "看答案", exact: true }).tap();
    await training.waitForFunction(() => window.__gomoku.snap().hintLevel === 3);
  }
  if (!await placeTraining(r, c)) fail("invalid puzzle move: " + name);
  await training.getByRole("heading", { name: "解题成功", exact: true }).waitFor();
  await training.getByRole("button", { name: "返回标题", exact: true }).tap();
}
await training.getByRole("button", { name: /双四夹击/ }).tap();
await placeTraining(6, 6);
await nextTrainingMove(14);
const forkBlock = await training.evaluate(() => window.__gomoku.snap().lastMove);
await (forkBlock.r === 6 && forkBlock.c === 7 ? placeTraining(7, 6) : placeTraining(6, 7));
await training.getByRole("heading", { name: "解题成功", exact: true }).waitFor();
await training.getByRole("button", { name: "返回标题", exact: true }).tap();
await training.getByRole("button", { name: /连续冲四/ }).tap();
await placeTraining(7, 7);
await nextTrainingMove(12);
await placeTraining(8, 7);
await nextTrainingMove(14);
const vcfBlock = await training.evaluate(() => window.__gomoku.snap().lastMove);
await (vcfBlock.r === 4 && vcfBlock.c === 7 ? placeTraining(9, 7) : placeTraining(4, 7));
await training.getByRole("heading", { name: "解题成功", exact: true }).waitFor();
await training.getByRole("button", { name: "返回标题", exact: true }).tap();
await training.getByRole("heading", { name: /残局闯关 6 \/ 6/ }).waitFor();
await training.close();

// 10) Complete and resume a two-leg challenge with a deterministic opponent.
const challenge = await browser.newPage();
await challenge.addInitScript(() => localStorage.setItem("game.gomoku.preferences", JSON.stringify({ tacticalReview: false })));
await challenge.route("**/rapfi/worker.js", (route) => route.fulfill({
  contentType: "text/javascript",
  body: `self.postMessage({ type: "ready" });
    self.onmessage = ({ data: { token, player, history } }) => {
      const index = Math.floor((history.length - 4) / 2);
      const [r, c] = [[14,0],[12,3],[14,7],[11,10],[13,13]][index];
      self.postMessage({ type: "move", token, move: { r, c, player } });
    };`,
}));
await challenge.goto(`http://127.0.0.1:${port}/`);
await challenge.getByRole("button", { name: "大师 · Rapfi", exact: true }).click();
await challenge.getByRole("button", { name: "训练", exact: true }).click();
await challenge.getByRole("button", { name: "斜邻开局", exact: true }).click();
async function winLeg(player, start) {
  for (let c = 0; c < 5; c++) {
    await challenge.waitForFunction(({ player, count }) => {
      const s = window.__gomoku.snap();
      return s.mode === "challenge" && s.turn === player && s.playerColor === player && s.moveCount === count;
    }, { player, count: start + c * 2 });
    if (!await challenge.evaluate((c) => window.__gomoku.place(1, c), c)) fail("challenge move rejected");
  }
}
await winLeg(1, 4);
await challenge.getByRole("button", { name: /换执白棋/ }).waitFor();
await challenge.reload();
await challenge.getByRole("button", { name: "训练", exact: true }).click();
await challenge.getByRole("button", { name: /继续挑战/ }).click();
await winLeg(2, 5);
await challenge.getByText("两局合计 你 2 : 0 AI", { exact: true }).waitFor();
await challenge.close();

// 11) Uneven custom position, White to move, and a real background AI reply.
const edit = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
edit.on("pageerror", (e) => consoleErrors.push(String(e)));
await edit.goto(`http://127.0.0.1:${port}/`);
await edit.getByRole("button", { name: "高手", exact: true }).tap();
await edit.getByRole("button", { name: "训练", exact: true }).tap();
await edit.getByRole("button", { name: "开始摆棋", exact: true }).tap();
await edit.waitForFunction(() => window.__gomoku.snap().phase === "editor");
const editStone = ([r, c]) => edit.evaluate(([row, column]) => window.__gomoku.place(row, column), [r, c]);
for (let c = 2; c <= 6; c++) {
  if (!await editStone([7, c])) fail("editor rejected Black stone");
}
await edit.getByRole("button", { name: "从这里开局", exact: true }).tap();
await edit.getByRole("alert").filter({ hasText: "已有五连" }).waitFor();
await edit.getByRole("button", { name: "擦除", exact: true }).tap();
await editStone([7, 6]);
await edit.getByRole("button", { name: "放白棋", exact: true }).tap();
await editStone([7, 1]);
await edit.getByRole("button", { name: "白先走", exact: true }).tap();
await edit.getByRole("button", { name: "从这里开局", exact: true }).tap();
await edit.waitForFunction(() => {
  const s = window.__gomoku.snap();
  return s.phase === "playing" && s.custom && s.turn === 2 && s.moveCount === 0 && window.__gomoku.visibleStones() === 5;
});
await editStone([7, 6]);
await edit.waitForFunction(() => window.__gomoku.snap().moveCount === 2 && window.__gomoku.markedMove()?.player === 1);
await edit.getByRole("button", { name: "悔棋", exact: true }).tap();
await edit.waitForFunction(() => !window.__gomoku.markedMove() && window.__gomoku.visibleStones() === 5 && window.__gomoku.snap().turn === 2);
await edit.close();

// 12) Exercise the local 5+3 clock without waiting five real minutes.
const timed = await browser.newPage();
await timed.addInitScript(() => {
  const original = Date.now.bind(Date);
  window.__clockOffset = 0;
  Date.now = () => original() + window.__clockOffset;
});
await timed.goto(`http://127.0.0.1:${port}/`);
await timed.getByRole("button", { name: "开启快棋 5+3", exact: true }).click();
await timed.getByRole("button", { name: "本地双人", exact: true }).click();
await timed.getByLabel("棋钟").getByText("白 5:00").waitFor();
await timed.evaluate(() => { window.__clockOffset += 7000; });
const beforeIncrement = await timed.evaluate(() => window.__gomoku.snap().clock.seconds[0]);
await timed.evaluate(() => window.__gomoku.place(7, 7));
await timed.waitForFunction((before) => {
  const s = window.__gomoku.snap();
  return s.clock.active === 2 && s.clock.seconds[0] >= before + 2 && s.clock.seconds[0] <= before + 3;
}, beforeIncrement);
await timed.getByRole("button", { name: "暂停", exact: true }).click();
const frozen = await timed.evaluate(() => window.__gomoku.snap().clock.seconds[1]);
await timed.evaluate(() => { window.__clockOffset += 8000; });
if (await timed.evaluate(() => window.__gomoku.snap().clock.seconds[1]) !== frozen) fail("paused local clock ran");
await timed.getByRole("button", { name: /继续/ }).click();
await timed.evaluate(() => { window.__clockOffset += 310000; });
await timed.getByText("白棋超时", { exact: true }).waitFor();
await timed.waitForFunction(() => window.__gomoku.snap().winner === 1 && window.__gomoku.snap().timeout);
await timed.close();

// 13) The rule is optional, persists across reloads, and applies to both people and AI.
const rules = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
rules.on("pageerror", (e) => consoleErrors.push(String(e)));
await rules.goto(`http://127.0.0.1:${port}/`);
if (await rules.getByRole("button", { name: "联机", exact: true }).count()) fail("LAN menu should be gone");
await rules.getByRole("button", { name: "黑棋禁双三", exact: true, pressed: false }).waitFor();
await rules.getByRole("button", { name: "黑棋禁双三", exact: true }).tap();
await rules.getByRole("button", { name: "本地双人", exact: true }).tap();

const cross = [[7, 6], [7, 8], [6, 7], [8, 7]];
const placeRule = ([r, c]) => rules.evaluate(([row, col]) => window.__gomoku.place(row, col), [r, c]);
for (const [i, cell] of cross.entries()) {
  if (!await placeRule(cell) || !await placeRule([0, i * 2])) fail("could not build the cross");
}
const center = await rules.evaluate(() => window.__gomoku.screenPos(7, 7));
await rules.touchscreen.tap(center.x, center.y);
await rules.getByRole("status").filter({ hasText: "黑棋双三" }).waitFor();
const rejected = await rules.evaluate(() => window.__gomoku.snap());
if (rejected.turn !== 1 || rejected.moveCount !== 8) fail("forbidden tap consumed the move");
await rules.reload();
await rules.getByRole("button", { name: "黑棋禁双三", exact: true, pressed: true }).waitFor();
await rules.getByRole("button", { name: "继续上次对局", exact: true }).tap();
if (await placeRule([7, 7])) fail("resumed game lost its rule");
if (!await placeRule([11, 11])) fail("legal alternative was rejected");

await rules.getByRole("button", { name: "暂停", exact: true }).tap();
await rules.getByRole("button", { name: "返回标题", exact: true }).tap();
await rules.getByRole("button", { name: "大师", exact: true }).tap();
await rules.getByRole("button", { name: "训练", exact: true }).tap();
await rules.getByRole("button", { name: "开始摆棋", exact: true }).tap();
for (const cell of cross) await placeRule(cell);
await rules.getByRole("button", { name: "从这里开局", exact: true }).tap();
await rules.waitForFunction(() => {
  const s = window.__gomoku.snap();
  return s.turn === 2 && s.moveCount === 1 && s.aiEngine === "local";
}, null, { timeout: 15000 });
const aiMove = await rules.evaluate(() => window.__gomoku.snap().lastMove);
const startingBoard = new Uint8Array(225);
for (const [r, c] of cross) startingBoard[r * 15 + c] = 1;
if (aiMove.player !== 1 || isBlackDoubleThree(startingBoard, aiMove.r, aiMove.c)) fail("AI chose a forbidden move");

await rules.getByRole("button", { name: "暂停", exact: true }).tap();
await rules.getByRole("button", { name: "返回标题", exact: true }).tap();
await rules.getByRole("button", { name: "开始摆棋", exact: true }).tap();
await rules.getByRole("button", { name: "放白棋", exact: true }).tap();
for (const cell of cross) await placeRule(cell);
await rules.getByRole("button", { name: "白先走", exact: true }).tap();
await rules.getByRole("button", { name: "从这里开局", exact: true }).tap();
if (!await placeRule([7, 7])) fail("White should be allowed to play double-three");
await rules.close();

// 14) The speculative reply must only be used for the position that was predicted.
for (const matchPrediction of [true, false]) {
  const ponder = await browser.newPage();
  await ponder.bringToFront();
  await ponder.route("**/rapfi/worker.js", (route) => route.fulfill({
    contentType: "text/javascript",
    body: `self.postMessage({type:"ready"});
      self.onmessage = ({ data: { token, player } }) => self.postMessage({
        type: "move", token, move: { r: 0, c: token < 0 ? 0 : 1, player }
      });`,
  }));
  await ponder.addInitScript(() => {
    const moves = [112, 30, 194, 211, 5, 219].map((square, ply) => ({
      r: Math.floor(square / 15), c: square % 15, player: ply % 2 + 1,
    }));
    localStorage.setItem("game.gomoku.active", JSON.stringify({
      setup: { playerColor: 1, difficulty: "hard", mode: "solo", style: "balanced", rule: "freestyle" },
      moves, lockedPly: 0,
    }));
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...rest) {
      if (message.history?.length === 7 && message.token < 0) {
        this.addEventListener("message", ({ data }) => {
          if (data.token === message.token && data.type === "move") window.__pondered = message.history.at(-1);
        }, { once: true });
      }
      if (message.history?.length === 7 && message.token > 0) window.__actualSearchMs = message.timeMs;
      return post.call(this, message, ...rest);
    };
  });
  await ponder.goto(`http://127.0.0.1:${port}/`);
  await ponder.getByRole("button", { name: "继续上次对局", exact: true }).click();
  await ponder.waitForFunction(() => window.__pondered);
  const played = await ponder.evaluate((match) => {
    const { r, c } = window.__pondered;
    if (match) return window.__gomoku.place(r, c);
    return window.__gomoku.place(0, c === 13 && r === 0 ? 12 : 13);
  }, matchPrediction);
  if (!played) fail("could not play in the prediction test");
  await ponder.waitForFunction(() => window.__gomoku.snap().moveCount === 8);
  const result = await ponder.evaluate(() => ({
    move: window.__gomoku.snap().lastMove, searchMs: window.__actualSearchMs ?? 0,
  }));
  if (result.move.c !== (matchPrediction ? 0 : 1) || result.searchMs !== (matchPrediction ? 0 : 840)) {
    fail(`unexpected ponder hit or miss behavior ${JSON.stringify(result)}`);
  }
  await ponder.close();
}

// 15) A matching local prediction keeps the same worker and supplies its preferred move.
const localPonder = await browser.newPage();
await localPonder.bringToFront();
await localPonder.addInitScript(() => {
  const moves = [112, 30, 194, 211, 5, 219].map((square, ply) => ({
    r: Math.floor(square / 15), c: square % 15, player: ply % 2 + 1,
  }));
  localStorage.setItem("game.gomoku.active", JSON.stringify({
    setup: { playerColor: 1, difficulty: "hard", mode: "solo", style: "balanced", rule: "double-three" },
    moves, lockedPly: 0,
  }));
  const post = Worker.prototype.postMessage;
  let warmedWorker;
  Worker.prototype.postMessage = function (message, ...rest) {
    const stones = message.board?.filter(Boolean).length;
    if (message.kind === "ponder" && stones === 6) {
      this.addEventListener("message", ({ data }) => {
        if (data.kind === "ponder" && data.reply) {
          warmedWorker = this;
          window.__localPrediction = data.prediction;
          window.__localPreferred = data.reply.r * 15 + data.reply.c;
        }
      }, { once: true });
    }
    if (message.kind !== "ponder" && stones === 7) {
      window.__localReused = this === warmedWorker && message.preferred === window.__localPreferred;
    }
    return post.call(this, message, ...rest);
  };
});
await localPonder.goto(`http://127.0.0.1:${port}/`);
await localPonder.getByRole("button", { name: "继续上次对局", exact: true }).click();
await localPonder.waitForFunction(() => window.__localPrediction);
if (!await localPonder.evaluate(() => window.__gomoku.place(window.__localPrediction.r, window.__localPrediction.c))) {
  fail("could not play the local prediction");
}
await localPonder.waitForFunction(() => window.__gomoku.snap().moveCount === 8);
if (!await localPonder.evaluate(() => window.__localReused)) fail("search discarded the matching local worker");
await localPonder.close();

// 16) Zero errors in the real game.
if (consoleErrors.length) fail(`${consoleErrors.length} console error(s): ${consoleErrors[0]}`);

await browser.close();
server.close();
console.log("VERIFY OK: modes, touch, custom editor and AI, optional Black double-three, adaptive search and ponder reuse.");
