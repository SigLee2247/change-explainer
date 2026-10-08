import { expect, mock, test } from 'claude-code/testing'

// 지난 세션 s1: 첫 턴에서 Bash로 /w/api를 고치고 커밋, 둘째 턴은 질문만
const J = (o: any) => JSON.stringify(o)
const TRANSCRIPT = [
  J({ type: 'user', uuid: 'u1', timestamp: '2026-10-02T01:00:00Z', message: { content: 'SHOP-1 상한을 200으로 고쳐줘' } }),
  J({ type: 'assistant', timestamp: '2026-10-02T01:01:00Z', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: "cd /w/api && sed -i 's/100/200/' src/A.java && git commit -qam 'fix(SHOP-1): 상한 200'" } }] } }),
  J({ type: 'assistant', timestamp: '2026-10-02T01:02:00Z', message: { content: [{ type: 'text', text: '상한을 200으로 올리고 커밋했습니다.' }] } }),
  J({ type: 'user', uuid: 'u2', timestamp: '2026-10-02T02:00:00Z', message: { content: '이거 왜 200이야?' } }),
  J({ type: 'assistant', timestamp: '2026-10-02T02:00:10Z', message: { content: [{ type: 'text', text: '요청하신 값입니다.' }] } }),
].join('\n')

function run(argv: string[]): { exitCode: number; stdout: string } {
  if (argv[0] === 'sh') {
    const script = argv[2]
    if (script.includes('grep -m 1')) return { exitCode: 0, stdout: TRANSCRIPT.split('\n')[0] + '\n' }
    if (script.includes('originalFile') && script.includes('tool_result')) return { exitCode: 0, stdout: TRANSCRIPT + '\n' }
    return { exitCode: 0, stdout: '' }
  }
  const [, , cwd, ...args] = argv
  const a = args.join(' ')
  if (!cwd.startsWith('/w/api')) return { exitCode: 128, stdout: '' }
  if (a === 'rev-parse --show-toplevel') return { exitCode: 0, stdout: '/w/api\n' }
  if (a === 'config user.email') return { exitCode: 0, stdout: 'me@x\n' }
  if (args[0] === 'log') {
    // 그 턴의 시간 범위와 내 커밋만 요청하는지 확인
    if (!a.includes('--since=2026-10-02T01:00:00Z') || !a.includes('--until=2026-10-02T02:00:00Z') || !a.includes('--author=me@x')) return { exitCode: 0, stdout: '' }
    return { exitCode: 0, stdout: 'c1\t2026-10-02T10:01:30+09:00\tfix(SHOP-1): 상한 200\n' }
  }
  if (a === 'show --name-status -M --format= c1') return { exitCode: 0, stdout: 'M\tsrc/A.java\n' }
  if (a === 'show c1^:src/A.java') return { exitCode: 0, stdout: 'class A { int max = 100; }\n' }
  if (a === 'show c1:src/A.java') return { exitCode: 0, stdout: 'class A { int max = 200; }\n' }
  return { exitCode: 0, stdout: '' }
}

const SUMMARY = { tldr: '상한을 100에서 200으로 올렸습니다.', files: [], why: ['요청대로'], how: [], review: [], hunkNotes: ['상한 200'] }

function setup(on: any) {
  const writes = new Map<string, string>()
  const prompts: string[] = []
  mock.clock(on, { now: 1000 })
  on('env.get', () => ({ value: '/home/u' }))
  on('session.cwd', () => ({ value: '/work/harness' }))
  on('session.id', () => ({ value: 'now' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.model', () => ({ value: 'claude-sonnet' }))
  on('process.run', ($: any, e: any) => ({ value: { ...run(e.argv), stderr: '' } }))
  on('fs.list', () => ({ value: [{ name: 's1.jsonl', kind: 'file', size: 100, mtimeMs: 2, isLink: false }, { name: 'now.jsonl', kind: 'file', size: 1, mtimeMs: 3, isLink: false }] }))
  on('fs.exists', ($: any, e: any) => ({ value: e.path.startsWith('/w/') }))
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('fs.read', ($: any, e: any) => (writes.has(e.path) ? { value: writes.get(e.path) } : { deny: 'ENOENT' }))
  on('fs.write', ($: any, e: any) => { writes.set(e.path, e.text); return { value: undefined } })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({ value: {} }))
  on('ui.log', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('model.fork', () => { throw new Error('지난 세션은 fork하지 않아야 한다') })
  on('model.complete', ($: any, e: any) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: JSON.stringify(SUMMARY), usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  return { writes, prompts }
}

const pane = () => ({
  plugin: 'change-explainer', component: 'Pane', requestId: 'change-explainer', surface: 'terminal',
  viewport: { columns: 200, rows: 80 },
  props: { title: '변경 해설', isFocused: true, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
}) as any

const flush = () => new Promise((r) => setTimeout(r, 30))

test('지난 세션을 펼치면 파일을 바꾼 턴만 보이고, 지금 세션은 지난 세션 목록에 없다', async ($, on) => {
  setup(on)
  await $.command.run({ command: 'explain', args: 'list' })
  await flush()
  const ui = await $.ui.mount(pane())
  expect(await ui.find({ key: 'ses-s1' })).toMatchObject({ props: { label: '▸ 10-02 01:00  SHOP-1 상한을 200으로 고쳐줘' } })
  expect(await ui.find({ key: 'ses-now' })).toBeUndefined()
  await ui.press({ key: 'ses-s1' })
  await flush()
  expect(await ui.find({ key: 'past-u1' })).toMatchObject({ props: { label: '#1  SHOP-1 상한을 200으로 고쳐줘' } })
  expect(await ui.find({ key: 'past-u2' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /커밋 1개/ })).toBeDefined()
})

test('지난 턴을 열면 그 시간대의 내 커밋에서 변경을 복원하고, 그 턴의 대화로 해설하며 토큰을 기록한다', async ($, on) => {
  const { writes, prompts } = setup(on)
  await $.command.run({ command: 'explain', args: 'list' })
  await flush()
  const ui = await $.ui.mount(pane())
  await ui.press({ key: 'ses-s1' })
  await flush()
  await ui.press({ key: 'past-u1' })
  await flush()

  const key = [...writes.keys()].find((k) => k.endsWith('/s1/turns/0001-h-u1/turn.json'))!
  const rec = JSON.parse(writes.get(key)!)
  expect(rec).toMatchObject({ kind: 'past', sessionId: 's1', added: 1, removed: 1, commits: [{ repo: 'api', sha: 'c1' }] })
  expect(rec.files).toMatchObject([{ path: 'api/src/A.java', tools: ['git commit'] }])
  // 해설 맥락: 그 턴의 요청과 Claude의 설명, 그리고 커밋
  expect(prompts[0]).toMatch(/사용자: SHOP-1 상한을 200으로 고쳐줘/)
  expect(prompts[0]).toMatch(/Claude: 상한을 200으로 올리고 커밋했습니다\./)
  expect(prompts[0]).toMatch(/이 턴에 만든 커밋\n- api c1 fix\(SHOP-1\): 상한 200/)
  expect(prompts[0]).not.toMatch(/요청하신 값입니다/)
  expect(await ui.find({ type: 'Text', text: '상한을 100에서 200으로 올렸습니다.' })).toBeDefined()
  // 토큰: 턴과 저장소 누적
  expect(await ui.find({ type: 'Text', text: /호출 1회 · 입력 1\.2k \(캐시 읽기 0\) · 출력 300/ })).toBeDefined()
  const repoUsage = [...writes.keys()].find((k) => k.endsWith('/usage.json') && !k.includes('/views/'))!
  expect(JSON.parse(writes.get(repoUsage)!)).toEqual({ calls: 1, input: 1200, output: 300, cacheRead: 0, cacheWrite: 0 })
})
