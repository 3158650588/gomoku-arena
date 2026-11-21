# 五子棋对决 · v6.0 擂台版

基于 Three.js 渲染 + Rapfi 引擎（WASM）的五子棋对战游戏，支持人机对弈、训练、棋谱、战绩与擂台模式。

## 功能概览

- **人机对弈**：6 个 AI 档位（新手 ~ 大师 · Rapfi），可选执黑 / 执白
- **擂台模式**：大师档深算与擂台重新搜索，复杂局面按规则分配搜索预算（自由规则上限约 12 秒，禁双三 / 摆棋约 9 秒）
- **规则**：自由规则、黑棋禁双三；支持标准 / 深算两种大师复核强度
- **训练**：每日一题（6 个基本局面 × 48 个旋转镜像布局）、三档让子挑战、最近败局练习
- **残局精算**：剩 10 空位以内可跑全分支搜索，给出胜负、手数与可用落点
- **快棋**：按棋钟剩余时间调度搜索预算
- **皮肤**：原木 / 青瓷 / 星夜三套棋盘皮肤
- **移动端**：手机轻点直接下或先预览再确认，可在设置中切换
- **Windows 原生引擎**：本机启动 `start-game.cmd` 后，大师档可调用原生 Rapfi（上限 8 线程）；手机或原生不可用时自动回退浏览器 Rapfi

## 快速开始

大文件（Rapfi WASM 引擎与网络权重，合计约 41 MB）不随仓库分发，克隆后先下载：

```bash
node scripts/download-rapfi.mjs           # 浏览器版引擎（js/wasm/data，含 SHA-256 校验）
node scripts/download-rapfi.mjs --native  # 可选：Windows/Linux 原生引擎（约 80 MB）
```

然后常规安装运行：

```bash
npm install
npm run dev        # 开发服务器 http://localhost:3000
npm run build      # 生产构建，输出到 dist/
npm run preview    # 预览构建产物
```

Windows 用户也可以直接双击 `start-game.cmd` 启动（含原生 Rapfi 引擎）。

## 验证与基准

```bash
npm run verify          # 构建产物自检（Playwright 冒烟）
npm run verify:arena    # 擂台模式回归：原生落子、浏览器回退、手机入口、规则分支、败局复测
npm run verify:master   # 大师复核：双活三 220 种回法、反冲四、合法性、漏防替换、深算预算
npm run benchmark:arena # 原生 vs 浏览器 Rapfi 对拍基准
```

完整版本演进与测试记录见 [HANDOVER.md](./HANDOVER.md)。

## 技术栈

- **渲染**：Three.js（WebGL），React 仅作 DOM 外壳，渲染循环在 `src/game/`
- **引擎**：Rapfi（五子棋引擎）编译为 WASM，`public/rapfi/` 内为浏览器版单线程 SIMD 构建
- **本地搜索**：禁双三合法性、开局库、战术复核由本地 Worker 完成（`src/game/gomoku/`）
- **构建**：Vite + TypeScript

## 目录结构

```
index.html / src/main.tsx / src/App.tsx   React 入口外壳
src/pages/                                大厅、设置等页面
src/game/                                 游戏逻辑（引擎循环、状态机、输入、音效、存档）
src/game/gomoku/                          五子棋规则、AI 调度、开局库、战术、擂台、训练
public/rapfi/                             浏览器版 Rapfi WASM + 网络权重（大文件由脚本下载）
third-party/rapfi/                        Rapfi 源码、构建脚本与 Windows 原生引擎
tests/                                    单元与战术测试
scripts/                                  验证、基准与资源下载脚本
```

## 许可与合规

- 本仓库游戏代码以 **GPL-3.0** 发布（因链接并分发 GPL-3.0 的 Rapfi 引擎，整体需采用兼容许可）。
- `public/rapfi/` 与 `third-party/rapfi/` 下的 Rapfi 引擎及源码 © Rapfi 作者，许可见各目录内的 `LICENSE.txt` / `Copying.txt`（GPL-3.0）。
- Rapfi 网络权重（`*.data`、`*.bin`、`*.lz4`）以 CC0 1.0 发布，见 `NETWORKS-LICENSE.txt`。
- 上述大文件不进 Git：由 `scripts/download-rapfi.mjs` 从固定版本（rapfi-wasm v0.1.0 / Rapfi 250615）拉取并校验 SHA-256，版本与校验值见 `third-party/rapfi/README.md`。

## 致谢

- [Rapfi](https://github.com/dhbloo/rapfi) — 强大的开源五子棋引擎
