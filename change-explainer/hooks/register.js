// change-explainer: Claude가 턴마다 바꾼 파일을 기록하고, 원할 때 해설한다.
//
// 1단계: 변경 수집과 저장 / 2단계: diff 창 / 3단계: 해설 생성과 해설 창
// - 턴에서 파일을 처음 건드리기 직전의 내용(변경 전)과 턴이 끝난 뒤의 내용(변경 후)을 남긴다
// - 서브에이전트의 수정은 그 서브에이전트를 실행한 메인 턴에 붙인다
// - 도구 호출은 관찰만 한다. 막거나 바꾸지 않고 next(e)의 결과를 그대로 돌려준다
//
// 저장 위치: ~/.claude/explanations/<저장소>-<해시>/<세션 id>/
//   session.json                      세션 정보와 턴 목록
//   turns/<순번>-<turnId>/turn.json   턴 기록 (요청문, 답변, 파일별 줄 수)
//   turns/<순번>-<turnId>/before/…    변경 전 스냅숏, after/… 변경 후 스냅숏
//   turns/<순번>-<turnId>/views/…     생성한 섹션(JSON), Wait what 대화와 질문
// 저장소 단위: ~/.claude/explanations/<저장소>-<해시>/learning.json   Known 용어, 막혔던 섹션

import { buildRows } from './diff.js'
import { SECTIONS, answerPrompt, easyPrompt, parseAt, retryPrompt, sectionPrompt, turnContext, validate } from './generate.js'
import { diffCodeRows, diffModel, diffView, hunkList } from './views/diff.js'
import { explainView } from './views/explain.js'
import {
  EDIT_TOOLS, MAX_FILE_BYTES, absolutePath, editedPath, looksBinary, newFileEntry, newTurn, recordEdit,
  repoFolder, storedPath, turnRecord, turnSummary,
} from './turns.js'

// 메모리에 남겨 둘 끝난 턴 수: 늦게 끝난 백그라운드 서브에이전트의 수정을 붙이기 위해
const KEEP_FINISHED = 20

// 세션 정보 (처음 필요할 때 채운다): { repoBase, base, root, cwd, sessionId, session }
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
// 화면: 'explain'(해설) 또는 'diff'
let mode = 'explain'
// 띄운 턴의 해설 상태: { dir, sections, open, current, threads, qa, quiz, seqLeft, understood }
let ex = null
// 저장소 단위 학습 기록: 이미 아는 용어, 막혔던 섹션 (다음 해설 프롬프트에 넣는다)
let learning = { known: [], stuck: [] }
const SECTION_TITLE = Object.fromEntries(SECTIONS.map((s) => [s.id, s.title]))

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
  const repoBase = home + '/.claude/explanations/' + (await repoFolder(root))
  const base = repoBase + '/' + sessionId
  let session = null
  try {
    session = JSON.parse(await $.fs.read(base + '/session.json'))
  } catch {}
  if (!session) session = { sessionId, repoRoot: root, startedAt: await $.clock.now(), transcriptPath: null, turns: [] }
  let learned = null
  try {
    learned = JSON.parse(await $.fs.read(repoBase + '/learning.json'))
  } catch {}
  learning = { known: (learned && learned.known) || [], stuck: (learned && learned.stuck) || [] }
  ctx = { repoBase, base, root, cwd, sessionId, session }
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

  const prev = c.session.turns.find((t) => t.turnId === turnId)
  const summary = { ...turnSummary(record), understood: !!(prev && prev.understood) }
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
    files.push({ ...f, beforeText: before, afterText: after, ...buildRows(before, after || '') })
  }
  return { turn: rec, files, dir }
}

// ── 해설 생성 ────────────────────────────────────────────────

// 보기 순서를 섞는다. 모델은 정답을 첫 번째에 두는 버릇이 있어서 순서는 코드가 정한다
function shuffled(n) {
  const a = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const newQuiz = (data) => ({ order: data.questions.map((q) => shuffled(q.options.length)), picked: data.questions.map(() => null) })

// 모델 호출: 이 세션의 턴이면 현재 대화를 fork(맥락을 알고, 캐시로 싸다), 아니면 요청문·답변·diff만으로 complete
async function callModel($, prompt) {
  const c = await ensureCtx($)
  if (!view || view.turn.sessionId === c.sessionId) {
    const r = await $.model.fork({ prompt })
    if (r.isAnswered) return { text: r.text }
    if (r.reason !== 'nothing-to-fork') return { error: r.reason + (r.status ? ' ' + r.status : '') }
  }
  let model = 'sonnet'
  try { model = (await $.session.model()) || model } catch {}
  const r = await $.model.complete({
    model,
    system: '너는 코드 변경을 사용자에게 해설하는 도우미다. 요청한 JSON 객체 하나만 답한다.',
    prompt,
    maxTokens: 4000,
    timeoutMs: 120000,
  })
  return r.isAnswered ? { text: r.text } : { error: r.reason + (r.status ? ' ' + r.status : '') }
}

// 프롬프트를 보내고 kind 형식으로 검증한다. 형식이 틀리면 한 번 더 요청한다
async function ask($, prompt, kind, check) {
  let reply = await callModel($, prompt)
  if (reply.error) return { ok: false, error: '모델 응답 없음(' + reply.error + ')' }
  let v = validate(kind, reply.text, check)
  if (v.ok) return v
  reply = await callModel($, prompt + '\n\n' + retryPrompt(v.error))
  if (reply.error) return { ok: false, error: '모델 응답 없음(' + reply.error + ')' }
  v = validate(kind, reply.text, check)
  return v.ok ? v : { ok: false, error: '형식이 맞지 않음(' + v.error + ')' }
}

async function saveJson($, path, value) {
  try { await $.fs.write(path, JSON.stringify(value, null, 2)) } catch (err) { $.ui.log('저장 실패: ' + path + ': ' + err) }
}

const saveThreads = ($, target) => saveJson($, target.dir + '/views/threads.json', { threads: target.threads, qa: target.qa })
const saveLearning = async ($) => saveJson($, (await ensureCtx($)).repoBase + '/learning.json', learning)

// 섹션 하나를 만든다. 다른 턴으로 바꾼 뒤에 답이 와도 원래 턴에만 반영한다
async function generateSection($, id) {
  const target = ex
  const v = view
  if (!target || target.sections[id].status === 'loading') return
  target.sections[id] = { status: 'loading', data: null, error: null }
  $.ui.invalidate('ui.render')
  const context = turnContext(v.turn, v.files, learning)
  const r = await ask($, sectionPrompt(id, context), id, context)
  if (r.ok) {
    target.sections[id] = { status: 'done', data: r.value, error: null }
    if (id === 'quiz') target.quiz = newQuiz(r.value)
    await saveJson($, target.dir + '/views/' + id + '.json', r.value)
  } else {
    target.sections[id] = { status: 'error', data: null, error: r.error }
  }
  $.ui.invalidate('ui.render')
}

// 대화 상자의 i번째 항목을 채운다
function fillThread(target, id, i, patch) {
  target.threads = { ...target.threads, [id]: target.threads[id].map((x, j) => (j === i ? { ...x, ...patch } : x)) }
}

// Wait, what?: 앞의 설명들과 다른 방식으로 더 쉽게. 누른 섹션은 막혔던 곳으로 기록한다
async function explainEasier($, id) {
  const target = ex
  const thread = target.threads[id] || []
  const i = thread.length
  target.threads = { ...target.threads, [id]: [...thread, { type: 'easy', text: null }] }
  $.ui.invalidate('ui.render')
  const title = SECTION_TITLE[id] + ' (' + view.turn.title + ')'
  if (!learning.stuck.includes(title)) {
    learning = { ...learning, stuck: [...learning.stuck, title].slice(-20) }
    await saveLearning($)
  }
  const r = await ask($, easyPrompt(id, turnContext(view.turn, view.files, learning), target.sections[id].data, thread), 'text')
  fillThread(target, id, i, { text: r.ok ? r.value.text : '(설명을 만들지 못했습니다: ' + r.error + ')' })
  await saveThreads($, target)
  $.ui.invalidate('ui.render')
}

// 섹션 안의 질문
async function askInSection($, id, q) {
  const target = ex
  const thread = target.threads[id] || []
  const i = thread.length
  target.threads = { ...target.threads, [id]: [...thread, { type: 'q', q, a: null }] }
  $.ui.invalidate('ui.render')
  const section = { id, json: target.sections[id].data, thread: thread.filter((x) => (x.type === 'easy' ? x.text : x.a)) }
  const r = await ask($, answerPrompt(q, turnContext(view.turn, view.files, learning), section), 'text')
  fillThread(target, id, i, { a: r.ok ? r.value.text : '(답을 만들지 못했습니다: ' + r.error + ')' })
  await saveThreads($, target)
  $.ui.invalidate('ui.render')
}

// 해설 창 맨 아래의 질문
async function askTurn($, q) {
  const target = ex
  const i = target.qa.length
  target.qa = [...target.qa, { q, a: null }]
  $.ui.invalidate('ui.render')
  const r = await ask($, answerPrompt(q, turnContext(view.turn, view.files, learning), null), 'text')
  target.qa = target.qa.map((x, j) => (j === i ? { ...x, a: r.ok ? r.value.text : '(답을 만들지 못했습니다: ' + r.error + ')' } : x))
  await saveThreads($, target)
  $.ui.invalidate('ui.render')
}

// 퀴즈를 다 맞히면 세션 목록에 이해함으로 남긴다
async function markUnderstood($) {
  const c = await ensureCtx($)
  const id = view.turn.turnId
  c.session = { ...c.session, turns: c.session.turns.map((t) => (t.turnId === id ? { ...t, understood: true } : t)) }
  await saveJson($, c.base + '/session.json', c.session)
}

// 턴 하나를 해설 창에 띄운다: 저장해 둔 섹션·대화를 불러오고, 요약과 펼쳐 둔 섹션을 만든다
async function openTurn($, rec) {
  const c = await ensureCtx($)
  view = await loadView($, rec)
  const sections = Object.fromEntries(SECTIONS.map((s) => [s.id, { status: 'none', data: null, error: null }]))
  let quiz = { order: [], picked: [] }
  for (const s of SECTIONS) {
    const saved = await readOrNull($, view.dir + '/views/' + s.id + '.json')
    if (!saved) continue
    try {
      sections[s.id] = { status: 'done', data: JSON.parse(saved), error: null }
      if (s.id === 'quiz') quiz = newQuiz(sections[s.id].data)
    } catch {}
  }
  let threads = {}
  let qa = []
  const savedThreads = await readOrNull($, view.dir + '/views/threads.json')
  if (savedThreads) {
    try {
      const t = JSON.parse(savedThreads)
      threads = t.threads || {}
      qa = t.qa || []
    } catch {}
  }
  let open = { summary: true }
  try {
    const saved = await $.store.get('open')
    if (saved && typeof saved === 'object') open = { ...saved, summary: saved.summary !== false }
  } catch {}
  const summary = c.session.turns.find((t) => t.turnId === rec.turnId)
  ex = { dir: view.dir, sections, open, current: 'summary', threads, qa, quiz, seqLeft: 0, understood: !!(summary && summary.understood) }
  mode = 'explain'
  pos = 0
  diffTop = 0
  diffLeft = 0
  // 요약은 창을 열 때, 펼쳐 둔 섹션도 함께 만든다 (모두 처음 한 번만)
  for (const s of SECTIONS) {
    if (open[s.id] && sections[s.id].status === 'none') generateSection($, s.id).catch((err) => $.ui.log('생성 실패: ' + err))
  }
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
    try {
      await $.command.register({
        name: 'explain-check',
        description: '(개발용) 마지막 변경 턴의 해설 섹션 하나를 실제로 만들어 JSON으로 출력',
        argumentHint: '[summary|background|walk|flow|seq|ba|impact|terms|quiz]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('/explain-check 등록 실패: ' + err)
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
    await openTurn($, rec)
    const opened = await $.ui.open({ id: PANE, title: '변경 해설', focus: true, closeOnEscape: true, columns: WANT_COLUMNS })
    if (opened && opened.isPlaced) return {}
    return { text: textAnswer() + '\n(창이 아직 열리지 않았습니다: ' + ((opened && opened.reason) || '터미널이 좁음') + ')' }
  })

  // 개발용: 섹션 하나를 실제 모델로 만들어 검증 결과를 글로 보여 준다 (claude -p에서도 동작)
  on('command.run', { command: 'explain-check' }, async ($, e) => {
    const id = (e.args || '').trim() || 'summary'
    if (!SECTION_TITLE[id]) return { text: '섹션 이름: ' + SECTIONS.map((s) => s.id).join(', ') }
    const rec = await latestRecord($)
    if (!rec) return { text: '이 세션에서 아직 기록된 변경이 없습니다.' }
    view = await loadView($, rec)
    const context = turnContext(view.turn, view.files, learning)
    const r = await ask($, sectionPrompt(id, context), id, context)
    return { text: r.ok ? JSON.stringify(r.value, null, 2) : '실패: ' + r.error }
  })

  // diff 창에서는 휠과 스크롤 키로 창 전체가 아니라 코드 영역만 움직인다
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (!view || mode !== 'diff') return next(e)
    diffTop = Math.max(0, Math.min(diffMaxTop, diffTop + e.by))
    $.ui.invalidate('ui.render')
    return {}
  }).catch(passThrough)

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const el = $.ui.resolve(e)
    if (!view) return el.Text({ color: '#858b94', children: ['/explain 으로 마지막 변경을 엽니다.'] })
    const cols = e.props.bodyColumns || 100
    const bodyRows = (e.props.scroll && e.props.scroll.bodyRows) || 30
    const redraw = () => $.ui.invalidate('ui.render')
    const reveal = (key) => { $.ui.scroll({ in: PANE, to: { key }, block: 'start' }).catch(() => {}) }
    const hunks = hunkList(view.files)

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
    const openDiff = (f) => {
      mode = 'diff'
      goTo(f === undefined ? pos : firstHunkOf(f))
      $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {})
    }

    // ── diff 화면 ──
    if (mode === 'diff') {
      const m = diffModel(cols, view.files, pos)
      diffMaxTop = Math.max(0, m.lines.length - diffCodeRows(bodyRows))
      diffTop = Math.min(diffTop, diffMaxTop)
      diffLeft = Math.min(diffLeft, m.maxLeft)
      const summary = ex && ex.sections.summary.status === 'done' ? ex.sections.summary.data : null
      return diffView(el, cols, bodyRows, { turn: view.turn, files: view.files, pos, top: diffTop, left: diffLeft, notes: summary ? summary.hunkNotes : null }, {
        prev: () => goTo(pos - 1),
        next: () => goTo(pos + 1),
        nextFile: () => goTo(firstHunkOf(((hunks[pos] ? hunks[pos].f : 0) + 1) % view.files.length)),
        pickFile: (f) => goTo(firstHunkOf(f)),
        up: () => { diffTop = Math.max(0, diffTop - STEP_ROWS); redraw() },
        down: () => { diffTop = Math.min(diffMaxTop, diffTop + STEP_ROWS); redraw() },
        leftward: () => { diffLeft = Math.max(0, diffLeft - STEP_COLS); redraw() },
        rightward: () => { diffLeft = Math.min(m.maxLeft, diffLeft + STEP_COLS); redraw() },
        back: () => { mode = 'explain'; redraw() },
      })
    }

    // ── 해설 화면 ──
    const failed = (err) => $.ui.log('해설 생성 실패: ' + err)
    const saveOpen = () => { $.store.set('open', ex.open).catch(() => {}) }
    const toggle = (id, show) => {
      ex.open = { ...ex.open, [id]: !ex.open[id] }
      if (ex.open[id]) {
        ex.current = id
        if (ex.sections[id].status === 'none') generateSection($, id).catch(failed)
      }
      saveOpen()
      redraw()
      if (show !== false && ex.open[id]) reveal('sec-' + id)
    }
    const codeFor = (at) => {
      const p = parseAt(at)
      if (!p) return null
      const file = view.files.find((f) => f.path === p.path) || view.files.find((f) => f.path.endsWith('/' + p.path) || p.path.endsWith('/' + f.path))
      const text = file && (p.deleted ? file.beforeText : file.afterText)
      if (!text) return null
      const all = text.split(/\r?\n/)
      const lines = []
      for (let n = p.start; n <= p.end && n <= all.length; n++) lines.push({ num: n, text: all[n - 1] })
      return lines.length ? { lines, deleted: p.deleted } : null
    }

    return explainView(el, cols, { turn: view.turn, files: view.files, ...ex, known: learning.known, codeFor }, {
      openDiff,
      toggle: (id) => toggle(id, true),
      toc: (id) => { if (!ex.open[id]) toggle(id, true); else reveal('sec-' + id) },
      toggleAll: (target) => { SECTIONS.forEach((s) => { if (!!ex.open[s.id] !== target) toggle(s.id, false) }) },
      regen: () => {
        if (ex.sections[ex.current].status === 'loading') return
        if (!ex.open[ex.current]) { toggle(ex.current, true); return }
        ex.sections[ex.current] = { status: 'none', data: null, error: null }
        generateSection($, ex.current).catch(failed)
      },
      goQuiz: () => { if (!ex.open.quiz) toggle('quiz', true); else reveal('sec-quiz') },
      easy: (id) => { explainEasier($, id).catch(failed) },
      askSection: (id, q) => { askInSection($, id, q).catch(failed) },
      ask: (q) => {
        askTurn($, q).catch(failed)
        $.ui.scroll({ in: PANE, to: { key: 'qa-' + ex.qa.length }, block: 'nearest' }).catch(() => {})
      },
      toggleKnown: (term) => {
        learning = { ...learning, known: learning.known.includes(term) ? learning.known.filter((x) => x !== term) : [...learning.known, term] }
        redraw()
        saveLearning($).catch(failed)
      },
      pick: (i, orig) => {
        ex.quiz = { ...ex.quiz, picked: ex.quiz.picked.map((x, j) => (j === i ? orig : x)) }
        if (ex.quiz.picked.every((x) => x === 0) && !ex.understood) {
          ex.understood = true
          markUnderstood($).catch(failed)
          $.ui.toast('#' + view.turn.seq + ' 턴을 이해함으로 표시했습니다')
        }
        redraw()
      },
      quizRetry: () => { ex.quiz = newQuiz(ex.sections.quiz.data); redraw() },
      seqShift: (delta, maxLeft) => { ex.seqLeft = Math.max(0, Math.min(maxLeft, ex.seqLeft + delta)); redraw() },
    })
  })
}
