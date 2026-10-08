import { expect, test } from 'claude-code/testing'
import {
  baseCandidates, candidateDirs, conversationExcerpt, parseNameStatus, parseShortstat, parseWorktrees, projectDirName, slug, ticketKey,
} from '../hooks/branches.js'

test('대화 기록 폴더 이름', () => {
  expect(projectDirName('/Users/me/work/ax/shop-harness')).toBe('-Users-me-work-ax-shop-harness')
  expect(projectDirName('/a/b/.claude/worktrees/x')).toBe('-a-b--claude-worktrees-x')
})

test('기준 브랜치 후보', () => {
  expect(baseCandidates('develop, main')).toEqual(['develop', 'main'])
  expect(baseCandidates('')).toEqual(['develop', 'main'])
  expect(baseCandidates('release/2026,main')).toEqual(['release/2026', 'main'])
})

test('git worktree list --porcelain', () => {
  const text = 'worktree /r/api\nHEAD aaa\nbranch refs/heads/develop\n\nworktree /r/wt-SHOP-217\nHEAD bbb\nbranch refs/heads/feature/SHOP-217-sitemap\n\nworktree /r/wt-x\nHEAD ccc\ndetached\n'
  expect(parseWorktrees(text)).toEqual([
    { path: '/r/api', head: 'aaa', branch: 'develop' },
    { path: '/r/wt-SHOP-217', head: 'bbb', branch: 'feature/SHOP-217-sitemap' },
    { path: '/r/wt-x', head: 'ccc', branch: '' },
  ])
})

test('git diff --name-status, --shortstat', () => {
  expect(parseNameStatus('M\tsrc/a.java\nA\tsrc/b.java\nR087\told/c.java\tnew/c.java\nD\tsrc/d.java\n')).toEqual([
    { status: 'M', path: 'src/a.java', from: null },
    { status: 'A', path: 'src/b.java', from: null },
    { status: 'R', path: 'new/c.java', from: 'old/c.java' },
    { status: 'D', path: 'src/d.java', from: null },
  ])
  expect(parseShortstat(' 3 files changed, 42 insertions(+), 10 deletions(-)')).toEqual({ files: 3, added: 42, removed: 10 })
  expect(parseShortstat(' 1 file changed, 1 insertion(+)')).toEqual({ files: 1, added: 1, removed: 0 })
})

test('대화 기록에서 뽑은 경로 → 후보 디렉토리 (임시 폴더와 Claude 데이터는 제외)', () => {
  const dirs = candidateDirs([
    '"file_path":"/Users/u/p/shop/wt-SHOP-265-batch/src/main/A.java"',
    'cd /Users/u/p/shop/shop-tms',
    '"cwd":"/Users/u/p/ax/shop-harness"',
    'cd ~/p/shop/wt-SHOP-217',
    '"file_path":"/private/tmp/claude-501/x/y.md"',
    '"file_path":"/Users/u/.claude/projects/x/memory/a.md"',
  ], '/Users/u')
  expect(dirs).toEqual([
    '/Users/u/p/ax/shop-harness',
    '/Users/u/p/shop/shop-tms',
    '/Users/u/p/shop/wt-SHOP-217',
    '/Users/u/p/shop/wt-SHOP-265-batch/src/main',
  ])
})

test('티켓 키와 폴더 이름', () => {
  expect(ticketKey('fix/SHOP-262-review-score')).toBe('SHOP-262')
  expect(ticketKey('develop')).toBe('')
  expect(slug('fix/SHOP-262 review score')).toBe('fix_SHOP-262_review_score')
})

test('대화 발췌: 사용자 요청과 Claude 설명만, 시간순', () => {
  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-10-02T10:00:00Z', message: { content: 'SHOP-217 사이트맵 대상 바꿔줘' } }),
    JSON.stringify({ type: 'user', timestamp: '2026-10-02T10:00:01Z', message: { content: '<system-reminder>무시</system-reminder>' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-02T10:01:00Z', message: { content: [{ type: 'text', text: '노출 상품만 대상으로 바꿨습니다.' }, { type: 'tool_use', name: 'Bash' }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-10-02T10:01:30Z', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: '2026-10-02T10:02:00Z', message: { content: [{ type: 'text', text: '서브에이전트 글' }] } }),
    'not json',
  ]
  expect(conversationExcerpt(lines)).toBe('[2026-10-02 10:00] 사용자: SHOP-217 사이트맵 대상 바꿔줘\n\n[2026-10-02 10:01] Claude: 노출 상품만 대상으로 바꿨습니다.')
})

test('대화 발췌: 작업이 언급된 구간만 (그 앞의 요청부터 다음 요청 전까지)', () => {
  const L = (type: string, at: string, content: any) => JSON.stringify({ type, timestamp: '2026-10-02T' + at + ':00Z', message: { content } })
  const lines = [
    L('user', '01:00', '회원 API 테스트해줘'),
    L('assistant', '01:01', [{ type: 'text', text: '회원 API 테스트 결과입니다.' }]),
    L('user', '02:00', 'SHOP-217 사이트맵 대상 바꿔줘'),
    L('assistant', '02:01', [{ type: 'tool_use', name: 'Bash', input: { command: 'cd /w/wt-SHOP-217 && git commit' } }]),
    L('assistant', '02:05', [{ type: 'text', text: '노출 상품만 대상으로 바꿨습니다.' }]),
    L('user', '03:00', '배포 일정 알려줘'),
    L('assistant', '03:01', [{ type: 'text', text: '목요일입니다.' }]),
  ]
  expect(conversationExcerpt(lines, 12000, ['/w/wt-SHOP-217', 'feature/SHOP-217', 'SHOP-217'])).toBe(
    '[2026-10-02 02:00] 사용자: SHOP-217 사이트맵 대상 바꿔줘\n\n[2026-10-02 02:05] Claude: 노출 상품만 대상으로 바꿨습니다.',
  )
})
