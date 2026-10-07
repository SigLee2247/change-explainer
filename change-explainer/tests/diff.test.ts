import { expect, test } from 'claude-code/testing'
import { countChanges, diffLines, lineStats, splitLines } from '../hooks/diff.js'

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
