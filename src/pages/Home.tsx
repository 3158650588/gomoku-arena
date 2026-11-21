/**
 * Home.tsx — 五子棋 HUD：React 只负责 DOM 外壳（标题/对局/暂停/终局界面），
 * 渲染循环与棋局逻辑全部在 src/game/ 内。
 */

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent } from 'react'
import { startGame, stopGame, subscribe, ui, Snapshot } from '@/game/boot'
import { DIFFICULTIES, type Difficulty } from '@/game/gomoku/ai'
import { BLACK, WHITE, EMPTY } from '@/game/gomoku/logic'
import { HANDICAPS, STYLES } from '@/game/gomoku/match'
import { SKINS, SKIN_IDS, type Skin } from '@/game/gomoku/skins'
import { ColorStats, ReplayLibrary, TrainingMenu, downloadReplay } from './LobbyExtras'
import { GameSettings } from './GameSettings'

const LOBBY_TABS = [
  ['play', '开局'], ['training', '训练'], ['replays', '棋谱'], ['stats', '战绩'], ['settings', '设置'],
] as const
const STYLE_LABEL = { balanced: '均衡', attack: '偏进攻', defense: '偏防守' }
const clockText = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
const coordinates = ({ r, c }: { r: number; c: number }) => `${String.fromCharCode(65 + c)}${r + 1}`
function afterTouch(event: PointerEvent<HTMLButtonElement>, action: () => void) {
  if (event.pointerType === 'touch' &&
      event.currentTarget.contains(document.elementFromPoint(event.clientX, event.clientY))) action()
}

function analysisText(analysis: NonNullable<Snapshot['analysis']>) {
  if (analysis === 'finished') return '请回到一手合法、尚未结束的局面再算。'
  if (analysis === 'working') return '正在精算双方的应手…'
  if (analysis.kind === 'too-many') return '空位超过 10 格。往后多走几手再精算。'
  if (analysis.kind === 'timeout') return '这次用时内还没算完，胜负待定。'
  if (analysis.kind === 'exact') {
    if (analysis.winner === null) return '双方最佳应对下是和棋。'
    const color = analysis.winner === BLACK ? '黑棋' : '白棋'
    const move = analysis.move ? ` 当前方最佳落点为 ${coordinates(analysis.move)}。` : ''
    return analysis.winnerMoves === 0 ? `${color}胜，黑棋无合法落点。` :
      `双方最佳应对下，${color}需 ${analysis.winnerMoves} 手取胜。${move}`
  }
}

const LEVELS: Record<Difficulty, { label: string; description: string }> = {
  easy: { label: '新手', description: 'AI 会成五和挡五，平时偶尔会换一种下法。' },
  beginner: { label: '入门', description: 'AI 会抓住成五机会，也会堵住你的五连。' },
  normal: { label: '普通', description: 'AI 会考虑你的下一手。' },
  advanced: { label: '进阶', description: 'AI 会多算几步，能发现更多连续威胁。' },
  expert: { label: '高手', description: 'Rapfi 限深搜索，适合练习攻防。' },
  hard: { label: '大师 · Rapfi', description: 'Rapfi 每手最多约 3.5 秒，挑战最高棋力。' },
}

function SkinPicker({ selected }: { selected: Skin }) {
  return (
    <fieldset className="settings-group">
      <legend>棋盘皮肤</legend>
      <div className="skin-choices">
        {SKIN_IDS.map((id) => {
          const skin = SKINS[id]
          return (
            <button
              key={id}
              type="button"
              className="skin-btn"
              aria-pressed={selected === id}
              onClick={() => ui.setSkin(id)}
              style={{
                '--swatch-board': skin.board,
                '--swatch-grid': skin.grid,
                '--swatch-dark': skin.dark,
                '--swatch-light': skin.light,
              } as CSSProperties}
            >
              <span className="skin-swatch" aria-hidden="true" />
              {skin.label}
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [tab, setTab] = useState<typeof LOBBY_TABS[number][0]>('play')
  const [pauseSettings, setPauseSettings] = useState(false)

  const [bootError, setBootError] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    try {
      startGame(canvas)
    } catch {
      setBootError(true)
      return
    }
    setSnap(ui.snapshot())
    const unsub = subscribe(setSnap)
    return () => {
      unsub()
      stopGame()
    }
  }, [])

  useEffect(() => {
    if (snap?.phase !== 'paused') setPauseSettings(false)
  }, [snap?.phase])

  if (bootError) {
    return (
      <div id="game-root" className="boot-error">
        <p>当前浏览器无法创建 WebGL 环境，五子棋无法启动。</p>
        <p>请更换支持 WebGL 的浏览器后再试。</p>
      </div>
    )
  }

  const phase = snap?.phase ?? 'title'
  const replayPly = snap?.replayPly ?? null
  const playerWon = snap != null && snap.winner === snap.playerColor
  const humanTurn = snap?.mode === 'local' || snap?.turn === snap?.playerColor
  const shownColor = snap?.winner || snap?.turn
  const shownColorName = shownColor === BLACK ? '黑' : '白'
  const aiThinkingLabel = snap?.aiEngine === 'loading' ? 'Rapfi 加载中…' : `AI（${shownColorName}）思考中…`
  const skin = SKINS[snap?.skin ?? 'wood']

  return (
    <div id="game-root" style={{
      '--skin-panel': skin.panel,
      '--skin-accent': skin.accent,
      '--skin-glow': skin.glow,
      '--skin-stone-dark': skin.dark,
      '--skin-stone-light': skin.light,
    } as CSSProperties}>
      <canvas id="game-canvas" ref={canvasRef} />

      {/* 常驻顶栏 */}
      {phase !== 'title' && phase !== 'replay' && phase !== 'editor' && snap && (
        <div className="topbar">
          <div className={`turn-chip ${shownColor === BLACK ? 'black-turn' : 'white-turn'}`}>
            <span className="stone-dot" />
            {phase === 'over'
              ? snap.puzzle?.result
                ? snap.puzzle.result === 'solved' ? '已解题' : '本次未解'
                : snap.draw
                ? '平局'
                : `${shownColorName}棋胜利`
              : snap.aiThinking
                ? aiThinkingLabel
                : humanTurn
                  ? snap.mode === 'local' ? `${shownColorName}棋落子` : `你的回合（${shownColorName}）`
                  : `AI 回合（${shownColorName}）`}
          </div>
          <div className="topbar-actions">
            <button className="btn" disabled={!snap.undoable} onClick={() => ui.undo()}>
              悔棋
            </button>
            <button className="btn" onClick={() => ui.restart()}>
              重开
            </button>
            <button className="btn" onClick={() => ui.togglePause()}>
              暂停
            </button>
            <button className="btn icon" onClick={() => ui.toggleMute()} title="音效开关">
              {snap.muted ? '🔇' : '🔊'}
            </button>
          </div>
        </div>
      )}

      {(phase === 'playing' || phase === 'paused' || phase === 'over') && snap && (
        <div className="live-notices">
          {snap.clock && <div className="clock-strip" aria-label="棋钟">
            <span className={snap.clock.active === BLACK ? 'running-clock' : undefined}>黑 {clockText(snap.clock.seconds[0])}</span>
            <span className={snap.clock.active === WHITE ? 'running-clock' : undefined}>白 {clockText(snap.clock.seconds[1])}</span>
          </div>}
          {snap.rule === 'double-three' && <div className="live-notice">黑棋禁双三</div>}
          {snap.aiEngine === 'native' && <div className="live-notice">擂台 · 本机多线程</div>}
          {snap.difficulty === 'hard' && snap.mode !== 'local' && snap.preferences.masterMode === 'arena' &&
            snap.aiEngine === 'rapfi' && <div className="live-notice">擂台 · 浏览器引擎</div>}
          {snap.forbiddenNote && <div className="live-notice" role="status">{snap.forbiddenNote}</div>}
          {snap.aiEngine === 'fallback' && snap.mode !== 'local' &&
            <div className="live-notice" role="status">{snap.custom || snap.rule === 'double-three' ? '后台搜索' : 'Rapfi'}暂不可用，已切换为普通 AI</div>}
          {snap.puzzle && <div className="live-notice">{snap.puzzle.prompt}</div>}
          {snap.challenge && <div className="live-notice">{snap.challenge.title} · 第 {snap.challenge.round} / 2 局</div>}
          {snap.mode === 'practice' && <div className="live-notice">{snap.custom ? '自定义局面 · 本地 AI' : '分支练习'}</div>}
          {snap.handicap && <div className="live-notice">让子挑战 · {snap.handicap.title}</div>}
          {snap.hintText && <div className="live-notice" role="status">{snap.hintText}</div>}
        </div>
      )}

      {/* 底部提示 */}
      {phase === 'playing' && snap && (
        <div className="play-footer">
          <div className="hint-bar">
            <span className="desktop-hints">点击落子 · 拖拽旋转 · 滚轮缩放 · Enter 落子 · Esc 暂停</span>
            <span className="touch-hints">{snap.preferences.touchConfirm ? '轻点预览 · 再点同一处确认 · 拖预览棋微调' : '轻点落子 · 拖动旋转 · 双指缩放'}</span>
          </div>
          {snap.touchPreview && <div className="touch-confirm-bar" role="group" aria-label="待确认落子">
            <span aria-live="polite">{coordinates(snap.touchPreview)}</span>
            <button className="btn" onClick={ui.clearTouch} onPointerUp={(event) => afterTouch(event, ui.clearTouch)}>取消</button>
            <button className="btn primary" onClick={ui.confirmTouch} onPointerUp={(event) => afterTouch(event, ui.confirmTouch)}>确认落子</button>
          </div>}
          <button type="button" className="btn board-tool" disabled={!humanTurn || snap.hintLevel >= 3}
            onClick={() => ui.hint()}>
            {snap.hintLevel === 0 ? '提示' : snap.hintLevel === 1 ? '看候选' : snap.hintLevel === 2 ? '看答案' : '已提示'}
          </button>
          <button type="button" className="btn board-tool" aria-pressed={snap.overhead} onClick={() => ui.toggleOverhead()}>
            {snap.overhead ? '3D 视角' : '俯视'}
          </button>
          <button
            type="button"
            className="btn view-reset"
            onClick={() => ui.resetView()}
            onPointerUp={(event) => {
              // Touch browsers can suppress the click immediately following a drag.
              afterTouch(event, ui.resetView)
            }}
          >
            复位视角
          </button>
        </div>
      )}

      {/* 标题界面 */}
      {phase === 'title' && snap && (
        <div className="panel title-panel">
          <h1 className="game-title">五子棋对决</h1>
          <nav className="lobby-tabs" aria-label="大厅">
            {LOBBY_TABS.map(([id, label]) => (
              <button key={id} type="button" className="btn" aria-pressed={tab === id} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </nav>
          {tab === 'training' && <TrainingMenu snap={snap} />}
          {tab === 'replays' && <ReplayLibrary snap={snap} />}
          {tab === 'stats' && <ColorStats snap={snap} labels={LEVELS} />}
          {tab === 'settings' && <GameSettings snap={snap} skins={<SkinPicker selected={snap.skin} />} />}
          {tab === 'play' && <>
          <div className="side-setting" role="group" aria-label="执子颜色">
            <span className="side-rule">黑棋先行</span>
            <div className="side-options">
              <button type="button" className="side-btn black-turn"
                aria-pressed={snap.playerColor === BLACK} onClick={() => ui.setPlayerColor(BLACK)}>
                <span className="stone-dot" aria-hidden="true" />执黑
              </button>
              <button type="button" className="side-btn white-turn"
                aria-pressed={snap.playerColor === WHITE} onClick={() => ui.setPlayerColor(WHITE)}>
                <span className="stone-dot" aria-hidden="true" />执白
              </button>
            </div>
          </div>

          <fieldset className="settings-group">
            <legend>人机难度</legend>
            <div className="diff-grid">
              {DIFFICULTIES.map((level, i) => (
                <button
                  key={level}
                  type="button"
                  aria-pressed={snap.difficulty === level}
                  className="diff-btn"
                  onClick={() => ui.setDifficulty(level)}
                >
                  <span className="level-number" aria-hidden="true">{i + 1}</span>
                  {level === 'hard' && snap.rule === 'double-three' ? '大师' : LEVELS[level].label}
                </button>
              ))}
            </div>
            <p className="level-description" aria-live="polite">
              {snap.difficulty === 'hard' && snap.preferences.masterMode !== 'standard' ?
                (snap.preferences.masterMode === 'arena' ? '擂台已开启。复杂局面会多算变化和防守。' : '深算已开启。常见开局会重新计算。') :
                snap.rule === 'double-three' && (snap.difficulty === 'expert' || snap.difficulty === 'hard')
                ? '本地后台搜索会排除黑棋禁手。'
                : LEVELS[snap.difficulty].description}
            </p>
          </fieldset>

          <fieldset className="settings-group">
            <legend>AI 棋风</legend>
            <div className="skin-choices">
              {STYLES.map((style) => (
                <button key={style} type="button" className="side-btn" aria-pressed={snap.style === style}
                  onClick={() => ui.setStyle(style)}>{STYLE_LABEL[style]}</button>
              ))}
            </div>
          </fieldset>

          <SkinPicker selected={snap.skin} />
          <div className="game-options" role="group" aria-label="对局规则">
            <button className="btn quick-switch" aria-pressed={snap.rule === 'double-three'}
              onClick={() => ui.setRule(snap.rule === 'double-three' ? 'freestyle' : 'double-three')}>
              黑棋禁双三
            </button>
            <button className="btn quick-switch" aria-pressed={snap.quick} onClick={() => ui.setQuick(!snap.quick)}>
              {snap.quick ? '快棋 5+3 已开启' : '开启快棋 5+3'}
            </button>
          </div>
          {snap.rule === 'double-three' && <p className="level-description">黑棋一手同时形成两条活三时须换点，成五优先。</p>}

          {snap.canResume && <button className="btn" onClick={() => ui.resume()}>继续上次对局</button>}
          <div className="lobby-start">
            <button className="btn primary big" onClick={() => ui.start()}>
              开始对局<span className="keyboard-hints">（空格）</span>
            </button>
            <button className="btn" onClick={() => ui.startLocal()}>本地双人</button>
          </div>

          <div className="score-row">
            <span>你 {snap.scores.player}</span>
            <span>平局 {snap.scores.draw}</span>
            <span>AI {snap.scores.ai}</span>
          </div>
          <p className="fineprint">战绩仅保存在本浏览器</p>
          </>}
        </div>
      )}

      {phase === 'editor' && snap && (
        <>
          <div className="topbar">
            <div className="turn-chip">自定义摆棋</div>
            <div className="topbar-actions">
              <button className="btn" onClick={() => ui.clearEditor()}>清空棋盘</button>
              <button className="btn" onClick={() => ui.backToTitle()}>返回大厅</button>
            </div>
          </div>
          <div className="editor-controls replay-controls">
            {snap.editor.error && <p role="alert">{snap.editor.error}</p>}
            <div className="editor-controls-row" role="group" aria-label="摆棋工具">
              {([[BLACK, '放黑棋'], [WHITE, '放白棋'], [EMPTY, '擦除']] as const).map(([tool, label]) =>
                <button className="btn quick-switch" key={tool} aria-pressed={snap.editor.tool === tool}
                  onClick={() => ui.setEditorTool(tool)}>{label}</button>)}
            </div>
            <div className="editor-controls-row" role="group" aria-label="下一手">
              <button className="btn quick-switch" aria-pressed={snap.editor.turn === BLACK} onClick={() => ui.setEditorTurn(BLACK)}>黑先走</button>
              <button className="btn quick-switch" aria-pressed={snap.editor.turn === WHITE} onClick={() => ui.setEditorTurn(WHITE)}>白先走</button>
              <button className="btn primary" onClick={() => ui.playEditor()}>从这里开局</button>
            </div>
          </div>
        </>
      )}

      {/* 暂停界面 */}
      {phase === 'paused' && snap && (
        <div className="panel pause-panel">
          {pauseSettings ? <GameSettings snap={snap} skins={<SkinPicker selected={snap.skin} />} onClose={() => setPauseSettings(false)} /> : <>
          <h2>已暂停</h2>
          <SkinPicker selected={snap.skin} />
          <button className="btn" onClick={() => setPauseSettings(true)}>设置</button>
          <button className="btn primary" onClick={() => ui.togglePause()}>
            继续（Esc）
          </button>
          <button className="btn" onClick={() => ui.restart()}>
            重新开始
          </button>
          <button className="btn" onClick={() => ui.backToTitle()}>
            返回标题
          </button>
          </>}
        </div>
      )}

      {/* 终局界面 */}
      {phase === 'over' && snap && (
        <div className="panel">
          <h2 className={snap.draw || snap.mode === 'local' ? undefined :
            (snap.puzzle ? snap.puzzle.result === 'solved' : playerWon) ? 'win-text' : 'lose-text'}>
            {snap.puzzle ? snap.puzzle.result === 'solved' ? '解题成功' : '再想一想' :
              snap.draw ? '平局' : snap.mode === 'local' ? `${shownColorName}棋获胜` :
                playerWon ? '你赢了！' : 'AI 获胜'}
          </h2>
          {snap.timeout && <p className="subtitle">{shownColor === BLACK ? '白' : '黑'}棋超时</p>}
          {snap.noLegalMove && <p className="subtitle">黑棋无合法落点</p>}
          {snap.puzzle && <p className="subtitle">{snap.puzzle.title}</p>}
          {snap.daily && <p className="subtitle">本次 {snap.daily.played} 手 · 参考 {snap.daily.target} 手
            {snap.daily.best !== null && ` · 今日最佳 ${snap.daily.best} 手`}</p>}
          {snap.challenge && <p className="subtitle">
            {snap.challenge.total === null
              ? `第 1 局得 ${snap.challenge.result} 分，第二局换执白棋。`
              : `两局合计 你 ${snap.challenge.total} : ${2 - snap.challenge.total} AI`}
          </p>}
          {snap.mode === 'solo' && <p className="subtitle">
            {snap.draw ? '棋盘已满，不分胜负' : playerWon ? '漂亮的五连珠' : '再接再厉，下一盘翻盘'}
          </p>}
          {(snap.moveCount > 0 || snap.custom) && <button className="btn" onClick={() => ui.openReplay()}>复盘本局</button>}
          {snap.canTrainLoss && <button className="btn" onClick={() => ui.trainLoss()}>把这盘变成练习</button>}
          {snap.handicap && playerWon && snap.handicap.index < HANDICAPS.length - 1 &&
            <button className="btn" onClick={() => ui.startHandicap(snap.handicap!.index + 1)}>
              下一关 · {HANDICAPS[snap.handicap.index + 1].title}
            </button>}
          {snap.challenge?.round === 1 &&
            <button className="btn primary" onClick={() => ui.nextChallenge()}>换执白棋 · 第二局</button>}
          <button className="btn primary" onClick={() => ui.restart()}>
            {snap.puzzle ? '再试一次' : '再来一局'}<span className="keyboard-hints">（空格）</span>
          </button>
          <button className="btn" onClick={() => ui.backToTitle()}>
            返回标题
          </button>
          {snap.mode === 'solo' && <div className="score-row">
            <span>你 {snap.scores.player}</span>
            <span>平局 {snap.scores.draw}</span>
            <span>AI {snap.scores.ai}</span>
          </div>}
        </div>
      )}

      {phase === 'replay' && snap && replayPly !== null && (
        <>
          <div className="topbar">
            <div className="turn-chip">棋谱回放</div>
            <div className="topbar-actions">
              <button className="btn" disabled={!snap.canBranch} onClick={() => ui.branchReplay()}>从这手重下</button>
              <button className="btn" onClick={() => downloadReplay(ui.replayData())}>导出棋谱</button>
              <button className="btn" onClick={() => ui.closeReplay()}>{snap.replayFromLibrary ? '返回大厅' : '返回结果'}</button>
            </div>
          </div>
          <div className="replay-controls">
            <div className="replay-tools">
              <button className="btn" aria-pressed={!!snap.comparison} onClick={() => ui.compareReplay()}>
                {snap.comparison ? '回到原规则' : `对照${snap.rule === 'freestyle' ? '禁双三' : '自由规则'}`}
              </button>
              {snap.preferences.exactEndgame && <button className="btn" disabled={snap.analysis === 'working'} onClick={() => ui.analyzeReplay()}>残局精算</button>}
            </div>
            {snap.comparison && <p className="replay-note" role="status">
              {snap.comparison.move && snap.comparison.forbiddenPly !== null
                ? `禁双三下第 ${snap.comparison.forbiddenPly + 1} 手黑棋 ${coordinates(snap.comparison.move)} 违规。回到这一手前可换点重下。`
                : `这份棋谱的落子符合${snap.comparison.rule === 'double-three' ? '禁双三' : '自由五子棋'}规则。`}
            </p>}
            {snap.analysis && <p className="replay-note" role="status">{analysisText(snap.analysis)}</p>}
            {snap.lesson && <>
              <p className="replay-note">{snap.lesson.tactical ? '这里可以尝试挡住 AI 的强杀，或换边把杀棋下出来。' :
                '从最后一次防守重试，或换边练习最后的成五。'}</p>
              <div className="replay-tools">
                <button className="btn" onClick={() => ui.playLesson(false)}>练习防守</button>
                <button className="btn primary" onClick={() => ui.playLesson(true)}>换边练杀</button>
              </div>
            </>}
            <input
              type="range"
              aria-label="回放进度"
              aria-valuetext={`第 ${replayPly} 手，共 ${snap.moveCount} 手`}
              min={0}
              max={snap.moveCount}
              value={replayPly}
              onChange={(event) => ui.seekReplay(event.currentTarget.valueAsNumber)}
            />
            <div className="replay-actions">
              <button className="btn" disabled={replayPly === 0} onClick={() => ui.seekReplay(replayPly - 1)}>
                上一步
              </button>
              <div className="replay-position" aria-live="polite">
                <span>第 {replayPly} / {snap.moveCount} 手</span>
                <span>
                  {snap.lastMove
                    ? `${snap.lastMove.player === BLACK ? '黑' : '白'}棋 ${String.fromCharCode(65 + snap.lastMove.c)}${snap.lastMove.r + 1}`
                    : snap.custom ? '初始局面' : '空棋盘'}
                </span>
              </div>
              <button className="btn" disabled={replayPly === snap.moveCount} onClick={() => ui.seekReplay(replayPly + 1)}>
                下一步
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
