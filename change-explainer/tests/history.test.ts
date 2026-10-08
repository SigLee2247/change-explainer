import { expect, test } from 'claude-code/testing'
import { applyEdit, isWorkPath, madeByTurn, parseLog, promptText, turnsFromTranscript } from '../hooks/history.js'

const J = (o: any) => JSON.stringify(o)
const user = (uuid: string, at: string, text: string) => J({ type: 'user', uuid, timestamp: at, message: { content: text } })
const say = (at: string, text: string) => J({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text }] } })
const use = (at: string, id: string, name: string, input: any) => J({ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id, name, input }] } })
const result = (at: string, id: string, toolUseResult: any, isError = false) =>
  J({ type: 'user', timestamp: at, toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'ok' }] } })

test('편집 적용: Edit, replace_all, MultiEdit, Write, 적용 불가', () => {
  expect(applyEdit('a b a', { tool: 'Edit', old_string: 'a', new_string: 'x' })).toBe('x b a')
  expect(applyEdit('a b a', { tool: 'Edit', old_string: 'a', new_string: 'x', replace_all: true })).toBe('x b x')
  expect(applyEdit('a b', { tool: 'MultiEdit', edits: [{ old_string: 'a', new_string: 'x' }, { old_string: 'b', new_string: 'y' }] })).toBe('x y')
  expect(applyEdit(null, { tool: 'Write', content: 'new' })).toBe('new')
  expect(applyEdit('abc', { tool: 'Edit', old_string: 'zzz', new_string: 'x' })).toBeNull()
})

test('대화 기록에서 턴과 Edit/Write 변경, Bash 명령을 복원한다', () => {
  const lines = [
    user('u1', '2026-10-02T01:00:00Z', '로그인 재시도 넣어줘'),
    use('2026-10-02T01:01:00Z', 'e1', 'Edit', { file_path: '/r/a.js', old_string: 'one', new_string: 'two', replace_all: false }),
    result('2026-10-02T01:01:01Z', 'e1', { filePath: '/r/a.js', originalFile: 'one\nkeep\n' }),
    use('2026-10-02T01:02:00Z', 'e2', 'Edit', { file_path: '/r/a.js', old_string: 'keep', new_string: 'kept', replace_all: false }),
    result('2026-10-02T01:02:01Z', 'e2', { filePath: '/r/a.js', originalFile: 'two\nkeep\n' }),
    use('2026-10-02T01:03:00Z', 'w1', 'Write', { file_path: '/r/new.js', content: 'n\n' }),
    result('2026-10-02T01:03:01Z', 'w1', { filePath: '/r/new.js', originalFile: null, type: 'create' }),
    use('2026-10-02T01:04:00Z', 'e3', 'Edit', { file_path: '/r/b.js', old_string: 'x', new_string: 'y' }),
    result('2026-10-02T01:04:01Z', 'e3', {}, true),
    use('2026-10-02T01:05:00Z', 'b1', 'Bash', { command: 'cd /w/api && git commit -qam fix' }),
    say('2026-10-02T01:06:00Z', '재시도를 넣었습니다.'),
    user('u2', '2026-10-02T02:00:00Z', '고마워'),
    say('2026-10-02T02:00:05Z', '천만에요.'),
  ]
  const turns = turnsFromTranscript(lines)
  expect(turns).toHaveLength(2)
  const t = turns[0]
  expect(t).toMatchObject({ id: 'u1', startAt: '2026-10-02T01:00:00Z', endAt: '2026-10-02T02:00:00Z', request: '로그인 재시도 넣어줘', answer: '재시도를 넣었습니다.' })
  // 같은 파일을 두 번 고치면 변경 전은 처음 것, 변경 후는 마지막 결과
  expect(t.files['/r/a.js']).toMatchObject({ before: 'one\nkeep\n', after: 'two\nkept\n', tools: ['Edit'], skipped: null })
  expect(t.files['/r/new.js']).toMatchObject({ before: null, after: 'n\n', tools: ['Write'] })
  // 실패한 편집은 없다
  expect(t.files['/r/b.js']).toBeUndefined()
  expect(t.bashCommands).toEqual(['cd /w/api && git commit -qam fix'])
  expect(t.excerpt).toMatch(/사용자: 로그인 재시도 넣어줘[\s\S]*Claude: 재시도를 넣었습니다\./)
  expect(Object.keys(turns[1].files)).toEqual([])
})

test('서브에이전트의 편집은 시각이 들어가는 메인 턴에 붙는다', () => {
  const lines = [
    user('u1', '2026-10-02T01:00:00Z', '테스트 써줘'),
    user('u2', '2026-10-02T03:00:00Z', '다음 일'),
  ]
  const sub = [
    { agent: 'agentA', line: use('2026-10-02T01:30:00Z', 's1', 'Write', { file_path: '/r/a.test.js', content: 't\n' }) },
    { agent: 'agentA', line: result('2026-10-02T01:30:01Z', 's1', { filePath: '/r/a.test.js', originalFile: null, type: 'create' }) },
  ]
  const turns = turnsFromTranscript(lines, sub)
  expect(turns[0].files['/r/a.test.js']).toMatchObject({ before: null, after: 't\n', agents: ['agentA'] })
  expect(Object.keys(turns[1].files)).toEqual([])
})

test('커밋은 그것을 만든 턴에만 붙는다 (같은 시간대의 다른 세션 커밋은 제외)', () => {
  // 커밋 명령이 없는 턴
  expect(madeByTurn('fix(A-1): 고침', ['git log --oneline', 'git status'])).toBe(false)
  expect(madeByTurn('fix(A-1): 고침', ['base=$(git -C /w/api merge-base HEAD origin/main)', 'git log --no-merges'])).toBe(false)
  // 메시지를 적어 넣은 커밋: 제목이 맞아야
  expect(madeByTurn('fix(A-1): 고침', ["cd /w/api && git commit -qam 'fix(A-1): 고침'"])).toBe(true)
  expect(madeByTurn('fix(B-2): 다른 세션', ["cd /w/api && git commit -qam 'fix(A-1): 고침'"])).toBe(false)
  expect(madeByTurn('fix(A-1): 고침', ["git commit -F - <<'EOF'\nfix(A-1): 고침\n\n본문\nEOF"])).toBe(true)
  // 메시지를 알 수 없는 커밋(cherry-pick, 파일 메시지)은 시간으로 믿는다
  expect(madeByTurn('fix(A-1): 고침', ['git -C /w/api cherry-pick abc123'])).toBe(true)
  expect(madeByTurn('fix(A-1): 고침', ['git commit -F msg.txt'])).toBe(true)
})

test('git log 해석', () => {
  expect(parseLog('abc\t2026-10-02T10:00:00+09:00\tfix(SHOP-1): 고침\n')).toEqual([{ sha: 'abc', at: '2026-10-02T10:00:00+09:00', subject: 'fix(SHOP-1): 고침' }])
})

test('이미지를 붙인 요청도 턴으로 인식하고, 작업 결과가 아닌 경로는 가린다', () => {
  expect(promptText({ type: 'user', message: { content: [{ type: 'image' }, { type: 'text', text: '이거 봐줘' }] } })).toBe('이거 봐줘')
  expect(promptText({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } })).toBeNull()
  expect(promptText({ type: 'user', message: { content: '<system-reminder>x' } })).toBeNull()
  expect(promptText({ type: 'user', message: { content: '[Request interrupted by user]' } })).toBeNull()
  expect(promptText({ type: 'user', message: { content: '[Image #1] [Image #2] 이거 행사 찾아줘' } })).toBe('이거 행사 찾아줘')
  expect(promptText({ type: 'user', message: { content: '[Image: source: /var/folders/x/T/p.png]' } })).toBe('(이미지)')
  expect(isWorkPath('/Users/u/p/api/src/A.java', '/Users/u')).toBe(true)
  expect(isWorkPath('/Users/u/.claude/projects/x/memory/a.md', '/Users/u')).toBe(false)
  expect(isWorkPath('/private/tmp/claude-501/x/scratch.md', '/Users/u')).toBe(false)
})

test('지난 턴의 맥락에는 같은 세션의 앞선 요청이 들어간다', () => {
  const lines = [
    user('a', '2026-10-02T01:00:00Z', 'SHOP-217 판매채널을 파라미터로 받게 해줘'),
    user('b', '2026-10-02T02:00:00Z', '안 넘기면 전체 채널로'),
    user('c', '2026-10-02T03:00:00Z', 'ㅇㅇㅇ가자'),
  ]
  const t = turnsFromTranscript(lines)[2]
  expect(t.excerpt).toMatch(/## 같은 세션의 앞선 요청 \(오래된 것부터\)\n- SHOP-217 판매채널을 파라미터로 받게 해줘\n- 안 넘기면 전체 채널로\n\n## 이 턴\n사용자: ㅇㅇㅇ가자/)
  expect(turnsFromTranscript(lines)[0].excerpt.startsWith('사용자: ')).toBe(true)
})
