// change-explainer: Claude가 턴마다 바꾼 파일을 기록하고, 원할 때 해설한다.
//
// 1단계(이 파일): 변경 수집과 저장
// - 턴에서 파일을 처음 건드리기 직전의 내용(변경 전)과 턴이 끝난 뒤의 내용(변경 후)을 남긴다
// - 서브에이전트의 수정은 그 서브에이전트를 실행한 메인 턴에 붙인다
// - 도구 호출은 관찰만 한다. 막거나 바꾸지 않고 next(e)의 결과를 그대로 돌려준다
//
// 저장 위치: ~/.claude/explanations/<저장소>-<해시>/<세션 id>/
//   session.json                      세션 정보와 턴 목록
//   turns/<순번>-<turnId>/turn.json   턴 기록 (요청문, 답변, 파일별 줄 수)
//   turns/<순번>-<turnId>/before/…    변경 전 스냅숏, after/… 변경 후 스냅숏

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

  // 지금은 기록이 제대로 쌓이는지 보는 텍스트. 해설 창은 다음 단계에서 붙인다
  on('command.run', { command: 'explain' }, async ($) => {
    if (!lastRecord) return { text: '이 세션에서 아직 기록된 변경이 없습니다.' }
    const r = lastRecord
    const lines = [
      '#' + r.seq + '  ' + r.title,
      '파일 ' + r.files.filter((f) => f.changed).length + '개  +' + r.added + ' −' + r.removed,
      ...r.files.map((f) => {
        const tag = f.skipped ? '내용 생략(' + f.skipped + ')' : f.isNew ? '새 파일' : f.changed ? '수정' : '변화 없음'
        const who = f.agents.length ? '  · 서브에이전트 ' + f.agents.map((a) => a.type || a.agentId).join(', ') : ''
        return '  ' + f.path + '  ' + tag + '  +' + f.added + ' −' + f.removed + who
      }),
      '기록: ' + ctx.base + '/turns/' + pad(r.seq) + '-' + r.turnId,
    ]
    return { text: lines.join('\n') }
  })
}
