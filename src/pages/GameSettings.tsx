import { useState, type CSSProperties, type ReactNode } from 'react'
import { ui, type Snapshot } from '@/game/boot'
import { SKINS } from '@/game/gomoku/skins'
import { MASTER_MODES } from '@/game/gomoku/master-profile'

const MODE_LABEL = { standard: '标准', deep: '深算', arena: '擂台' }
const MODE_DESCRIPTION = {
  standard: '根据局面分配用时。自由规则最多约 3.5 秒，禁双三或摆棋约 2.2 秒。',
  deep: '重新计算常见开局。复杂局面自由规则最多约 6 秒，禁双三或摆棋约 4.2 秒。',
  arena: 'Windows 电脑试玩包可调用本机多线程引擎。复杂局面自由规则最多约 12 秒，禁双三或摆棋约 9 秒。',
}

export function GameSettings({ snap, skins, onClose }: { snap: Snapshot; skins: ReactNode; onClose?: () => void }) {
  const { touchConfirm, tacticalReview, exactEndgame, masterMode } = snap.preferences
  const [preview, setPreview] = useState<number | null>(null)
  const [placed, setPlaced] = useState<number | null>(null)
  const skin = SKINS[snap.skin]

  const selectMode = (confirm: boolean) => {
    ui.setPreference('touchConfirm', confirm)
    setPreview(null)
    setPlaced(null)
  }

  const demoTap = (cell: number) => {
    if (touchConfirm && preview !== cell) {
      setPlaced(null)
      setPreview(cell)
    } else {
      setPlaced(cell)
      setPreview(null)
    }
  }

  return (
    <section className="game-settings" aria-label="游戏设置">
      <div className="settings-heading">
        <h2>设置</h2>
        {onClose && <button type="button" className="btn" onClick={onClose}>返回暂停</button>}
      </div>
      <fieldset className="settings-group">
        <legend>手机落子方式</legend>
        <div className="game-options">
          <button type="button" className="btn quick-switch" aria-pressed={!touchConfirm} onClick={() => selectMode(false)}>轻点直接下</button>
          <button type="button" className="btn quick-switch" aria-pressed={touchConfirm} onClick={() => selectMode(true)}>先预览、再确认</button>
        </div>
      </fieldset>
      <div className="touch-practice">
        <div className="touch-practice-board" role="group" aria-label="试落子棋盘" style={{
          '--practice-board': skin.board,
          '--practice-grid': skin.grid,
        } as CSSProperties}>
          {Array.from({ length: 9 }, (_, cell) => (
            <button key={cell} type="button" className="practice-intersection"
              aria-label={`试落子 ${String.fromCharCode(65 + cell % 3)}${Math.floor(cell / 3) + 1}`}
              disabled={cell === 4 || cell === 5}
              data-stone={cell === 5 ? 'white' : cell === 4 || cell === placed ? 'black' : cell === preview ? 'preview' : undefined}
              onClick={() => demoTap(cell)}
            />
          ))}
        </div>
        <div className="touch-practice-copy">
          <strong>在小棋盘上试一下</strong>
          <p role="status">
            {preview !== null ? '这颗是预览棋。再点同一处就能落下。' : placed !== null ? '已落子，可以再试一个交叉点。' :
              touchConfirm ? '轻点空位先预览。实战里可以拖动预览棋微调。' : '轻点一个空位，棋子会直接落下。'}
          </p>
        </div>
      </div>
      <fieldset className="settings-group preferences-checks">
        <legend>棋力与分析</legend>
        <div className="skin-choices" role="group" aria-label="大师思考用时">
          {MASTER_MODES.map((mode) => (
            <button key={mode} type="button" className="side-btn" aria-pressed={masterMode === mode} onClick={() => ui.setMasterMode(mode)}>
              {MODE_LABEL[mode]}
            </button>
          ))}
        </div>
        <p className="level-description">{MODE_DESCRIPTION[masterMode]}</p>
        <label className="preference-check">
          <span><strong>大师落子复核</strong><small>复杂局面比较候选，检查活三、冲四和对手的反击。</small></span>
          <input type="checkbox" checked={tacticalReview} onChange={(event) => ui.setPreference('tacticalReview', event.currentTarget.checked)} />
        </label>
        <label className="preference-check">
          <span><strong>残局精算</strong><small>剩 10 个空位以内时，大师档和棋谱可尝试穷举。</small></span>
          <input type="checkbox" checked={exactEndgame} onChange={(event) => ui.setPreference('exactEndgame', event.currentTarget.checked)} />
        </label>
      </fieldset>
      {skins}
    </section>
  )
}
