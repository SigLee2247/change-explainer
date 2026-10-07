import { expect, test } from 'claude-code/testing'
import { buildRows, countChanges, diffLines, lineStats, splitLines } from '../hooks/diff.js'

// 편집 목록을 a에 적용하면 b가 나와야 한다
function apply(a: string[], b: string[], ops: { op: string; a?: number; b?: number }[]) {
  const out: string[] = []
  for (const o of ops) {
    if (o.op === 'eq') out.push(a[o.a!])
    else if (o.op === 'add') out.push(b[o.b!])
  }
  return out
}

test('같은 글은 모두 eq', () => {
  const a = ['x', 'y', 'z']
  expect(diffLines(a, a).every((o) => o.op === 'eq')).toBe(true)
})

test('추가·삭제·수정이 섞인 diff가 b를 다시 만든다', () => {
  const a = splitLines("import { api } from '../lib/api'\n\nexport async function login(u, p) {\n  const res = await api.post(u, p)\n  log.info(res)\n  return res\n}\n")
  const b = splitLines("import { api } from '../lib/api'\nimport { retry } from '../lib/retry'\n\nexport async function login(u, p) {\n  const res = await retry(() => api.post(u, p))\n  return res\n}\n")
  const ops = diffLines(a, b)
  expect(apply(a, b, ops)).toEqual(b)
  expect(countChanges(ops)).toEqual({ added: 2, removed: 2 })
})

test('새 파일과 빈 파일', () => {
  expect(lineStats(null, 'a\nb\n')).toEqual({ added: 2, removed: 0 })
  expect(lineStats('a\nb\n', '')).toEqual({ added: 0, removed: 2 })
  expect(lineStats('', '')).toEqual({ added: 0, removed: 0 })
})

test('여러 무작위 쌍에서도 b를 다시 만든다', () => {
  let seed = 7
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647
  for (let n = 0; n < 50; n++) {
    const a = Array.from({ length: Math.floor(rand() * 20) }, () => String(Math.floor(rand() * 5)))
    const b = Array.from({ length: Math.floor(rand() * 20) }, () => String(Math.floor(rand() * 5)))
    expect(apply(a, b, diffLines(a, b))).toEqual(b)
  }
})

test('CRLF 줄바꿈도 줄로 나눈다', () => {
  expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b'])
})

test('화면 행: 수정 블록은 짝을 짓고, 줄 안에서 바뀐 구간을 찾는다', () => {
  const { rows, hunks } = buildRows('a\nconst x = api(u)\nb\n', 'a\nconst x = retry(() => api(u))\nextra\nb\n')
  expect(hunks).toBe(1)
  expect(rows.map((r: any) => r.kind)).toEqual(['eq', 'mod', 'mod', 'eq'])
  const pair = rows[1] as any
  // 왼쪽은 그대로 남았고, 오른쪽에 'retry(() => '와 ')'가 덧붙었다
  expect(pair.left.hi).toEqual([])
  expect(pair.right.hi.map(([s, e]: number[]) => pair.right.text.slice(s, e))).toEqual(['retry(() => ', ')'])
  // 짝이 없는 추가 줄은 왼쪽이 비어 있다
  expect((rows[2] as any).left).toBeNull()
  expect((rows[2] as any).right).toMatchObject({ num: 3, text: 'extra' })
})

test('화면 행: 변경에서 먼 같은 줄은 접고, 한 줄짜리는 접지 않는다', () => {
  const before = Array.from({ length: 20 }, (_, i) => 'line' + i).join('\n')
  const after = before.replace('line10', 'LINE10')
  const { rows } = buildRows(before, after)
  expect(rows[0]).toEqual({ kind: 'fold', count: 7 })
  expect(rows[rows.length - 1]).toEqual({ kind: 'fold', count: 6 })
  expect(rows.filter((r: any) => r.kind === 'mod')).toHaveLength(1)

  // 변경 두 개 사이에 숨길 줄이 하나뿐이면 그대로 보인다
  const b2 = before.replace('line3', 'X').replace('line10', 'Y')
  const kinds = buildRows(before, b2).rows.map((r: any) => r.kind)
  expect(kinds.includes('fold')).toBe(true)
  expect(buildRows(before, before.replace('line3', 'X').replace('line11', 'Y')).rows.filter((r: any) => r.kind === 'fold' && r.count === 1)).toHaveLength(0)
})

test('화면 행: 새 파일은 모두 추가, 블록 번호가 붙는다', () => {
  const { rows, hunks } = buildRows(null, 'x\ny\n')
  expect(hunks).toBe(1)
  expect(rows).toMatchObject([{ kind: 'add', left: null, hunk: 1 }, { kind: 'add', hunk: 1 }])
})
