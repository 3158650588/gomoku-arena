#!/usr/bin/env node
/**
 * 下载 Rapfi WASM 引擎资源（不进 Git 的大文件）。
 *
 * 按 third-party/rapfi/README.md 的固定版本与 SHA-256 校验值下载，
 * 覆盖 public/rapfi/ 下的运行所需文件。若已存在且校验通过则跳过。
 *
 * 用法：
 *   node scripts/download-rapfi.mjs           # 下载 WASM 引擎（js/wasm/data）
 *   node scripts/download-rapfi.mjs --native  # 另外下载原生引擎 Rapfi-engine.7z 到 third-party/rapfi/native/
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 固定版本：brianhliou/rapfi-wasm v0.1.0（以源文件 1387d113 构建，含当前网络）
const WASM_RELEASE =
  'https://github.com/brianhliou/rapfi-wasm/releases/download/v0.1.0';
const TARGETS = [
  {
    url: `${WASM_RELEASE}/rapfi-single-simd128.js`,
    dest: 'public/rapfi/rapfi-single-simd128.js',
    sha256:
      'd0987108ee8cb1133b9624a789130fddb5f9ff0747dca9ee8a2b027985986592',
  },
  {
    url: `${WASM_RELEASE}/rapfi-single-simd128.wasm`,
    dest: 'public/rapfi/rapfi-single-simd128.wasm',
    sha256:
      '6d07362503d344c01734c98640f66a2d599dfe6cb6f7df76b70f1426d9cb3bcf',
  },
  {
    url: `${WASM_RELEASE}/rapfi-single-simd128.data`,
    dest: 'public/rapfi/rapfi-single-simd128.data',
    sha256:
      'f61d31b4d98fc53fb43a31a4f0b4357a8b64053bb5762a0967250b873cc9a57e',
  },
];

// 原生引擎（Windows/Linux）：dotb1ue/rapfi release 250615
const NATIVE = {
  url: 'https://github.com/dotb1ue/rapfi/releases/download/250615/Rapfi-engine.7z',
  dest: 'third-party/rapfi/native/Rapfi-engine.7z',
};

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`下载失败 ${res.status}: ${url}`);
  }
  await mkdir(dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function ensure({ url, dest, sha256: expected }, { verify = true } = {}) {
  const abs = join(root, dest);
  if (existsSync(abs) && (!verify || (await sha256(abs)) === expected)) {
    console.log(`✓ 已存在，跳过: ${dest}`);
    return;
  }
  if (existsSync(abs)) {
    console.log(`  已存在但校验不符，重新下载: ${dest}`);
  }
  console.log(`  下载: ${url}`);
  console.log(`    → ${dest}`);
  await download(url, abs);
  if (verify && (await sha256(abs)) !== expected) {
    throw new Error(`SHA-256 校验失败: ${dest}（下载内容被篡改或版本不符）`);
  }
  console.log('  ✓ 校验通过');
}

const wantNative = process.argv.includes('--native');
for (const t of TARGETS) {
  await ensure(t);
}
if (wantNative) {
  const abs = join(root, NATIVE.dest);
  const existed = existsSync(abs);
  if (!existed) {
    console.log(`  下载: ${NATIVE.url}`);
    console.log(`    → ${NATIVE.dest}（约 80 MB）`);
    await download(NATIVE.url, abs);
  }
  console.log(`✓ 原生引擎${existed ? '已存在，跳过' : '已下载'}: ${NATIVE.dest}`);
  console.log('  完整性校验值见 third-party/rapfi/README.md「原生引擎」一节。');
}
console.log('完成。');
