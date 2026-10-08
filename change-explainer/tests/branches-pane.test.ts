import { expect, mock, test } from 'claude-code/testing'

// 실제 저장소처럼 답하는 git 스텁: 메인 저장소 /work/api(develop)와 워크트리 /work/wt-a(feature/SHOP-1-sitemap)
const TRANSCRIPT = [
  JSON.stringify({ type: 'user', timestamp: '2026-10-02T01:00:00Z', message: { content: 'SHOP-1 사이트맵 대상에서 품절 상품을 빼줘' } }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-10-02T01:05:00Z', message: { content: [{ type: 'text', text: '노출 중인 상품만 사이트맵에 넣도록 바꿨습니다.' }] } }),
].join('\n')

function gitStub(argv: string[]): string {
  if (argv[0] === 'sh') {
    const script = argv[2]
    if (script.includes('grep -rhoE')) return '"cwd":"/work/wt-a"\ncd /work/api\n'
    if (script.includes('grep -rlF')) return './s1.jsonl\n'
    if (script.includes('tool_result')) return TRANSCRIPT
    return ''
  }
  const [, , cwd, ...args] = argv  // git -C <경로> ...
  const a = args.join(' ')
  if (a === 'rev-parse --show-toplevel') return cwd.startsWith('/work/wt-a') ? '/work/wt-a\n' : cwd.startsWith('/work/api') ? '/work/api\n' : cwd + '\n'
  if (a === 'rev-parse --path-format=absolute --git-common-dir') return '/work/api/.git\n'
  if (a.startsWith('for-each-ref')) return 'develop\nmain\nfeature/SHOP-1-sitemap\norigin/develop\n'
  if (a === 'worktree list --porcelain') return 'worktree /work/api\nHEAD a\nbranch refs/heads/develop\n\nworktree /work/wt-a\nHEAD b\nbranch refs/heads/feature/SHOP-1-sitemap\n'
  if (a.startsWith('reflog show')) return cwd === '/work/wt-a' ? 'c2 commit: 사이트맵에서 품절 상품 제외\nmb1 branch: Created from origin/develop\n' : ''
  if (a.startsWith('merge-base HEAD')) return a.endsWith(' main') ? 'mbmain\n' : 'mb1\n'
  if (a.startsWith('rev-list --count')) return '2\n'
  if (a.startsWith('diff --shortstat')) return ' 1 file changed, 1 insertion(+), 1 deletion(-)\n'
  if (a.startsWith('status --porcelain')) return ''
  if (a === 'log -1 --format=%cI') return '2026-10-02T10:00:00+09:00\n'
  if (a.startsWith('log --format=%s')) return '사이트맵에서 품절 상품 제외\n사이트맵 대상 조회 분리\n'
  if (a.startsWith('diff --name-status -M')) return 'M\tsrc/Sitemap.java\n'
  if (a.startsWith('ls-files --others')) return ''
  if (a.startsWith('show mb1:src/Sitemap.java')) return 'class Sitemap {\n  List<Goods> targets() { return all(); }\n}\n'
  return ''
}

const pane = (bodyColumns = 110) => ({
  plugin: 'change-explainer', component: 'Pane', requestId: 'change-explainer', surface: 'terminal',
  viewport: { columns: 200, rows: 80 },
  props: { title: '변경 해설', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
}) as any

const SUMMARY = {
  tldr: '사이트맵 대상에서 품절 상품을 뺐습니다.', files: [{ path: 'src/Sitemap.java', desc: '노출 상품만' }],
  why: ['품절 상품이 검색에 노출되지 않게 하려고'], how: [], review: [], hunkNotes: ['대상 조회를 노출 상품으로'],
}

function setup(on: any) {
  const files = new Map<string, string>([['/work/wt-a/src/Sitemap.java', 'class Sitemap {\n  List<Goods> targets() { return visible(); }\n}\n']])
  const writes = new Map<string, string>()
  const store = new Map<string, unknown>()
  const prompts: string[] = []
  mock.clock(on, { now: 1000 })
  on('env.get', () => ({ value: '/home/u' }))
  on('session.cwd', () => ({ value: '/work/harness' }))
  on('session.id', () => ({ value: 'sess1' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.model', () => ({ value: 'claude-sonnet' }))
  on('process.run', ($: any, e: any) => ({ value: { exitCode: 0, stdout: gitStub(e.argv), stderr: '' } }))
  on('fs.exists', ($: any, e: any) => ({ value: e.path.startsWith('/work/') }))
  on('fs.stat', ($: any, e: any) => (files.has(e.path) ? { value: { kind: 'file', size: files.get(e.path)!.length, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' }))
  on('fs.read', ($: any, e: any) => (files.has(e.path) ? { value: files.get(e.path) } : { deny: 'ENOENT' }))
  on('fs.write', ($: any, e: any) => { writes.set(e.path, e.text); files.set(e.path, e.text); return { value: undefined } })
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({ value: {} }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  on('model.fork', () => { throw new Error('브랜치 작업은 fork하지 않아야 한다') })
  on('model.complete', ($: any, e: any) => { prompts.push(e.prompt); return { value: { isAnswered: true, text: JSON.stringify(SUMMARY), usage } } })
  return { writes, store, prompts }
}

const flush = () => new Promise((r) => setTimeout(r, 30))

test('작업 목록: 대화 기록에서 저장소를 찾고, 기준보다 앞선 워크트리 브랜치를 보여 준다', async ($, on) => {
  setup(on)
  expect(await $.command.run({ command: 'explain', args: 'list' })).toEqual({})
  await flush()
  const ui = await $.ui.mount(pane())
  expect(await ui.find({ type: 'Text', text: 'api' })).toBeDefined()
  expect(await ui.find({ key: 'base-/work/api/.git' })).toMatchObject({ props: { value: 'auto' } })
  expect(await ui.find({ type: 'Text', text: /기준 origin\/develop에서 만든 시점/ })).toBeDefined()
  // 제목은 첫 커밋 (티켓 키가 든 커밋이 없을 때)
  expect(await ui.find({ key: 'item-work_wt-a' })).toMatchObject({ props: { label: 'SHOP-1  사이트맵 대상 조회 분리' } })
  expect(await ui.find({ type: 'Text', text: /커밋 2  ·  파일 1/ })).toBeDefined()
})

test('브랜치를 고르면 merge-base와 지금 파일로 diff를 만들고, 그 작업의 대화를 맥락으로 해설한다', async ($, on) => {
  const { writes, prompts } = setup(on)
  await $.command.run({ command: 'explain', args: 'list' })
  await flush()
  const ui = await $.ui.mount(pane())
  await ui.press({ key: 'item-work_wt-a' })
  await flush()
  const key = [...writes.keys()].find((k) => k.endsWith('/branches/feature_SHOP-1-sitemap/turn.json'))!
  expect(key).toMatch(/^\/home\/u\/\.claude\/explanations\/wt-a-[0-9a-f]{8}\/branches\//)
  expect(JSON.parse(writes.get(key)!)).toMatchObject({ kind: 'branch', branch: 'feature/SHOP-1-sitemap', base: 'origin/develop에서 만든 시점', added: 1, removed: 1 })
  // 해설은 fork가 아니라 complete로, 커밋과 대화 발췌를 맥락으로
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toMatch(/브랜치 feature\/SHOP-1-sitemap \(api, 기준: origin\/develop에서 만든 시점\)/)
  expect(prompts[0]).toMatch(/사이트맵 대상에서 품절 상품을 빼줘/)
  expect(prompts[0]).toMatch(/- class Sitemap|\+    2   List<Goods> targets\(\) \{ return visible\(\); \}/)
  expect(await ui.find({ type: 'Text', text: '사이트맵 대상에서 품절 상품을 뺐습니다.' })).toBeDefined()
})

test('저장소마다 기준 브랜치를 바꾸면 저장하고 다시 계산한다', async ($, on) => {
  const { store } = setup(on)
  await $.command.run({ command: 'explain', args: 'list' })
  await flush()
  const ui = await $.ui.mount(pane())
  await ui.select({ key: 'base-/work/api/.git', value: 'main' })
  await flush()
  expect(store.get('base:/work/api/.git')).toBe('main')
  expect(await ui.find({ key: 'base-/work/api/.git' })).toMatchObject({ props: { value: 'main' } })
})
