// change-explainer: Claude가 턴마다 바꾼 파일을 기록하고, 원할 때 해설한다.
//
// 1단계: 변경 수집과 저장 / 2단계: diff 창 / 3단계: 해설 생성과 해설 창 / 4단계: 작업 목록(이 세션과 지난 세션의 턴)
// - 턴에서 파일을 처음 건드리기 직전의 내용(변경 전)과 턴이 끝난 뒤의 내용(변경 후)을 남긴다
// - 서브에이전트의 수정은 그 서브에이전트를 실행한 메인 턴에 붙인다
// - Bash로 바꾼 파일도 잡는다: Bash가 건드리는 git 저장소의 상태를 턴에서 처음 건드릴 때 남기고,
//   턴이 끝나면 지금 상태와 비교한다 (커밋, 수정, 새 파일, 삭제. 턴 전부터 있던 수정은 뺀다)
// - 도구 호출은 관찰만 한다. 막거나 바꾸지 않고 next(e)의 결과를 그대로 돌려준다
//
// 저장 위치: ~/.claude/explanations/<저장소>-<해시>/<세션 id>/
//   session.json                      세션 정보와 턴 목록
//   turns/<순번>-<turnId>/turn.json   턴 기록 (요청문, 답변, 파일별 줄 수)
//   turns/<순번>-<turnId>/before/…    변경 전 스냅숏, after/… 변경 후 스냅숏
//   turns/<순번>-<turnId>/views/…     생성한 섹션(JSON), Wait what 대화와 질문
// 저장소 단위: ~/.claude/explanations/<저장소>-<해시>/learning.json   Known 용어, 막혔던 섹션
//               ~/.claude/explanations/<저장소>-<해시>/usage.json      해설에 쓴 토큰 누적
// 지난 세션의 턴도 같은 위치·형식으로 남는다 (대화 기록과 git에서 복원)

import { commandDirs, parseNameStatus, parseStatus, projectDirName } from './git.js'
import { isWorkPath, localDay, madeByTurn, parseLog, promptText, turnsFromTranscript } from './history.js'
import { buildRows } from './diff.js'
import { SECTIONS, setLanguage, answerPrompt, easyPrompt, parseAt, retryPrompt, sectionPrompt, turnContext, validate } from './generate.js'
import { applyTheme } from './views/common.js'
import { diffCodeRows, diffModel, diffView, hunkList } from './views/diff.js'
import { explainView } from './views/explain.js'
import { listView } from './views/list.js'
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
// 화면: 'explain'(해설), 'diff', 'list'(작업 목록)
let mode = 'explain'
// 작업 목록 상태 (views/list.js 참고)
let list = null
// 플러그인 설정 (userConfig): language, theme, model
let options = {}
// 띄운 턴의 해설 상태: { dir, sections, open, current, threads, qa, quiz, seqLeft, understood }
let ex = null
// 저장소 단위 학습 기록: 이미 아는 용어, 막혔던 섹션 (다음 해설 프롬프트에 넣는다)
let learning = { known: [], stuck: [] }
const SECTION_TITLE = Object.fromEntries(SECTIONS.map((s) => [s.id, s.title]))

const pad = (n) => String(n).padStart(4, '0')

// 아직 기록이 없을 때: 무엇을 하면 되는지까지 알려 준다
const NOTHING_YET = [
  '이 세션에서 아직 기록된 변경이 없습니다.',
  'Claude에게 파일을 고치게 하고, 그 턴이 끝난 뒤 /explain 을 입력하세요.',
  '(이 mod를 불러오기 전에 한 변경은 기록되지 않습니다)',
].join('\n')

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

// ── Bash로 바꾼 파일 잡기 ────────────────────────────────────

// 한 턴에서 처음 기록할 때 미리 읽어 둘 파일 수 (턴 전부터 수정돼 있거나 추적 안 되는 파일)
const MAX_SNAPSHOT_FILES = 300
// 한 저장소에서 한 턴에 기록할 변경 파일 수
const MAX_BASH_FILES = 80

// 디렉토리 → git 최상위 ('' 이면 저장소가 아님). 세션 동안 기억한다
let topCache = {}

async function topOf($, dir) {
  if (dir in topCache) return topCache[dir]
  let top = ''
  try {
    if (await $.fs.exists(dir)) {
      const r = await git($, dir, ['rev-parse', '--show-toplevel'])
      top = r.ok ? r.out.trim() : ''
    }
  } catch {}
  topCache[dir] = top
  return top
}

// 파일을 저장할 때 쓸 상대 경로: 세션 저장소 안이면 그대로, 다른 저장소면 "저장소이름/경로", 아니면 _outside
function relFor(c, abs) {
  const base = c.root.replace(/\/$/, '') + '/'
  if (abs.startsWith(base)) return abs.slice(base.length)
  const top = Object.values(topCache).filter((t) => t && abs.startsWith(t + '/')).sort((a, b) => b.length - a.length)[0]
  if (top) return top.split('/').pop() + '/' + abs.slice(top.length + 1)
  return storedPath(abs, c.root)
}

// 저장소의 지금 상태: HEAD, 그리고 이미 수정돼 있거나 추적 안 되는 파일의 내용 (턴 전부터 있던 변경을 빼려고)
async function snapshotRepo($, top) {
  const head = await git($, top, ['rev-parse', 'HEAD'])
  if (!head.ok) return null
  const st = parseStatus((await git($, top, ['status', '--porcelain'])).out)
  const read = async (paths) => {
    const out = {}
    for (const p of paths.slice(0, MAX_SNAPSHOT_FILES)) out[p] = await readSnapshot($, top + '/' + p)
    return out
  }
  return { top, point: head.out.trim(), dirtyBefore: await read(st.dirty), untrackedBefore: await read(st.untracked), agents: [] }
}

// Bash 명령이 건드릴 저장소들을 찾아, 이 턴에서 처음이면 상태를 남긴다. 건드린 저장소 목록을 돌려준다
async function trackBashRepos($, turn, command, agent) {
  const c = await ensureCtx($)
  const home = await $.env.get('HOME')
  const tops = []
  for (const dir of [c.cwd, ...commandDirs(command, c.cwd, home)]) {
    const top = await topOf($, dir)
    if (!top || tops.includes(top)) continue
    tops.push(top)
    if (!(top in turn.repos)) turn.repos[top] = await snapshotRepo($, top)
    const repo = turn.repos[top]
    if (repo && agent && !repo.agents.some((a) => a.agentId === agent.agentId)) repo.agents.push(agent)
  }
  return tops
}

const asText = (v) => (typeof v === 'string' ? v : null)
const skippedOf = (v) => (v && typeof v === 'object' ? v.skipped : null)

// 턴 시작 상태와 지금을 비교해 바뀐 파일을 턴 기록에 넣는다. Edit/Write로 이미 잡은 파일은 그대로 둔다
async function finalizeRepo($, turn, top) {
  const repo = turn.repos[top]
  if (!repo) return
  const c = await ensureCtx($)
  const changed = new Map()
  for (const ch of parseNameStatus((await git($, top, ['diff', '--name-status', '-M', repo.point])).out)) changed.set(ch.path, ch.from)
  for (const p of parseStatus((await git($, top, ['status', '--porcelain'])).out).untracked) if (!changed.has(p)) changed.set(p, null)
  for (const p of [...Object.keys(repo.dirtyBefore), ...Object.keys(repo.untrackedBefore)]) if (!changed.has(p)) changed.set(p, null)

  let count = 0
  for (const [path, from] of changed) {
    if (count >= MAX_BASH_FILES) break
    const abs = top + '/' + path
    const existing = turn.files[abs]
    if (existing && !existing.fromBash) continue
    let before
    if (existing) before = existing.skipped ? { skipped: existing.skipped } : existing.before
    else if (path in repo.dirtyBefore) before = repo.dirtyBefore[path]
    else if (path in repo.untrackedBefore) before = repo.untrackedBefore[path]
    else {
      const show = await git($, top, ['show', repo.point + ':' + (from || path)])
      before = show.ok ? (looksBinary(show.out) ? { skipped: 'binary' } : show.out) : null
    }
    const after = await readSnapshot($, abs)
    const skipped = skippedOf(before) || skippedOf(after)
    // 이번 턴에 바뀌지 않은 파일 (턴 전부터 수정돼 있던 것 포함)
    if (!skipped && asText(before) === asText(after)) {
      if (existing) delete turn.files[abs]
      continue
    }
    let entry = newFileEntry(abs, relFor(c, abs), skipped ? undefined : asText(before), skipped)
    entry.fromBash = true
    for (const a of repo.agents.length ? repo.agents : [null]) entry = recordEdit(entry, 'Bash', a)
    turn.files[abs] = { ...entry, fromBash: true }
    count++
  }
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
async function loadView($, rec, at) {
  const c = await ensureCtx($)
  const dir = at || turnDir(c, rec)
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
    if (r.isAnswered) return { text: r.text, usage: r.usage }
    if (r.reason !== 'nothing-to-fork') return { error: r.reason + (r.status ? ' ' + r.status : ''), usage: r.usage }
  }
  // 설정 model이 있으면 그것, 없으면 세션 모델
  let model = options.model && options.model !== 'session' ? options.model : 'sonnet'
  if (!options.model || options.model === 'session') {
    try { model = (await $.session.model()) || model } catch {}
  }
  const r = await $.model.complete({
    model,
    system: '너는 코드 변경을 사용자에게 해설하는 도우미다. 요청한 JSON 객체 하나만 답한다.',
    prompt,
    maxTokens: 4000,
    timeoutMs: 120000,
  })
  return r.isAnswered ? { text: r.text, usage: r.usage } : { error: r.reason + (r.status ? ' ' + r.status : ''), usage: r.usage }
}

// ── 토큰 사용량 ──
// 모델이 보고한 사용량을 해설 단위(턴)와 저장소 단위로 쌓는다

const emptyUsage = () => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

function addUsage(total, u) {
  if (!u) return total
  return {
    calls: total.calls + 1,
    input: total.input + (u.input_tokens || 0),
    output: total.output + (u.output_tokens || 0),
    cacheRead: total.cacheRead + (u.cache_read_input_tokens || 0),
    cacheWrite: total.cacheWrite + (u.cache_creation_input_tokens || 0),
  }
}

// 저장소 누적 사용량 (작업 목록에 보인다)
let repoUsage = null

async function recordUsage($, target, u) {
  if (!u) return
  const c = await ensureCtx($)
  if (!repoUsage) {
    const saved = await readOrNull($, c.repoBase + '/usage.json')
    try { repoUsage = saved ? { ...emptyUsage(), ...JSON.parse(saved) } : emptyUsage() } catch { repoUsage = emptyUsage() }
  }
  repoUsage = addUsage(repoUsage, u)
  await saveJson($, c.repoBase + '/usage.json', repoUsage)
  if (target) {
    target.usage = addUsage(target.usage || emptyUsage(), u)
    await saveJson($, target.dir + '/views/usage.json', target.usage)
  }
}

// 프롬프트를 보내고 kind 형식으로 검증한다. 형식이 틀리면 한 번 더 요청한다. 쓴 토큰은 target에 기록
async function ask($, prompt, kind, check, target) {
  let reply = await callModel($, prompt)
  await recordUsage($, target, reply.usage)
  if (reply.error) return { ok: false, error: '모델 응답 없음(' + reply.error + ')' }
  let v = validate(kind, reply.text, check)
  if (v.ok) return v
  reply = await callModel($, prompt + '\n\n' + retryPrompt(v.error))
  await recordUsage($, target, reply.usage)
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
  const r = await ask($, sectionPrompt(id, context), id, context, target)
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
  const r = await ask($, easyPrompt(id, turnContext(view.turn, view.files, learning), target.sections[id].data, thread), 'text', null, target)
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
  const r = await ask($, answerPrompt(q, turnContext(view.turn, view.files, learning), section), 'text', null, target)
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
  const r = await ask($, answerPrompt(q, turnContext(view.turn, view.files, learning), null), 'text', null, target)
  target.qa = target.qa.map((x, j) => (j === i ? { ...x, a: r.ok ? r.value.text : '(답을 만들지 못했습니다: ' + r.error + ')' } : x))
  await saveThreads($, target)
  $.ui.invalidate('ui.render')
}

// 퀴즈를 다 맞히면 이해함으로 남긴다: 작업 폴더의 state.json, 이 세션의 턴이면 세션 목록에도
async function markUnderstood($) {
  const c = await ensureCtx($)
  const id = view.turn.turnId
  await saveJson($, view.dir + '/state.json', { understood: true })
  if (c.session.turns.some((t) => t.turnId === id)) {
    c.session = { ...c.session, turns: c.session.turns.map((t) => (t.turnId === id ? { ...t, understood: true } : t)) }
    await saveJson($, c.base + '/session.json', c.session)
  }
}

async function readUnderstood($, dir) {
  const text = await readOrNull($, dir + '/state.json')
  try { return !!(text && JSON.parse(text).understood) } catch { return false }
}

// 턴 하나를 해설 창에 띄운다: 저장해 둔 섹션·대화를 불러오고, 요약과 펼쳐 둔 섹션을 만든다
async function openTurn($, rec, at) {
  const c = await ensureCtx($)
  view = await loadView($, rec, at)
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
  const understood = !!(summary && summary.understood) || (await readUnderstood($, view.dir))
  let usage = emptyUsage()
  const savedUsage = await readOrNull($, view.dir + '/views/usage.json')
  try { if (savedUsage) usage = { ...usage, ...JSON.parse(savedUsage) } } catch {}
  ex = { dir: view.dir, sections, open, current: 'summary', threads, qa, quiz, seqLeft: 0, understood, usage }
  mode = 'explain'
  pos = 0
  diffTop = 0
  diffLeft = 0
  // 요약은 창을 열 때, 펼쳐 둔 섹션도 함께 만든다 (모두 처음 한 번만)
  for (const s of SECTIONS) {
    if (open[s.id] && sections[s.id].status === 'none') generateSection($, s.id).catch((err) => $.ui.log('생성 실패: ' + err))
  }
}

// ── 작업 목록: 이 세션과 지난 세션의 턴 ──────────────────────

async function git($, cwd, args) {
  try {
    const r = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 20000 })
    return { ok: r.exitCode === 0, out: r.stdout }
  } catch {
    return { ok: false, out: '' }
  }
}

// sh에 인자로 넘겨 실행한다 (경로를 스크립트 글에 끼워 넣지 않는다). sh가 없으면 빈 글
async function sh($, script, args) {
  try {
    const r = await $.process.run(['sh', '-c', script, 'sh', ...args], { timeoutMs: 60000 })
    return r.stdout || ''
  } catch {
    return ''
  }
}

// 이 프로젝트의 대화 기록 폴더 (세션을 연 디렉토리 기준)
async function transcriptsDir($) {
  const c = await ensureCtx($)
  return (await $.env.get('HOME')) + '/.claude/projects/' + projectDirName(c.cwd)
}


const MAX_SESSIONS = 30
const SCAN_SESSIONS = 120

// 세션 파일마다: 바꾼 흔적이 있으면 @@CHANGED (Claude 메모리·임시 폴더가 아닌 곳의 Edit/Write, 또는 git commit. 서브에이전트 기록 포함),
// 그리고 앞쪽 사용자 줄 몇 개 (제목용)
const SCAN_SCRIPT = [
  'for f in "$@"; do',
  '  echo "@@F $f"',
  '  sub="${f%.jsonl}/subagents"',
  '  if { cat "$f"; [ -d "$sub" ] && cat "$sub"/*.jsonl; } 2>/dev/null | grep -E \'"name":"(Edit|Write|MultiEdit)"|"command":"[^"]*git [^"]*commit\' | grep -v -E \'"file_path":"[^"]*(/[.]claude/|/tmp/claude-)\' | grep -q .; then echo "@@CHANGED"; fi',
  '  grep -m 12 -E \'"type":"user"\' "$f" | grep -v \'"tool_result"\'',
  'done',
].join('\n')

// 지난 세션 목록: 최근에 쓴 것부터, 무언가 바꾼 세션만. 제목은 첫 요청, 시각은 마지막으로 쓴 때
async function listSessions($) {
  const c = await ensureCtx($)
  const dir = await transcriptsDir($)
  let entries = []
  try { entries = await $.fs.list(dir) } catch {}
  const files = entries
    .filter((x) => x.kind === 'file' && x.name.endsWith('.jsonl') && x.name.slice(0, -6) !== c.sessionId)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, SCAN_SESSIONS)
  const scan = {}
  let cur = null
  for (const line of (await sh($, SCAN_SCRIPT, files.map((f) => dir + '/' + f.name))).split('\n')) {
    if (line.startsWith('@@F ')) scan[(cur = line.slice(4).split('/').pop())] = { changed: false, title: '' }
    else if (!cur) continue
    else if (line === '@@CHANGED') scan[cur].changed = true
    else if (!scan[cur].title) {
      let o = null
      try { o = JSON.parse(line) } catch {}
      const text = promptText(o)
      if (text) scan[cur].title = text.split('\n')[0].slice(0, 60)
    }
  }
  const out = []
  for (const f of files) {
    const s = scan[f.name]
    if (!s || !s.changed || !s.title) continue
    out.push({ id: f.name.slice(0, -6), title: s.title, at: localDay(f.mtimeMs), size: f.size, turns: null, status: 'idle' })
    if (out.length >= MAX_SESSIONS) break
  }
  return out
}

// 그 턴이 다룬 git 저장소: Edit/Write 파일이 있는 곳, Bash 명령의 경로, 세션 디렉토리
async function turnRepos($, t) {
  const c = await ensureCtx($)
  const home = await $.env.get('HOME')
  const dirs = new Set([c.cwd])
  for (const path of Object.keys(t.files)) dirs.add(path.slice(0, path.lastIndexOf('/')) || '/')
  for (const cmd of t.bashCommands) for (const d of commandDirs(cmd, c.cwd, home)) dirs.add(d)
  const tops = new Set()
  for (const d of dirs) {
    const top = await topOf($, d)
    if (top) tops.add(top)
  }
  return [...tops]
}

// 그 턴의 시간 범위에 내가(저장소의 user.email) 만든 커밋. 병합 커밋 제외, 오래된 것부터
async function turnCommits($, top, t) {
  const email = (await git($, top, ['config', 'user.email'])).out.trim()
  const args = ['log', '--all', '--no-merges', '--reverse', '--since=' + t.startAt, '--until=' + t.endAt, '--format=%H%x09%cI%x09%s']
  if (email) args.push('--author=' + email)
  return parseLog((await git($, top, args)).out).filter((cm) => madeByTurn(cm.subject, t.bashCommands))
}

// 세션 하나의 턴들을 대화 기록에서 복원한다 (펼칠 때). 서브에이전트 기록도 함께
async function loadSessionTurns($, sessionId) {
  const dir = await transcriptsDir($)
  const file = dir + '/' + sessionId + '.jsonl'
  // 요청·설명·도구 호출 줄, 그리고 편집 결과(고치기 전 파일이 든 줄)만. 아주 긴 줄은 편집 결과일 때만
  const mainScript = '{ grep -E "\\"type\\":\\"(user|assistant)\\"" "$1" | grep -v "\\"tool_result\\"" | awk \'length($0) < 500000\'; grep -F "\\"originalFile\\"" "$1"; } 2>/dev/null'
  const main = (await sh($, mainScript, [file])).split('\n')
  const subScript = 'for f in "$1"/subagents/*.jsonl; do [ -f "$f" ] || continue; echo "@@AGENT $(basename "$f" .jsonl)"; grep -h -E "\\"name\\":\\"(Edit|Write|MultiEdit)\\"|\\"originalFile\\"" "$f"; done 2>/dev/null'
  const agentLines = []
  let agent = ''
  for (const line of (await sh($, subScript, [dir + '/' + sessionId])).split('\n')) {
    if (line.startsWith('@@AGENT ')) agent = line.slice(8)
    else if (line) agentLines.push({ agent, line })
  }
  const home = await $.env.get('HOME')
  const out = []
  const turns = turnsFromTranscript(main, agentLines)
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]
    // Claude 메모리나 임시 작업 폴더를 고친 것은 작업 결과가 아니다
    for (const path of Object.keys(t.files)) if (!isWorkPath(path, home)) delete t.files[path]
    // 실제로 바뀐 것이 있는 턴만: Edit/Write 변경, 또는 그 시간대의 커밋
    const subjects = []
    if (t.bashCommands.length) for (const top of await turnRepos($, t)) for (const cm of await turnCommits($, top, t)) subjects.push(cm.subject)
    const files = Object.keys(t.files).length
    // "가자"처럼 짧은 요청만으로는 무슨 턴인지 모른다: 커밋 메시지와 바꾼 파일 이름을 함께 보여 준다
    const fileNames = Object.keys(t.files).map((x) => x.split('/').pop())
    if (files || subjects.length) out.push({ ...t, seq: i + 1, files, commits: subjects.length, subjects, fileNames })
  }
  return out
}

// 지난 턴 하나를 턴 기록으로 만든다: Edit/Write는 대화 기록에서, Bash로 바꾼 것은 그 턴 시간 범위의 커밋에서
async function reconstructTurn($, sessionId, t) {
  const c = await ensureCtx($)
  // 그 시간 범위에 내가 만든 커밋에서 바뀐 파일
  const files = {}
  const commits = []
  for (const top of await turnRepos($, t)) {
    for (const cm of await turnCommits($, top, t)) {
      commits.push({ ...cm, repo: top.split('/').pop() })
      for (const ch of parseNameStatus((await git($, top, ['show', '--name-status', '-M', '--format=', cm.sha])).out)) {
        const abs = top + '/' + ch.path
        if (!files[abs]) {
          const prev = ch.status === 'A' ? { ok: false } : await git($, top, ['show', cm.sha + '^:' + (ch.from || ch.path)])
          files[abs] = { before: prev.ok ? prev.out : null, tools: ['git commit'] }
        }
        const now = ch.status === 'D' ? { ok: true, out: '' } : await git($, top, ['show', cm.sha + ':' + ch.path])
        files[abs].after = now.ok ? now.out : null
      }
    }
  }
  // Edit/Write: 변경 전은 대화 기록의 것(더 이르다), 변경 후는 커밋된 것이 있으면 그것
  for (const [abs, f] of Object.entries(t.files)) {
    if (files[abs]) files[abs] = { ...files[abs], before: f.before, tools: [...new Set([...f.tools, ...files[abs].tools])], agents: f.agents, skipped: f.skipped }
    else files[abs] = { ...f }
  }

  const turn = newTurn('h-' + t.id, t.request, 0)
  const afters = {}
  for (const [abs, f] of Object.entries(files)) {
    const skipped = f.skipped || (typeof f.before === 'string' && looksBinary(f.before)) || (typeof f.after === 'string' && looksBinary(f.after)) ? f.skipped || 'binary' : null
    let entry = newFileEntry(abs, relFor(c, abs), skipped ? undefined : f.before, skipped)
    for (const tool of f.tools) entry = recordEdit(entry, tool, null)
    for (const a of f.agents || []) entry = recordEdit(entry, f.tools[0], { agentId: a, type: null })
    turn.files[abs] = entry
    afters[abs] = typeof f.after === 'string' ? f.after : null
  }
  const commitText = commits.length ? '\n\n## 이 턴에 만든 커밋\n' + commits.map((x) => '- ' + x.repo + ' ' + x.sha.slice(0, 9) + ' ' + x.subject).join('\n') : ''
  const record = turnRecord(turn, afters, {
    kind: 'past',
    sessionId,
    seq: t.seq,
    answer: t.answer,
    endedAt: t.endAt,
    context: t.excerpt + commitText,
    commits: commits.map((x) => ({ repo: x.repo, sha: x.sha, subject: x.subject })),
  })
  const dir = c.repoBase + '/' + sessionId + '/turns/' + pad(t.seq) + '-h-' + t.id
  for (const x of Object.values(turn.files)) {
    if (x.skipped) continue
    if (typeof x.before === 'string') await $.fs.write(dir + '/before/' + x.rel, x.before)
    if (typeof afters[x.abs] === 'string') await $.fs.write(dir + '/after/' + x.rel, afters[x.abs])
  }
  await saveJson($, dir + '/turn.json', record)
  return { record, dir }
}

// 작업 목록을 만든다: 이 세션의 턴(기록) + 지난 세션(펼치면 턴을 복원)
async function loadList($) {
  const c = await ensureCtx($)
  if (!repoUsage) {
    const saved = await readOrNull($, c.repoBase + '/usage.json')
    try { repoUsage = saved ? { ...emptyUsage(), ...JSON.parse(saved) } : emptyUsage() } catch { repoUsage = emptyUsage() }
  }
  const turns = []
  for (const t of c.session.turns) turns.push({ ...t, understood: t.understood || (await readUnderstood($, turnDir(c, t))) })
  list = { status: 'loading', progress: '지난 세션을 찾는 중…', turns, sessions: [], usage: repoUsage, error: '' }
  $.ui.invalidate('ui.render')
  list = { ...list, sessions: await listSessions($), status: 'done', progress: '' }
  $.ui.invalidate('ui.render')
}

// 지난 세션 하나를 펼친다: 턴을 복원하고, 이미 해설한 턴이면 이해 여부를 표시
async function expandSession($, sessionId) {
  const c = await ensureCtx($)
  const set = (patch) => {
    list = { ...list, sessions: list.sessions.map((x) => (x.id === sessionId ? { ...x, ...patch } : x)) }
    $.ui.invalidate('ui.render')
  }
  set({ status: 'loading' })
  const turns = await loadSessionTurns($, sessionId)
  for (const t of turns) t.understood = await readUnderstood($, c.repoBase + '/' + sessionId + '/turns/' + pad(t.seq) + '-h-' + t.id)
  set({ status: 'open', turns })
}

// ── 훅 ─────────────────────────────────────────────────────

export function register(on, opts) {
  options = opts || {}
  applyTheme(options.theme)
  setLanguage(options.language)
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'explain',
        description: 'Claude가 바꾼 내용 해설 (마지막 변경 턴). list: 이 세션의 턴과 브랜치 작업 목록',
        argumentHint: '[list]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('/explain 등록 실패: ' + err)
    }
    // 개발용 명령은 CHANGE_EXPLAINER_DEV=1 일 때만
    if ((await $.env.get('CHANGE_EXPLAINER_DEV')) === '1') try {
      await $.command.register({
        name: 'explain-check',
        description: '(개발용) 마지막 변경 턴의 해설 섹션 하나를 실제로 만들어 JSON으로 출력',
        argumentHint: '[섹션] [세션 id 앞부분/턴 번호]',
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
        await topOf($, abs.slice(0, abs.lastIndexOf('/')) || '/')
        turn.files[abs] = newFileEntry(abs, relFor(c, abs), skipped ? undefined : before, skipped)
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

  // Bash: 실행 전에 건드릴 저장소의 상태를 남긴다 (턴마다 저장소당 한 번)
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const turnId = e.agentId ? agentTurn[e.agentId] : current && current.turnId
    const turn = !turnId ? null : current && current.turnId === turnId ? current : finished[turnId] && finished[turnId].turn
    if (!turn || typeof e.command !== 'string') return next(e)
    const agent = e.agentId ? { agentId: e.agentId, type: agentType[e.agentId] || null } : null
    let tops = []
    try { tops = await trackBashRepos($, turn, e.command, agent) } catch (err) { $.ui.log('저장소 상태 기록 실패: ' + err) }
    const result = await next(e)
    // 메인 턴이 이미 끝난 뒤의 명령(백그라운드 서브에이전트)이면 그 저장소를 다시 비교해 저장한다
    if (finished[turnId] && tops.length) {
      try {
        for (const top of tops) await finalizeRepo($, turn, top)
        await saveTurn($, turnId)
      } catch (err) { $.ui.log('턴 기록 갱신 실패: ' + err) }
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
    // Bash가 건드린 저장소: 턴 시작 상태와 지금을 비교해 바뀐 파일을 넣는다
    for (const top of Object.keys(turn.repos)) {
      try { await finalizeRepo($, turn, top) } catch (err) { $.ui.log('Bash 변경 비교 실패: ' + top + ': ' + err) }
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
  on('command.run', { command: 'explain' }, async ($, e) => {
    const arg = (e.args || '').trim()
    const hasSurface = (await $.session.surfaces()).length > 0
    const openPane = async () => {
      const opened = await $.ui.open({ id: PANE, title: '변경 해설', focus: true, closeOnEscape: true, columns: WANT_COLUMNS })
      return opened && opened.isPlaced
    }
    // /explain list: 이 세션의 턴과 브랜치 작업 목록
    if (/^(list|목록|branches|history)$/.test(arg)) {
      // 화면이 없으면 목록을 글로 (claude -p에서 확인용)
      if (!hasSurface) {
        await loadList($)
        const lines = []
        for (const t of list.turns) lines.push('#' + t.seq + '  ' + t.title + '  파일 ' + t.files + '  +' + t.added + ' −' + t.removed)
        for (const ses of list.sessions) {
          const turns = await loadSessionTurns($, ses.id)
          if (!turns.length) continue
          lines.push('', ses.at + '  ' + ses.title + '  [' + ses.id.slice(0, 8) + ']')
          for (const t of turns) {
            lines.push('  #' + t.seq + '  ' + t.request.split('\n')[0].slice(0, 60))
            for (const subject of t.subjects) lines.push('      커밋: ' + subject)
            if (t.fileNames.length) lines.push('      파일: ' + t.fileNames.join(', '))
          }
        }
        const u = list.usage
        lines.push('', '해설에 쓴 토큰 (이 저장소 누적): 호출 ' + u.calls + '회, 입력 ' + u.input + ' (캐시 읽기 ' + u.cacheRead + ', 캐시 쓰기 ' + u.cacheWrite + '), 출력 ' + u.output)
        return { text: lines.join('\n') }
      }
      mode = 'list'
      loadList($).catch((err) => $.ui.log('목록을 만들지 못함: ' + err))
      return (await openPane()) ? {} : { text: '창을 열지 못했습니다. 터미널을 넓혀 주세요.' }
    }
    const rec = await latestRecord($)
    if (!rec) {
      // 이 세션에 기록이 없으면 지난 작업 목록을 보여 준다
      if (!hasSurface) return { text: NOTHING_YET }
      mode = 'list'
      loadList($).catch((err) => $.ui.log('목록을 만들지 못함: ' + err))
      return (await openPane()) ? {} : { text: NOTHING_YET }
    }
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
    const [id = 'summary', target] = (e.args || '').trim().split(/\s+/)
    if (!SECTION_TITLE[id]) return { text: '섹션 이름: ' + SECTIONS.map((s) => s.id).join(', ') }
    if (target) {
      // 지난 세션의 턴: "<세션 id 앞부분>/<턴 번호>"
      const [prefix, num] = target.split('/')
      await loadList($)
      const ses = list.sessions.find((x) => x.id.startsWith(prefix))
      if (!ses) return { text: '세션을 찾지 못했습니다: ' + prefix }
      const turns = await loadSessionTurns($, ses.id)
      const t = num ? turns.find((x) => String(x.seq) === num) : turns[turns.length - 1]
      if (!t) return { text: '변경이 있는 턴을 찾지 못했습니다. 있는 턴: ' + turns.map((x) => x.seq).join(', ') }
      const { record, dir } = await reconstructTurn($, ses.id, t)
      view = await loadView($, record, dir)
    } else {
      const rec = await latestRecord($)
      if (!rec) return { text: NOTHING_YET }
      view = await loadView($, rec)
    }
    const context = turnContext(view.turn, view.files, learning)
    const used = { dir: view.dir, usage: emptyUsage() }
    const r = await ask($, sectionPrompt(id, context), id, context, used)
    const u = used.usage
    const usageLine = '\n토큰: 호출 ' + u.calls + '회, 입력 ' + u.input + ' (캐시 읽기 ' + u.cacheRead + ', 캐시 쓰기 ' + u.cacheWrite + '), 출력 ' + u.output
    return { text: (r.ok ? JSON.stringify(r.value, null, 2) : '실패: ' + r.error) + usageLine }
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
    const cols = e.props.bodyColumns || 100
    const failedList = (err) => $.ui.log('작업 목록 오류: ' + err)
    const showList = () => {
      mode = 'list'
      if (!list) loadList($).catch(failedList)
      $.ui.invalidate('ui.render')
      $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {})
    }

    // ── 작업 목록 ──
    if (mode === 'list' || !view) {
      if (!list) return el.Text({ color: '#858b94', children: ['작업을 찾는 중…'] })
      return listView(el, cols, list, {
        refresh: () => { if (list.status !== 'loading') loadList($).catch(failedList) },
        back: view ? () => { mode = 'explain'; $.ui.invalidate('ui.render') } : null,
        openTurn: async (t) => {
          const c = await ensureCtx($)
          const text = await readOrNull($, turnDir(c, t) + '/turn.json')
          if (!text) return
          await openTurn($, JSON.parse(text))
          $.ui.invalidate('ui.render')
          $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {})
        },
        toggleSession: (ses) => {
          if (ses.status === 'open') {
            list = { ...list, sessions: list.sessions.map((x) => (x.id === ses.id ? { ...x, status: 'idle' } : x)) }
            $.ui.invalidate('ui.render')
            return
          }
          if (ses.turns) {
            list = { ...list, sessions: list.sessions.map((x) => (x.id === ses.id ? { ...x, status: 'open' } : x)) }
            $.ui.invalidate('ui.render')
            return
          }
          expandSession($, ses.id).catch(failedList)
        },
        openPast: async (ses, t) => {
          list = { ...list, progress: '#' + t.seq + ' 턴을 대화 기록과 git에서 복원하는 중…', status: 'loading' }
          $.ui.invalidate('ui.render')
          try {
            const { record, dir } = await reconstructTurn($, ses.id, t)
            await openTurn($, record, dir)
          } catch (err) {
            list = { ...list, error: '복원하지 못했습니다: ' + err }
          }
          list = { ...list, status: 'done', progress: '' }
          $.ui.invalidate('ui.render')
          $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {})
        },
      })
    }
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
      list: showList,
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
