// 줄 단위 diff (Myers 알고리즘). mods API를 쓰지 않는 순수 함수만 둔다.

// 글을 줄 배열로 나눈다. 끝의 줄바꿈 하나는 빈 줄로 세지 않는다
export function splitLines(text) {
  if (text === null || text === undefined || text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

// a에서 b로 가는 최단 편집: [{ op: 'eq' | 'del' | 'add', a?: a의 줄 위치, b?: b의 줄 위치 }]
// 위치는 0부터. eq는 a와 b 둘 다, del은 a만, add는 b만 가진다
export function diffLines(a, b) {
  const n = a.length
  const m = b.length
  const max = n + m
  const offset = max
  const v = new Array(2 * max + 2).fill(0)
  const trace = []

  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1]
      else x = v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v[offset + k] = x
      if (x >= n && y >= m) break outer
    }
  }

  // 지나온 길을 거꾸로 따라가며 편집 목록을 만든다
  const ops = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d]
    const k = x - y
    let prevK
    if (k === -d || (k !== d && vv[offset + k - 1] < vv[offset + k + 1])) prevK = k + 1
    else prevK = k - 1
    const prevX = vv[offset + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) { x--; y--; ops.push({ op: 'eq', a: x, b: y }) }
    if (d > 0) {
      if (x === prevX) { y--; ops.push({ op: 'add', b: y }) }
      else { x--; ops.push({ op: 'del', a: x }) }
    }
  }
  return ops.reverse()
}

// 추가·삭제 줄 수
export function countChanges(ops) {
  let added = 0
  let removed = 0
  for (const o of ops) {
    if (o.op === 'add') added++
    else if (o.op === 'del') removed++
  }
  return { added, removed }
}

// 두 글의 추가·삭제 줄 수 (before가 null이면 새 파일)
export function lineStats(before, after) {
  return countChanges(diffLines(splitLines(before), splitLines(after)))
}

// ── 화면용 diff 행 ───────────────────────────────────────────
// 변경 블록(연속된 추가·삭제) 단위로 묶고, 변경 없는 긴 구간은 접는다.
//
// 행 하나: { kind, left, right, hunk }
//   kind   'eq' 같음 · 'add' 추가만 · 'del' 삭제만 · 'mod' 같은 블록 안에 삭제와 추가가 함께
//   left   { num, text, hi } 또는 null (변경 전 줄, num은 1부터)
//   right  { num, text, hi } 또는 null (변경 후 줄)
//   hi     줄 안에서 바뀐 구간 [[시작, 끝)] (mod 짝 줄에만)
//   hunk   변경 블록 번호 (1부터, eq는 0)
// 접힌 구간: { kind: 'fold', count }

export const CONTEXT = 3

// 이보다 긴 줄은 단어 diff 대신 앞뒤가 같은 부분만 빼고 강조한다 (계산량 제한)
const WORD_DIFF_MAX = 2000

// 줄을 단어·공백·기호 단위로 쪼갠다
function tokens(text) {
  return text.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) || []
}

// 두 줄에서 바뀐 구간들을 찾는다: { left: [[시작, 끝)], right: [[시작, 끝)] }
// 단어 단위로 diff해서, 바뀐 단어가 이어지는 곳을 한 구간으로 묶는다
export function changedSpan(a, b) {
  if (a.length + b.length > WORD_DIFF_MAX) return edgeSpan(a, b)
  const ta = tokens(a)
  const tb = tokens(b)
  const left = []
  const right = []
  let pa = 0
  let pb = 0
  const push = (list, s, e) => {
    const last = list[list.length - 1]
    if (last && last[1] === s) last[1] = e
    else list.push([s, e])
  }
  for (const o of diffLines(ta, tb)) {
    if (o.op === 'eq') { pa += ta[o.a].length; pb += tb[o.b].length; continue }
    if (o.op === 'del') { push(left, pa, pa + ta[o.a].length); pa += ta[o.a].length }
    else { push(right, pb, pb + tb[o.b].length); pb += tb[o.b].length }
  }
  return { left, right }
}

// 앞뒤의 같은 부분을 뺀 가운데 한 구간
function edgeSpan(a, b) {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  return { left: endA > start ? [[start, endA]] : [], right: endB > start ? [[start, endB]] : [] }
}

export function buildRows(beforeText, afterText, context = CONTEXT) {
  const a = splitLines(beforeText)
  const b = splitLines(afterText)
  const ops = diffLines(a, b)
  const rows = []
  let hunk = 0
  let i = 0
  while (i < ops.length) {
    if (ops[i].op === 'eq') {
      const o = ops[i]
      rows.push({ kind: 'eq', left: { num: o.a + 1, text: a[o.a] }, right: { num: o.b + 1, text: b[o.b] }, hunk: 0 })
      i++
      continue
    }
    // 연속된 추가·삭제를 한 블록으로
    const dels = []
    const adds = []
    while (i < ops.length && ops[i].op !== 'eq') {
      if (ops[i].op === 'del') dels.push(ops[i].a)
      else adds.push(ops[i].b)
      i++
    }
    hunk++
    const kind = dels.length && adds.length ? 'mod' : dels.length ? 'del' : 'add'
    const n = Math.max(dels.length, adds.length)
    for (let k = 0; k < n; k++) {
      const l = k < dels.length ? { num: dels[k] + 1, text: a[dels[k]], hi: [] } : null
      const r = k < adds.length ? { num: adds[k] + 1, text: b[adds[k]], hi: [] } : null
      if (l && r) {
        const span = changedSpan(l.text, r.text)
        l.hi = span.left
        r.hi = span.right
      }
      rows.push({ kind, left: l, right: r, hunk })
    }
  }
  return { rows: fold(rows, context), hunks: hunk }
}

// 변경 블록에서 context줄보다 먼 같은 줄은 접는다. 숨길 줄이 한 줄뿐이면 접지 않고 보여 준다
function fold(rows, context) {
  const near = rows.map(() => false)
  rows.forEach((r, i) => {
    if (r.kind === 'eq') return
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) near[k] = true
  })
  const out = []
  let hidden = []
  const flush = () => {
    if (hidden.length === 1) out.push(hidden[0])
    else if (hidden.length > 1) out.push({ kind: 'fold', count: hidden.length })
    hidden = []
  }
  rows.forEach((r, i) => {
    if (r.kind === 'eq' && !near[i]) { hidden.push(r); return }
    flush()
    out.push(r)
  })
  flush()
  return out
}
