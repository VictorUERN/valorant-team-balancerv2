import { useEffect, useMemo, useRef, useState } from 'react'

const STORAGE_KEY = 'valorant-team-balancer:v1'
const TOTAL_PLAYERS = 10
const TEAM_SIZE = 5
const MIN_SKILL = 1
const MAX_SKILL = 5
const MAX_NAME = 20
const POOL_SIZE = 7

// Todos os mapas padrão do jogo. O pool competitivo muda a cada Ato,
// por isso o pool ativo pode ser ajustado na tela.
const ALL_MAPS = [
  'Abyss', 'Ascent', 'Bind', 'Breeze', 'Corrode', 'Fracture', 'Haven',
  'Icebox', 'Lotus', 'Pearl', 'Split', 'Summit', 'Sunset'
]
// Pool competitivo do patch 13.08 (13/10/2026)
const DEFAULT_POOL = ['Abyss', 'Bind', 'Corrode', 'Haven', 'Lotus', 'Summit', 'Sunset']

const FORMATS = {
  bo1: { label: 'Melhor de 1', short: 'MD1' },
  bo3: { label: 'Melhor de 3', short: 'MD3' },
  bo5: { label: 'Melhor de 5', short: 'MD5' }
}
const SIDES = { attack: 'Ataque', defense: 'Defesa' }
const otherTeam = (t) => (t === 'A' ? 'B' : 'A')

const SKILLS = {
  1: 'Muito iniciante',
  2: 'Iniciante',
  3: 'Intermediário',
  4: 'Avançado',
  5: 'Muito avançado'
}

/* ------------------------------------------------------------------ */
/* Algoritmo                                                           */
/* ------------------------------------------------------------------ */

// Gera todas as combinações de k elementos entre os índices 0..n-1.
function combinations(n, k) {
  const out = []
  const current = []
  const walk = (start) => {
    if (current.length === k) {
      out.push([...current])
      return
    }
    for (let i = start; i < n; i += 1) {
      current.push(i)
      walk(i + 1)
      current.pop()
    }
  }
  walk(0)
  return out
}

const sum = (list) => list.reduce((acc, p) => acc + p.skill, 0)

// Avalia as 70 distribuições dos 8 jogadores restantes (4 para cada time).
// O capitão A fica sempre no Time A e o capitão B sempre no Time B.
function evaluateAll(players, captainAId, captainBId) {
  const capA = players.find((p) => p.id === captainAId)
  const capB = players.find((p) => p.id === captainBId)
  if (!capA || !capB || capA.id === capB.id) {
    throw new Error('Selecione dois capitães diferentes.')
  }
  const rest = players.filter((p) => p.id !== capA.id && p.id !== capB.id)
  if (rest.length !== TOTAL_PLAYERS - 2) {
    throw new Error('São necessários exatamente 10 jogadores.')
  }

  const combos = combinations(rest.length, TEAM_SIZE - 1)
  if (combos.length !== 70) throw new Error('Falha ao gerar as 70 combinações.')

  return combos.map((indexes) => {
    const chosen = new Set(indexes)
    const teamA = [capA, ...indexes.map((i) => rest[i])]
    const teamB = [capB, ...rest.filter((_, i) => !chosen.has(i))]
    const totalA = sum(teamA)
    const totalB = sum(teamB)
    const avgA = totalA / TEAM_SIZE
    const avgB = totalB / TEAM_SIZE
    return {
      teamA: teamA.map((p) => p.id),
      teamB: teamB.map((p) => p.id),
      totalA,
      totalB,
      avgA,
      avgB,
      diff: Math.abs(avgA - avgB)
    }
  })
}

// Escolhe a melhor combinação (menor diferença entre as médias).
// Em caso de empate, sorteia entre as melhores e evita repetir a atual.
function findBest(players, captainAId, captainBId, avoidKey = null) {
  const all = evaluateAll(players, captainAId, captainBId)
  const minDiff = Math.min(...all.map((c) => c.diff))
  const best = all.filter((c) => c.diff - minDiff < 1e-9)
  const keyOf = (c) => [...c.teamA].sort().join('|')
  let pool = best
  if (avoidKey && best.length > 1) {
    const others = best.filter((c) => keyOf(c) !== avoidKey)
    if (others.length) pool = others
  }
  const pick = pool[Math.floor(Math.random() * pool.length)]
  return {
    teamA: pick.teamA,
    teamB: pick.teamB,
    evaluated: all.length,
    tied: best.length,
    key: keyOf(pick)
  }
}

/* ------------------------------------------------------------------ */
/* Veto de mapas (picks e bans)                                        */
/* ------------------------------------------------------------------ */

const defaultVeto = () => ({ format: 'bo3', first: 'A', pool: [...DEFAULT_POOL], actions: [] })

// Sequência competitiva com 7 mapas:
// MD1: 6 bans alternados, sobra o decisivo.
// MD3: ban, ban, pick, pick, ban, ban, sobra o decisivo.
// MD5: ban, ban, pick, pick, pick, pick, sobra o decisivo.
// Quem NÃO escolheu o mapa escolhe o lado. No decisivo, o lado é escolhido
// pelo time que não começou o veto.
function buildSteps(format, first) {
  const second = otherTeam(first)
  const steps = []
  const ban = (team) => steps.push({ kind: 'ban', team })
  const pick = (team) => {
    steps.push({ kind: 'pick', team })
    steps.push({ kind: 'side', team: otherTeam(team) })
  }
  if (format === 'bo1') {
    for (let i = 0; i < 6; i += 1) ban(i % 2 === 0 ? first : second)
  } else if (format === 'bo3') {
    ban(first); ban(second); pick(first); pick(second); ban(first); ban(second)
  } else {
    ban(first); ban(second); pick(first); pick(second); pick(first); pick(second)
  }
  steps.push({ kind: 'decider' })
  steps.push({ kind: 'side', team: second })
  return steps
}

function isValidVeto(v) {
  try {
    if (!v || !FORMATS[v.format] || (v.first !== 'A' && v.first !== 'B')) return false
    if (!Array.isArray(v.pool) || v.pool.length !== POOL_SIZE) return false
    if (new Set(v.pool).size !== POOL_SIZE || !v.pool.every((m) => ALL_MAPS.includes(m))) return false
    if (!Array.isArray(v.actions)) return false
    const steps = buildSteps(v.format, v.first)
    if (v.actions.length > steps.length) return false
    const remaining = new Set(v.pool)
    for (let i = 0; i < v.actions.length; i += 1) {
      const step = steps[i]
      const a = v.actions[i]
      if (!a || typeof a !== 'object') return false
      if (step.kind === 'side') {
        if (a.side !== 'attack' && a.side !== 'defense') return false
      } else if (step.kind === 'decider') {
        if (remaining.size !== 1 || !remaining.has(a.map)) return false
        remaining.delete(a.map)
      } else {
        if (!remaining.has(a.map)) return false
        remaining.delete(a.map)
      }
    }
    return true
  } catch (e) {
    return false
  }
}

function seriesOf(v) {
  const steps = buildSteps(v.format, v.first)
  const out = []
  steps.forEach((s, i) => {
    if (s.kind !== 'pick' && s.kind !== 'decider') return
    const a = v.actions[i]
    if (!a || !a.map) return
    const sideAction = v.actions[i + 1]
    out.push({
      n: out.length + 1,
      map: a.map,
      kind: s.kind,
      team: s.team || null,
      sideTeam: steps[i + 1].team,
      side: sideAction && sideAction.side ? sideAction.side : null
    })
  })
  return out
}

function sideText(item) {
  if (!item.side) return 'lado pendente'
  const opposite = item.side === 'attack' ? 'defense' : 'attack'
  return `Time ${item.sideTeam}: ${SIDES[item.side]} · Time ${otherTeam(item.sideTeam)}: ${SIDES[opposite]}`
}

function vetoText(v) {
  if (!v.actions.length) return ''
  const steps = buildSteps(v.format, v.first)
  const lines = [`MAPAS — ${FORMATS[v.format].label}`]
  const bans = []
  steps.forEach((s, i) => {
    const a = v.actions[i]
    if (a && s.kind === 'ban') bans.push(`Time ${s.team} baniu ${a.map}`)
  })
  if (bans.length) lines.push(...bans)
  seriesOf(v).forEach((m) => {
    const origin = m.kind === 'decider' ? 'decisivo' : `pick do Time ${m.team}`
    lines.push(`Mapa ${m.n}: ${m.map} (${origin}) — ${sideText(m)}`)
  })
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* Persistência                                                        */
/* ------------------------------------------------------------------ */

const isValidSkill = (n) => Number.isInteger(n) && n >= MIN_SKILL && n <= MAX_SKILL

function loadState() {
  const empty = { players: [], captainA: '', captainB: '', result: null, veto: defaultVeto() }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return empty
    const data = JSON.parse(raw)
    if (!data || !Array.isArray(data.players)) return empty

    const seen = new Set()
    const players = []
    for (const p of data.players) {
      if (
        p &&
        typeof p.id === 'string' &&
        typeof p.name === 'string' &&
        p.name.trim() &&
        isValidSkill(p.skill) &&
        !seen.has(p.id) &&
        players.length < TOTAL_PLAYERS
      ) {
        seen.add(p.id)
        players.push({ id: p.id, name: p.name.trim().slice(0, MAX_NAME), skill: p.skill })
      }
    }

    const ids = new Set(players.map((p) => p.id))
    let captainA = ids.has(data.captainA) ? data.captainA : ''
    let captainB = ids.has(data.captainB) ? data.captainB : ''
    if (captainA && captainA === captainB) captainB = ''

    let result = null
    const r = data.result
    if (
      r &&
      players.length === TOTAL_PLAYERS &&
      Array.isArray(r.teamA) &&
      Array.isArray(r.teamB) &&
      r.teamA.length === TEAM_SIZE &&
      r.teamB.length === TEAM_SIZE &&
      r.teamA.includes(captainA) &&
      r.teamB.includes(captainB) &&
      new Set([...r.teamA, ...r.teamB]).size === TOTAL_PLAYERS &&
      [...r.teamA, ...r.teamB].every((id) => ids.has(id))
    ) {
      result = {
        teamA: r.teamA,
        teamB: r.teamB,
        evaluated: Number(r.evaluated) || 70,
        tied: Number(r.tied) || 1,
        key: [...r.teamA].sort().join('|')
      }
    }
    const veto = isValidVeto(data.veto) ? data.veto : defaultVeto()
    return { players, captainA, captainB, result, veto }
  } catch (e) {
    return empty
  }
}

const newId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/* ------------------------------------------------------------------ */
/* Utilidades de exibição                                              */
/* ------------------------------------------------------------------ */

const fmt = (n) => n.toFixed(2).replace('.', ',')

function balanceLevel(diff) {
  if (diff < 0.001) return { label: 'Equilíbrio perfeito', tone: 'perfect' }
  if (diff <= 0.25) return { label: 'Muito equilibrado', tone: 'great' }
  if (diff <= 0.5) return { label: 'Equilibrado', tone: 'good' }
  if (diff <= 1) return { label: 'Pouco equilibrado', tone: 'warn' }
  return { label: 'Desequilibrado', tone: 'bad' }
}

async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(area)
  if (!ok) throw new Error('copy-failed')
}

/* ------------------------------------------------------------------ */
/* Componentes                                                         */
/* ------------------------------------------------------------------ */

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 64 64" aria-hidden="true">
      <path d="M4 10h14l14 30 14-30h14L38 56H26z" fill="currentColor" />
      <path d="M26 56 4 10h14l16 34z" fill="#08090a" opacity=".35" />
    </svg>
  )
}

function SkillPicker({ value, onChange, label }) {
  return (
    <div className="skill-picker" role="group" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={`skill-btn ${value === n ? 'is-on' : ''}`}
          aria-pressed={value === n}
          title={`${n} — ${SKILLS[n]}`}
          onClick={() => onChange(n)}
        >
          {n}
        </button>
      ))}
    </div>
  )
}

function TeamCard({ title, tone, ids, captainId, players, delay }) {
  const members = ids
    .map((id) => players.find((p) => p.id === id))
    .filter(Boolean)
    .sort((a, b) => (a.id === captainId ? -1 : b.id === captainId ? 1 : b.skill - a.skill))
  const total = sum(members)
  const avg = total / TEAM_SIZE

  return (
    <article className={`team team-${tone}`} style={{ animationDelay: `${delay}ms` }}>
      <header className="team-head">
        <h3>{title}</h3>
        <span className="team-count">{members.length} jogadores</span>
      </header>

      <ul className="roster">
        {members.map((p) => (
          <li key={p.id} className={p.id === captainId ? 'is-captain' : ''}>
            <span className="roster-name">
              {p.id === captainId && (
                <span className="cap-badge" title="Capitão">
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="m10 1 2.6 5.6 6 .7-4.5 4.1 1.2 6L10 14.4 4.7 17.4l1.2-6L1.4 7.3l6-.7z" fill="currentColor" />
                  </svg>
                  Capitão
                </span>
              )}
              {p.name}
            </span>
            <span className="roster-skill" title={SKILLS[p.skill]}>
              <span className="pips" aria-hidden="true">
                {[1, 2, 3, 4, 5].map((n) => (
                  <i key={n} className={n <= p.skill ? 'on' : ''} />
                ))}
              </span>
              <b>{p.skill}</b>
            </span>
          </li>
        ))}
      </ul>

      <footer className="team-stats">
        <div>
          <span>Pontuação total</span>
          <strong>{total}</strong>
        </div>
        <div>
          <span>Média de habilidade</span>
          <strong>{fmt(avg)}</strong>
        </div>
      </footer>
    </article>
  )
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

function VetoPanel({ veto, setVeto, label }) {
  const steps = useMemo(() => buildSteps(veto.format, veto.first), [veto.format, veto.first])
  const done = veto.actions.length
  const step = steps[done] || null
  const poolOk = veto.pool.length === POOL_SIZE
  const started = done > 0
  const finished = done >= steps.length

  const used = new Map()
  steps.forEach((s, i) => {
    const a = veto.actions[i]
    if (a && a.map) used.set(a.map, { kind: s.kind, team: s.team })
  })
  const series = seriesOf(veto)

  const chooseMap = (map) => {
    setVeto((v) => {
      const st = buildSteps(v.format, v.first)
      const cur = st[v.actions.length]
      if (!cur || (cur.kind !== 'ban' && cur.kind !== 'pick')) return v
      const remaining = v.pool.filter((m) => !v.actions.some((a) => a.map === m))
      if (!remaining.includes(map)) return v
      const actions = [...v.actions, { map }]
      const next = st[actions.length]
      if (next && next.kind === 'decider') {
        const left = remaining.filter((m) => m !== map)
        if (left.length === 1) actions.push({ map: left[0], auto: true })
      }
      return { ...v, actions }
    })
  }

  const chooseSide = (side) => {
    setVeto((v) => {
      const st = buildSteps(v.format, v.first)
      const cur = st[v.actions.length]
      if (!cur || cur.kind !== 'side') return v
      return { ...v, actions: [...v.actions, { side }] }
    })
  }

  const undo = () =>
    setVeto((v) => {
      const actions = v.actions.slice(0, -1)
      while (actions.length && actions[actions.length - 1].auto) actions.pop()
      return { ...v, actions }
    })

  const restart = () => setVeto((v) => ({ ...v, actions: [] }))
  const setFormat = (format) => setVeto((v) => ({ ...v, format, actions: [] }))
  const setFirst = (first) => setVeto((v) => (v.actions.length ? v : { ...v, first }))
  const flip = () =>
    setVeto((v) => (v.actions.length ? v : { ...v, first: Math.random() < 0.5 ? 'A' : 'B' }))
  const togglePool = (map) =>
    setVeto((v) => {
      if (v.actions.length) return v
      const pool = v.pool.includes(map) ? v.pool.filter((m) => m !== map) : [...v.pool, map]
      return { ...v, pool }
    })

  const stepText = (s) => {
    if (s.kind === 'ban') return `${label(s.team)} bane`
    if (s.kind === 'pick') return `${label(s.team)} escolhe o mapa`
    if (s.kind === 'side') return `${label(s.team)} escolhe o lado`
    return 'Mapa decisivo (o que sobrar)'
  }

  let banner = null
  if (!poolOk) {
    banner = `Selecione exatamente ${POOL_SIZE} mapas no pool (${veto.pool.length}/${POOL_SIZE}).`
  } else if (finished) {
    banner = 'Veto concluído. Boa partida!'
  } else if (step.kind === 'ban') {
    banner = `${label(step.team)}: escolha um mapa para banir.`
  } else if (step.kind === 'pick') {
    banner = `${label(step.team)}: escolha o mapa que será jogado.`
  } else if (step.kind === 'side') {
    const mapName = veto.actions[done - 1] && veto.actions[done - 1].map
    banner = `${label(step.team)}: escolha o lado em ${mapName}.`
  }

  const canChoose = poolOk && step && (step.kind === 'ban' || step.kind === 'pick')

  return (
    <section className="veto" aria-labelledby="sec-veto">
      <div className="panel-head">
        <h2 id="sec-veto">Mapas: picks e bans</h2>
        <div className="seg" role="group" aria-label="Formato da série">
          {Object.entries(FORMATS).map(([key, f]) => (
            <button
              key={key}
              type="button"
              className={`seg-btn ${veto.format === key ? 'is-on' : ''}`}
              aria-pressed={veto.format === key}
              title={f.label}
              onClick={() => setFormat(key)}
            >
              {f.short}
            </button>
          ))}
        </div>
      </div>

      <div className="veto-controls">
        <div className="field">
          <label htmlFor="veto-first">Quem começa o veto</label>
          <select
            id="veto-first"
            value={veto.first}
            disabled={started}
            onChange={(e) => setFirst(e.target.value)}
          >
            <option value="A">{label('A')}</option>
            <option value="B">{label('B')}</option>
          </select>
        </div>
        <button className="btn" onClick={flip} disabled={started}>
          Sortear quem começa
        </button>
        <details className="pool-edit">
          <summary>
            Pool de mapas ({veto.pool.length}/{POOL_SIZE})
          </summary>
          <p className="hint">
            Pool competitivo do patch 13.08 (13/10/2026). Ele muda a cada Ato; ajuste aqui se mudar.
            {started ? ' Reinicie o veto para editar.' : ''}
          </p>
          <div className="pool-grid">
            {ALL_MAPS.map((m) => (
              <label key={m} className={`pool-item ${veto.pool.includes(m) ? 'is-on' : ''}`}>
                <input
                  type="checkbox"
                  checked={veto.pool.includes(m)}
                  disabled={started}
                  onChange={() => togglePool(m)}
                />
                {m}
              </label>
            ))}
          </div>
        </details>
      </div>

      <p className={`banner ${finished ? 'is-done' : ''}`} role="status">
        {banner}
      </p>

      {poolOk && step && step.kind === 'side' && (
        <div className="side-choice">
          <button className="btn btn-primary" onClick={() => chooseSide('attack')}>Ataque</button>
          <button className="btn btn-primary" onClick={() => chooseSide('defense')}>Defesa</button>
        </div>
      )}

      {poolOk && (
        <ul className="map-grid">
          {veto.pool.map((m) => {
            const u = used.get(m)
            const cls = u
              ? u.kind === 'ban'
                ? 'is-ban'
                : u.kind === 'pick'
                  ? `is-pick is-team-${u.team.toLowerCase()}`
                  : 'is-decider'
              : 'is-open'
            const tag = u
              ? u.kind === 'ban'
                ? `Ban · Time ${u.team}`
                : u.kind === 'pick'
                  ? `Pick · Time ${u.team}`
                  : 'Decisivo'
              : canChoose
                ? step.kind === 'ban' ? 'Banir' : 'Escolher'
                : 'Disponível'
            return (
              <li key={m}>
                <button
                  className={`map-tile ${cls}`}
                  disabled={u || !canChoose}
                  onClick={() => chooseMap(m)}
                  aria-label={`${m}: ${tag}`}
                >
                  <span className="map-name">{m}</span>
                  <span className="map-tag">{tag}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <div className="veto-bottom">
        <ol className="timeline">
          {steps.map((s, i) => (
            <li key={i} className={i < done ? 'is-done' : i === done ? 'is-now' : ''}>
              <span>{stepText(s)}</span>
              {veto.actions[i] && (
                <b>{veto.actions[i].map || SIDES[veto.actions[i].side]}</b>
              )}
            </li>
          ))}
        </ol>

        <div className="series">
          <h4>Série ({FORMATS[veto.format].label})</h4>
          {series.length === 0 ? (
            <p className="hint">Os mapas aparecem aqui conforme o veto avança.</p>
          ) : (
            <ol>
              {series.map((m) => (
                <li key={m.n}>
                  <strong>Mapa {m.n}: {m.map}</strong>
                  <span>{m.kind === 'decider' ? 'Decisivo' : `Pick do Time ${m.team}`}</span>
                  <span>{sideText(m)}</span>
                </li>
              ))}
            </ol>
          )}
          <div className="actions">
            <button className="btn btn-small" onClick={undo} disabled={!started}>Desfazer</button>
            <button className="btn btn-small btn-danger" onClick={restart} disabled={!started}>Reiniciar veto</button>
          </div>
        </div>
      </div>
    </section>
  )
}

export default function App() {
  const initial = useRef(null)
  if (initial.current === null) initial.current = loadState()

  const [players, setPlayers] = useState(initial.current.players)
  const [captainA, setCaptainA] = useState(initial.current.captainA)
  const [captainB, setCaptainB] = useState(initial.current.captainB)
  const [result, setResult] = useState(initial.current.result)
  const [veto, setVeto] = useState(initial.current.veto)

  const [name, setName] = useState('')
  const [skill, setSkill] = useState(3)
  const [editingId, setEditingId] = useState(null)
  const [editName, setEditName] = useState('')

  const [formError, setFormError] = useState('')
  const [balanceError, setBalanceError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const [storageWarning, setStorageWarning] = useState(false)

  const resultRef = useRef(null)
  const timer = useRef(null)

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ players, captainA, captainB, result, veto })
      )
      setStorageWarning(false)
    } catch (e) {
      setStorageWarning(true)
    }
  }, [players, captainA, captainB, result, veto])

  useEffect(() => () => clearTimeout(timer.current), [])

  const full = players.length === TOTAL_PLAYERS
  const captainsReady = Boolean(captainA && captainB && captainA !== captainB)
  const canBalance = full && captainsReady && !busy

  const readiness = useMemo(() => {
    if (!full) return `Cadastre mais ${TOTAL_PLAYERS - players.length} jogador(es) para continuar.`
    if (!captainsReady) return 'Escolha os dois capitães para liberar o balanceamento.'
    return 'Tudo pronto. As 70 combinações serão avaliadas.'
  }, [full, captainsReady, players.length])

  const invalidate = () => {
    setResult(null)
    setBalanceError('')
    setCopied('')
  }

  /* ----- cadastro ----- */
  const nameTaken = (candidate, exceptId = null) =>
    players.some(
      (p) => p.id !== exceptId && p.name.toLowerCase() === candidate.toLowerCase()
    )

  const addPlayer = (e) => {
    e.preventDefault()
    const clean = name.trim().replace(/\s+/g, ' ')
    if (full) return setFormError('Você já cadastrou os 10 jogadores.')
    if (!clean) return setFormError('Digite o nickname do jogador.')
    if (clean.length > MAX_NAME)
      return setFormError(`O nickname pode ter no máximo ${MAX_NAME} caracteres.`)
    if (nameTaken(clean)) return setFormError('Já existe um jogador com esse nickname.')
    if (!isValidSkill(skill)) return setFormError('A nota deve ser um número de 1 a 5.')

    setPlayers((list) => [...list, { id: newId(), name: clean, skill }])
    setName('')
    setFormError('')
    invalidate()
  }

  const startEdit = (p) => {
    setEditingId(p.id)
    setEditName(p.name)
    setFormError('')
  }

  const saveEdit = (id) => {
    const clean = editName.trim().replace(/\s+/g, ' ')
    if (!clean) return setFormError('O nickname não pode ficar vazio.')
    if (clean.length > MAX_NAME)
      return setFormError(`O nickname pode ter no máximo ${MAX_NAME} caracteres.`)
    if (nameTaken(clean, id)) return setFormError('Já existe um jogador com esse nickname.')
    setPlayers((list) => list.map((p) => (p.id === id ? { ...p, name: clean } : p)))
    setEditingId(null)
    setFormError('')
    invalidate()
  }

  const removePlayer = (id) => {
    setPlayers((list) => list.filter((p) => p.id !== id))
    if (captainA === id) setCaptainA('')
    if (captainB === id) setCaptainB('')
    if (editingId === id) setEditingId(null)
    setFormError('')
    invalidate()
  }

  /* ----- configuração ----- */
  const rate = (id, value) => {
    const n = Number(value)
    if (!isValidSkill(n)) return
    setPlayers((list) => list.map((p) => (p.id === id ? { ...p, skill: n } : p)))
    invalidate()
  }

  const chooseCaptain = (team, id) => {
    if (team === 'A') {
      if (id && id === captainB) return setBalanceError('O mesmo jogador não pode ser os dois capitães.')
      setCaptainA(id)
    } else {
      if (id && id === captainA) return setBalanceError('O mesmo jogador não pode ser os dois capitães.')
      setCaptainB(id)
    }
    invalidate()
  }

  /* ----- balanceamento ----- */
  const balance = () => {
    setBalanceError('')
    setCopied('')
    if (!full) return setBalanceError('Cadastre exatamente 10 jogadores.')
    if (!captainA || !captainB) return setBalanceError('Selecione os dois capitães.')
    if (captainA === captainB)
      return setBalanceError('O mesmo jogador não pode ser os dois capitães.')
    if (!players.every((p) => isValidSkill(p.skill)))
      return setBalanceError('Há notas fora da escala de 1 a 5.')

    setBusy(true)
    const avoid = result ? result.key : null
    timer.current = setTimeout(() => {
      try {
        const best = findBest(players, captainA, captainB, avoid)
        if (best.teamA.length !== TEAM_SIZE || best.teamB.length !== TEAM_SIZE)
          throw new Error('Os times precisam ter 5 jogadores.')
        if (!best.teamA.includes(captainA) || !best.teamB.includes(captainB))
          throw new Error('Os capitães precisam permanecer em seus times.')
        setResult(best)
        requestAnimationFrame(() =>
          resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        )
      } catch (err) {
        setBalanceError(err.message || 'Não foi possível balancear as equipes.')
      } finally {
        setBusy(false)
      }
    }, 650)
  }

  /* ----- resultado ----- */
  const summary = useMemo(() => {
    if (!result) return null
    const byId = new Map(players.map((p) => [p.id, p]))
    const build = (ids) => {
      const list = ids.map((id) => byId.get(id)).filter(Boolean)
      const total = sum(list)
      return { list, total, avg: total / TEAM_SIZE }
    }
    const a = build(result.teamA)
    const b = build(result.teamB)
    const diff = Math.abs(a.avg - b.avg)
    return { a, b, diff, level: balanceLevel(diff) }
  }, [result, players])

  const resultText = () => {
    if (!summary) return ''
    const block = (title, team, capId) => {
      const lines = [...team.list]
        .sort((x, y) => (x.id === capId ? -1 : y.id === capId ? 1 : y.skill - x.skill))
        .map((p) => `${p.id === capId ? '★' : '•'} ${p.name} (${p.skill})${p.id === capId ? ' — Capitão' : ''}`)
      return `${title}\n${lines.join('\n')}\nTotal: ${team.total} | Média: ${fmt(team.avg)}`
    }
    return [
      'VALORANT TEAM BALANCER',
      '',
      block('TIME A', summary.a, captainA),
      '',
      block('TIME B', summary.b, captainB),
      '',
      `Diferença entre as médias: ${fmt(summary.diff)} (${summary.level.label})`,
      ...(veto.actions.length ? ['', vetoText(veto)] : [])
    ].join('\n')
  }

  const copyResult = async () => {
    try {
      await copyToClipboard(resultText())
      setCopied('ok')
    } catch (e) {
      setCopied('error')
    }
    setTimeout(() => setCopied(''), 2500)
  }

  const resetAll = () => {
    clearTimeout(timer.current)
    setPlayers([])
    setCaptainA('')
    setCaptainB('')
    setResult(null)
    setVeto(defaultVeto())
    setName('')
    setSkill(3)
    setEditingId(null)
    setFormError('')
    setBalanceError('')
    setCopied('')
    setBusy(false)
    setConfirmReset(false)
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch (e) {
      /* ignora */
    }
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const meterPct = summary ? Math.max(6, Math.round((1 - Math.min(summary.diff, 1.5) / 1.5) * 100)) : 0

  return (
    <div className="app">
      <header className="hero">
        <div className="hero-brand">
          <Logo />
          <span>Valorant Team Balancer</span>
        </div>
        <h1>
          Dez jogadores.
          <br />
          Dois times. Zero discussão.
        </h1>
        <p className="hero-text">
          Cadastre o grupo, escolha os capitães e dê uma nota de habilidade a cada
          jogador. O balanceador testa as 70 divisões possíveis e mostra a mais justa. Com os times prontos, os capitães fazem o veto de mapas no formato competitivo.
        </p>
      </header>

      {storageWarning && (
        <div className="alert alert-warn" role="alert">
          Não foi possível salvar no navegador. Seus dados valem apenas até fechar a página.
        </div>
      )}

      <main>
        {/* 1. Cadastro */}
        <section className="panel" aria-labelledby="sec-players">
          <div className="panel-head">
            <h2 id="sec-players">Jogadores</h2>
            <span className={`counter ${full ? 'is-full' : ''}`}>
              {players.length}/{TOTAL_PLAYERS}
            </span>
          </div>

          <form className="add-form" onSubmit={addPlayer} noValidate>
            <div className="field grow">
              <label htmlFor="nick">Nickname</label>
              <input
                id="nick"
                type="text"
                value={name}
                maxLength={MAX_NAME + 10}
                placeholder={full ? 'Lista completa' : 'Ex.: Jett#BR1'}
                disabled={full}
                autoComplete="off"
                onChange={(e) => {
                  setName(e.target.value)
                  if (formError) setFormError('')
                }}
              />
            </div>
            <div className="field">
              <label id="lbl-skill">Habilidade</label>
              <SkillPicker value={skill} onChange={setSkill} label="Habilidade do novo jogador" />
            </div>
            <button type="submit" className="btn btn-primary" disabled={full}>
              Adicionar jogador
            </button>
          </form>
          <p className="hint">
            Nota {skill}: <b>{SKILLS[skill]}</b>
          </p>
          {formError && (
            <p className="alert alert-error" role="alert">
              {formError}
            </p>
          )}

          {players.length === 0 ? (
            <p className="empty">Nenhum jogador ainda. Adicione o primeiro nickname acima.</p>
          ) : (
            <ul className="player-list">
              {players.map((p, i) => (
                <li key={p.id} className="player-row">
                  <span className="idx">{i + 1}</span>
                  {editingId === p.id ? (
                    <>
                      <input
                        className="edit-input"
                        value={editName}
                        maxLength={MAX_NAME + 10}
                        autoFocus
                        aria-label={`Novo nickname de ${p.name}`}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveEdit(p.id)
                          if (e.key === 'Escape') setEditingId(null)
                        }}
                      />
                      <div className="row-actions">
                        <button className="btn btn-small btn-primary" onClick={() => saveEdit(p.id)}>
                          Salvar
                        </button>
                        <button className="btn btn-small" onClick={() => setEditingId(null)}>
                          Cancelar
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <span className="player-name">{p.name}</span>
                      <span className="player-skill">{p.skill} · {SKILLS[p.skill]}</span>
                      <div className="row-actions">
                        <button className="btn btn-small" onClick={() => startEdit(p)}>
                          Editar
                        </button>
                        <button className="btn btn-small btn-danger" onClick={() => removePlayer(p.id)}>
                          Excluir
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 2. Configuração */}
        <section className="panel" aria-labelledby="sec-config">
          <div className="panel-head">
            <h2 id="sec-config">Capitães e notas</h2>
          </div>

          {players.length === 0 ? (
            <p className="empty">Cadastre os jogadores para escolher capitães e ajustar notas.</p>
          ) : (
            <>
              <div className="captains">
                <div className="field">
                  <label htmlFor="capA">Capitão do Time A</label>
                  <select id="capA" value={captainA} onChange={(e) => chooseCaptain('A', e.target.value)}>
                    <option value="">Selecione…</option>
                    {players.map((p) => (
                      <option key={p.id} value={p.id} disabled={p.id === captainB}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="capB">Capitão do Time B</label>
                  <select id="capB" value={captainB} onChange={(e) => chooseCaptain('B', e.target.value)}>
                    <option value="">Selecione…</option>
                    {players.map((p) => (
                      <option key={p.id} value={p.id} disabled={p.id === captainA}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <ul className="rating-list">
                {players.map((p) => (
                  <li key={p.id} className="rating-row">
                    <span className="rating-name">
                      {p.name}
                      {p.id === captainA && <em className="tag tag-a">Capitão A</em>}
                      {p.id === captainB && <em className="tag tag-b">Capitão B</em>}
                    </span>
                    <SkillPicker
                      value={p.skill}
                      onChange={(n) => rate(p.id, n)}
                      label={`Nota de ${p.name}`}
                    />
                    <span className="rating-label">{SKILLS[p.skill]}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        {/* 3. Balanceamento */}
        <section className="panel panel-cta" aria-labelledby="sec-balance">
          <h2 id="sec-balance" className="sr-only">Balanceamento</h2>
          <button className="btn-balance" onClick={balance} disabled={!canBalance}>
            {busy ? (
              <span className="loading">
                <i /> Avaliando 70 combinações…
              </span>
            ) : (
              'BALANCEAR EQUIPES'
            )}
          </button>
          <p className="hint center">{readiness}</p>
          {balanceError && (
            <p className="alert alert-error" role="alert">
              {balanceError}
            </p>
          )}
        </section>

        {/* 4. Resultado */}
        {summary && (
          <section className="result" ref={resultRef} aria-labelledby="sec-result">
            <div className="panel-head">
              <h2 id="sec-result">Times definidos</h2>
            </div>

            <div className="teams">
              <TeamCard title="Time A" tone="a" ids={result.teamA} captainId={captainA} players={players} delay={0} />
              <TeamCard title="Time B" tone="b" ids={result.teamB} captainId={captainB} players={players} delay={120} />
            </div>

            <div className={`balance balance-${summary.level.tone}`}>
              <div className="balance-top">
                <div>
                  <span className="balance-label">Diferença entre as médias</span>
                  <strong className="balance-diff">{fmt(summary.diff)}</strong>
                </div>
                <span className="balance-verdict">{summary.level.label}</span>
              </div>
              <div
                className="meter"
                role="meter"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={meterPct}
                aria-label="Nível de equilíbrio"
              >
                <span style={{ width: `${meterPct}%` }} />
              </div>
              <p className="hint">
                {result.evaluated} combinações avaliadas
                {result.tied > 1
                  ? `; ${result.tied} empatam na menor diferença. "Gerar novas equipes" alterna entre elas.`
                  : '; esta é a única com a menor diferença.'}
              </p>
            </div>

            <VetoPanel
              veto={veto}
              setVeto={setVeto}
              label={(t) => {
                const cap = players.find((p) => p.id === (t === 'A' ? captainA : captainB))
                return cap ? `Time ${t} (${cap.name})` : `Time ${t}`
              }}
            />

            <div className="actions">
              <button className="btn btn-primary" onClick={balance} disabled={busy}>
                Gerar novas equipes
              </button>
              <button className="btn" onClick={copyResult}>
                {copied === 'ok' ? 'Copiado!' : copied === 'error' ? 'Falha ao copiar' : 'Copiar resultado'}
              </button>
              {confirmReset ? (
                <span className="confirm">
                  Apagar tudo?
                  <button className="btn btn-danger" onClick={resetAll}>Sim, reiniciar</button>
                  <button className="btn" onClick={() => setConfirmReset(false)}>Cancelar</button>
                </span>
              ) : (
                <button className="btn btn-danger" onClick={() => setConfirmReset(true)}>
                  Reiniciar configuração
                </button>
              )}
            </div>
          </section>
        )}

        {!summary && players.length > 0 && (
          <div className="actions actions-end">
            {confirmReset ? (
              <span className="confirm">
                Apagar tudo?
                <button className="btn btn-danger" onClick={resetAll}>Sim, reiniciar</button>
                <button className="btn" onClick={() => setConfirmReset(false)}>Cancelar</button>
              </span>
            ) : (
              <button className="btn btn-danger" onClick={() => setConfirmReset(true)}>
                Reiniciar configuração
              </button>
            )}
          </div>
        )}
      </main>

      <footer className="foot">
        Valorant Team Balancer · projeto de fãs, sem vínculo com a Riot Games. Dados salvos apenas neste navegador.
      </footer>
    </div>
  )
}
