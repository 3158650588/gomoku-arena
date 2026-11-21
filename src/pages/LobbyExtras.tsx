import { useState } from 'react'
import { ui } from '@/game/boot'
import type { Snapshot } from '@/game/boot'
import { DIFFICULTIES, type Difficulty } from '@/game/gomoku/ai'
import { BLACK, WHITE } from '@/game/gomoku/logic'
import { HANDICAPS, OPENINGS, PUZZLES, exportReplay, importReplay, readPosition } from '@/game/gomoku/match'
import type { SavedMatch, Score } from '@/game/gomoku/match'

export function downloadReplay(match: SavedMatch | null) {
  if (!match || (!match.moves.length && !match.setup.initial?.stones.length)) return
  const url = URL.createObjectURL(new Blob([exportReplay(match)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = '五子棋棋谱.json'
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function TrainingMenu({ snap }: { snap: Snapshot }) {
  const recentLoss = snap.records.find(({ match, winner }) => winner !== 0 && winner !== match.setup.playerColor &&
    match.setup.mode !== 'local' && match.setup.mode !== 'puzzle' &&
    match.moves.some((move, ply) => ply >= match.lockedPly && move.player === match.setup.playerColor) &&
    readPosition(match.moves, match.setup.initial, match.setup.rule)?.winner === winner)
  return (
    <>
      {snap.daily && <section className="lobby-section" aria-label="每日一题">
        <h2>每日一题 <span>{snap.daily.day}</span></h2>
        <p>{snap.daily.best === null ? `今天执${snap.daily.player === BLACK ? '黑' : '白'}，目标在 ${snap.daily.target} 手内取胜。` :
          `今日最佳 ${snap.daily.best} 手，参考 ${snap.daily.target} 手。`}</p>
        <button className="btn primary" onClick={() => ui.startDaily()}>挑战今日残局</button>
      </section>}
      <section className="lobby-section" aria-label="让子挑战">
        <h2>让子挑战</h2>
        <p>用你选的棋色带着优势开局。赢了就挑战下一档。</p>
        <div className="opening-options">
          {HANDICAPS.map(({ id, title }, i) => (
            <button className="btn" key={id} disabled={i > snap.handicapUnlocked} onClick={() => ui.startHandicap(i)}>{title}</button>
          ))}
        </div>
      </section>
      {recentLoss && <section className="lobby-section" aria-label="败局练习">
        <h2>败局练习</h2>
        <button className="btn" onClick={() => ui.trainLoss(recentLoss.match)}>练习最近一盘败局</button>
      </section>}
      <section className="lobby-section" aria-label="自定义摆棋">
        <h2>自定义摆棋</h2>
        <p>摆好黑白棋，再选哪方先走。AI 执你在开局页选择颜色的另一方。</p>
        <button className="btn" onClick={() => ui.openEditor()}>开始摆棋</button>
      </section>
      <section className="lobby-section" aria-label="换色挑战">
        <h2>换色挑战</h2>
        <p>同一组开局先执黑、再执白，两局合计得分。</p>
        {snap.pendingChallenge && <button className="btn primary" onClick={() => ui.nextChallenge()}>继续挑战 · 第二局</button>}
        <div className="opening-options">
          {OPENINGS.map(({ id, title }) => (
            <button type="button" key={id} className="btn" onClick={() => ui.startChallenge(id)}>{title}</button>
          ))}
        </div>
      </section>
      <section className="lobby-section" aria-label="残局闯关">
        <h2>残局闯关 <span>{snap.solvedPuzzles.length} / {PUZZLES.length}</span></h2>
        <ul className="lobby-list">
          {PUZZLES.map((puzzle) => (
            <li key={puzzle.id}>
              <button className="lobby-entry" onClick={() => ui.startPuzzle(puzzle.id)}>
                <span>{puzzle.title}<small>{puzzle.prompt}</small></span>
                {snap.solvedPuzzles.includes(puzzle.id) && <em>已解</em>}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}

export function ReplayLibrary({ snap }: { snap: Snapshot }) {
  const [error, setError] = useState('')
  const loadFile = async (file: File) => {
    try {
      const match = file.size <= 48_000 ? importReplay(await file.text()) : null
      if (!match) {
        setError('这份文件的棋谱格式或落子顺序有误。')
        return
      }
      setError('')
      ui.loadReplay(match)
    } catch {
      setError('读取文件失败，请重新选择棋谱。')
    }
  }
  const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })

  return (
    <section className="lobby-section" aria-label="棋谱">
      <h2>棋谱</h2>
      <label className="file-picker">
        导入棋谱
        <input type="file" accept=".json,application/json" onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file) void loadFile(file)
        }} />
      </label>
      {error && <p role="alert">{error}</p>}
      {snap.records.length === 0 && <p>打完一局后，棋谱会保存在这里。</p>}
      <ul className="lobby-list">
        {snap.records.map((record) => (
          <li key={record.id} className="library-row">
            <button className="lobby-entry" onClick={() => ui.loadReplay(record.match)}>
              <span>{record.winner ? `${record.winner === BLACK ? '黑' : '白'}棋胜` : '对局记录'} · {record.match.moves.length} 手
                <small>{date.format(record.timestamp)}</small>
              </span>
            </button>
            <button type="button" className="btn" onClick={() => downloadReplay(record.match)}>导出</button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function scoreText(score: Score | undefined) {
  return score ? `${score.player} 胜 ${score.ai} 负 ${score.draw} 平` : '—'
}

export function ColorStats({ snap, labels }: { snap: Snapshot; labels: Record<Difficulty, { label: string }> }) {
  return (
    <section className="lobby-section" aria-label="人机战绩">
      <h2>人机战绩</h2>
      <p>累计 {scoreText(snap.scores)}。分色统计从本版开始记录普通人机对局。</p>
      <table className="color-stats">
        <thead><tr><th scope="col">难度</th><th scope="col">执黑</th><th scope="col">执白</th></tr></thead>
        <tbody>
          {DIFFICULTIES.map((tier) => (
            <tr key={tier}>
              <th scope="row">{labels[tier].label}</th>
              <td>{scoreText(snap.breakdown[`${tier}:${BLACK}`])}</td>
              <td>{scoreText(snap.breakdown[`${tier}:${WHITE}`])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
