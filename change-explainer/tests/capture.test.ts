import { expect, test } from 'claude-code/testing'
import { edit, setup, turnEnd, turnStart } from './helpers.ts'

test('수정한 파일과 새 파일을 턴 기록으로 남긴다', async ($, on) => {
  const fs = setup(on, { '/repo/src/login.ts': 'a\nb\nc\n' })
  await turnStart($, 't1', '로그인 재시도 넣어줘')
  await edit($, '/repo/src/login.ts', 'b', 'B')
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/retry.ts', content: 'x\ny\n' })
  await turnEnd($, 't1')

  const turn = fs.json('/sess1/turns/0001-t1/turn.json')
  expect(turn).toMatchObject({ seq: 1, turnId: 't1', title: '로그인 재시도 넣어줘', added: 3, removed: 1, hasChanges: true })
  expect(turn.files).toMatchObject([
    { path: 'src/login.ts', isNew: false, changed: true, added: 1, removed: 1, tools: ['Edit'] },
    { path: 'src/retry.ts', isNew: true, changed: true, added: 2, removed: 0, tools: ['Write'] },
  ])
  // 스냅숏: 수정한 파일은 전후 모두, 새 파일은 후만
  expect(fs.writes.get(fs.find('/0001-t1/before/src/login.ts')!)).toBe('a\nb\nc\n')
  expect(fs.writes.get(fs.find('/0001-t1/after/src/login.ts')!)).toBe('a\nB\nc\n')
  expect(fs.find('/0001-t1/before/src/retry.ts')).toBeUndefined()
  expect(fs.writes.get(fs.find('/0001-t1/after/src/retry.ts')!)).toBe('x\ny\n')
  // 저장 위치: ~/.claude/explanations/<저장소>-<해시>/<세션>
  expect(fs.find('/sess1/turns/0001-t1/turn.json')).toMatch(/^\/home\/u\/\.claude\/explanations\/repo-[0-9a-f]{8}\/sess1\//)
  expect(fs.json('/sess1/session.json').turns).toMatchObject([{ seq: 1, turnId: 't1', files: 2, added: 3, removed: 1 }])
})

test('한 파일을 여러 번 고쳐도 변경 전은 턴 시작 시점의 내용 하나다', async ($, on) => {
  const fs = setup(on, { '/repo/a.ts': 'one\ntwo\n' })
  await turnStart($, 't1', '고쳐줘')
  await edit($, '/repo/a.ts', 'one', 'ONE')
  await edit($, '/repo/a.ts', 'two', 'TWO')
  await turnEnd($, 't1')
  expect(fs.writes.get(fs.find('/before/a.ts')!)).toBe('one\ntwo\n')
  expect(fs.writes.get(fs.find('/after/a.ts')!)).toBe('ONE\nTWO\n')
  expect(fs.json('/turn.json').files).toMatchObject([{ path: 'a.ts', added: 2, removed: 2 }])
})

test('거부되거나 실패한 수정은 기록하지 않는다', async ($, on) => {
  const fs = setup(on, { '/repo/a.ts': 'x\n', '/repo/b.ts': 'y\n' }, { deny: ['/repo/a.ts'], toolFails: ['/repo/b.ts'] })
  await turnStart($, 't1', '고쳐줘')
  expect(await edit($, '/repo/a.ts', 'x', 'X')).toEqual({ deny: 'not allowed' })
  await edit($, '/repo/b.ts', 'zzz', 'Y')
  await turnEnd($, 't1')
  expect(fs.find('turn.json')).toBeUndefined()
  expect(fs.find('session.json')).toBeUndefined()
})

test('파일을 고치지 않은 턴은 저장하지 않고 순번도 쓰지 않는다', async ($, on) => {
  const fs = setup(on, { '/repo/a.ts': 'x\n' })
  await turnStart($, 't1', '설명만 해줘')
  await turnEnd($, 't1')
  await turnStart($, 't2', '이제 고쳐줘')
  await edit($, '/repo/a.ts', 'x', 'X')
  await turnEnd($, 't2')
  expect(fs.find('/turns/0001-t2/turn.json')).toBeDefined()
  expect(fs.find('t1')).toBeUndefined()
})

test('턴 안의 서브에이전트 수정은 그 턴에 붙고, 누가 고쳤는지 남긴다', async ($, on) => {
  const fs = setup(on, { '/repo/a.ts': 'x\n' })
  await turnStart($, 't1', '테스트까지 써줘')
  await $.agent.spawn({ prompt: '테스트 작성', description: 'tests', subagentType: 'general-purpose', background: false } as any)
  await $.tool.call({ tool: 'Write', file_path: '/repo/a.test.ts', content: 't\n', agentId: 'agentA' } as any)
  // 서브에이전트의 턴 종료는 메인 턴을 끝내지 않는다
  await turnEnd($, 'sub-turn', { agentId: 'agentA' })
  await edit($, '/repo/a.ts', 'x', 'X')
  await turnEnd($, 't1')
  const files = fs.json('/0001-t1/turn.json').files
  expect(files).toMatchObject([
    { path: 'a.test.ts', isNew: true, agents: [{ agentId: 'agentA', type: 'general-purpose' }] },
    { path: 'a.ts', agents: [] },
  ])
})

test('메인 턴이 끝난 뒤 백그라운드 서브에이전트가 고치면 그 턴의 기록을 갱신한다', async ($, on) => {
  const fs = setup(on, { '/repo/a.ts': 'x\n', '/repo/b.ts': 'y\n' })
  await turnStart($, 't1', '백그라운드로 정리해줘')
  await $.agent.spawn({ prompt: '정리', description: 'bg', subagentType: 'general-purpose', background: true } as any)
  await edit($, '/repo/a.ts', 'x', 'X')
  await turnEnd($, 't1')
  expect(fs.json('/0001-t1/turn.json').files).toHaveLength(1)

  // 다음 턴이 진행 중이어도 백그라운드 서브에이전트의 수정은 원래 턴으로 간다
  await turnStart($, 't2', '다른 일')
  await edit($, '/repo/b.ts', 'y', 'Y', { agentId: 'agentBg' })
  const files = fs.json('/0001-t1/turn.json').files
  expect(files.map((f: any) => f.path)).toEqual(['a.ts', 'b.ts'])
  expect(files[1]).toMatchObject({ agents: [{ agentId: 'agentBg' }] })
})

test('저장소 밖 파일은 _outside 아래에 경로를 유지해 남긴다', async ($, on) => {
  const fs = setup(on, { '/etc/app.conf': 'a\n' })
  await turnStart($, 't1', '설정 고쳐줘')
  await edit($, '/etc/app.conf', 'a', 'b')
  await turnEnd($, 't1')
  expect(fs.find('/before/_outside/etc/app.conf')).toBeDefined()
  expect(fs.json('/turn.json').files[0].path).toBe('_outside/etc/app.conf')
})

test('창을 그릴 수 없는 곳에서 /explain은 마지막 변경 턴을 텍스트로 보여 준다', async ($, on) => {
  setup(on, { '/repo/a.ts': 'x\n' }, { headless: true })
  expect((await $.command.run({ command: 'explain', args: '' })).text).toMatch(/아직 기록된 변경이 없습니다/)
  await turnStart($, 't1', '고쳐줘')
  await edit($, '/repo/a.ts', 'x', 'X')
  await turnEnd($, 't1')
  const out = (await $.command.run({ command: 'explain', args: '' })).text
  expect(out).toMatch(/^#1  고쳐줘/)
  expect(out).toMatch(/a\.ts  수정  \+1 −1/)
})
