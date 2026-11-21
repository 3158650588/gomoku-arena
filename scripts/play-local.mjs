import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { createNativeEngine, readEnginePosition } from "./rapfi-native.mjs";

const build = new URL("../dist/", import.meta.url);
const root = await realpath(fileURLToPath(build)).catch(() => null);
if (!root) {
  console.error("Game files are missing. Extract the whole ZIP, or run npm run build in the source folder.");
  process.exit(1);
}
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
};
const mobile = process.argv.includes("--mobile");
const host = mobile ? "0.0.0.0" : "127.0.0.1";
const specifiedPort = process.argv.find((arg) => arg.startsWith("--port="));
const availablePorts = specifiedPort ? [Number(specifiedPort.slice(7))] : mobile ? [5179, 5181] : [5175, 5177, 5178];
let port = availablePorts.shift();
const localUrl = () => `http://127.0.0.1:${port}/`;
const native = mobile ? null : createNativeEngine();

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function nativeRequest(req, res, path) {
  const url = new URL(localUrl());
  if (!native || req.socket.localAddress !== "127.0.0.1" || req.headers.host !== url.host) {
    json(res, 404, { available: false });
    return;
  }
  if (path === "/api/arena/status" && req.method === "GET") {
    json(res, 200, { available: true, threads: native.threads });
    return;
  }
  if (path !== "/api/arena/move" || req.method !== "POST" || req.headers.origin !== url.origin ||
      req.headers["content-type"] !== "application/json") {
    json(res, 403, { error: "Invalid local engine request" });
    return;
  }
  const length = Number(req.headers["content-length"]);
  if (!Number.isInteger(length) || length < 1 || length > 9000) {
    json(res, 413, { error: "Invalid board size" });
    return;
  }
  let position;
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    position = readEnginePosition(JSON.parse(body));
  } catch {
    position = null;
  }
  if (!position) {
    json(res, 400, { error: "Invalid game position" });
    return;
  }
  const controller = new AbortController();
  res.once("close", () => controller.abort());
  if (res.destroyed) return;
  try {
    const move = await native.move(position, controller.signal);
    if (!res.destroyed) json(res, 200, { move });
  } catch {
    if (!res.destroyed) json(res, 503, { error: "Local Rapfi is unavailable" });
  }
}

const server = createServer(async (req, res) => {
  const path = req.url?.split("?")[0];
  if (path === "/api/arena/status" || path === "/api/arena/move") {
    await nativeRequest(req, res, path);
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  let file;
  let info;
  try {
    const pathname = decodeURIComponent(new URL(req.url, localUrl()).pathname);
    file = await realpath(resolve(root, "." + (pathname === "/" ? "/index.html" : pathname)));
    if (file.startsWith(root + sep)) info = await stat(file);
  } catch {
    // Missing, malformed or outside the build.
  }
  if (!info?.isFile()) {
    res.writeHead(404).end();
    return;
  }
  const etag = `"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag }).end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": mime[extname(file)] ?? "application/octet-stream",
    "Content-Length": info.size,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    ETag: etag,
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).on("error", () => res.destroy()).pipe(res);
});

function showAddress() {
  const url = localUrl();
  console.log(`Five in a Row is ready at ${url}`);
  console.log("Keep this window open while playing. Close it to stop the game.");
  if (mobile) {
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.family === "IPv4" && !address.internal) {
          console.log(`Phone browser address: http://${address.address}:${port}/`);
        }
      }
    }
  }
  if (process.platform === "win32" && !process.argv.includes("--no-open")) {
    const browser = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    browser.on("error", () => console.log(`Open ${url} in your browser.`));
    browser.unref();
  }
}

async function servesThisBuild() {
  try {
    const response = await fetch(localUrl(), { signal: AbortSignal.timeout(650) });
    if (!response.ok) return false;
    const expected = await readFile(resolve(root, "index.html"));
    return Buffer.from(await response.arrayBuffer()).equals(expected);
  } catch {
    return false;
  }
}

server.on("error", async (error) => {
  if (error.code === "EADDRINUSE") {
    if (!mobile && await servesThisBuild()) {
      showAddress();
      return;
    }
    if (availablePorts.length) {
      port = availablePorts.shift();
      server.listen(port, host);
      return;
    }
  }
  console.error(error.code === "EADDRINUSE"
    ? `Port ${port} is already in use. Please close the previous server or specify a free port.`
    : error.message);
  process.exitCode = 1;
});
server.on("listening", () => {
  if (port === 0) port = server.address().port;
  showAddress();
});
server.listen(port, host);
