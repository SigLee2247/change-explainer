// 지난 세션 복원: Claude Code의 대화 기록(JSONL)에서 턴과 그 턴의 변경을 되살리는 순수 함수.
// 파일 읽기와 git 실행은 register.js가 한다.
//
// 턴 = 사용자 요청 하나부터 다음 요청 직전까지. 그 턴에서
// - Edit/Write는 기록에 남은 고치기 전 파일(originalFile)과 바꾼 내용으로 정확히 복원하고
// - Bash로 다룬 저장소는 경로만 모아 둔다 (register.js가 그 턴 시간 범위의 커밋을 git에서 찾는다)

// 대화 기록 줄에서 사용자의 요청(시스템이 넣은 <…> 글과 도구 결과는 제외).
// 이미지를 붙인 요청은 내용이 블록 목록이다: 그 안의 글 블록을 쓴다
export function promptText(o) {
  const c = o && o.message && o.message.content
  if (!o || o.type !== 'user' || o.isSidechain) return null
  let t = ''
  if (typeof c === 'string') t = c
  else if (Array.isArray(c) && !c.some((b) => b && b.type === 'tool_result')) t = c.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n')
  t = t.trim()
  return t && !t.startsWith('<') ? t : null
}

// Claude 자체 데이터와 임시 작업 폴더는 작업 결과가 아니다
export function isWorkPath(path, home) {
  return !path.startsWith(home + '/.claude/') && !/^\/(private\/)?tmp\/claude-/.test(path)
}

function assistantText(o) {
  const c = o.message && o.message.content
  if (o.type !== 'assistant' || !Array.isArray(c)) return ''
  return c.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n').trim()
}

// 편집 하나를 고치기 전 내용에 적용한 결과. 적용할 수 없으면 null
export function applyEdit(original, edit) {
  if (edit.tool === 'Write') return edit.content
  if (original === null || original === undefined) return null
  const steps = edit.tool === 'MultiEdit' ? edit.edits : [{ old_string: edit.old_string, new_string: edit.new_string, replace_all: edit.replace_all }]
  let text = original
  for (const s of steps || []) {
    if (typeof s.old_string !== 'string' || typeof s.new_string !== 'string') return null
    if (!text.includes(s.old_string)) return null
    text = s.replace_all ? text.split(s.old_string).join(s.new_string) : text.replace(s.old_string, s.new_string)
  }
  return text
}

// 대화 기록 줄들 → 턴 목록
// [{ id, startAt, endAt, request, answer, excerpt, files: { 경로: { before, after, tools, agents, skipped } }, bashCommands }]
// agentLines: 서브에이전트 기록 줄들 (시각으로 메인 턴에 붙인다)
export function turnsFromTranscript(lines, agentLines = []) {
  const turns = []
  let cur = null
  const uses = {}
  const events = []

  const parse = (line, agent) => {
    try {
      const o = JSON.parse(line)
      if (agent) o.__agent = agent
      return o
    } catch {
      return null
    }
  }
  const main = lines.map((l) => parse(l, null)).filter(Boolean)
  const subs = agentLines.map((x) => parse(x.line, x.agent)).filter(Boolean)

  for (const o of main) {
    const prompt = promptText(o)
    if (prompt) {
      cur = { id: o.uuid || 't' + turns.length, startAt: o.timestamp || '', endAt: o.timestamp || '', request: prompt, texts: [], files: {}, bashCommands: [], order: [] }
      turns.push(cur)
      continue
    }
    if (!cur) continue
    if (o.timestamp) cur.endAt = o.timestamp
    const text = assistantText(o)
    if (text && !o.isSidechain) cur.texts.push({ at: o.timestamp || '', text })
    events.push({ o, turn: cur })
  }
  // 서브에이전트의 기록은 시각이 들어가는 메인 턴에 붙인다
  for (const o of subs) {
    const at = o.timestamp || ''
    const turn = turns.filter((t) => t.startAt <= at).pop()
    if (turn) events.push({ o, turn })
  }

  for (const { o, turn } of events) {
    const c = o.message && o.message.content
    if (!Array.isArray(c)) continue
    for (const b of c) {
      if (b.type === 'tool_use') {
        if (['Edit', 'Write', 'MultiEdit'].includes(b.name)) uses[b.id] = { tool: b.name, input: b.input || {}, turn, agent: o.__agent }
        else if (b.name === 'Bash' && b.input && typeof b.input.command === 'string') turn.bashCommands.push(b.input.command)
      }
      if (b.type === 'tool_result' && uses[b.tool_use_id]) {
        const u = uses[b.tool_use_id]
        delete uses[b.tool_use_id]
        if (b.is_error) continue
        const r = o.toolUseResult && typeof o.toolUseResult === 'object' ? o.toolUseResult : {}
        const path = r.filePath || u.input.file_path
        if (!path) continue
        const original = typeof r.originalFile === 'string' ? r.originalFile : r.type === 'create' ? null : undefined
        const edit = { tool: u.tool, ...u.input }
        const after = original === undefined ? null : applyEdit(original, edit)
        const f = u.turn.files[path]
        if (!f) {
          u.turn.files[path] = {
            before: original === undefined ? null : original,
            after,
            tools: [u.tool],
            agents: u.agent ? [u.agent] : [],
            // 고치기 전 내용이 기록에 없거나 적용이 안 되면 내용 비교를 하지 않는다
            skipped: original === undefined || after === null ? 'unreadable' : null,
          }
        } else {
          f.after = after
          if (after === null) f.skipped = 'unreadable'
          if (!f.tools.includes(u.tool)) f.tools.push(u.tool)
          if (u.agent && !f.agents.includes(u.agent)) f.agents.push(u.agent)
        }
      }
    }
  }

  return turns.map((t, i) => ({
    id: t.id,
    startAt: t.startAt,
    // 다음 요청 직전까지가 이 턴 (커밋 시간 범위)
    endAt: turns[i + 1] ? turns[i + 1].startAt : t.endAt,
    request: t.request,
    answer: t.texts.length ? t.texts[t.texts.length - 1].text : '',
    // "가자"처럼 짧은 요청은 앞 턴들에 진짜 이유가 있다: 같은 세션의 앞선 요청 몇 개를 함께
    excerpt: priorRequests(turns, i) + turnExcerpt(t),
    files: t.files,
    bashCommands: t.bashCommands,
  }))
}

const PRIOR_TURNS = 4

function priorRequests(turns, i) {
  const prior = turns.slice(Math.max(0, i - PRIOR_TURNS), i)
  if (!prior.length) return ''
  return '## 같은 세션의 앞선 요청 (오래된 것부터)\n' + prior.map((p) => '- ' + (p.request.length > 400 ? p.request.slice(0, 400) + '…' : p.request).replace(/\n+/g, ' ')).join('\n') + '\n\n## 이 턴\n'
}

// 이 턴의 대화: 요청과 Claude의 설명 (해설 프롬프트의 맥락)
function turnExcerpt(t, maxChars = 12000) {
  const parts = ['사용자: ' + t.request, ...t.texts.map((x) => 'Claude: ' + (x.text.length > 2000 ? x.text.slice(0, 2000) + '…' : x.text))]
  let out = parts.join('\n\n')
  if (out.length > maxChars) out = out.slice(0, 2000) + '\n\n…(중간 생략)…\n\n' + out.slice(out.length - (maxChars - 2100))
  return out
}

// `git log --format=%H%x09%cI%x09%s` → [{ sha, at, subject }]
export function parseLog(text) {
  return text.split('\n').filter(Boolean).map((line) => {
    const [sha, at, ...rest] = line.split('\t')
    return { sha, at, subject: rest.join('\t') }
  })
}
