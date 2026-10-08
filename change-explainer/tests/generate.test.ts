import { expect, test } from 'claude-code/testing'
import { parseAt, sectionPrompt, setLanguage, validate } from '../hooks/generate.js'

const ctx = { text: '## 해설할 턴', hunkCount: 2 }

test('설정 language: 해설 언어 지시가 바뀐다', () => {
  setLanguage('en')
  expect(sectionPrompt('summary', ctx)).toMatch(/Write every text value in English/)
  setLanguage('ko')
  expect(sectionPrompt('summary', ctx)).toMatch(/한국어로, 짧고 쉬운 문장으로/)
})

test('코드 위치 해석', () => {
  expect(parseAt('src/a.ts:3-9')).toEqual({ path: 'src/a.ts', start: 3, end: 9, deleted: false })
  expect(parseAt('src/a.ts:12 (삭제)')).toEqual({ path: 'src/a.ts', start: 12, end: 12, deleted: true })
  expect(parseAt('src/a.ts:1-100')).toMatchObject({ end: 15 })
  expect(parseAt('대화')).toBeNull()
})

test('검증: 요약의 hunkNotes는 변경 블록 수에 맞춘다, 퀴즈는 보기 3개인 문제만', () => {
  const s = validate('summary', '{"tldr":"t","hunkNotes":["a"]}', { hunkCount: 3 })
  expect(s).toMatchObject({ ok: true, value: { hunkNotes: ['a', '', ''] } })
  const q = validate('quiz', '{"questions":[{"q":"a","options":["1","2"],"explain":""},{"q":"b","options":["1","2","3"],"explain":"e"}]}')
  expect(q).toMatchObject({ ok: true, value: { questions: [{ q: 'b' }] } })
  expect(validate('flow', 'not json')).toMatchObject({ ok: false })
})
