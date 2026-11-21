/**
 * boot.ts — 五子棋对决：Three.js 3D 棋盘 + 人机对弈。
 * 状态机：title → playing ⇄ paused → over ⇄ replay
 * 合约：startGame(canvas) 挂载，stopGame() 卸载；Space 从标题/终局进入对局；
 * __gameProbe() 暴露棋盘光标坐标（自检脚本用 W/S/A/D 做方向断言）。
 */

import * as THREE from "three";
import { GameLoop } from "./engine";
import { AudioSystem, SfxId } from "./audio";
import { storage } from "./storage";
import { BOARD, BLACK, WHITE, EMPTY, Cell, Stone, Board, Move, type Rule, createBoard, idx, checkWin, isFull, inBounds, opposite, forbiddenMove, hasLegalMove } from "./gomoku/logic";
import { bestMove, DIFFICULTIES, Difficulty, moveHints, RAPFI_LEVELS, stylePreferences, usesRapfi } from "./gomoku/ai";
import type { AiWorkerReply, AiWorkerRequest } from "./gomoku/ai-worker";
import { openingMove } from "./gomoku/opening-book";
import { hasPressure, searchTime } from "./gomoku/tactics";
import { MASTER_MODES, MASTER_PROFILES, masterBudget, type MasterMode } from "./gomoku/master-profile";
import { ENDGAME_LIMIT, type EndgameResult } from "./gomoku/endgame";
import { defeatLesson, firstReplayBan } from "./gomoku/training";
import { SKINS, SKIN_IDS, Skin } from "./gomoku/skins";
import { HANDICAPS, OPENINGS, PUZZLES, STYLES, dailyKey, dailyPuzzle, handicapPosition, puzzleFor, readInitial, readPosition, readSavedMatch } from "./gomoku/match";
import type { Mode, Position, RecordEntry, SavedMatch, Score, Setup, Style } from "./gomoku/match";
import { freezeClock, moveClock, newClock, timeLeft, type Clock } from "../../scripts/chess-clock.mjs";

declare global {
  interface Window {
    __gameProbe?: () => { x: number; y: number; z: number };
    __GAME_READY__?: boolean;
    /** 自动化测试钩子：读取快照、格子屏幕坐标、直接落子。 */
    __gomoku?: {
      snap: () => Snapshot;
      screenPos: (r: number, c: number) => { x: number; y: number };
      place: (r: number, c: number) => boolean;
      visibleStones: () => number;
      markedMove: () => Move | null;
    };
  }
}

/* ---------- 与 HUD 通信 ---------- */

interface Preferences {
  touchConfirm: boolean;
  tacticalReview: boolean;
  exactEndgame: boolean;
  masterMode: MasterMode;
}

export interface Snapshot {
  phase: "title" | "playing" | "paused" | "over" | "replay" | "editor";
  turn: Stone;
  playerColor: Stone;
  winner: Cell;                  // EMPTY 表示未分出胜负
  draw: boolean;
  moveCount: number;
  difficulty: Difficulty;
  skin: Skin;
  muted: boolean;
  scores: { player: number; ai: number; draw: number };
  lastMove: Move | null;
  replayPly: number | null;
  undoable: boolean;
  aiThinking: boolean;
  aiEngine: "loading" | "rapfi" | "native" | "local" | "fallback" | null;
  mode: Mode;
  style: Style;
  overhead: boolean;
  canBranch: boolean;
  replayFromLibrary: boolean;
  canResume: boolean;
  hintText: string | null;
  hintLevel: number;
  puzzle: { title: string; prompt: string; result: "solved" | "missed" | null } | null;
  solvedPuzzles: readonly string[];
  challenge: { title: string; round: number; result: number | null; total: number | null } | null;
  pendingChallenge: string | null;
  records: readonly RecordEntry[];
  breakdown: Readonly<Record<string, Score>>;
  quick: boolean;
  clock: { seconds: [number, number]; active: Stone | null } | null;
  timeout: boolean;
  custom: boolean;
  editor: { tool: Cell; turn: Stone; error: string | null };
  rule: Rule;
  forbiddenNote: string | null;
  noLegalMove: boolean;
  preferences: Preferences;
  touchPreview: { r: number; c: number } | null;
  daily: { day: string; best: number | null; played: number | null; target: number; player: Stone } | null;
  handicap: { index: number; title: string } | null;
  handicapUnlocked: number;
  canTrainLoss: boolean;
  lesson: ReturnType<typeof defeatLesson>;
  comparison: { rule: Rule; forbiddenPly: number | null; move: Move | null } | null;
  analysis: EndgameResult | "working" | "finished" | null;
}

type RapfiReply =
  | { type: "ready" }
  | { type: "move"; token: number; move: Move; alternatives?: Move[] }
  | { type: "error"; token?: number; message: string };

interface PonderedTurn {
  historyLength: number;
  token: number;
  worker: Worker | null;
  prediction: Move | null;
  reply: Move | null;
  nativeTime: number;
}

type Listener = (s: Snapshot) => void;
const listeners = new Set<Listener>();

function emit(s: Snapshot) {
  for (const l of listeners) l(s);
}

/** HUD 订阅状态变化。返回取消订阅函数。 */
export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** HUD 请求悔棋/重开（由场景内的状态机执行）。 */
export const ui = {
  undo: () => session?.undo(),
  restart: () => session?.restart(),
  togglePause: () => session?.togglePause(),
  backToTitle: () => session?.backToTitle(),
  openReplay: () => session?.openReplay(),
  seekReplay: (ply: number) => session?.seekReplay(ply),
  closeReplay: () => session?.closeReplay(),
  branchReplay: () => session?.branchReplay(),
  compareReplay: () => session?.compareReplay(),
  analyzeReplay: () => session?.analyzeReplay(),
  trainLoss: (match?: SavedMatch) => session?.trainLoss(match),
  playLesson: (attack: boolean) => session?.playLesson(attack),
  loadReplay: (match: SavedMatch) => session?.loadReplay(match),
  replayData: () => session?.replayData() ?? null,
  resume: () => session?.resume(),
  startLocal: () => session?.startLocal(),
  setQuick: (quick: boolean) => session?.setQuick(quick),
  setRule: (rule: Rule) => session?.setRule(rule),
  openEditor: () => session?.openEditor(),
  setEditorTool: (tool: Cell) => session?.setEditorTool(tool),
  setEditorTurn: (turn: Stone) => session?.setEditorTurn(turn),
  clearEditor: () => session?.clearEditor(),
  playEditor: () => session?.playEditor(),
  startPuzzle: (id: string) => session?.startPuzzle(id),
  startDaily: () => session?.startDaily(),
  startHandicap: (index: number) => session?.startHandicap(index),
  startChallenge: (id: string) => session?.startChallenge(id),
  nextChallenge: () => session?.nextChallenge(),
  hint: () => session?.showHint(),
  toggleOverhead: () => session?.toggleOverhead(),
  setStyle: (style: Style) => session?.setStyle(style),
  setPlayerColor: (color: Stone) => session?.setPlayerColor(color),
  setDifficulty: (d: Difficulty) => session?.setDifficulty(d),
  setSkin: (skin: Skin) => session?.setSkin(skin),
  setPreference: (key: Exclude<keyof Preferences, "masterMode">, value: boolean) => session?.setPreference(key, value),
  setMasterMode: (mode: MasterMode) => session?.setMasterMode(mode),
  confirmTouch: () => session?.confirmTouch(),
  clearTouch: () => session?.clearTouch(),
  resetView: () => session?.resetView(),
  toggleMute: () => session?.toggleMute(),
  start: () => session?.startFromUI(),
  snapshot: (): Snapshot | null => session?.snapshot() ?? null,
};

/* ---------- 常量 ---------- */

const SP = 1;                       // 棋子间距（世界单位）
const HALF = ((BOARD - 1) / 2) * SP; // 棋盘半径
const CELL_WORLD = (r: number, c: number) => new THREE.Vector3((c - 7) * SP, 0, (r - 7) * SP);
const STONE_R = 0.44;
const STONE_Y = 0.36;               // 棋子落在盘面上时的中心高度（略扁球）
const DEFAULT_PITCH = 0.92;
const DEFAULT_DISTANCE = 21;

interface ScreenPoint {
  x: number;
  y: number;
}

const SCORES_KEY = "gomoku.scores";
const PLAYER_COLOR_KEY = "gomoku.playerColor";
const DIFF_KEY = "gomoku.difficulty";
const SKIN_KEY = "gomoku.skin";
const STYLE_KEY = "gomoku.style";
const MATCH_KEY = "gomoku.active";
const LIBRARY_KEY = "gomoku.replays";
const BREAKDOWN_KEY = "gomoku.scoreBreakdown";
const PUZZLES_KEY = "gomoku.solvedPuzzles";
const CHALLENGE_KEY = "gomoku.nextChallenge";
const QUICK_KEY = "gomoku.quick";
const RULE_KEY = "gomoku.rule";
const PREFERENCES_KEY = "gomoku.preferences";
const DAILY_KEY = "gomoku.daily";
const HANDICAP_KEY = "gomoku.handicap";
const RAPFI_LOAD_TIMEOUT_MS = 20000;
const RAPFI_SEARCH_TIMEOUT_MS = 16000;

function loadScores() {
  return storage.get(SCORES_KEY, { player: 0, ai: 0, draw: 0 });
}
function loadPlayerColor(): Stone {
  return storage.get<unknown>(PLAYER_COLOR_KEY, WHITE) === BLACK ? BLACK : WHITE;
}
function loadDifficulty(): Difficulty {
  const stored = storage.get<unknown>(DIFF_KEY, null);
  return DIFFICULTIES.find((difficulty) => difficulty === stored) ?? "beginner";
}

function loadStyle(): Style {
  const stored = storage.get<unknown>(STYLE_KEY, null);
  return STYLES.find((style) => style === stored) ?? "balanced";
}

function loadPreferences(): Preferences {
  const saved = storage.get<(Partial<Preferences> & { deepSearch?: boolean }) | null>(PREFERENCES_KEY, null);
  return {
    touchConfirm: saved?.touchConfirm === true,
    tacticalReview: saved?.tacticalReview !== false,
    exactEndgame: saved?.exactEndgame !== false,
    masterMode: saved?.masterMode && MASTER_MODES.includes(saved.masterMode) ? saved.masterMode :
      saved?.deepSearch === true ? "deep" : "standard",
  };
}

function loadRecords(): RecordEntry[] {
  const records = storage.get<unknown>(LIBRARY_KEY, []);
  if (!Array.isArray(records)) return [];
  return records.filter((entry) => typeof entry?.id === "string" &&
    Number.isFinite(entry.timestamp) && readSavedMatch(entry.match)).slice(0, 24);
}

function loadSkin(): Skin {
  const stored = storage.get<unknown>(SKIN_KEY, null);
  return SKIN_IDS.find((skin) => skin === stored) ?? "wood";
}

/* ---------- 木纹纹理（程序化生成，无外部资源） ---------- */

function makeWoodTexture(): THREE.CanvasTexture {
  const size = 512;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const g = cv.getContext("2d")!;
  // 底色：暖黄木色
  const grad = g.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, "#e0a95f");
  grad.addColorStop(0.5, "#d99f52");
  grad.addColorStop(1, "#ce9347");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  // 木纹丝缕
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 90; i++) {
    const y = rnd() * size;
    const wobble = 4 + rnd() * 10;
    const alpha = 0.03 + rnd() * 0.08;
    g.strokeStyle = `rgba(120, 66, 18, ${alpha})`;
    g.lineWidth = 0.6 + rnd() * 1.8;
    g.beginPath();
    g.moveTo(-10, y);
    for (let x = 0; x <= size + 10; x += 32) {
      g.lineTo(x, y + Math.sin(x * 0.02 + i) * wobble);
    }
    g.stroke();
  }
  // 柔和暗角
  const vg = g.createRadialGradient(size / 2, size / 2, size * 0.35, size / 2, size / 2, size * 0.75);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(70,35,8,0.28)");
  g.fillStyle = vg;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ---------- 会话 ---------- */

interface Falling {
  mesh: THREE.Mesh;
  targetY: number;
  t: number; // 0→1
}
interface Particle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
}

let session: GomokuSession | null = null;

class GomokuSession {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private loop: GameLoop;
  private audio = new AudioSystem();
  private raycaster = new THREE.Raycaster();
  private boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private pointerNDC = new THREE.Vector2();

  // 资源
  private stoneGeo = new THREE.SphereGeometry(STONE_R, 28, 20);
  private blackMat = new THREE.MeshStandardMaterial({ color: 0x14151a, roughness: 0.28, metalness: 0.12 });
  private whiteMat = new THREE.MeshStandardMaterial({ color: 0xf4f0e4, roughness: 0.4, metalness: 0.02 });
  private hoverMat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, roughness: 0.5 });
  private tableMat = new THREE.MeshStandardMaterial({ roughness: 0.85 });
  private tableWood = makeWoodTexture();
  private boardTopMat = new THREE.MeshStandardMaterial({ roughness: 0.55 });
  private boardWood = makeWoodTexture();
  private boardEdgeMat = new THREE.MeshStandardMaterial({ roughness: 0.6 });
  private gridMat = new THREE.LineBasicMaterial();
  private starMat = new THREE.MeshBasicMaterial();
  private skinPreview = new THREE.Group();
  private disposables: Array<{ dispose: () => void }> = [];

  // 棋局状态
  private phase: Snapshot["phase"] = "title";
  private board: Board = createBoard();
  private turn: Stone = BLACK;
  private playerColor = loadPlayerColor();
  private winner: Cell = EMPTY;
  private draw = false;
  private moveHistory: Move[] = [];
  private replayPly: number | null = null;
  private replayFromLibrary = false;
  private comparison: Snapshot["comparison"] = null;
  private lesson: Snapshot["lesson"] = null;
  private analysis: Snapshot["analysis"] = null;
  private analysisWorker: Worker | null = null;
  private branchable = false;
  private lockedPly = 0;
  private stoneMeshes: (THREE.Mesh | null)[] = new Array(BOARD * BOARD).fill(null);
  private winLineMeshes: THREE.Mesh[] = [];
  private winLineMats: THREE.MeshStandardMaterial[] = [];
  private scores = loadScores();
  private difficulty: Difficulty = loadDifficulty();
  private style = loadStyle();
  private quick = storage.get<unknown>(QUICK_KEY, false) === true;
  private rule: Rule = storage.get<unknown>(RULE_KEY, "freestyle") === "double-three" ? "double-three" : "freestyle";
  private setup: Setup = { mode: "solo", playerColor: this.playerColor, difficulty: this.difficulty, style: this.style };
  private savedMatch = readSavedMatch(storage.get<unknown>(MATCH_KEY, null));
  private records = loadRecords();
  private breakdown = storage.get<Record<string, Score>>(BREAKDOWN_KEY, {}) ?? {};
  private solvedPuzzles = storage.get<string[]>(PUZZLES_KEY, []);
  private dailyResults = storage.get<Record<string, number>>(DAILY_KEY, {}) ?? {};
  private handicapUnlocked = Math.min(HANDICAPS.length - 1, Math.max(0, Math.trunc(storage.get(HANDICAP_KEY, 0)) || 0));
  private preferences = loadPreferences();
  private puzzleResult: "solved" | "missed" | null = null;
  private nextLeg = readSavedMatch(storage.get<unknown>(CHALLENGE_KEY, null));
  private hintLevel = 0;
  private hint: ReturnType<typeof moveHints> = null;
  private hintRings: THREE.Mesh[] = [];
  private lastMarker = new THREE.Mesh(new THREE.CircleGeometry(0.105, 20), new THREE.MeshBasicMaterial());
  private clock: Clock | null = null;
  private clockSeconds = "";
  private timeout = false;
  private editorTool: Cell = BLACK;
  private editorTurn: Stone = BLACK;
  private editorError: string | null = null;
  private forbiddenNote: string | null = null;
  private noLegalMove = false;
  private skin: Skin = loadSkin();
  private aiThinking = false;
  private aiTimer = 0; // 延迟起手（秒）
  private aiWorker: Worker | null = null;
  private positionWorker: Worker | null = null;
  private aiEngine: Snapshot["aiEngine"] = null;
  private aiToken = 0;
  private ponderToken = 0;
  private ponderedTurn: PonderedTurn | null = null;
  private aiRequestPending = false;
  private nativeReviewLimit = 0;
  private nativeRequest: AbortController | null = null;
  private nativeUnavailable = false;
  private aiWatchdog: ReturnType<typeof setTimeout> | null = null;
  private pendingAiMove: Move | null = null; // 暂停期间到达的 AI 应手
  private undoAnims: { mesh: THREE.Mesh; t: number }[] = [];

  private get aiColor(): Stone {
    return this.playerColor === BLACK ? WHITE : BLACK;
  }

  // 光标（键盘操作 & 探针）
  private cursor = { r: 7, c: 7 };
  private cursorMesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;

  // 悬停
  private hover: { r: number; c: number } | null = null;
  private hoverMesh: THREE.Mesh;

  // 动画
  private falling: Falling[] = [];
  private particles: Particle[] = [];
  private particleGeo = new THREE.TetrahedronGeometry(0.09);
  private particleMats: THREE.MeshBasicMaterial[] = [];

  // 镜头
  private camYaw = 0;
  private camPitch = DEFAULT_PITCH;
  private camDist = DEFAULT_DISTANCE;
  private overhead = false;
  private pointers = new Map<number, ScreenPoint>();
  private gestureTravel = 0;
  private gestureMoved = false;
  private idleT = 0;
  private touchPrimary = window.matchMedia("(pointer: coarse)").matches;
  private touchPreview: Snapshot["touchPreview"] = null;
  private adjustingTouch = false;
  private reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  private frameBoard(width = this.canvas.clientWidth, height = this.canvas.clientHeight) {
    if (width < 1 || height < 1) return;
    this.camera.aspect = width / height;
    const shortLandscape = width >= 600 && width > height && height < 560;
    this.camera.zoom = Math.min(shortLandscape ? 0.84 : 1, this.camera.aspect / 1.08);
    if (this.overhead && width > height) this.camera.zoom *= 0.84;
    if (this.phase === "replay" || this.phase === "editor") {
      this.camera.zoom *= shortLandscape ? 0.76 : width > height ? 0.86 : 0.95;
      this.camera.setViewOffset(width, height, 0, height * 0.045, width, height);
    } else if (this.phase === "title" && (shortLandscape || (width >= 900 && height >= 560))) {
      this.camera.zoom = shortLandscape ? 0.76 : 0.89;
      this.camera.setViewOffset(width, height, -width * 0.18, 0, width, height);
    } else if (this.phase === "title" && width < 900 && height >= 650) {
      this.camera.setViewOffset(width, height, 0, height * 0.25, width, height);
    } else if (shortLandscape && this.phase !== "title") {
      this.camera.setViewOffset(width, height, 0, height * 0.035, width, height);
    } else {
      this.camera.clearViewOffset();
    }
    this.camera.updateProjectionMatrix();
  }

  private onResize = () => {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width < 1 || height < 1) return;
    this.frameBoard(width, height);
    this.renderer.setSize(width, height, false);
  };
  private resizeObserver = new ResizeObserver(this.onResize);

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.touchPrimary ? 1.5 : 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x101418);
    this.scene.fog = new THREE.Fog(0x101418, 34, 70);

    this.camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.1, 120);
    this.onResize();

    this.buildEnvironment();
    this.buildBoard();
    this.buildSkinPreview();

    // 悬停指示 & 光标
    this.hoverMesh = new THREE.Mesh(this.stoneGeo, this.hoverMat);
    this.hoverMesh.scale.y = 0.82;
    this.hoverMesh.visible = false;
    this.scene.add(this.hoverMesh);

    this.cursorMesh = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.62, 32),
      new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
    );
    this.cursorMesh.rotation.x = -Math.PI / 2;
    this.cursorMesh.visible = false;
    this.scene.add(this.cursorMesh);
    this.disposables.push(this.cursorMesh.geometry, this.cursorMesh.material as THREE.Material);
    this.lastMarker.rotation.x = -Math.PI / 2;
    this.lastMarker.visible = false;
    this.scene.add(this.lastMarker);
    this.disposables.push(this.lastMarker.geometry, this.lastMarker.material);
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(this.cursorMesh.geometry, this.cursorMesh.material);
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      this.scene.add(ring);
      this.hintRings.push(ring);
    }

    // 粒子材质（双色）
    for (const color of [0xffd166, 0x8df0c1, 0xffffff]) {
      this.particleMats.push(new THREE.MeshBasicMaterial({ color, transparent: true }));
    }
    this.applySkin();

    this.resizeObserver.observe(canvas);
    window.addEventListener("blur", this.cancelGesture);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
    canvas.addEventListener("lostpointercapture", this.onPointerCancel);
    canvas.addEventListener("pointerleave", this.clearHover);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKeyUp);

    this.loop = new GameLoop({ update: this.update, render: this.render });
    this.loop.start();

    window.__gameProbe = () => {
      const p = CELL_WORLD(this.cursor.r, this.cursor.c);
      return { x: p.x, y: 0, z: p.z };
    };
    window.__gomoku = {
      snap: () => this.snapshot(),
      screenPos: (r, c) => {
        const rect = this.canvas.getBoundingClientRect();
        const p = CELL_WORLD(r, c).project(this.camera);
        return {
          x: rect.left + ((p.x + 1) / 2) * rect.width,
          y: rect.top + ((1 - p.y) / 2) * rect.height,
        };
      },
      place: (r, c) => this.placePlayer(r, c),
      visibleStones: () => this.stoneMeshes.filter((mesh) => mesh?.visible).length,
      markedMove: () => this.lastMarker.visible ? this.moveHistory.at(-1) ?? null : null,
    };
    this.push();
  }

  /* ----- 场景搭建 ----- */

  private buildEnvironment() {
    // 灯光
    this.scene.add(new THREE.HemisphereLight(0xcfd8e3, 0x2a1f14, 0.75));
    const key = new THREE.DirectionalLight(0xfff1dd, 1.9);
    key.position.set(8, 16, 6);
    key.castShadow = true;
    const shadowSize = this.touchPrimary ? 1024 : 2048;
    key.shadow.mapSize.set(shadowSize, shadowSize);
    key.shadow.camera.left = -14;
    key.shadow.camera.right = 14;
    key.shadow.camera.top = 14;
    key.shadow.camera.bottom = -14;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.5);
    rim.position.set(-10, 8, -8);
    this.scene.add(rim);

    // 桌面地面
    this.tableWood.wrapS = this.tableWood.wrapT = THREE.RepeatWrapping;
    this.tableWood.repeat.set(6, 6);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), this.tableMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.0;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.disposables.push(floor.geometry, this.tableMat, this.tableWood);
  }

  private buildBoard() {
    const edge = this.boardEdgeMat;
    const geo = new THREE.BoxGeometry(HALF * 2 + 1.8, 0.9, HALF * 2 + 1.8);
    const box = new THREE.Mesh(geo, [edge, edge, this.boardTopMat, edge, edge, edge]);
    box.position.y = -0.45; // 顶面 y=0
    box.castShadow = true;
    box.receiveShadow = true;
    this.scene.add(box);
    this.disposables.push(geo, edge, this.boardTopMat, this.boardWood);

    // 网格线
    const pts: number[] = [];
    for (let i = 0; i < BOARD; i++) {
      const p = (i - 7) * SP;
      pts.push(-HALF, 0.012, p, HALF, 0.012, p);
      pts.push(p, 0.012, -HALF, p, 0.012, HALF);
    }
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    this.scene.add(new THREE.LineSegments(lineGeo, this.gridMat));
    this.disposables.push(lineGeo, this.gridMat);

    // 星位
    const starGeo = new THREE.CircleGeometry(0.09, 20);
    for (const [r, c] of [[3, 3], [3, 11], [7, 7], [11, 3], [11, 11]]) {
      const s = new THREE.Mesh(starGeo, this.starMat);
      const p = CELL_WORLD(r, c);
      s.position.set(p.x, 0.012, p.z);
      s.rotation.x = -Math.PI / 2;
      this.scene.add(s);
    }
    this.disposables.push(starGeo, this.starMat);
  }

  private applySkin() {
    const palette = SKINS[this.skin];
    const wood = this.skin === "wood";
    (this.scene.background as THREE.Color).set(palette.stage);
    this.scene.fog?.color.set(palette.stage);
    this.tableMat.color.set(palette.table);
    this.tableMat.map = wood ? this.tableWood : null;
    this.tableMat.needsUpdate = true;
    this.boardTopMat.color.set(wood ? "#ffffff" : palette.board);
    this.boardTopMat.map = wood ? this.boardWood : null;
    this.boardTopMat.roughness = this.skin === "celadon" ? 0.28 : 0.55;
    this.boardTopMat.needsUpdate = true;
    this.boardEdgeMat.color.set(palette.edge);
    this.gridMat.color.set(palette.grid);
    this.starMat.color.set(palette.grid);
    this.blackMat.color.set(palette.dark);
    this.whiteMat.color.set(palette.light);
    this.hoverMat.color.copy(this.playerColor === BLACK ? this.blackMat.color : this.whiteMat.color);
    this.cursorMesh.material.color.set(palette.glow);
    this.particleMats[0].color.set(palette.glow);
    this.particleMats[1].color.set(palette.accent);
    this.particleMats[2].color.set(palette.light);
    for (const [i, mesh] of this.winLineMeshes.entries()) {
      this.winLineMats[i].color.copy(mesh.userData.player === BLACK ? this.blackMat.color : this.whiteMat.color);
      this.winLineMats[i].emissive.set(palette.glow);
    }
  }

  private buildSkinPreview() {
    const preview = [
      [7, 6, BLACK], [7, 7, WHITE], [8, 8, BLACK], [8, 7, WHITE], [9, 6, BLACK],
    ];
    for (const [r, c, player] of preview) {
      const stone = new THREE.Mesh(this.stoneGeo, player === BLACK ? this.blackMat : this.whiteMat);
      const position = CELL_WORLD(r, c);
      stone.position.set(position.x, STONE_Y, position.z);
      stone.scale.y = 0.82;
      stone.castShadow = true;
      this.skinPreview.add(stone);
    }
    this.scene.add(this.skinPreview);
  }

  /* ----- 状态机 ----- */

  private get puzzle() {
    return puzzleFor(this.setup);
  }

  private get humanTurn() {
    return this.setup.mode === "local" || this.turn === this.playerColor;
  }

  private get activeRule(): Rule {
    return this.setup.rule ?? "freestyle";
  }

  private clockView(): Snapshot["clock"] {
    if (!this.clock || this.phase === "title" || this.phase === "replay") return null;
    const now = Date.now();
    const seconds: [number, number] = this.clock.left.map((value) => Math.ceil(value / 1000)) as [number, number];
    const active = this.phase === "playing" && this.clock.startedAt !== null ? this.turn : null;
    if (active !== null) seconds[active - 1] = Math.ceil(timeLeft(this.clock, active, now) / 1000);
    return { seconds, active };
  }

  snapshot(): Snapshot {
    const lastMove = this.moveHistory[(this.replayPly ?? this.moveHistory.length) - 1];
    const puzzle = this.puzzle;
    const opening = this.setup.mode === "challenge" && OPENINGS.find((item) => item.id === this.setup.preset);
    const challengeResult = this.phase === "over" ? this.resultPoints() : null;
    const hint = this.hint;
    const day = this.phase === "title" ? dailyKey() : this.setup.daily;
    const daily = day ? (this.phase === "title" ? dailyPuzzle(day) : puzzle) : undefined;
    const handicap = this.setup.mode === "handicap" ? HANDICAPS.findIndex(({ id }) => id === this.setup.preset) : -1;
    return {
      phase: this.phase,
      turn: this.turn,
      playerColor: this.playerColor,
      winner: this.winner,
      draw: this.draw,
      moveCount: this.moveHistory.length,
      difficulty: this.difficulty,
      skin: this.skin,
      muted: this.audio.muted,
      scores: { ...this.scores },
      lastMove: lastMove ? { ...lastMove } : null,
      replayPly: this.replayPly,
      undoable: this.phase === "playing" && this.humanTurn && !this.clock &&
        this.moveHistory.length - this.lockedPly >= (this.setup.mode === "local" ? 1 : 2),
      aiThinking: this.aiThinking,
      aiEngine: this.aiEngine,
      mode: this.setup.mode,
      style: this.style,
      overhead: this.overhead,
      canBranch: this.branchable,
      replayFromLibrary: this.replayFromLibrary,
      canResume: this.savedMatch !== null,
      hintLevel: this.hintLevel,
      hintText: hint && (this.hintLevel === 1
        ? hint.urgency === "win" ? `看向${hint.area}，你有成五机会。`
          : hint.urgency === "defense" ? `留意${hint.area}的威胁。` : `可以关注${hint.area}。`
        : this.hintLevel === 2 ? "棋盘上已标出可考虑的落点。" : "棋盘上的大圆环是推荐落点。"),
      puzzle: puzzle ? { title: puzzle.title, prompt: puzzle.prompt, result: this.puzzleResult } : null,
      solvedPuzzles: this.solvedPuzzles,
      challenge: opening ? { title: opening.title, round: this.setup.firstScore === undefined ? 1 : 2,
        result: challengeResult, total: challengeResult !== null && this.setup.firstScore !== undefined
          ? this.setup.firstScore + challengeResult : null } : null,
      pendingChallenge: this.nextLeg?.setup.preset ?? null,
      records: this.records,
      breakdown: this.breakdown,
      quick: this.quick,
      clock: this.clockView(),
      timeout: this.timeout,
      custom: this.setup.initial !== undefined,
      editor: { tool: this.editorTool, turn: this.editorTurn, error: this.editorError },
      rule: this.phase === "title" ? this.rule : this.activeRule,
      forbiddenNote: this.forbiddenNote,
      noLegalMove: this.noLegalMove,
      preferences: this.preferences,
      touchPreview: this.touchPreview,
      daily: day && daily?.goal.kind === "win" ? { day, best: this.dailyResults[day] ?? null,
        played: this.phase === "over" ? this.dailyAttempts() : null, target: daily.goal.maxMoves, player: daily.player } : null,
      handicap: handicap >= 0 && this.phase !== "title" ? { index: handicap, title: HANDICAPS[handicap].title } : null,
      handicapUnlocked: this.handicapUnlocked,
      canTrainLoss: this.phase === "over" && this.canTrainLoss(),
      lesson: this.lesson,
      comparison: this.comparison,
      analysis: this.analysis,
    };
  }

  private push() {
    emit(this.snapshot());
  }

  startFromUI() {
    if (this.phase === "title") this.startMatch();
    else if (this.phase === "over") this.restart();
  }

  private readCurrentMatch(): SavedMatch {
    return { setup: { ...this.setup }, moves: this.moveHistory.slice(), lockedPly: this.lockedPly, clock: this.clock ?? undefined };
  }

  private saveProgress() {
    this.savedMatch = this.readCurrentMatch();
    storage.set(MATCH_KEY, this.savedMatch);
  }

  private preparePosition(match: SavedMatch, position: Position) {
    this.cancelGesture();
    this.touchPreview = null;
    this.resetReplayTools();
    this.clearStones();
    this.resetAiTurn();
    this.setup = { ...match.setup };
    this.playerColor = this.setup.playerColor;
    this.difficulty = this.setup.difficulty;
    this.style = this.setup.style;
    this.board = position.board;
    this.moveHistory = position.moves;
    this.lockedPly = match.lockedPly;
    this.turn = position.turn;
    this.winner = position.winner;
    this.draw = position.full && !position.winner;
    this.replayPly = null;
    this.replayFromLibrary = false;
    this.branchable = false;
    this.puzzleResult = null;
    this.clock = null;
    this.clockSeconds = "";
    this.timeout = false;
    this.noLegalMove = false;
    this.forbiddenNote = null;
    this.clearHint();
    this.aiThinking = false;
    this.aiTimer = 0;
    this.cursor = { r: 7, c: 7 };
    for (const { r, c, player } of this.setup.initial?.stones ?? []) this.spawnStone(r, c, player, false);
    for (const { r, c, player } of this.moveHistory) this.spawnStone(r, c, player, false);
    this.applySkin();
  }

  private activateMatch(match: SavedMatch) {
    const position = readPosition(match.moves, match.setup.initial, match.setup.rule);
    if (!position || position.winner || position.full) return;
    this.preparePosition(match, position);
    this.phase = "playing";
    this.clock = this.setup.quick ? match.clock
      ? { ...match.clock, startedAt: match.clock.startedAt ?? Date.now() }
      : newClock(Date.now()) : null;
    this.frameBoard();
    if (this.expiredClock() || this.adjudicateNoMove()) return;
    if (this.setup.mode !== "local" && !this.setup.initial && this.activeRule === "freestyle" &&
        usesRapfi(this.difficulty) && !this.canUseNativeArena()) this.prepareRapfi();
    else this.stopAiWorker();
    if (!this.humanTurn) this.queueAiTurn();
    else this.startPonder();
    this.saveProgress();
    this.audio.sfx("ui");
    this.push();
  }

  private newSetup(mode: Mode): Setup {
    return { mode, playerColor: this.playerColor, difficulty: this.difficulty, style: this.style, rule: this.rule };
  }

  private startMatch() {
    this.activateMatch({ setup: { ...this.newSetup("solo"), quick: this.quick }, moves: [], lockedPly: 0 });
  }

  startLocal() {
    if (this.phase !== "title") return;
    this.activateMatch({ setup: { ...this.newSetup("local"), quick: this.quick }, moves: [], lockedPly: 0 });
  }

  startPuzzle(id: string) {
    if (this.phase !== "title") return;
    const puzzle = PUZZLES.find((entry) => entry.id === id);
    if (!puzzle) return;
    this.activateMatch({
      setup: { ...this.newSetup("puzzle"), preset: id, playerColor: puzzle.player, difficulty: "normal", style: "balanced", rule: "freestyle" },
      moves: puzzle.moves, lockedPly: puzzle.moves.length,
    });
  }

  startDaily() {
    if (this.phase !== "title") return;
    const day = dailyKey();
    const puzzle = dailyPuzzle(day);
    if (!puzzle) return;
    this.activateMatch({
      setup: { ...this.newSetup("puzzle"), preset: puzzle.id, daily: day, playerColor: puzzle.player,
        difficulty: "normal", style: "balanced", rule: "freestyle" },
      moves: puzzle.moves, lockedPly: puzzle.moves.length,
    });
  }

  startHandicap(index: number) {
    if ((this.phase !== "title" && this.phase !== "over") || !Number.isInteger(index) ||
        index < 0 || index > this.handicapUnlocked) return;
    const player = this.playerColor;
    this.activateMatch({
      setup: { ...this.newSetup("handicap"), preset: HANDICAPS[index].id, difficulty: "hard",
        style: "balanced", initial: handicapPosition(index, player) },
      moves: [], lockedPly: 0,
    });
  }

  startChallenge(id: string) {
    if (this.phase !== "title") return;
    const opening = OPENINGS.find((entry) => entry.id === id);
    if (!opening) return;
    this.nextLeg = null;
    storage.remove(CHALLENGE_KEY);
    this.activateMatch({ setup: { ...this.newSetup("challenge"), preset: id, playerColor: BLACK },
      moves: opening.moves, lockedPly: opening.moves.length });
  }

  nextChallenge() {
    if (!this.nextLeg || (this.phase !== "over" && this.phase !== "title")) return;
    const next = this.nextLeg;
    this.nextLeg = null;
    storage.remove(CHALLENGE_KEY);
    this.activateMatch(next);
  }

  resume() {
    if (this.phase === "title" && this.savedMatch) this.activateMatch(this.savedMatch);
  }

  restart() {
    if (this.phase !== "playing" && this.phase !== "paused" && this.phase !== "over") return;
    if (this.phase === "over" && this.setup.mode === "challenge" && this.setup.firstScore === undefined) {
      this.nextLeg = null;
      storage.remove(CHALLENGE_KEY);
    }
    this.activateMatch({ setup: this.setup,
      moves: this.moveHistory.slice(0, this.lockedPly), lockedPly: this.lockedPly });
  }

  backToTitle() {
    if (this.phase === "editor") this.clearEditor();
    this.cancelGesture();
    this.touchPreview = null;
    this.resetReplayTools();
    this.showMovesThrough(this.moveHistory.length);
    this.replayPly = null;
    this.replayFromLibrary = false;
    this.branchable = false;
    this.phase = "title";
    this.aiThinking = false;
    this.playerColor = loadPlayerColor();
    this.difficulty = loadDifficulty();
    this.style = loadStyle();
    this.clearHint();
    this.resetAiTurn();
    this.forbiddenNote = null;
    this.applySkin();
    this.frameBoard();
    this.audio.sfx("ui");
    this.push();
  }

  openReplay() {
    if (this.phase !== "over" || (!this.moveHistory.length && !this.setup.initial?.stones.length)) return;
    this.cancelGesture();
    this.resetReplayTools();
    // Replay reuses the existing meshes and leaves the completed game's state intact.
    for (const falling of this.falling) falling.mesh.position.y = falling.targetY;
    this.falling = [];
    for (const particle of this.particles) particle.mesh.visible = false;
    this.phase = "replay";
    this.frameBoard();
    this.seekReplay(this.moveHistory.length);
  }

  loadReplay(match: SavedMatch) {
    if (this.phase !== "title") return;
    const position = readPosition(match.moves, match.setup.initial, match.setup.rule);
    if (!position || (!position.moves.length && !match.setup.initial?.stones.length)) return;
    this.preparePosition(match, position);
    this.replayFromLibrary = true;
    if (position.line) this.highlightWin(position.line);
    this.phase = "replay";
    this.frameBoard();
    this.seekReplay(this.moveHistory.length);
  }

  replayData() {
    return this.phase === "over" || this.phase === "replay" ? this.readCurrentMatch() : null;
  }

  branchReplay() {
    if (this.phase !== "replay" || this.replayPly === null || !this.branchable) return;
    this.activateMatch({
      setup: { ...this.newSetup(this.setup.mode === "local" ? "local" : "practice"),
        initial: this.setup.initial, rule: this.comparison?.rule ?? this.activeRule },
      moves: this.moveHistory.slice(0, this.replayPly), lockedPly: this.replayPly,
    });
  }

  compareReplay() {
    if (this.phase !== "replay" || this.replayPly === null) return;
    if (this.comparison) {
      this.comparison = null;
      this.seekReplay(this.replayPly);
      return;
    }
    const rule = this.activeRule === "freestyle" ? "double-three" : "freestyle";
    const forbiddenPly = rule === "double-three" ? firstReplayBan(this.readCurrentMatch()) : null;
    this.comparison = { rule, forbiddenPly, move: forbiddenPly === null ? null : this.moveHistory[forbiddenPly] };
    this.seekReplay(forbiddenPly ?? this.replayPly);
  }

  private canTrainLoss() {
    return !this.timeout && !this.noLegalMove && this.winner === this.aiColor &&
      this.setup.mode !== "local" && this.setup.mode !== "puzzle" &&
      this.moveHistory.some((move, ply) => ply >= this.lockedPly && move.player === this.playerColor);
  }

  trainLoss(match?: SavedMatch) {
    if (match ? this.phase !== "title" : this.phase !== "over" || !this.canTrainLoss()) return;
    const lesson = defeatLesson(match ?? this.readCurrentMatch());
    if (!lesson) return;
    if (match) this.loadReplay(match);
    else this.openReplay();
    if (this.phase !== "replay") return;
    this.lesson = lesson;
    this.seekReplay(lesson.defendPly);
  }

  playLesson(attack: boolean) {
    if (this.phase !== "replay" || !this.lesson) return;
    const ply = attack ? this.lesson.attackPly : this.lesson.defendPly;
    this.activateMatch({
      setup: { ...this.setup, mode: "practice", playerColor: attack ? this.aiColor : this.playerColor,
        quick: false, preset: undefined, daily: undefined },
      moves: this.moveHistory.slice(0, ply), lockedPly: ply,
    });
  }

  private cancelAnalysis() {
    this.analysisWorker?.terminate();
    this.analysisWorker = null;
    this.analysis = null;
  }

  private resetReplayTools() {
    this.cancelAnalysis();
    this.comparison = null;
    this.lesson = null;
  }

  analyzeReplay() {
    if (this.phase !== "replay" || this.replayPly === null || !this.preferences.exactEndgame) return;
    this.cancelAnalysis();
    const rule = this.comparison?.rule ?? this.activeRule;
    const position = readPosition(this.moveHistory.slice(0, this.replayPly), this.setup.initial, rule);
    if (!position || position.winner || position.full) {
      this.analysis = "finished";
    } else if (position.board.filter((cell) => cell === EMPTY).length > ENDGAME_LIMIT) {
      this.analysis = { kind: "too-many" };
    } else {
      try {
        const worker = new Worker(new URL("./gomoku/ai-worker.ts", import.meta.url), { type: "module" });
        this.analysisWorker = worker;
        this.analysis = "working";
        const finish = (result: EndgameResult) => {
          if (this.analysisWorker !== worker) return;
          this.cancelAnalysis();
          this.analysis = result;
          this.push();
        };
        worker.onmessage = ({ data }: MessageEvent<AiWorkerReply>) => {
          if (data.kind === "solve") finish(data.result);
        };
        worker.onerror = (event) => {
          event.preventDefault();
          finish({ kind: "timeout" });
        };
        const request: AiWorkerRequest = { kind: "solve", token: 0, board: position.board,
          player: position.turn, rule, timeMs: 1600 };
        worker.postMessage(request);
      } catch {
        this.cancelAnalysis();
        this.analysis = { kind: "timeout" };
      }
    }
    this.push();
  }

  private showMovesThrough(ply: number) {
    for (const [i, { r, c }] of this.moveHistory.entries()) {
      const mesh = this.stoneMeshes[idx(r, c)];
      if (mesh) mesh.visible = i < ply;
    }
    for (const material of this.winLineMats) {
      material.emissiveIntensity = ply === this.moveHistory.length ? 0.55 : 0;
    }
  }

  seekReplay(ply: number) {
    if (this.phase !== "replay" || !Number.isFinite(ply)) return;
    this.cancelAnalysis();
    this.replayPly = THREE.MathUtils.clamp(Math.trunc(ply), 0, this.moveHistory.length);
    const withinRule = this.comparison?.forbiddenPly == null || this.replayPly <= this.comparison.forbiddenPly;
    this.branchable = withinRule && (this.replayPly < this.moveHistory.length || (!this.winner && !this.draw));
    this.showMovesThrough(this.replayPly);
    this.push();
  }

  closeReplay() {
    if (this.phase !== "replay") return;
    if (this.replayFromLibrary) {
      this.backToTitle();
      return;
    }
    this.cancelGesture();
    this.resetReplayTools();
    this.showMovesThrough(this.moveHistory.length);
    this.replayPly = null;
    this.branchable = false;
    this.phase = "over";
    this.frameBoard();
    this.push();
  }

  setQuick(quick: boolean) {
    if (this.phase !== "title") return;
    this.quick = quick;
    storage.set(QUICK_KEY, quick);
    this.push();
  }

  setRule(rule: Rule) {
    if (this.phase !== "title" || this.rule === rule) return;
    this.rule = rule;
    storage.set(RULE_KEY, rule);
    this.push();
  }

  setPreference(key: Exclude<keyof Preferences, "masterMode">, value: boolean) {
    if (this.phase !== "title" && this.phase !== "paused") return;
    this.preferences = { ...this.preferences, [key]: value };
    this.touchPreview = null;
    storage.set(PREFERENCES_KEY, this.preferences);
    this.push();
  }

  setMasterMode(mode: MasterMode) {
    if (this.phase !== "title" && this.phase !== "paused") return;
    this.preferences = { ...this.preferences, masterMode: mode };
    storage.set(PREFERENCES_KEY, this.preferences);
    this.push();
  }

  openEditor() {
    if (this.phase !== "title") return;
    this.preparePosition({ setup: this.newSetup("practice"), moves: [], lockedPly: 0 }, readPosition([])!);
    this.editorTool = BLACK;
    this.editorTurn = BLACK;
    this.editorError = null;
    this.phase = "editor";
    this.resetView();
    this.overhead = true;
    this.frameBoard();
    this.push();
  }

  setEditorTool(tool: Cell) {
    if (this.phase !== "editor") return;
    this.editorTool = tool;
    this.push();
  }

  setEditorTurn(turn: Stone) {
    if (this.phase !== "editor") return;
    this.editorTurn = turn;
    this.push();
  }

  clearEditor() {
    if (this.phase !== "editor") return;
    this.clearStones();
    this.board = createBoard();
    this.editorError = null;
    this.push();
  }

  private editCell(r: number, c: number) {
    if (!inBounds(r, c)) return false;
    const i = idx(r, c);
    if (this.board[i] === this.editorTool) return false;
    const previous = this.stoneMeshes[i];
    if (previous) this.scene.remove(previous);
    this.stoneMeshes[i] = null;
    this.board[i] = this.editorTool;
    if (this.editorTool !== EMPTY) this.spawnStone(r, c, this.editorTool, false);
    this.editorError = null;
    this.push();
    return true;
  }

  playEditor() {
    if (this.phase !== "editor") return;
    const stones: Move[] = [];
    this.board.forEach((player, i) => {
      if (player === BLACK || player === WHITE) stones.push({ r: Math.floor(i / BOARD), c: i % BOARD, player });
    });
    const initial = readInitial({ stones, turn: this.editorTurn });
    if (!initial) {
      this.editorError = "棋盘已满或已有五连，请调整后续下。";
      this.push();
      return;
    }
    this.activateMatch({ setup: { ...this.newSetup("practice"), initial }, moves: [], lockedPly: 0 });
  }

  private expiredClock(now = Date.now()) {
    if (!this.clock || timeLeft(this.clock, this.turn, now) > 0) return false;
    this.finish(opposite(this.turn), null, null, true);
    return true;
  }

  togglePause() {
    if (this.phase === "playing") {
      if (this.expiredClock()) return;
      this.cancelGesture();
      this.touchPreview = null;
      this.phase = "paused";
      this.clearPonder();
      if (this.clock) {
        this.clock = freezeClock(this.clock, this.turn, Date.now());
        this.saveProgress();
      }
      this.audio.sfx("ui");
    } else if (this.phase === "paused") {
      this.phase = "playing";
      if (this.clock) {
        this.clock = { ...this.clock, startedAt: Date.now() };
        this.saveProgress();
      }
      this.audio.sfx("ui");
      // 暂停期间 AI 已算完：恢复后立即落子
      if (this.pendingAiMove && this.turn === this.aiColor) {
        const mv = this.pendingAiMove;
        this.pendingAiMove = null;
        this.tryPlace(mv.r, mv.c, this.aiColor);
      }
      this.startPonder();
    }
    this.push();
  }

  setDifficulty(d: Difficulty) {
    if (this.phase !== "title" || this.difficulty === d) return;
    this.difficulty = d;
    if (!usesRapfi(d)) this.stopAiWorker();
    storage.set(DIFF_KEY, d);
    this.audio.sfx("ui");
    this.push();
  }

  setPlayerColor(color: Stone) {
    if (this.phase !== "title" || this.playerColor === color) return;
    this.playerColor = color;
    this.hoverMat.color.copy(color === BLACK ? this.blackMat.color : this.whiteMat.color);
    storage.set(PLAYER_COLOR_KEY, color);
    this.audio.sfx("ui");
    this.push();
  }

  setStyle(style: Style) {
    if (this.phase !== "title" || this.style === style) return;
    this.style = style;
    storage.set(STYLE_KEY, style);
    this.push();
  }

  setSkin(skin: Skin) {
    if (this.skin === skin) return;
    this.skin = skin;
    this.applySkin();
    storage.set(SKIN_KEY, skin);
    this.audio.sfx("ui");
    this.push();
  }

  resetView() {
    this.cancelGesture();
    this.camYaw = 0;
    this.camPitch = DEFAULT_PITCH;
    this.camDist = DEFAULT_DISTANCE;
  }

  toggleOverhead() {
    this.cancelGesture();
    this.overhead = !this.overhead;
    this.camDist = DEFAULT_DISTANCE;
    this.frameBoard();
    this.push();
  }

  private clearHint() {
    this.hint = null;
    this.hintLevel = 0;
  }

  showHint() {
    if (this.phase !== "playing" || !this.humanTurn || this.hintLevel >= 3) return;
    this.hint ??= moveHints(this.board, this.turn, this.activeRule);
    if (!this.hint) return;
    this.hintLevel++;
    this.push();
  }

  toggleMute() {
    this.audio.toggleMute();
    this.push();
  }

  undo() {
    const s = this.snapshot();
    if (!s.undoable) return;
    this.touchPreview = null;
    this.clearPonder();
    const count = this.setup.mode === "local" ? 1 : 2;
    for (let i = 0; i < count; i++) {
      const m = this.moveHistory.pop();
      if (!m) break;
      this.board[idx(m.r, m.c)] = EMPTY;
      const mesh = this.stoneMeshes[idx(m.r, m.c)];
      this.stoneMeshes[idx(m.r, m.c)] = null;
      if (mesh) {
        mesh.material = (mesh.material as THREE.MeshStandardMaterial).clone();
        this.undoAnims.push({ mesh, t: 0 });
      }
    }
    this.turn = count % 2 ? opposite(this.turn) : this.turn;
    this.forbiddenNote = null;
    this.clearHint();
    this.startPonder();
    this.saveProgress();
    this.audio.sfx("pickup");
    this.push();
  }

  private clearStones() {
    this.falling = [];
    for (const { mesh } of this.undoAnims) {
      this.scene.remove(mesh);
      (mesh.material as THREE.Material).dispose();
    }
    this.undoAnims = [];
    for (let i = 0; i < this.stoneMeshes.length; i++) {
      const m = this.stoneMeshes[i];
      if (m) {
        this.scene.remove(m);
        this.stoneMeshes[i] = null;
      }
    }
    this.winLineMeshes = [];
    for (const m of this.winLineMats) m.dispose();
    this.winLineMats = [];
    for (const p of this.particles) this.scene.remove(p.mesh);
    this.particles = [];
  }

  /* ----- 落子 ----- */

  private placePlayer(r: number, c: number) {
    if (this.phase === "editor") return this.editCell(r, c);
    return this.humanTurn && this.tryPlace(r, c, this.turn);
  }

  clearTouch() {
    if (!this.touchPreview) return;
    this.touchPreview = null;
    this.push();
  }

  confirmTouch() {
    if (!this.touchPreview || !this.humanTurn || this.phase !== "playing") return;
    const { r, c } = this.touchPreview;
    this.placePlayer(r, c);
  }

  private previewTouch(r: number, c: number) {
    if (this.touchPreview?.r === r && this.touchPreview.c === c) return;
    if (this.board[idx(r, c)] !== EMPTY) return;
    if (forbiddenMove(this.board, r, c, this.turn, this.activeRule)) {
      this.touchPreview = null;
      this.forbiddenNote = "黑棋双三，这手不能下。请换一个交叉点。";
      this.push();
      return;
    }
    this.forbiddenNote = null;
    this.touchPreview = { r, c };
    this.push();
  }

  private tryPlace(r: number, c: number, player: Stone) {
    if (this.phase !== "playing" || !inBounds(r, c) || this.board[idx(r, c)] !== EMPTY) return false;
    if (this.turn !== player) return false;
    const now = Date.now();
    if (this.expiredClock(now)) return false;
    if (forbiddenMove(this.board, r, c, player, this.activeRule)) {
      this.forbiddenNote = "黑棋双三，这手不能下。请换一个交叉点。";
      this.push();
      return false;
    }
    this.forbiddenNote = null;
    this.touchPreview = null;
    if (this.clock) this.clock = moveClock(this.clock, player, now);

    this.board[idx(r, c)] = player;
    this.moveHistory.push({ r, c, player });
    this.spawnStone(r, c, player);
    this.audio.sfx("move");
    this.clearHint();

    const goal = this.puzzle?.goal;
    if (goal?.kind === "block" && player === this.playerColor) {
      this.finish(EMPTY, null, r === goal.at[0] && c === goal.at[1] ? "solved" : "missed");
      return true;
    }

    const { win, line } = checkWin(this.board, r, c, player);
    if (win) {
      this.finish(player, line ?? [[r, c]], goal ? (player === this.playerColor ? "solved" : "missed") : null);
      return true;
    }
    if (goal?.kind === "win" && player === this.playerColor &&
        Math.ceil((this.moveHistory.length - this.lockedPly) / 2) >= goal.maxMoves) {
      this.finish(EMPTY, null, "missed");
      return true;
    }
    if (isFull(this.board)) {
      this.finish(EMPTY, null, goal ? "missed" : null);
      return true;
    }
    this.turn = player === BLACK ? WHITE : BLACK;
    if (this.adjudicateNoMove()) return true;
    if (!this.humanTurn) this.queueAiTurn();
    else this.startPonder();
    this.saveProgress();
    this.push();
    return true;
  }

  private dailyAttempts() {
    return this.moveHistory.slice(this.lockedPly).filter((move) => move.player === this.playerColor).length;
  }

  private resultPoints() {
    return this.draw ? 0.5 : this.winner === this.playerColor ? 1 : 0;
  }

  private adjudicateNoMove() {
    if (this.activeRule !== "double-three" || this.turn !== BLACK ||
        hasLegalMove(this.board, BLACK, this.activeRule)) return false;
    this.noLegalMove = true;
    this.finish(WHITE, null);
    return true;
  }

  private finish(winner: Cell, line: [number, number][] | null, puzzleResult: "solved" | "missed" | null = null,
    timeout = false) {
    this.clearPonder();
    this.touchPreview = null;
    if (this.clock) this.clock = freezeClock(this.clock, this.turn, Date.now());
    if (timeout) this.resetAiTurn();
    this.phase = "over";
    this.aiThinking = false;
    this.winner = winner;
    this.puzzleResult = puzzleResult;
    this.timeout = timeout;
    this.draw = winner === EMPTY && puzzleResult === null;
    this.savedMatch = null;
    storage.remove(MATCH_KEY);

    if (this.setup.mode === "solo") {
      const outcome = winner === this.playerColor ? "player" : winner ? "ai" : "draw";
      this.scores[outcome]++;
      storage.set(SCORES_KEY, this.scores);
      const key = `${this.difficulty}:${this.playerColor}`;
      const score = this.breakdown[key] ?? { player: 0, ai: 0, draw: 0 };
      this.breakdown = { ...this.breakdown, [key]: { ...score, [outcome]: score[outcome] + 1 } };
      storage.set(BREAKDOWN_KEY, this.breakdown);
    } else if (this.setup.mode === "challenge" && this.setup.firstScore === undefined) {
      this.nextLeg = { setup: { ...this.setup, playerColor: WHITE, firstScore: this.resultPoints() },
        moves: this.moveHistory.slice(0, this.lockedPly), lockedPly: this.lockedPly };
      storage.set(CHALLENGE_KEY, this.nextLeg);
    } else if (this.setup.mode === "handicap" && winner === this.playerColor) {
      const index = HANDICAPS.findIndex(({ id }) => id === this.setup.preset);
      this.handicapUnlocked = Math.min(HANDICAPS.length - 1, Math.max(this.handicapUnlocked, index + 1));
      storage.set(HANDICAP_KEY, this.handicapUnlocked);
    } else if (this.setup.daily && puzzleResult === "solved") {
      const day = this.setup.daily;
      this.dailyResults = { ...this.dailyResults, [day]: Math.min(this.dailyAttempts(), this.dailyResults[day] ?? Infinity) };
      const recent = Object.keys(this.dailyResults).sort().slice(-62);
      this.dailyResults = Object.fromEntries(recent.map((key) => [key, this.dailyResults[key]]));
      storage.set(DAILY_KEY, this.dailyResults);
    } else if (this.puzzle && puzzleResult === "solved" && !this.solvedPuzzles.includes(this.puzzle.id)) {
      this.solvedPuzzles = [...this.solvedPuzzles, this.puzzle.id];
      storage.set(PUZZLES_KEY, this.solvedPuzzles);
    }

    const timestamp = Date.now();
    this.records = [{ id: `${timestamp}-${Math.random().toString(36).slice(2)}`, timestamp,
      match: this.readCurrentMatch(), winner }, ...this.records].slice(0, 24);
    storage.set(LIBRARY_KEY, this.records);

    if (line) {
      this.highlightWin(line);
      this.burst(line);
    }
    this.audio.sfx(puzzleResult === "solved" || winner === this.playerColor ? "win" :
      puzzleResult === "missed" || winner === this.aiColor ? "lose" : "ui");
    this.push();
  }

  private highlightWin(line: [number, number][]) {
    this.winLineMeshes = line.map(([r, c]) => this.stoneMeshes[idx(r, c)])
      .filter((mesh): mesh is THREE.Mesh => mesh !== null);
    this.winLineMats = this.winLineMeshes.map((mesh) => {
      const material = (mesh.material as THREE.MeshStandardMaterial).clone();
      material.emissive.set(SKINS[this.skin].glow);
      mesh.material = material;
      return material;
    });
  }

  /* ----- AI 调度 ----- */

  private queueAiTurn(): void {
    this.aiThinking = true;
    this.aiTimer = 0.45 + Math.random() * 0.3;
  }

  private clearPonder(): void {
    this.ponderedTurn?.worker?.terminate();
    this.ponderedTurn = null;
  }

  private startPonder(): void {
    if (this.ponderedTurn || this.phase !== "playing" || !this.humanTurn || document.hidden ||
        this.difficulty !== "hard" || this.style !== "balanced" || this.setup.quick ||
        (this.setup.mode !== "solo" && this.setup.mode !== "practice")) return;
    const local = !!this.setup.initial || this.activeRule === "double-three";
    if (!local && this.aiEngine !== "rapfi") return;
    try {
      const worker = new Worker(new URL("./gomoku/ai-worker.ts", import.meta.url), { type: "module" });
      const ponder: PonderedTurn = {
        historyLength: this.moveHistory.length, token: --this.ponderToken, worker,
        prediction: null, reply: null, nativeTime: 0,
      };
      this.ponderedTurn = ponder;
      worker.onmessage = ({ data }: MessageEvent<AiWorkerReply>) => {
        if (this.ponderedTurn !== ponder || data.kind !== "ponder" || data.token !== ponder.token) return;
        ponder.prediction = data.prediction;
        ponder.reply = data.reply;
        if (local) return; // Keep this worker's search cache for the predicted position.
        worker.terminate();
        ponder.worker = null;
        const move = ponder.prediction;
        if (!move || !this.humanTurn || document.hidden || this.phase !== "playing" || !this.aiWorker || this.aiEngine !== "rapfi") return;
        const board = this.board.slice();
        board[idx(move.r, move.c)] = move.player;
        if (checkWin(board, move.r, move.c, move.player).win || isFull(board)) return;
        const timeMs = searchTime(board, this.aiColor, RAPFI_LEVELS.hard.timeMs);
        // Keep speculative native calls short so a different human move can be answered promptly.
        if (timeMs > 950) return;
        ponder.nativeTime = timeMs;
        try {
          this.aiWorker.postMessage({ token: ponder.token, history: [...this.moveHistory, move],
            player: this.aiColor, ...RAPFI_LEVELS.hard, timeMs });
        } catch {
          this.clearPonder();
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        if (this.ponderedTurn === ponder) this.clearPonder();
      };
      const request: AiWorkerRequest = { kind: "ponder", token: ponder.token, board: this.board,
        opponent: this.turn, ai: this.aiColor, rule: this.activeRule, local };
      worker.postMessage(request);
    } catch {
      this.clearPonder();
    }
  }

  private takePonder(): PonderedTurn | null {
    const ponder = this.ponderedTurn;
    const predicted = ponder?.prediction;
    const last = this.moveHistory.at(-1);
    if (ponder && predicted && last && this.moveHistory.length === ponder.historyLength + 1 &&
        last.r === predicted.r && last.c === predicted.c && last.player === predicted.player) {
      this.ponderedTurn = null;
      return ponder;
    }
    this.clearPonder();
    return null;
  }

  private clearAiWatchdog(): void {
    if (this.aiWatchdog !== null) clearTimeout(this.aiWatchdog);
    this.aiWatchdog = null;
  }

  private stopAiWorker(): void {
    this.nativeRequest?.abort();
    this.nativeRequest = null;
    this.nativeReviewLimit = 0;
    this.clearPonder();
    this.clearAiWatchdog();
    this.aiWorker?.terminate();
    this.aiWorker = null;
    this.positionWorker?.terminate();
    this.positionWorker = null;
    this.aiEngine = null;
  }

  private resetAiTurn(): void {
    this.clearPonder();
    this.aiToken++;
    this.pendingAiMove = null;
    if (this.aiRequestPending) this.stopAiWorker();
    this.aiRequestPending = false;
  }

  private watchRapfi(timeout: number): void {
    this.clearAiWatchdog();
    this.aiWatchdog = setTimeout(() => this.useAiFallback(), timeout);
  }

  private prepareRapfi(): void {
    if (this.aiWorker) return;
    try {
      // The vendor loader requires a classic worker. Vite copies it with the model.
      const worker = new Worker(new URL("rapfi/worker.js", document.baseURI).href);
      this.aiWorker = worker;
      this.aiEngine = "loading";
      this.watchRapfi(RAPFI_LOAD_TIMEOUT_MS);
      worker.onmessage = ({ data }: MessageEvent<RapfiReply>) => {
        if (this.aiWorker !== worker) return;
        if (data.type === "ready") {
          this.clearAiWatchdog();
          this.aiEngine = "rapfi";
          if (this.aiRequestPending) this.watchRapfi(RAPFI_SEARCH_TIMEOUT_MS);
          else this.startPonder();
          this.push();
        } else if (data.token !== undefined && data.token < 0) {
          if (data.type === "move" && data.token === this.ponderedTurn?.token) this.ponderedTurn.reply = data.move;
        } else if (data.type === "error") {
          if (data.token === undefined || data.token === this.aiToken) this.useAiFallback();
        } else if (this.aiRequestPending && data.token === this.aiToken) {
          const { r, c, player } = data.move;
          if (player !== this.aiColor || !inBounds(r, c) || this.board[idx(r, c)] !== EMPTY) {
            this.useAiFallback();
            return;
          }
          this.reviewNativeMove(data.move, this.nativeReviewLimit, data.alternatives);
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        if (this.aiWorker === worker) this.useAiFallback();
      };
    } catch {
      this.useAiFallback();
    }
  }

  private useAiFallback(): void {
    const wasLocal = this.aiEngine === "local";
    this.stopAiWorker();
    this.aiEngine = "fallback";
    if (this.aiRequestPending && this.turn === this.aiColor) {
      if (!wasLocal && this.difficulty === "hard" && this.preferences.masterMode !== "standard" &&
          !this.setup.initial && this.activeRule === "freestyle" &&
          this.requestPositionWorker(this.aiClockMs(), null)) return;
      this.applyAiMove(bestMove(this.board, this.aiColor, "normal", Math.random, this.style, this.activeRule));
    } else {
      this.push();
    }
  }

  private applyAiMove(move: Move | null): void {
    if (this.aiRequestPending || this.aiEngine !== "loading") this.clearAiWatchdog();
    this.aiRequestPending = false;
    this.aiThinking = false;
    if (move && this.turn === this.aiColor) {
      if (this.phase === "paused") this.pendingAiMove = move;
      if (this.phase === "playing") {
        this.tryPlace(move.r, move.c, this.aiColor);
        return;
      }
    }
    this.push();
  }

  private nativeReviewBudget() {
    if (this.difficulty !== "hard") return 0;
    const late = this.preferences.exactEndgame && this.board.filter((cell) => cell === EMPTY).length <= ENDGAME_LIMIT;
    if (!late && (!this.preferences.tacticalReview || !hasPressure(this.board, this.aiColor))) return 0;
    const clock = this.clock ? timeLeft(this.clock, this.turn, Date.now()) - 180 : Infinity;
    return Math.max(0, Math.min(MASTER_PROFILES[this.preferences.masterMode].review, Math.floor(clock / 4)));
  }

  private reviewNativeMove(move: Move, maximum: number, alternatives?: Move[]) {
    const timeMs = Math.min(maximum, this.nativeReviewBudget());
    if (timeMs < 20 || (this.phase !== "playing" && this.phase !== "paused")) {
      this.applyAiMove(move);
      return;
    }
    try {
      const worker = new Worker(new URL("./gomoku/ai-worker.ts", import.meta.url), { type: "module" });
      this.positionWorker = worker;
      this.aiRequestPending = true;
      const token = ++this.aiToken;
      const complete = (checked: Move = move) => {
        if (this.positionWorker !== worker || this.aiToken !== token) return;
        worker.terminate();
        this.positionWorker = null;
        this.applyAiMove(checked);
      };
      worker.onmessage = ({ data }: MessageEvent<AiWorkerReply>) => {
        if (data.kind === "review" && data.token === token) complete(data.move);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        complete();
      };
      const request: AiWorkerRequest = { kind: "review", token, board: this.board, player: this.aiColor, rule: this.activeRule,
        timeMs, move, alternatives, exact: this.preferences.exactEndgame, review: this.preferences.tacticalReview,
        arena: this.preferences.masterMode === "arena" };
      worker.postMessage(request);
      this.clearAiWatchdog();
      this.aiWatchdog = setTimeout(complete, timeMs + 900);
    } catch {
      this.positionWorker?.terminate();
      this.positionWorker = null;
      this.applyAiMove(move);
    }
  }

  private aiClockMs() {
    return this.clock ? timeLeft(this.clock, this.turn, Date.now()) - 100 : Infinity;
  }

  private canUseNativeArena() {
    return this.difficulty === "hard" && this.preferences.masterMode === "arena" &&
      this.style === "balanced" && !this.nativeUnavailable && window.location.hostname === "127.0.0.1";
  }

  private requestNativeArena(timeMs: number, reserve: number): boolean {
    const budget = timeMs - reserve;
    if (!this.canUseNativeArena() || budget < 350) return false;
    this.clearAiWatchdog();
    this.aiWorker?.terminate();
    this.aiWorker = null;
    const controller = new AbortController();
    this.nativeRequest = controller;
    this.aiRequestPending = true;
    const token = ++this.aiToken;
    const started = performance.now();
    const limit = setTimeout(() => controller.abort(), budget + 1700);
    void (async () => {
      let move: Move | undefined;
      try {
        const response = await fetch(new URL("api/arena/move", document.baseURI), {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ history: this.moveHistory, player: this.aiColor, timeMs: budget }),
        });
        if (response.status === 404 || response.status === 405 || response.status === 503 ||
            !response.headers.get("content-type")?.includes("application/json")) this.nativeUnavailable = true;
        if (response.ok) ({ move } = await response.json());
      } catch {
        // The browser engine can finish the turn if the local executable is unavailable.
      } finally {
        clearTimeout(limit);
      }
      if (this.nativeRequest !== controller || token !== this.aiToken) return;
      this.nativeRequest = null;
      if (move && move.player === this.aiColor && Number.isInteger(move.r) && Number.isInteger(move.c) &&
          inBounds(move.r, move.c) && this.board[idx(move.r, move.c)] === EMPTY) {
        this.aiEngine = "native";
        this.reviewNativeMove(move, reserve);
      } else {
        const remaining = Math.min(this.aiClockMs(), Math.max(550, timeMs - (performance.now() - started)));
        const browserBudget = Math.max(1, Math.min(timeMs, Math.floor(remaining)));
        this.prepareRapfi();
        if (this.aiWorker) this.requestBrowserTurn(browserBudget, Math.min(reserve, Math.floor(browserBudget * 0.32)));
      }
    })();
    return true;
  }

  private requestBrowserTurn(timeMs: number, reserve: number) {
    if (!usesRapfi(this.difficulty) || !this.aiWorker) {
      if (this.aiRequestPending) this.useAiFallback();
      return;
    }
    this.aiRequestPending = true;
    this.nativeReviewLimit = reserve;
    try {
      this.aiWorker.postMessage({
        token: ++this.aiToken,
        history: this.moveHistory,
        player: this.aiColor,
        preferences: stylePreferences(this.board, this.aiColor, this.style),
        ...RAPFI_LEVELS[this.difficulty], timeMs: Math.max(1, timeMs - reserve),
        multiple: this.preferences.tacticalReview && reserve >= 20,
      });
      if (this.aiEngine === "rapfi") this.watchRapfi(RAPFI_SEARCH_TIMEOUT_MS);
    } catch {
      this.useAiFallback();
    }
  }

  private requestAI(): void {
    const local = !!this.setup.initial || this.activeRule === "double-three";
    const mode = this.difficulty === "hard" ? this.preferences.masterMode : "standard";
    const bookMove = this.difficulty === "hard" && this.style === "balanced" && this.setup.mode === "solo" && !this.setup.initial
      ? openingMove(this.board, this.moveHistory, this.aiColor, this.activeRule) : null;
    if (bookMove && (mode === "standard" || this.moveHistory.length === 0)) {
      this.clearPonder();
      if (local) this.aiEngine = "local";
      this.applyAiMove(bookMove);
      return;
    }
    const ponder = this.takePonder();
    const clockMs = this.aiClockMs();
    if (local) {
      if (usesRapfi(this.difficulty) && this.requestPositionWorker(clockMs, ponder, bookMove)) return;
      ponder?.worker?.terminate();
      this.applyAiMove(bestMove(this.board, this.aiColor, this.difficulty, Math.random, this.style, this.activeRule));
      return;
    }
    if (usesRapfi(this.difficulty)) {
      const level = RAPFI_LEVELS[this.difficulty];
      const timeMs = this.difficulty === "hard"
        ? masterBudget(this.board, this.aiColor, "freestyle", mode, clockMs, !!bookMove)
        : searchTime(this.board, this.aiColor, level.timeMs, clockMs);
      const reserve = Math.min(this.nativeReviewBudget(), Math.floor(timeMs * 0.32));
      if (this.requestNativeArena(timeMs, reserve)) return;
      const reply = ponder?.reply;
      if (reply && ponder.nativeTime >= timeMs && reply.player === this.aiColor &&
          inBounds(reply.r, reply.c) && this.board[idx(reply.r, reply.c)] === EMPTY) {
        this.reviewNativeMove(reply, reserve);
        return;
      }
      if (!this.aiWorker && this.aiEngine !== "fallback") this.prepareRapfi();
      if (this.aiWorker) {
        this.requestBrowserTurn(timeMs, reserve);
        return;
      }
      if (mode !== "standard" && this.requestPositionWorker(clockMs, null, bookMove)) return;
    }
    this.applyAiMove(bestMove(this.board, this.aiColor, usesRapfi(this.difficulty) ? "normal" : this.difficulty, Math.random, this.style));
  }

  private requestPositionWorker(clockMs: number, ponder: PonderedTurn | null, bookMove: Move | null = null): boolean {
    try {
      const worker = ponder?.worker ?? new Worker(new URL("./gomoku/ai-worker.ts", import.meta.url), { type: "module" });
      this.positionWorker = worker;
      this.aiEngine = "local";
      const token = ++this.aiToken;
      this.aiRequestPending = true;
      worker.onmessage = ({ data }: MessageEvent<AiWorkerReply>) => {
        if (data.kind !== "search" || this.positionWorker !== worker || token !== this.aiToken || data.token !== token) return;
        worker.terminate();
        this.positionWorker = null;
        const move = data.move;
        if (move && (move.player !== this.aiColor || !inBounds(move.r, move.c) || this.board[idx(move.r, move.c)] !== EMPTY ||
            forbiddenMove(this.board, move.r, move.c, move.player, this.activeRule))) {
          this.useAiFallback();
          return;
        }
        this.applyAiMove(move);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        if (this.positionWorker === worker) this.useAiFallback();
      };
      const mode = this.difficulty === "hard" ? this.preferences.masterMode : "standard";
      const ready = bookMove ?? ponder?.reply;
      const request: AiWorkerRequest = { token, board: this.board, ai: this.aiColor, variant: 0,
        maxDepth: this.difficulty === "hard" ? MASTER_PROFILES[mode].depth : 8,
        timeMs: this.difficulty === "hard" ? masterBudget(this.board, this.aiColor, "local", mode, clockMs, !!bookMove) :
          searchTime(this.board, this.aiColor, 650, clockMs),
        style: this.style, rule: this.activeRule, preferred: ready ? idx(ready.r, ready.c) : undefined,
        review: this.difficulty === "hard" && this.preferences.tacticalReview,
        exact: this.difficulty === "hard" && this.preferences.exactEndgame, deep: mode !== "standard", arena: mode === "arena" };
      worker.postMessage(request);
      this.watchRapfi(RAPFI_SEARCH_TIMEOUT_MS);
      return true;
    } catch {
      this.aiRequestPending = false;
      this.positionWorker?.terminate();
      this.positionWorker = null;
      return false;
    }
  }

  private spawnStone(r: number, c: number, player: Cell, animate = true) {
    const mesh = new THREE.Mesh(this.stoneGeo, player === BLACK ? this.blackMat : this.whiteMat);
    mesh.userData.player = player;
    mesh.scale.y = 0.82;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const p = CELL_WORLD(r, c);
    mesh.position.set(p.x, animate ? 6.5 : STONE_Y, p.z);
    this.scene.add(mesh);
    this.stoneMeshes[idx(r, c)] = mesh;
    if (animate) this.falling.push({ mesh, targetY: STONE_Y, t: 0 });
  }

  private burst(line: [number, number][]) {
    for (const [r, c] of line) {
      const p = CELL_WORLD(r, c);
      for (let i = 0; i < 10; i++) {
        const mat = this.particleMats[Math.floor(Math.random() * this.particleMats.length)];
        const m = new THREE.Mesh(this.particleGeo, mat);
        m.position.set(p.x, STONE_Y + 0.2, p.z);
        const a = Math.random() * Math.PI * 2;
        const sp = 1.5 + Math.random() * 2.5;
        this.particles.push({
          mesh: m,
          vel: new THREE.Vector3(Math.cos(a) * sp, 3 + Math.random() * 2.5, Math.sin(a) * sp),
          life: 1.2 + Math.random() * 0.4,
        });
        this.scene.add(m);
      }
    }
  }

  /* ----- 输入 ----- */

  private cellAt(e: PointerEvent): { r: number; c: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX >= rect.right ||
        e.clientY < rect.top || e.clientY >= rect.bottom) return null;
    this.pointerNDC.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointerNDC, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.boardPlane, hit)) return null;
    const c = Math.round(hit.x / SP + 7);
    const r = Math.round(hit.z / SP + 7);
    if (r < 0 || r >= BOARD || c < 0 || c >= BOARD) return null;
    return { r, c };
  }

  private clearHover = () => { this.hover = null; };

  private cancelGesture = () => {
    this.pointers.clear();
    this.adjustingTouch = false;
    this.clearHover();
  };

  private pinchDistance(): number {
    const [first, second] = this.pointers.values();
    return Math.hypot(first.x - second.x, first.y - second.y);
  }

  private onPointerMove = (e: PointerEvent) => {
    const previous = this.pointers.get(e.pointerId);
    if (!previous) {
      if (this.pointers.size === 0 && e.pointerType !== "touch") this.hover = this.cellAt(e);
      return;
    }

    const { clientX: x, clientY: y } = e;
    if (this.pointers.size >= 2) {
      const before = this.pinchDistance();
      this.pointers.set(e.pointerId, { x, y });
      const after = this.pinchDistance();
      if (before > 0 && after > 0) this.setCameraDistance(this.camDist * before / after);
      return;
    }

    this.pointers.set(e.pointerId, { x, y });
    const dx = x - previous.x;
    const dy = y - previous.y;
    this.gestureTravel += Math.hypot(dx, dy);
    if (this.gestureTravel > (e.pointerType === "touch" ? 9 : 5)) this.gestureMoved = true;
    if (!this.gestureMoved) {
      this.hover = this.cellAt(e);
      return;
    }
    this.clearHover();
    if (this.adjustingTouch) {
      const cell = this.cellAt(e);
      if (cell && this.phase === "playing" && this.humanTurn) this.previewTouch(cell.r, cell.c);
      return;
    }
    if (this.overhead) return;
    this.camYaw -= dx * 0.005;
    this.camPitch = THREE.MathUtils.clamp(this.camPitch + dy * 0.004, 0.45, 1.35);
  };

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (this.pointers.size === 0) {
      this.gestureMoved = false;
      this.gestureTravel = 0;
      this.hover = this.cellAt(e);
      this.adjustingTouch = e.pointerType === "touch" && !!this.touchPreview && !!this.hover &&
        this.touchPreview.r === this.hover.r && this.touchPreview.c === this.hover.c;
    } else {
      this.gestureMoved = true;
      this.adjustingTouch = false;
      this.clearHover();
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.canvas.setPointerCapture(e.pointerId);
  };

  private onPointerUp = (e: PointerEvent) => {
    const previous = this.pointers.get(e.pointerId);
    if (!previous) return;
    this.pointers.delete(e.pointerId);
    this.clearHover();
    const releaseTravel = Math.hypot(e.clientX - previous.x, e.clientY - previous.y);
    if (this.gestureMoved || this.gestureTravel + releaseTravel > (e.pointerType === "touch" ? 9 : 5) ||
        (this.phase !== "editor" && (this.phase !== "playing" || !this.humanTurn))) return;
    const cell = this.cellAt(e);
    if (!cell) return;
    this.cursor = cell;
    if (e.pointerType === "touch" && this.preferences.touchConfirm && this.phase === "playing") {
      if (this.touchPreview?.r === cell.r && this.touchPreview.c === cell.c) this.confirmTouch();
      else this.previewTouch(cell.r, cell.c);
      return;
    }
    this.placePlayer(cell.r, cell.c);
  };

  private onPointerCancel = (e: PointerEvent) => {
    if (!this.pointers.delete(e.pointerId)) return;
    this.gestureMoved = true;
    this.adjustingTouch = false;
    this.clearHover();
  };

  private setCameraDistance(distance: number) {
    this.camDist = THREE.MathUtils.clamp(distance, 12, 34);
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.setCameraDistance(this.camDist + e.deltaY * 0.02);
  };

  private keys = new Set<string>();

  private onKey = (e: KeyboardEvent) => {
    if (this.phase === "replay") {
      if (e.key === "Escape") this.closeReplay();
      else if (!(e.target instanceof HTMLInputElement) && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        this.seekReplay((this.replayPly ?? 0) + (e.key === "ArrowLeft" ? -1 : 1));
      }
      return;
    }
    if ((e.key === " " || e.key === "Enter") &&
        e.target instanceof HTMLElement && e.target.closest("button, input, select, textarea")) return;
    if (e.repeat) return void this.keys.add(e.key);
    this.keys.add(e.key);

    if (e.key === " " || e.key === "Enter") {
      // 标题/终局：Space 开局；对局中：Enter 落子
      if (e.key === " " && (this.phase === "title" || this.phase === "over")) {
        e.preventDefault();
        this.startFromUI();
        return;
      }
      if (e.key === "Enter" && (this.phase === "editor" || (this.phase === "playing" && this.humanTurn))) {
        e.preventDefault();
        this.placePlayer(this.cursor.r, this.cursor.c);
        return;
      }
    }
    if (e.key === "Escape") {
      if (this.phase === "editor") this.backToTitle();
      else this.togglePause();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.key);
  };

  /* ----- 主循环 ----- */

  private update = (dt: number) => {
    // 键盘光标移动（含 WASD，探针方向断言依赖：W→r-1(z-)，D→c+1(x+)）
    if (this.phase === "playing" || this.phase === "title" || this.phase === "editor") {
      let dr = 0, dc = 0;
      const k = this.keys;
      if (k.has("w") || k.has("W") || k.has("ArrowUp")) dr -= 1;
      if (k.has("s") || k.has("S") || k.has("ArrowDown")) dr += 1;
      if (k.has("a") || k.has("A") || k.has("ArrowLeft")) dc -= 1;
      if (k.has("d") || k.has("D") || k.has("ArrowRight")) dc += 1;
      if (dr || dc) {
        this.cursor.r = THREE.MathUtils.clamp(this.cursor.r + dr, 0, BOARD - 1);
        this.cursor.c = THREE.MathUtils.clamp(this.cursor.c + dc, 0, BOARD - 1);
        this.cursorMesh.visible = true;
      }
    }

    // 悬停指示
    const ghost = this.touchPreview ?? this.hover;
    if (ghost && this.phase === "playing" && this.humanTurn && this.board[idx(ghost.r, ghost.c)] === EMPTY) {
      const p = CELL_WORLD(ghost.r, ghost.c);
      this.hoverMat.color.copy(this.turn === BLACK ? this.blackMat.color : this.whiteMat.color);
      this.hoverMat.opacity = this.touchPreview ? 0.67 : 0.35;
      this.hoverMesh.position.set(p.x, STONE_Y + (this.touchPreview ? 0 : Math.sin(performance.now() * 0.004) * 0.05), p.z);
      this.hoverMesh.visible = true;
    } else {
      this.hoverMesh.visible = false;
    }

    // 光标环
    const replayMove = this.replayPly === null ? null : this.moveHistory[this.replayPly - 1];
    const cursor = replayMove ?? this.touchPreview ?? this.cursor;
    const cp = CELL_WORLD(cursor.r, cursor.c);
    this.cursorMesh.position.set(cp.x, 0.02, cp.z);
    this.cursorMesh.visible = !!replayMove || (this.phase === "playing" && this.humanTurn && this.hintLevel < 2);
    if (this.phase === "editor") this.cursorMesh.visible = true;
    for (const [i, ring] of this.hintRings.entries()) {
      const move = this.hint?.candidates[i];
      ring.visible = this.phase === "playing" && this.hintLevel >= 2 && !!move && (this.hintLevel < 3 || i === 0);
      if (ring.visible && move) {
        const point = CELL_WORLD(move.r, move.c);
        ring.position.set(point.x, 0.02, point.z);
        ring.scale.setScalar(this.hintLevel === 3 ? 1.28 : 0.78);
      }
    }

    // 落子动画（ease-out 下落）
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i];
      f.t = Math.min(1, f.t + dt * 2.6);
      const e = 1 - Math.pow(1 - f.t, 3);
      f.mesh.position.y = 6.5 + (f.targetY - 6.5) * e;
      if (f.t >= 1) {
        this.falling.splice(i, 1);
        this.audio.sfx("hit"); // 触盘脆响
      }
    }
    const lastMove = this.moveHistory.at(-1);
    const marked = lastMove && this.stoneMeshes[idx(lastMove.r, lastMove.c)];
    this.lastMarker.visible = !!marked && (this.phase === "playing" || this.phase === "paused");
    if (this.lastMarker.visible && marked && lastMove) {
      this.lastMarker.material.color.set(lastMove.player === BLACK ? SKINS[this.skin].glow : 0x433657);
      this.lastMarker.position.set(marked.position.x, marked.position.y + STONE_R * 0.82 + 0.014, marked.position.z);
    }

    // 悔棋抬升淡出（克隆独立材质，避免污染共用材质）
    for (let i = this.undoAnims.length - 1; i >= 0; i--) {
      const u = this.undoAnims[i];
      u.t += dt * 2;
      u.mesh.position.y += dt * 3;
      const mat = u.mesh.material as THREE.MeshStandardMaterial;
      mat.transparent = true;
      mat.opacity = Math.max(0, 1 - u.t);
      if (u.t >= 1) {
        this.scene.remove(u.mesh);
        mat.dispose();
        this.undoAnims.splice(i, 1);
      }
    }

    // AI 回合
    if (this.phase === "playing" && this.clock) {
      if (this.expiredClock()) return;
      const seconds = this.clockView()?.seconds.join(":") ?? "";
      if (seconds !== this.clockSeconds) {
        this.clockSeconds = seconds;
        this.push();
      }
    }
    if (this.phase === "playing" && !this.humanTurn && this.aiThinking) {
      this.aiTimer -= dt;
      if (this.aiTimer <= 0) {
        this.aiTimer = Number.POSITIVE_INFINITY; // 只触发一次，等待结果回传
        this.aiThinking = false;
        this.requestAI();
      }
    }

    // 胜利粒子
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      p.vel.y -= 9.8 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += dt * 6;
      p.mesh.rotation.z += dt * 5;
      const mat = p.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.min(1, p.life);
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        this.particles.splice(i, 1);
      }
    }

    // 胜利连线呼吸
    if (this.phase === "over" && this.winLineMeshes.length) {
      const glow = 0.4 + Math.sin(performance.now() * 0.005) * 0.35;
      for (const m of this.winLineMeshes) {
        (m.material as THREE.MeshStandardMaterial).emissiveIntensity = glow;
      }
    }

    this.idleT += dt;
  };

  private render = () => {
    // 相机（标题态缓慢环绕）
    this.skinPreview.visible = this.phase === "title" && !this.board.some((cell) => cell !== EMPTY);
    const sway = this.phase === "title" && !this.reduceMotion.matches ? Math.sin(this.idleT * 0.25) * 0.35 : 0;
    const yaw = this.overhead ? 0 : this.camYaw + sway;
    const pitch = this.overhead ? Math.PI / 2 - 0.001 : this.camPitch;
    this.camera.position.set(
      Math.sin(yaw) * Math.cos(pitch) * this.camDist,
      Math.sin(pitch) * this.camDist,
      Math.cos(yaw) * Math.cos(pitch) * this.camDist
    );
    this.camera.lookAt(0, -0.3, 0);
    this.renderer.render(this.scene, this.camera);
    window.__GAME_READY__ = true;
  };

  dispose() {
    this.loop.stop();
    this.resizeObserver.disconnect();
    window.removeEventListener("blur", this.cancelGesture);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerCancel);
    this.canvas.removeEventListener("lostpointercapture", this.onPointerCancel);
    this.canvas.removeEventListener("pointerleave", this.clearHover);
    this.canvas.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("keyup", this.onKeyUp);
    this.clearStones();
    for (const d of this.disposables) d.dispose();
    this.stoneGeo.dispose();
    for (const m of this.winLineMats) m.dispose();
    this.blackMat.dispose();
    this.whiteMat.dispose();
    this.hoverMat.dispose();
    this.particleGeo.dispose();
    for (const m of this.particleMats) m.dispose();
    this.stopAiWorker();
    this.audio.dispose();
    this.renderer.dispose();
    delete window.__gameProbe;
    delete window.__gomoku;
    window.__GAME_READY__ = false;
  }
}

/* ---------- 合约导出 ---------- */

export function startGame(canvas: HTMLCanvasElement): void {
  stopGame();
  session = new GomokuSession(canvas);
}

export function stopGame(): void {
  session?.dispose();
  session = null;
}
