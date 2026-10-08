import { expect, mock, test } from 'claude-code/testing'

// 메모리 위의 가짜 git: 저장소마다 커밋(경로→내용)과 HEAD, 그리고 작업 트리 파일
type Repo = { commits: Record<string, Record<string, string>>; head: string }

function world(on: any, initialRepos: Record<string, Repo>, initialFiles: Record<string, string>) {
  const repos = initialRepos
  const files = new Map<string, string>(Object.entries(initialFiles))
  const writes = new Map<string, string>()
  const topOf = (dir: string) => Object.keys(repos).filter((r) => dir === r || dir.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0]
  const working = (top: string) => {
    const out: Record<string, string> = {}
    for (const [p, v] of files) if (p.startsWith(top + '/')) out[p.slice(top.length + 1)] = v
    return out
  }
  const run = (argv: string[]): { exitCode: number; stdout: string } => {
    const [, , cwd, ...args] = argv
    const top = topOf(cwd)
    if (!top) return { exitCode: 128, stdout: '' }
    const repo = repos[top]
    const a = args.join(' ')
    const tracked = repo.commits[repo.head]
    const wt = working(top)
    if (a === 'rev-parse --show-toplevel') return { exitCode: 0, stdout: top + '\n' }
    if (a === 'rev-parse HEAD') return { exitCode: 0, stdout: repo.head + '\n' }
    if (a === 'status --porcelain') {
      const lines: string[] = []
      for (const p of Object.keys(tracked)) if (!(p in wt)) lines.push(' D ' + p); else if (wt[p] !== tracked[p]) lines.push(' M ' + p)
      for (const p of Object.keys(wt)) if (!(p in tracked)) lines.push('?? ' + p)
      return { exitCode: 0, stdout: lines.join('\n') + '\n' }
    }
    if (args[0] === 'diff' && args[1] === '--name-status') {
      const base = repo.commits[args[3]]
      const lines: string[] = []
      for (const p of Object.keys(base)) if (!(p in wt)) lines.push('D\t' + p); else if (wt[p] !== base[p]) lines.push('M\t' + p)
      for (const p of Object.keys(wt)) if (!(p in base) && p in tracked) lines.push('A\t' + p)
      return { exitCode: 0, stdout: lines.join('\n') + '\n' }
    }
    if (args[0] === 'show') {
      const [point, path] = args[1].split(':')
      const v = repo.commits[point] && repo.commits[point][path]
      return v === undefined ? { exitCode: 128, stdout: '' } : { exitCode: 0, stdout: v }
    }
    return { exitCode: 0, stdout: '' }
  }
  // 작업 트리 전체를 새 커밋으로
  const commit = (top: string, id: string) => {
    repos[top].commits[id] = working(top)
    repos[top].head = id
  }

  mock.clock(on, { now: 1000 })
  on('env.get', () => ({ value: '/home/u' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.id', () => ({ value: 'sess1' }))
  on('process.run', ($: any, e: any) => ({ value: { ...run(e.argv), stderr: '' } }))
  on('fs.exists', ($: any, e: any) => ({ value: !!topOf(e.path) }))
  on('fs.stat', ($: any, e: any) => (files.has(e.path) ? { value: { kind: 'file', size: files.get(e.path)!.length, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' }))
  on('fs.read', ($: any, e: any) => (files.has(e.path) ? { value: files.get(e.path) } : { deny: 'ENOENT' }))
  on('fs.write', ($: any, e: any) => { writes.set(e.path, e.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'agentA' }))
  const turnJson = () => {
    const k = [...writes.keys()].find((x) => x.endsWith('/turn.json'))
    return k ? JSON.parse(writes.get(k)!) : undefined
  }
  return { files, writes, commit, turnJson }
}

// Bash 명령의 효과를 정해 두고 tool.call에 답한다. Edit은 파일에 그대로 적용한다
function bashEffects(on: any, effects: Record<string, () => void>, files?: Map<string, string>) {
  on('tool.call', ($: any, e: any) => {
    if (e.tool === 'Bash') effects[e.command]?.()
    if (e.tool === 'Edit' && files) files.set(e.file_path, files.get(e.file_path)!.replace(e.old_string, e.new_string))
    return { result: 'ok' }
  })
}

const REPOS = (): Record<string, Repo> => ({
  '/repo': { commits: { r1: { 'notes.md': 'a\n' } }, head: 'r1' },
  '/w/api': { commits: { h1: { 'src/A.java': 'class A { int x = 1; }\n', 'src/B.java': 'class B {}\n' } }, head: 'h1' },
})

test('다른 저장소를 Bash로 고치고 커밋해도 그 턴의 변경으로 잡는다', async ($, on) => {
  const w = world(on, REPOS(), { '/repo/notes.md': 'a\n', '/w/api/src/A.java': 'class A { int x = 1; }\n', '/w/api/src/B.java': 'class B {}\n' })
  bashEffects(on, {
    "cd /w/api && sed -i 's/1/2/' src/A.java": () => w.files.set('/w/api/src/A.java', 'class A { int x = 2; }\n'),
    'cd /w/api && git commit -am fix': () => w.commit('/w/api', 'h2'),
    'cat > /w/api/src/C.java': () => w.files.set('/w/api/src/C.java', 'class C {}\n'),
    'git -C /w/api rm src/B.java': () => w.files.delete('/w/api/src/B.java'),
  })
  await $.turn.start({ turnId: 't1', text: 'x를 2로 바꿔줘' })
  await $.tool.call({ tool: 'Bash', command: "cd /w/api && sed -i 's/1/2/' src/A.java" })
  await $.tool.call({ tool: 'Bash', command: 'cd /w/api && git commit -am fix' })
  await $.tool.call({ tool: 'Bash', command: 'cat > /w/api/src/C.java' })
  await $.tool.call({ tool: 'Bash', command: 'git -C /w/api rm src/B.java' })
  await $.turn.complete({ turnId: 't1', answer: '바꿨습니다', durationMs: 1, isAborted: false, reason: 'answer' })

  const t = w.turnJson()
  const byPath = Object.fromEntries(t.files.map((f: any) => [f.path, f]))
  expect(Object.keys(byPath).sort()).toEqual(['api/src/A.java', 'api/src/B.java', 'api/src/C.java'])
  expect(byPath['api/src/A.java']).toMatchObject({ isNew: false, tools: ['Bash'], added: 1, removed: 1 })
  expect(byPath['api/src/C.java']).toMatchObject({ isNew: true, added: 1 })
  expect(byPath['api/src/B.java']).toMatchObject({ removed: 1, added: 0 })
  // 변경 전은 턴 시작 때의 HEAD 내용
  const before = [...w.writes.keys()].find((k) => k.endsWith('/before/api/src/A.java'))!
  expect(w.writes.get(before)).toBe('class A { int x = 1; }\n')
})

test('턴 전부터 수정돼 있던 파일은 그 상태를 변경 전으로 삼고, 더 바뀌지 않았으면 뺀다', async ($, on) => {
  const w = world(on, REPOS(), {
    '/repo/notes.md': 'a\n',
    '/w/api/src/A.java': 'class A { int x = 9; }\n', // 턴 전부터 수정돼 있음 (HEAD는 1)
    '/w/api/src/B.java': 'class B { /* wip */ }\n', // 턴 전부터 수정, 이번 턴에는 안 바뀜
    '/w/api/todo.txt': 'old\n', // 턴 전부터 있던 추적 안 되는 파일
  })
  bashEffects(on, {
    "cd /w/api && sed -i 's/9/10/' src/A.java": () => w.files.set('/w/api/src/A.java', 'class A { int x = 10; }\n'),
  })
  await $.turn.start({ turnId: 't1', text: '9를 10으로' })
  await $.tool.call({ tool: 'Bash', command: "cd /w/api && sed -i 's/9/10/' src/A.java" })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })

  const t = w.turnJson()
  expect(t.files.map((f: any) => f.path)).toEqual(['api/src/A.java'])
  const before = [...w.writes.keys()].find((k) => k.endsWith('/before/api/src/A.java'))!
  expect(w.writes.get(before)).toBe('class A { int x = 9; }\n')
})

test('읽기만 한 Bash는 아무것도 남기지 않는다', async ($, on) => {
  const w = world(on, REPOS(), { '/repo/notes.md': 'a\n', '/w/api/src/A.java': 'class A { int x = 1; }\n', '/w/api/src/B.java': 'class B {}\n' })
  bashEffects(on, { 'cd /w/api && git log --oneline': () => {} })
  await $.turn.start({ turnId: 't1', text: '읽기만' })
  await $.tool.call({ tool: 'Bash', command: 'cd /w/api && git log --oneline' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  expect(w.turnJson()).toBeUndefined()
})

test('같은 파일을 Edit과 Bash가 고치면 Edit 기록을 쓰고, 변경 후에는 둘 다 반영된다', async ($, on) => {
  const w = world(on, REPOS(), { '/repo/notes.md': 'a\n', '/w/api/src/A.java': 'class A { int x = 1; }\n', '/w/api/src/B.java': 'class B {}\n' })
  bashEffects(on, { 'cd /w/api && echo "// done" >> src/A.java': () => w.files.set('/w/api/src/A.java', w.files.get('/w/api/src/A.java') + '// done\n') }, w.files)
  await $.turn.start({ turnId: 't1', text: 'x를 2로, 표시 추가' })
  await $.tool.call({ tool: 'Edit', file_path: '/w/api/src/A.java', old_string: 'x = 1', new_string: 'x = 2' })
  await $.tool.call({ tool: 'Bash', command: 'cd /w/api && echo "// done" >> src/A.java' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  const t = w.turnJson()
  expect(t.files).toHaveLength(1)
  expect(t.files[0]).toMatchObject({ path: 'api/src/A.java', tools: ['Edit'], added: 2, removed: 1 })
  const after = [...w.writes.keys()].find((k) => k.endsWith('/after/api/src/A.java'))!
  expect(w.writes.get(after)).toBe('class A { int x = 2; }\n// done\n')
})

test('서브에이전트가 Bash로 고친 파일은 메인 턴에 붙고, 서브에이전트가 기록된다', async ($, on) => {
  const w = world(on, REPOS(), { '/repo/notes.md': 'a\n', '/w/api/src/A.java': 'class A { int x = 1; }\n', '/w/api/src/B.java': 'class B {}\n' })
  bashEffects(on, { 'cd /w/api && echo "// t" >> src/B.java': () => w.files.set('/w/api/src/B.java', 'class B {}\n// t\n') })
  await $.turn.start({ turnId: 't1', text: '테스트 주석 추가' })
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'general-purpose', background: false } as any)
  await $.tool.call({ tool: 'Bash', command: 'cd /w/api && echo "// t" >> src/B.java', agentId: 'agentA' } as any)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  const f = w.turnJson().files[0]
  expect(f).toMatchObject({ path: 'api/src/B.java', agents: [{ agentId: 'agentA', type: 'general-purpose' }], added: 1 })
})
