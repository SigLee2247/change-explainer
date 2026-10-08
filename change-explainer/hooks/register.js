// change-explainer: Claude가 턴마다 바꾼 파일을 기록하고, 원할 때 해설한다.
//
// 1단계: 변경 수집과 저장 / 2단계: diff 창 / 3단계: 해설 생성과 해설 창 / 4단계: 작업 목록(이 세션의 턴, 브랜치 작업)
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
// 브랜치 작업:  ~/.claude/explanations/<워크트리>-<해시>/branches/<브랜치>/   턴과 같은 형식

import { baseCandidates, candidateDirs, conversationExcerpt, parseNameStatus, parseShortstat, parseWorktrees, projectDirName, slug, ticketKey } from './branches.js'
import { buildRows } from './diff.js'
import { SECTIONS, answerPrompt, easyPrompt, parseAt, retryPrompt, sectionPrompt, turnContext, validate } from './generate.js'
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
// 플러그인 설정 (userConfig): base_branches
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
  ex = { dir: view.dir, sections, open, current: 'summary', threads, qa, quiz, seqLeft: 0, understood }
  mode = 'explain'
  pos = 0
  diffTop = 0
  diffLeft = 0
  // 요약은 창을 열 때, 펼쳐 둔 섹션도 함께 만든다 (모두 처음 한 번만)
  for (const s of SECTIONS) {
    if (open[s.id] && sections[s.id].status === 'none') generateSection($, s.id).catch((err) => $.ui.log('생성 실패: ' + err))
  }
}

// ── 작업 목록: 브랜치(워크트리) 작업 찾기 ──────────────────────

async function git($, cwd, args) {
  try {
    const r = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 20000 })
    return { ok: r.exitCode === 0, out: r.stdout }
  } catch {
    return { ok: false, out: '' }
  }
}

// sh에 인자로 넘겨 실행한다 (경로를 스크립트 글에 끼워 넣지 않는다)
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

// 대화 기록에서 Claude가 다룬 경로들을 모아 git 저장소를 찾는다: [{ key, name, tops: [워크트리 경로] }]
async function discoverRepos($) {
  const c = await ensureCtx($)
  const home = await $.env.get('HOME')
  const dir = await transcriptsDir($)
  const found = await sh($, 'cd "$1" 2>/dev/null || exit 0; grep -rhoE --include="*.jsonl" "\\"(file_path|cwd)\\":\\"[^\\"]+\\"|cd +[^ &;|\\"\\\\]+" . | sort -u | head -5000', [dir])
  const dirs = [c.root, ...candidateDirs(found.split('\n'), home)]
  const repos = new Map()
  const tops = []
  for (const d of dirs.slice(0, 300)) {
    if (tops.some((t) => d === t || d.startsWith(t + '/'))) continue
    // 대화에 나온 원격 서버 경로 등은 확인할 수 없다: 실패하면 그 경로만 건너뛴다
    let exists = false
    try { exists = await $.fs.exists(d) } catch {}
    if (!exists) continue
    const top = await git($, d, ['rev-parse', '--show-toplevel'])
    if (!top.ok) continue
    const root = top.out.trim()
    tops.push(root)
    const common = await git($, root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    const key = common.ok ? common.out.trim() : root + '/.git'
    if (!repos.has(key)) {
      const name = key.replace(/\/\.git\/?$/, '').split('/').pop()
      repos.set(key, { key, name, root })
    }
  }
  return [...repos.values()]
}

// 기준의 기본값: 브랜치를 만든 시점 (reflog). 병합된 작업도, 오래된 로컬 develop도 문제없다
export const AUTO = 'auto'

// 기준 브랜치: 저장소마다 고른 값, 없으면 자동(브랜치를 만든 시점, 그것도 없으면 설정의 후보 중 가장 가까운 것)
async function resolveBase($, repo) {
  const refs = await git($, repo.root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin'])
  const names = refs.out.split('\n').map((x) => x.trim()).filter((x) => x && x !== 'origin/HEAD' && x !== 'origin')
  const has = (b) => names.includes(b)
  const pick = (b) => (has(b) ? b : has('origin/' + b) ? 'origin/' + b : '')
  let chosen = ''
  try { chosen = (await $.store.get('base:' + repo.key)) || '' } catch {}
  const candidates = baseCandidates(options.base_branches)
  const base = chosen && (chosen === AUTO || has(chosen)) ? chosen : AUTO
  // 후보의 로컬과 origin 둘 다: 로컬이 오래됐을 수 있어서 가까운 쪽을 고른다
  const fallbacks = candidates.flatMap((b) => [b, 'origin/' + b]).filter(has)
  const preferred = [...candidates, 'develop', 'main', 'master'].flatMap((b) => ['origin/' + b, b]).filter(has)
  const local = names.filter((n) => !n.startsWith('origin/'))
  const baseOptions = [...new Set([AUTO, base, ...preferred, ...local])].filter(Boolean).slice(0, 40)
  return { base, baseOptions, fallbacks }
}

// 브랜치가 시작된 지점: { point, label }. 고른 기준이 있으면 그것과의 merge-base
async function branchPoint($, wt, repo) {
  // 기준 브랜치 자체(develop, main 등)에서 하는 작업은 커밋하지 않은 변경만 본다
  const mainline = [...baseCandidates(options.base_branches), 'master']
  if (mainline.includes(wt.branch)) {
    const head = await git($, wt.path, ['rev-parse', 'HEAD'])
    return head.ok ? { point: head.out.trim(), label: '마지막 커밋', uncommittedOnly: true } : null
  }
  if (repo.base !== AUTO) {
    const mb = await git($, wt.path, ['merge-base', 'HEAD', repo.base])
    return mb.ok ? { point: mb.out.trim(), label: repo.base } : null
  }
  // reflog의 가장 오래된 항목이 브랜치를 만든 순간이다 ("branch: Created from origin/main")
  const log = (await git($, wt.path, ['reflog', 'show', '--format=%H %gs', 'refs/heads/' + wt.branch])).out.trim().split('\n').filter(Boolean)
  const first = log[log.length - 1]
  if (first) {
    const m = /^(\S+) branch: Created from (.+)$/.exec(first)
    if (m) return { point: m[1], label: m[2] + '에서 만든 시점' }
  }
  // reflog가 없으면 후보들 중 가장 가까운(앞선 커밋이 가장 적은) 지점
  let best = null
  for (const b of repo.fallbacks || []) {
    const mb = await git($, wt.path, ['merge-base', 'HEAD', b])
    if (!mb.ok) continue
    const n = Number((await git($, wt.path, ['rev-list', '--count', mb.out.trim() + '..HEAD'])).out.trim() || 0)
    if (!best || n < best.n) best = { point: mb.out.trim(), label: b, n }
  }
  return best ? { point: best.point, label: best.label } : null
}

const branchDir = async ($, path, branch) => (await $.env.get('HOME')) + '/.claude/explanations/' + (await repoFolder(path)) + '/branches/' + slug(branch)

// 워크트리 하나의 작업 요약. 시작 지점보다 앞선 커밋도, 고친 파일도 없으면 null
async function branchItem($, wt, repo) {
  if (!wt.branch || wt.branch === repo.base || 'origin/' + wt.branch === repo.base) return null
  const bp = await branchPoint($, wt, repo)
  if (!bp) return null
  const mb = bp.point
  const ahead = Number((await git($, wt.path, ['rev-list', '--count', mb + '..HEAD'])).out.trim() || 0)
  const stat = parseShortstat((await git($, wt.path, ['diff', '--shortstat', mb])).out)
  if (!ahead && !stat.files) return null
  const dirty = !!(await git($, wt.path, ['status', '--porcelain', '--untracked-files=no'])).out.trim()
  const date = (await git($, wt.path, ['log', '-1', '--format=%cI'])).out.trim()
  const subjects = (await git($, wt.path, ['log', '--format=%s', mb + '..HEAD'])).out.split('\n').filter(Boolean).reverse()
  const ticket = ticketKey(wt.branch)
  // 제목: 티켓 키가 들어간 첫 커밋, 없으면 첫 커밋
  const subject = bp.uncommittedOnly ? '커밋하지 않은 변경 (' + wt.branch + ')' : subjects.find((x) => ticket && x.includes(ticket)) || subjects[0] || ''
  const dir = await branchDir($, wt.path, wt.branch)
  return {
    id: slug(wt.path),
    path: wt.path,
    branch: wt.branch,
    ticket,
    mb,
    baseLabel: bp.label,
    ahead,
    files: stat.files,
    added: stat.added,
    removed: stat.removed,
    dirty,
    date,
    subject,
    subjects,
    dir,
    understood: await readUnderstood($, dir),
  }
}

// 저장소 하나의 브랜치 작업들
async function repoItems($, repo) {
  const resolved = { ...repo, ...(await resolveBase($, repo)) }
  const items = []
  const wts = parseWorktrees((await git($, repo.root, ['worktree', 'list', '--porcelain'])).out)
  for (const wt of wts) {
    const item = await branchItem($, wt, resolved)
    if (item) items.push(item)
  }
  items.sort((a, b) => (a.date < b.date ? 1 : -1))
  return { ...resolved, items }
}

// 작업 목록을 처음부터 만든다. 저장소를 하나씩 찾을 때마다 화면에 보인다
async function loadList($) {
  const c = await ensureCtx($)
  const turns = []
  for (const t of c.session.turns) turns.push({ ...t, understood: t.understood || (await readUnderstood($, turnDir(c, t))) })
  list = { status: 'loading', progress: '대화 기록에서 다룬 저장소를 찾는 중…', turns, repos: [], error: '' }
  $.ui.invalidate('ui.render')
  const repos = await discoverRepos($)
  for (let i = 0; i < repos.length; i++) {
    list = { ...list, progress: '저장소 ' + (i + 1) + '/' + repos.length + ' 확인 중: ' + repos[i].name }
    $.ui.invalidate('ui.render')
    const r = await repoItems($, repos[i])
    list = { ...list, repos: [...list.repos, r] }
  }
  list = { ...list, status: 'done', progress: '' }
  $.ui.invalidate('ui.render')
}

// 이 작업을 다룬 대화를 발췌한다: 워크트리 경로·브랜치 이름·티켓 키가 나온 세션들에서, 그 언급 주변만
async function branchConversation($, item) {
  const dir = await transcriptsDir($)
  const keys = [item.path, item.branch, item.ticket].filter(Boolean)
  const files = (await sh($, 'cd "$1" 2>/dev/null || exit 0; grep -rlF --include="*.jsonl" -e "$2" -e "$3" . | head -6', [dir, item.path, item.branch])).split('\n').filter(Boolean)
  const parts = []
  for (const f of files.slice(0, 4)) {
    // 사용자·Claude 줄만. 아주 긴 줄(도구 입력 등)은 언급이 있을 때만 남긴다
    const script = 'grep -E "\\"type\\":\\"(user|assistant)\\"" "$1" | grep -v "\\"tool_result\\"" | awk -v a="$2" -v b="$3" -v c="$4" \'length($0) < 20000 || index($0, a) || index($0, b) || (c != "" && index($0, c))\' | tail -c 3000000'
    const lines = (await sh($, script, [dir + '/' + f.replace(/^\.\//, ''), item.path, item.branch, item.ticket || ''])).split('\n')
    const text = conversationExcerpt(lines, Math.floor(14000 / Math.min(files.length, 4)), keys)
    if (text) parts.push('### 세션 ' + f.replace(/^\.\//, '').slice(0, 8) + '\n' + text)
  }
  return parts.join('\n\n')
}

// 브랜치 작업을 턴과 같은 형식으로 가져온다: 갈라진 지점(merge-base)의 내용이 변경 전, 지금 파일이 변경 후
async function importBranch($, repo, item) {
  const changes = parseNameStatus((await git($, item.path, ['diff', '--name-status', '-M', item.mb])).out)
  const untracked = (await git($, item.path, ['ls-files', '--others', '--exclude-standard'])).out.split('\n').filter(Boolean)
  for (const p of untracked) changes.push({ status: 'A', path: p, from: null })
  const turn = newTurn('branch-' + slug(item.branch), '', 0)
  const afters = {}
  for (const ch of changes.slice(0, 80)) {
    const abs = item.path + '/' + ch.path
    let before = null
    if (ch.status !== 'A') {
      const show = await git($, item.path, ['show', item.mb + ':' + (ch.from || ch.path)])
      before = show.ok ? show.out : null
    }
    const after = ch.status === 'D' ? '' : await readSnapshot($, abs)
    const skipped = after && typeof after === 'object' ? after.skipped : before && looksBinary(before) ? 'binary' : null
    turn.files[abs] = recordEdit(newFileEntry(abs, ch.path, skipped ? undefined : before, skipped), 'git', null)
    afters[abs] = typeof after === 'string' ? after : null
  }
  const request = [
    '브랜치 ' + item.branch + ' (' + repo.name + ', 기준: ' + item.baseLabel + ')의 작업 전체.',
    item.subjects.length ? '커밋 (오래된 것부터):\n- ' + item.subjects.join('\n- ') : '아직 커밋하지 않은 변경만 있음',
    item.dirty ? '커밋하지 않은 변경도 포함.' : '',
  ].filter(Boolean).join('\n')
  const record = turnRecord(turn, afters, {
    kind: 'branch',
    sessionId: 'branch',
    seq: item.ahead,
    branch: item.branch,
    base: item.baseLabel,
    repo: repo.name,
    worktree: item.path,
    endedAt: item.date,
    answer: '',
    context: await branchConversation($, item),
  })
  record.title = (item.ticket ? item.ticket + '  ' : '') + (item.subject || item.branch)
  record.request = request
  for (const x of Object.values(turn.files)) {
    if (x.skipped) continue
    if (typeof x.before === 'string') await $.fs.write(item.dir + '/before/' + x.rel, x.before)
    if (typeof afters[x.abs] === 'string') await $.fs.write(item.dir + '/after/' + x.rel, afters[x.abs])
  }
  await saveJson($, item.dir + '/turn.json', record)
  return record
}

// ── 훅 ─────────────────────────────────────────────────────

export function register(on, opts) {
  options = opts || {}
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
    try {
      await $.command.register({
        name: 'explain-check',
        description: '(개발용) 마지막 변경 턴의 해설 섹션 하나를 실제로 만들어 JSON으로 출력',
        argumentHint: '[섹션] [티켓 키나 브랜치]',
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
        for (const r of list.repos) {
          lines.push('', r.name + '  (기준: ' + (r.base === AUTO ? '자동, 브랜치를 만든 시점' : r.base) + ')')
          for (const x of r.items) {
            lines.push('  ' + (x.ticket ? x.ticket + '  ' : '') + (x.subject || x.branch) + '  [' + x.branch + ', ' + x.baseLabel + ']')
            lines.push('    커밋 ' + x.ahead + '  파일 ' + x.files + '  +' + x.added + ' −' + x.removed + (x.dirty ? '  커밋 안 한 변경 있음' : '') + '  ' + x.date.slice(0, 10) + (x.understood ? '  ✓ 이해함' : ''))
          }
          if (!r.items.length) lines.push('  (진행 중인 브랜치 작업 없음)')
        }
        return { text: lines.length ? lines.join('\n') : '가져올 작업이 없습니다.' }
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
      // 브랜치 작업: 티켓 키나 브랜치 이름으로 찾아 가져온다
      await loadList($)
      let hit = null
      for (const r of list.repos) for (const x of r.items) if (!hit && (x.ticket === target || x.branch === target || x.path.endsWith('/' + target))) hit = { r, x }
      if (!hit) return { text: '작업을 찾지 못했습니다: ' + target }
      const rec = await importBranch($, hit.r, hit.x)
      view = await loadView($, rec, hit.x.dir)
    } else {
      const rec = await latestRecord($)
      if (!rec) return { text: NOTHING_YET }
      view = await loadView($, rec)
    }
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
        openBranch: async (repo, item) => {
          list = { ...list, progress: item.branch + ' 가져오는 중…', status: 'loading' }
          $.ui.invalidate('ui.render')
          try {
            const rec = await importBranch($, repo, item)
            await openTurn($, rec, item.dir)
          } catch (err) {
            list = { ...list, error: '가져오지 못했습니다: ' + err }
          }
          list = { ...list, status: 'done', progress: '' }
          $.ui.invalidate('ui.render')
          $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {})
        },
        setBase: async (repo, value) => {
          await $.store.set('base:' + repo.key, value).catch(() => {})
          const updated = await repoItems($, repo)
          list = { ...list, repos: list.repos.map((r) => (r.key === repo.key ? updated : r)) }
          $.ui.invalidate('ui.render')
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
