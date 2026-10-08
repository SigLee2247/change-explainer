// 지난 작업을 티켓(브랜치) 단위로 가져오기: git 출력과 대화 기록을 해석하는 순수 함수.
// git 명령 실행과 파일 읽기는 register.js가 한다.

// Claude Code가 대화 기록을 두는 폴더 이름: 작업 디렉토리의 영숫자 아닌 글자를 '-'로
export function projectDirName(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

// 쉼표로 적은 기준 브랜치 후보: "develop, main" → ['develop', 'main']
export function baseCandidates(text) {
  const list = String(text || '').split(',').map((x) => x.trim()).filter(Boolean)
  return list.length ? list : ['develop', 'main']
}

// `git worktree list --porcelain` → [{ path, head, branch }]
export function parseWorktrees(text) {
  const out = []
  let cur = null
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), head: '', branch: '' }
      out.push(cur)
    } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5)
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
    else if (cur && line === 'detached') cur.branch = ''
  }
  return out
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

// `git diff --shortstat` → { files, added, removed }
export function parseShortstat(text) {
  const n = (re) => Number((re.exec(text) || [])[1] || 0)
  return { files: n(/(\d+) files? changed/), added: n(/(\d+) insertions?\(\+\)/), removed: n(/(\d+) deletions?\(-\)/) }
}

// 대화 기록에서 뽑은 경로·cd 대상 목록 → 후보 디렉토리 (중복 제거, 너무 깊은 경로는 앞부분만)
export function candidateDirs(lines, home) {
  const seen = new Set()
  for (const raw of lines) {
    let p = raw.trim().replace(/^"(file_path|cwd)":"/, '').replace(/"$/, '').replace(/^cd\s+/, '').replace(/^["']|["']$/g, '')
    if (p.startsWith('~/')) p = home + p.slice(1)
    if (!p.startsWith('/')) continue
    // 임시 폴더, Claude Code 자체 데이터는 작업 저장소가 아니다
    if (/^\/(private\/)?(tmp|var)\//.test(p) || p.startsWith(home + '/.claude/')) continue
    // 파일 경로면 폴더로. 저장소 최상위 근처만 보면 되므로 앞 8단계까지만
    const parts = p.split('/').filter(Boolean)
    const dir = '/' + parts.slice(0, Math.min(parts.length - (/\.[A-Za-z0-9]+$/.test(p) ? 1 : 0), 8)).join('/')
    if (dir.length > 1) seen.add(dir)
  }
  return [...seen].sort()
}

// 티켓 키 형식 (설정 ticket_pattern, 정규식). 기본은 Jira 형식(SHOP-217). GitHub 이슈라면 예: #\d+ 또는 \d+
let ticketPattern = /([A-Z][A-Z0-9]+-\d+)/
export function setTicketPattern(source) {
  try {
    ticketPattern = source ? new RegExp('(' + source + ')') : /([A-Z][A-Z0-9]+-\d+)/
  } catch {
    ticketPattern = /([A-Z][A-Z0-9]+-\d+)/
  }
}

// 브랜치 이름에서 티켓 키
export function ticketKey(branch) {
  const m = ticketPattern.exec(branch || '')
  return m ? m[1] : ''
}

// 저장 폴더 이름으로 쓸 수 있게
export function slug(text) {
  return String(text).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'branch'
}

// 대화 기록 줄(JSONL)들에서 이 작업과 관련된 대화만 시간순으로 뽑는다.
// keys(워크트리 경로, 브랜치 이름, 티켓 키)가 나온 줄을 찾아, 그 앞의 사용자 요청부터
// 다음 사용자 요청 직전까지의 Claude 설명을 묶는다. keys가 없으면 전부.
// 도구 결과와 시스템이 넣은 글(<…>로 시작), 서브에이전트 글은 뺀다
export function conversationExcerpt(jsonLines, maxChars = 12000, keys = []) {
  const entries = []
  for (const line of jsonLines) {
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.isSidechain) continue
    const c = o.message && o.message.content
    const mentions = keys.length > 0 && keys.some((k) => k && line.includes(k))
    if (o.type === 'user' && typeof c === 'string' && c.trim() && !c.trim().startsWith('<')) {
      entries.push({ at: o.timestamp || '', who: '사용자', text: c.trim(), mentions })
    } else if (o.type === 'assistant' && Array.isArray(c)) {
      const text = c.filter((x) => x.type === 'text' && x.text).map((x) => x.text).join('\n').trim()
      entries.push({ at: o.timestamp || '', who: 'Claude', text, mentions })
    }
  }
  entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))

  // 관련 구간 고르기: 언급된 항목의 앞쪽 사용자 요청 ~ 다음 사용자 요청 전까지
  const keep = entries.map(() => !keys.length)
  entries.forEach((e, i) => {
    if (!e.mentions) return
    let start = i
    while (start > 0 && entries[start].who !== '사용자') start--
    let end = i + 1
    while (end < entries.length && entries[end].who !== '사용자') end++
    for (let k = start; k < end; k++) keep[k] = true
  })
  const items = entries.filter((e, i) => keep[i] && e.text)

  // 너무 길면 뒤쪽(최근)을 남기고 각 글도 줄인다
  const out = []
  let size = 0
  for (let i = items.length - 1; i >= 0; i--) {
    const text = items[i].text.length > 1500 ? items[i].text.slice(0, 1500) + '…' : items[i].text
    const s = '[' + items[i].at.slice(0, 16).replace('T', ' ') + '] ' + items[i].who + ': ' + text
    if (size + s.length > maxChars) break
    out.unshift(s)
    size += s.length
  }
  return out.join('\n\n')
}

// ── 실시간 수집: Bash가 건드리는 저장소 ──────────────────────

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
