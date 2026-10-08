// 턴 기록을 다루는 순수 함수. 파일 읽기·쓰기는 register.js가 한다.

import { lineStats } from './diff.js'

// 파일 하나를 통째로 다룰 수 있는 최대 크기 ($.fs 제한과 같다)
export const MAX_FILE_BYTES = 4 * 1024 * 1024

// 이 mod가 기록하는 수정 도구
export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

// 도구 입력에서 고친 파일 경로를 꺼낸다
export function editedPath(e) {
  return e.file_path || e.notebook_path || null
}

// 상대 경로면 작업 디렉터리 기준 절대 경로로
export function absolutePath(path, cwd) {
  if (path.startsWith('/')) return normalize(path)
  return normalize(cwd.replace(/\/$/, '') + '/' + path)
}

function normalize(path) {
  const out = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

// 저장소 안이면 저장소 기준 상대 경로, 밖이면 절대 경로를 '_outside/' 아래로
export function storedPath(abs, root) {
  const base = root.replace(/\/$/, '') + '/'
  if (abs.startsWith(base)) return abs.slice(base.length)
  return '_outside' + abs
}

// 글이 텍스트로 다룰 수 없는 내용인지 (NUL 문자가 있으면 바이너리로 본다)
export function looksBinary(text) {
  return text.includes('\u0000')
}

// 요청문 첫 줄로 턴 제목을 만든다 (모델을 부르지 않는다)
export function turnTitle(request, max = 60) {
  const first = (request || '').split('\n').map((x) => x.trim()).find((x) => x) || '(요청 없음)'
  return first.length > max ? first.slice(0, max - 1) + '…' : first
}

// repos: Bash가 건드린 git 저장소의 턴 시작 상태 (register.js의 snapshotRepo)
export function newTurn(turnId, request, startedAt) {
  return { turnId, request: request || '', startedAt, files: {}, repos: {} }
}

// 턴에서 처음 건드리는 파일의 기록. before가 null이면 새 파일, skipped면 내용을 다루지 않는다
export function newFileEntry(abs, rel, before, skipped) {
  return { abs, rel, before, isNew: before === null && !skipped, skipped: skipped || null, edits: 0, tools: [], agents: [] }
}

// 성공한 수정 한 번을 기록한다
export function recordEdit(entry, tool, agent) {
  const tools = entry.tools.includes(tool) ? entry.tools : [...entry.tools, tool]
  const agents = agent && !entry.agents.some((x) => x.agentId === agent.agentId) ? [...entry.agents, agent] : entry.agents
  return { ...entry, edits: entry.edits + 1, tools, agents }
}

// 저장할 턴 기록 (스냅숏 내용은 빼고 파일 목록과 줄 수만)
export function turnRecord(turn, afters, extra) {
  const files = Object.values(turn.files)
    .filter((f) => f.edits > 0)
    .map((f) => {
      const after = afters[f.abs]
      const changed = f.skipped ? true : f.before !== after
      const stats = f.skipped ? { added: 0, removed: 0 } : lineStats(f.before, after ?? '')
      return {
        path: f.rel,
        absPath: f.abs,
        isNew: f.isNew,
        skipped: f.skipped,
        tools: f.tools,
        agents: f.agents,
        changed,
        added: stats.added,
        removed: stats.removed,
      }
    })
  const changedFiles = files.filter((f) => f.changed)
  return {
    turnId: turn.turnId,
    title: turnTitle(turn.request),
    request: turn.request,
    startedAt: turn.startedAt,
    files,
    added: changedFiles.reduce((a, f) => a + f.added, 0),
    removed: changedFiles.reduce((a, f) => a + f.removed, 0),
    hasChanges: changedFiles.length > 0,
    ...extra,
  }
}

// 세션 목록에 올릴 턴 요약
export function turnSummary(record) {
  return {
    seq: record.seq,
    turnId: record.turnId,
    title: record.title,
    endedAt: record.endedAt,
    files: record.files.filter((f) => f.changed).length,
    added: record.added,
    removed: record.removed,
    agents: [...new Set(record.files.flatMap((f) => f.agents.map((a) => a.type || 'subagent')))],
    understood: false,
  }
}

// 저장 위치의 저장소 폴더 이름: 저장소 이름 + 경로 해시 8자리
export async function repoFolder(root) {
  const name = root.replace(/\/$/, '').split('/').pop() || 'root'
  const bytes = new TextEncoder().encode(root)
  const hash = await crypto.subtle.digest('SHA-1', bytes)
  const hex = [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, '0')).join('')
  return name.replace(/[^A-Za-z0-9._-]/g, '_') + '-' + hex.slice(0, 8)
}
