// change-explainer: Claude가 턴마다 바꾼 파일을 기록하고, 원할 때 해설한다.
//
// 1단계: 변경 수집과 저장 / 2단계: diff 창
// - 턴에서 파일을 처음 건드리기 직전의 내용(변경 전)과 턴이 끝난 뒤의 내용(변경 후)을 남긴다
// - 서브에이전트의 수정은 그 서브에이전트를 실행한 메인 턴에 붙인다
// - 도구 호출은 관찰만 한다. 막거나 바꾸지 않고 next(e)의 결과를 그대로 돌려준다
//
// 저장 위치: ~/.claude/explanations/<저장소>-<해시>/<세션 id>/
//   session.json                      세션 정보와 턴 목록
//   turns/<순번>-<turnId>/turn.json   턴 기록 (요청문, 답변, 파일별 줄 수)
//   turns/<순번>-<turnId>/before/…    변경 전 스냅숏, after/… 변경 후 스냅숏

import { buildRows } from './diff.js'
import { diffCodeRows, diffModel, diffView, hunkList } from './views/diff.js'
import {
  EDIT_TOOLS, MAX_FILE_BYTES, absolutePath, editedPath, looksBinary, newFileEntry, newTurn, recordEdit,
  repoFolder, storedPath, turnRecord, turnSummary,
} from './turns.js'

// 메모리에 남겨 둘 끝난 턴 수: 늦게 끝난 백그라운드 서브에이전트의 수정을 붙이기 위해
const KEEP_FINISHED = 20

// 세션 정보 (처음 필요할 때 채운다): { base, root, cwd, sessionId, session }
let ctx = null
// 마지막으로 제출한 프롬프트 (turn.start의 text가 비어 있을 때 쓴다)
let lastPrompt = ''
// 진행 중인 메인 턴
let current = null
// 끝난 턴: turnId → { turn, seq, answer, isAborted, durationMs, endedAt }
let finished = {}
// 서브에이전트 → 그 서브에이전트를 실행한 메인 턴, 그리고 서브에이전트 종류
let agentTurn = {}
let agentType = {}
// 마지막으로 저장한 변경 턴 기록
let lastRecord = null

// ── 창 상태 ──
const PANE = 'change-explainer'
const WANT_COLUMNS = 120
const STEP_ROWS = 5
const STEP_COLS = 8
// 창에 띄운 턴: { turn: 턴 기록, files: [{ ...파일 기록, rows, hunks }] }
let view = null
// diff: 보고 있는 변경 블록, 코드 영역의 위쪽 줄과 가로 밀림, 휠 스크롤 한계
let pos = 0
let diffTop = 0
let diffLeft = 0
let diffMaxTop = 0

const pad = (n) => String(n).padStart(4, '0')

// 이 mod는 관찰만 하므로, 훅이 실패해도 원래 동작은 그대로 진행한다.
// .catch 안의 next는 다시 불러도 안전하다: 이미 실행됐으면 그 결과를, 아니면 한 번만 실행한다
const passThrough = ($, e, next) => next(e)

// ── 저장소·세션 정보 ─────────────────────────────────────────

async function gitTop($, cwd) {
  try {
    const r = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })
    if (r.exitCode === 0 && r.stdout.trim()) return r.stdout.trim()
  } catch {}
  return null
}

async function ensureCtx($) {
  if (ctx) return ctx
  const home = await $.env.get('HOME')
  const cwd = await $.session.cwd()
  const sessionId = await $.session.id()
  // 워크트리에서는 워크트리의 최상위가 기준이다 (session.repo()는 메인 작업 트리를 준다)
  const root = (await gitTop($, cwd)) || cwd
  const base = home + '/.claude/explanations/' + (await repoFolder(root)) + '/' + sessionId
  let session = null
  try {
    session = JSON.parse(await $.fs.read(base + '/session.json'))
  } catch {}
  if (!session) session = { sessionId, repoRoot: root, startedAt: await $.clock.now(), transcriptPath: null, turns: [] }
  ctx = { base, root, cwd, sessionId, session }
  return ctx
}

// ── 파일 읽기 ────────────────────────────────────────────────

// 파일 내용: 없으면 null, 다룰 수 없으면 { skipped: 'too-large' | 'binary' }
async function readSnapshot($, abs) {
  let st
  try {
    st = await $.fs.stat(abs)
  } catch {
    return null
  }
  if (st.size > MAX_FILE_BYTES) return { skipped: 'too-large' }
  try {
    const text = await $.fs.read(abs)
    return looksBinary(text) ? { skipped: 'binary' } : text
  } catch {
    return { skipped: 'unreadable' }
  }
}

// ── 턴 저장 ─────────────────────────────────────────────────

async function saveTurn($, turnId) {
  const f = finished[turnId]
  if (!f) return
  const c = await ensureCtx($)
  const entries = Object.values(f.turn.files).filter((x) => x.edits > 0)
  const afters = {}
  for (const x of entries) {
    if (x.skipped) continue
    const now = await readSnapshot($, x.abs)
    afters[x.abs] = typeof now === 'string' ? now : null
  }
  const record = turnRecord(f.turn, afters, {
    sessionId: c.sessionId,
    answer: f.answer,
    isAborted: f.isAborted,
    durationMs: f.durationMs,
    endedAt: f.endedAt,
  })
  if (!record.hasChanges) return
  if (!f.seq) f.seq = c.session.turns.reduce((m, t) => Math.max(m, t.seq), 0) + 1
  record.seq = f.seq
  const dir = c.base + '/turns/' + pad(f.seq) + '-' + turnId

  for (const x of entries) {
    if (x.skipped) continue
    if (typeof x.before === 'string') await $.fs.write(dir + '/before/' + x.rel, x.before)
    if (typeof afters[x.abs] === 'string') await $.fs.write(dir + '/after/' + x.rel, afters[x.abs])
  }
  await $.fs.write(dir + '/turn.json', JSON.stringify(record, null, 2))

  const summary = turnSummary(record)
  const others = c.session.turns.filter((t) => t.turnId !== turnId)
  c.session = { ...c.session, turns: [...others, summary].sort((a, b) => a.seq - b.seq) }
  await $.fs.write(c.base + '/session.json', JSON.stringify(c.session, null, 2))
  lastRecord = record
}

// ── 창에 띄울 턴 불러오기 ────────────────────────────────────

const turnDir = (c, rec) => c.base + '/turns/' + pad(rec.seq) + '-' + rec.turnId

async function readOrNull($, path) {
  try { return await $.fs.read(path) } catch { return null }
}

// 마지막 변경 턴: 메모리에 없으면(mod를 다시 불러온 뒤 등) 세션 기록에서 찾는다
async function latestRecord($) {
  if (lastRecord) return lastRecord
  const c = await ensureCtx($)
  const last = c.session.turns[c.session.turns.length - 1]
  if (!last) return null
  const text = await readOrNull($, turnDir(c, last) + '/turn.json')
  return text ? JSON.parse(text) : null
}

// 턴 기록과 스냅숏으로 화면 데이터를 만든다
async function loadView($, rec) {
  const c = await ensureCtx($)
  const dir = turnDir(c, rec)
  const files = []
  for (const f of rec.files.filter((x) => x.changed)) {
    if (f.skipped) { files.push({ ...f, rows: [], hunks: 0 }); continue }
    const before = f.isNew ? null : await readOrNull($, dir + '/before/' + f.path)
    const after = await readOrNull($, dir + '/after/' + f.path)
    files.push({ ...f, ...buildRows(before, after || '') })
  }
  return { turn: rec, files }
}

// ── 훅 ─────────────────────────────────────────────────────

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'explain',
        description: '마지막으로 Claude가 바꾼 내용 보기 (지금은 기록 확인용 텍스트)',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('/explain 등록 실패: ' + err)
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    lastPrompt = e.text
    return next(e)
  }).catch(passThrough)

  // 메인 대화의 턴만 시작된다 (서브에이전트의 실행은 turn.start를 내지 않는다)
  on('turn.start', async ($, e, next) => {
    current = newTurn(e.turnId, e.text || lastPrompt, await $.clock.now())
    return next(e)
  }).catch(passThrough)

  // 서브에이전트가 시작되면 그때의 메인 턴과 묶어 둔다. 서브에이전트가 낳은 서브에이전트는 부모의 턴을 따른다
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result && result.agentId) {
      const owner = e.parentAgentId ? agentTurn[e.parentAgentId] : current && current.turnId
      if (owner) agentTurn[result.agentId] = owner
      agentType[result.agentId] = e.subagentType
    }
    return result
  }).catch(passThrough)

  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const path = editedPath(e)
    const turnId = e.agentId ? agentTurn[e.agentId] : current && current.turnId
    const turn = !turnId ? null : current && current.turnId === turnId ? current : finished[turnId] && finished[turnId].turn
    if (!path || !turn) return next(e)

    let abs = null
    try {
      const c = await ensureCtx($)
      abs = absolutePath(path, c.cwd)
      // 이 턴에서 처음 건드리는 파일이면 고치기 직전의 내용을 남긴다
      if (!turn.files[abs]) {
        const before = await readSnapshot($, abs)
        const skipped = before && typeof before === 'object' ? before.skipped : null
        turn.files[abs] = newFileEntry(abs, storedPath(abs, c.root), skipped ? undefined : before, skipped)
      }
    } catch {
      abs = null
    }

    const result = await next(e)

    if (abs && result && !result.deny && !result.isError) {
      const agent = e.agentId ? { agentId: e.agentId, type: agentType[e.agentId] || null } : null
      turn.files[abs] = recordEdit(turn.files[abs], e.tool, agent)
      // 메인 턴이 이미 끝난 뒤의 수정(백그라운드 서브에이전트)이면 그 턴의 기록을 다시 저장한다
      if (finished[turnId]) {
        try { await saveTurn($, turnId) } catch (err) { $.ui.log('턴 기록 갱신 실패: ' + err) }
      }
    }
    return result
  }).catch(passThrough)

  on('turn.complete', async ($, e, next) => {
    if (e.agentId || !current || current.turnId !== e.turnId) return next(e)
    const turn = current
    current = null
    finished[turn.turnId] = {
      turn,
      seq: 0,
      answer: e.answer,
      isAborted: e.isAborted,
      durationMs: e.durationMs,
      endedAt: await $.clock.now(),
    }
    // 오래된 턴은 메모리에서 뺀다 (변경 전 내용을 들고 있어서)
    const ids = Object.keys(finished)
    if (ids.length > KEEP_FINISHED) {
      const keep = {}
      ids.slice(-KEEP_FINISHED).forEach((id) => { keep[id] = finished[id] })
      finished = keep
    }
    if (Object.keys(turn.files).length) {
      try { await saveTurn($, turn.turnId) } catch (err) { $.ui.log('턴 기록 저장 실패: ' + err) }
    }
    return next(e)
  }).catch(passThrough)

  // 대화 기록 파일 위치: 지난 세션을 해설할 때 쓴다
  on('classic.Stop', async ($, e, next) => {
    if (e.transcript_path) {
      try {
        const c = await ensureCtx($)
        if (c.session.transcriptPath !== e.transcript_path) {
          c.session = { ...c.session, transcriptPath: e.transcript_path }
          if (c.session.turns.length) await $.fs.write(c.base + '/session.json', JSON.stringify(c.session, null, 2))
        }
      } catch {}
    }
    return next(e)
  }).catch(passThrough)

  // /explain: 마지막 변경 턴의 diff 창을 연다. 창을 그릴 수 없는 곳(claude -p 등)에서는 텍스트로 답한다
  on('command.run', { command: 'explain' }, async ($) => {
    const rec = await latestRecord($)
    if (!rec) return { text: '이 세션에서 아직 기록된 변경이 없습니다.' }
    const textAnswer = () => {
      const changed = rec.files.filter((f) => f.changed)
      return [
        '#' + rec.seq + '  ' + rec.title,
        '파일 ' + changed.length + '개  +' + rec.added + ' −' + rec.removed,
        ...changed.map((f) => {
          const tag = f.skipped ? '내용 생략(' + f.skipped + ')' : f.isNew ? '새 파일' : '수정'
          const who = f.agents.length ? '  · 서브에이전트 ' + f.agents.map((a) => a.type || a.agentId).join(', ') : ''
          return '  ' + f.path + '  ' + tag + '  +' + f.added + ' −' + f.removed + who
        }),
      ].join('\n')
    }
    // 화면이 없는 실행(claude -p)에서는 창을 열지 않고 글로 답한다
    if (!(await $.session.surfaces()).length) return { text: textAnswer() }
    view = await loadView($, rec)
    pos = 0
    diffTop = 0
    diffLeft = 0
    const opened = await $.ui.open({ id: PANE, title: '변경 해설', focus: true, closeOnEscape: true, columns: WANT_COLUMNS })
    if (opened && opened.isPlaced) return {}
    return { text: textAnswer() + '\n(창이 아직 열리지 않았습니다: ' + ((opened && opened.reason) || '터미널이 좁음') + ')' }
  })

  // diff 창에서는 휠과 스크롤 키로 창 전체가 아니라 코드 영역만 움직인다
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (!view) return next(e)
    diffTop = Math.max(0, Math.min(diffMaxTop, diffTop + e.by))
    $.ui.invalidate('ui.render')
    return {}
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const el = $.ui.resolve(e)
    if (!view) return el.Text({ color: '#858b94', children: ['/explain 으로 마지막 변경을 엽니다.'] })
    const cols = e.props.bodyColumns || 100
    const bodyRows = (e.props.scroll && e.props.scroll.bodyRows) || 30
    const redraw = () => $.ui.invalidate('ui.render')
    const hunks = hunkList(view.files)
    const m = diffModel(cols, view.files, pos)
    diffMaxTop = Math.max(0, m.lines.length - diffCodeRows(bodyRows))
    diffTop = Math.min(diffTop, diffMaxTop)
    diffLeft = Math.min(diffLeft, m.maxLeft)

    // 변경 블록으로 이동: 그 블록이 코드 영역 위쪽에 오도록
    const goTo = (n) => {
      pos = Math.max(0, Math.min(hunks.length - 1, n))
      diffTop = Math.max(0, diffModel(cols, view.files, pos).hunkStart - 2)
      diffLeft = 0
      redraw()
    }
    const firstHunkOf = (f) => {
      const i = hunks.findIndex((h) => h.f === f)
      return i < 0 ? pos : i
    }
    return diffView(el, cols, bodyRows, { turn: view.turn, files: view.files, pos, top: diffTop, left: diffLeft }, {
      prev: () => goTo(pos - 1),
      next: () => goTo(pos + 1),
      nextFile: () => goTo(firstHunkOf(((hunks[pos] ? hunks[pos].f : 0) + 1) % view.files.length)),
      pickFile: (f) => goTo(firstHunkOf(f)),
      up: () => { diffTop = Math.max(0, diffTop - STEP_ROWS); redraw() },
      down: () => { diffTop = Math.min(diffMaxTop, diffTop + STEP_ROWS); redraw() },
      leftward: () => { diffLeft = Math.max(0, diffLeft - STEP_COLS); redraw() },
      rightward: () => { diffLeft = Math.min(m.maxLeft, diffLeft + STEP_COLS); redraw() },
    })
  })
}
