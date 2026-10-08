// git 출력 해석과 Bash 명령의 경로 추출. mods API를 쓰지 않는 순수 함수만 둔다.

// Claude Code가 대화 기록을 두는 폴더 이름: 작업 디렉토리의 영숫자 아닌 글자를 '-'로
export function projectDirName(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

// `git diff --name-status -M <base>` → [{ status, path, from }]
export function parseNameStatus(text) {
  return text.split('\n').filter(Boolean).map((line) => {
    const parts = line.split('\t')
    const code = parts[0][0]
    if (code === 'R' || code === 'C') return { status: code, from: parts[1], path: parts[2] }
    return { status: code, path: parts[1], from: null }
  })
}

// Bash 명령에서 디렉토리 후보를 뽑는다: cd 대상, git -C 대상, 절대 경로와 ~/ 경로
// 상대 경로의 cd는 cwd 기준. 파일 경로는 폴더로(확장자가 있으면). 많아야 8개
export function commandDirs(command, cwd, home) {
  const out = new Set()
  const add = (p) => {
    if (!p) return
    let x = p.replace(/^["']|["']$/g, '')
    if (x.startsWith('~/')) x = home + x.slice(1)
    else if (x === '~') x = home
    else if (!x.startsWith('/')) x = cwd.replace(/\/$/, '') + '/' + x
    x = x.replace(/\/+$/, '')
    if (/\.[A-Za-z0-9]{1,8}$/.test(x.split('/').pop())) x = x.slice(0, x.lastIndexOf('/'))
    // 장치·커널 경로와 Claude Code 자체 데이터만 뺀다. 임시 폴더라도 git 저장소면 작업 대상이다
    // (저장소가 아닌 디렉토리는 git 최상위를 찾는 단계에서 걸러진다)
    if (/^\/(dev|proc|sys)(\/|$)/.test(x) || x.startsWith(home + '/.claude')) return
    if (x) out.add(x)
  }
  for (const m of command.matchAll(/(?:^|[;&|(]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) add(m[1])
  for (const m of command.matchAll(/git\s+-C\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) add(m[1])
  for (const m of command.matchAll(/(?:^|[\s'"=:(>])((?:\/|~\/)[A-Za-z0-9._~@+\/-]+)/g)) add(m[1])
  return [...out].slice(0, 8)
}

// `git status --porcelain` → { dirty: [경로], untracked: [경로] }  (이름 바꾸기는 새 경로)
export function parseStatus(text) {
  const dirty = []
  const untracked = []
  for (const line of text.split('\n')) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    let path = line.slice(3)
    if (path.includes(' -> ')) path = path.split(' -> ').pop()
    path = path.replace(/^"|"$/g, '')
    if (code === '??') untracked.push(path)
    else dirty.push(path)
  }
  return { dirty, untracked }
}
