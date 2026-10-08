import { expect, test } from 'claude-code/testing'
import { commandDirs, parseNameStatus, parseStatus, projectDirName } from '../hooks/git.js'

test('대화 기록 폴더 이름', () => {
  expect(projectDirName('/Users/me/work/ax/shop-harness')).toBe('-Users-me-work-ax-shop-harness')
  expect(projectDirName('/a/b/.claude/worktrees/x')).toBe('-a-b--claude-worktrees-x')
})

test('git diff --name-status', () => {
  expect(parseNameStatus('M\tsrc/a.java\nA\tsrc/b.java\nR087\told/c.java\tnew/c.java\nD\tsrc/d.java\n')).toEqual([
    { status: 'M', path: 'src/a.java', from: null },
    { status: 'A', path: 'src/b.java', from: null },
    { status: 'R', path: 'new/c.java', from: 'old/c.java' },
    { status: 'D', path: 'src/d.java', from: null },
  ])
})

test('Bash 명령에서 건드리는 디렉토리 후보', () => {
  expect(commandDirs('cd /w/wt-SHOP-1 && sed -i s/a/b/ src/A.java && git commit -m x', '/h', '/Users/u')).toEqual(['/w/wt-SHOP-1'])
  expect(commandDirs('git -C ~/p/api status', '/h', '/Users/u')).toEqual(['/Users/u/p/api'])
  expect(commandDirs('cat > /w/api/src/New.java <<EOF', '/h', '/Users/u')).toEqual(['/w/api/src'])
  expect(commandDirs('cd sub && ls', '/h', '/Users/u')).toEqual(['/h/sub'])
  expect(commandDirs('cat /dev/null; ls ~/.claude/projects', '/h', '/Users/u')).toEqual([])
  expect(commandDirs('cd /private/tmp/demo-repo && git status', '/h', '/Users/u')).toEqual(['/private/tmp/demo-repo'])
  expect(parseStatus(' M src/A.java\nA  src/B.java\nR  old.java -> new.java\n?? notes.md\n')).toEqual({ dirty: ['src/A.java', 'src/B.java', 'new.java'], untracked: ['notes.md'] })
})
