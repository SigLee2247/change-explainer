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
