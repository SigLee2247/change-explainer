import { expect, test } from 'claude-code/testing'
import { edit, setup, turnEnd, turnStart } from './helpers.ts'

const pane = (bodyColumns = 110, bodyRows = 60) => ({
  plugin: 'change-explainer',
  component: 'Pane',
  requestId: 'change-explainer',
  surface: 'terminal',
  viewport: { columns: 200, rows: 80 },
  props: { title: '변경 해설', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
}) as any

// 모델 대신 답하는 섹션별 JSON
const FIXTURES: Record<string, unknown> = {
  요약: {
    tldr: '로그인 요청을 실패하면 다시 시도하도록 바꿨습니다.',
    files: [{ path: 'src/login.ts', desc: 'api 호출을 retry로 감쌈' }],
    why: ['가끔 실패하는 요청을 사용자가 모르게 다시 보내기 위해서입니다.'],
    how: [{ label: 'retry(fn)', detail: '실패하면 다시 부릅니다.' }],
    review: [{ kind: 'warn', text: '응답이 늦어질 수 있습니다.' }],
    hunkNotes: ['api 호출을 retry로 감쌈'],
  },
  배경: { problem: '로그인이 가끔 실패했습니다.', cause: '한 번 실패하면 바로 에러를 던졌습니다.', causeAt: 'src/login.ts:2', goal: '다시 시도', outOfScope: [] },
  '코드 따라가기': { steps: [{ title: '재시도로 감싸기', at: 'src/login.ts:2-2', does: 'api 호출을 retry로 감쌉니다.', why: '일시적인 실패 때문', alt: '' }] },
  흐름도: { nodes: [{ title: 'login 호출', desc: '시작', kind: 'step' }, { title: '성공했나?', desc: '', kind: 'cond', branch: { label: '예', title: '반환', desc: '', kind: 'ok' } }] },
  시퀀스: { lanes: [{ name: 'login()' }, { name: 'api' }], msgs: [{ from: 0, to: 1, label: 'post', kind: 'normal' }, { from: 1, to: 0, label: '200', kind: 'ok', note: '성공' }] },
  '전후 비교': { rows: [{ when: '서버 503', before: '즉시 에러', after: '다시 시도', tone: 'better' }] },
  '영향 범위': { groups: [{ title: '부르는 곳', items: [{ path: 'src/page.ts:3', desc: '로딩이 길어질 수 있음' }] }] },
  용어: { terms: [{ id: 'retry', term: '재시도', en: 'retry', def: '실패한 요청을 다시 보내는 것.' }] },
  '확인 퀴즈': { questions: [{ q: '401이면?', options: ['바로 실패', '세 번 시도', '한 번 더'], explain: '재시도 대상이 아님' }] },
}

type Opts = { bad?: string[]; badTwice?: string[]; noFork?: boolean }

// 모델 스텁: 프롬프트의 "지금 만들 것" 제목을 보고 JSON을 고른다. 호출을 기록한다
function stubModel(on: any, opts: Opts = {}) {
  const calls: string[] = []
  const prompts: string[] = []
  const tries: Record<string, number> = {}
  const reply = (prompt: string) => {
    const easy = /잠깐, 무슨 말이야/.test(prompt)
    const question = /^## 질문$/m.test(prompt)
    if (easy) return JSON.stringify({ text: '쉽게 말하면 다시 전화를 거는 것과 같습니다.' })
    if (question) return JSON.stringify({ text: '401은 다시 보내도 결과가 같기 때문입니다.' })
    const title = (/## 지금 만들 것: (.+)/.exec(prompt) || [])[1]
    tries[title] = (tries[title] || 0) + 1
    if ((opts.bad || []).includes(title) && tries[title] === 1) return '죄송합니다, 여기 있습니다'
    if ((opts.badTwice || []).includes(title)) return 'JSON이 아님'
    return '```json\n' + JSON.stringify(FIXTURES[title]) + '\n```'
  }
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  on('model.fork', ($: any, e: any) => {
    calls.push('fork:' + ((/## 지금 만들 것: (.+)/.exec(e.prompt) || [])[1] || 'text'))
    prompts.push(e.prompt)
    if (opts.noFork) return { value: { isAnswered: false, reason: 'nothing-to-fork' } }
    return { value: { isAnswered: true, text: reply(e.prompt), usage } }
  })
  on('model.complete', ($: any, e: any) => {
    calls.push('complete')
    return { value: { isAnswered: true, text: reply(e.prompt), usage } }
  })
  on('session.model', () => ({ value: 'claude-sonnet' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.scroll', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  return Object.assign(calls, { prompts })
}

const flush = () => new Promise((r) => setTimeout(r, 20))

async function changedTurn($: any, on: any, opts: Opts = {}) {
  const fs = setup(on, { '/repo/src/login.ts': 'export function login(u) {\n  return api.post(u)\n}\n' })
  const calls = stubModel(on, opts)
  await turnStart($, 't1', '로그인 재시도 추가')
  await edit($, '/repo/src/login.ts', 'return api.post(u)', 'return retry(() => api.post(u))')
  await turnEnd($, 't1')
  await $.command.run({ command: 'explain', args: '' })
  await flush()
  return { fs, calls }
}

test('창을 열면 요약을 현재 대화의 fork로 만들고 캐시에 저장한다', async ($, on) => {
  const { fs, calls } = await changedTurn($, on)
  expect(calls).toEqual(['fork:요약'])
  const ui = await $.ui.mount(pane())
  expect(await ui.find({ type: 'Text', text: '로그인 요청을 실패하면 다시 시도하도록 바꿨습니다.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /응답이 늦어질 수 있습니다/ })).toBeDefined()
  expect(fs.json('/views/summary.json')).toMatchObject({ hunkNotes: ['api 호출을 retry로 감쌈'] })

  // 다시 열면 저장해 둔 것을 쓰고 모델을 부르지 않는다
  await $.command.run({ command: 'explain', args: '' })
  await flush()
  expect(calls).toEqual(['fork:요약'])
})

test('섹션은 펼칠 때 만든다: 흐름도는 카드, 코드 따라가기는 실제 줄을 스냅숏에서 읽는다', async ($, on) => {
  const { calls } = await changedTurn($, on)
  const ui = await $.ui.mount(pane())
  await ui.press({ key: 'btn-flow' })
  await flush()
  expect(await ui.find({ type: 'Text', text: '성공했나?' })).toBeDefined()
  await ui.press({ key: 'btn-walk' })
  await flush()
  expect(await ui.find({ type: 'Text', text: /return retry\(\(\) => api\.post\(u\)\)/, in: 'pan-walk-0' })).toBeDefined()
  expect(calls).toEqual(['fork:요약', 'fork:흐름도', 'fork:코드 따라가기'])
})

test('형식이 틀리면 한 번 더 요청하고, 두 번 다 틀리면 실패를 보여 준다', async ($, on) => {
  const { calls } = await changedTurn($, on, { bad: ['요약'], badTwice: ['배경'] })
  expect(calls).toEqual(['fork:요약', 'fork:요약'])
  const ui = await $.ui.mount(pane())
  expect(await ui.find({ type: 'Text', text: '로그인 요청을 실패하면 다시 시도하도록 바꿨습니다.' })).toBeDefined()
  await ui.press({ key: 'btn-background' })
  await flush()
  expect(await ui.find({ type: 'Text', text: /만들지 못했습니다: 형식이 맞지 않음/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✗ 만들지 못함/ })).toBeDefined()
})

test('fork할 대화가 없으면 요청문·답변·diff만으로 complete를 부른다', async ($, on) => {
  const { calls } = await changedTurn($, on, { noFork: true })
  expect(calls).toEqual(['fork:요약', 'complete'])
  const ui = await $.ui.mount(pane())
  expect(await ui.find({ type: 'Text', text: '로그인 요청을 실패하면 다시 시도하도록 바꿨습니다.' })).toBeDefined()
})

test('퀴즈를 다 맞히면 세션 목록에 이해함으로 남는다', async ($, on) => {
  const { fs } = await changedTurn($, on)
  const ui = await $.ui.mount(pane())
  await ui.press({ key: 'go-quiz' })
  await flush()
  await ui.press({ key: 'q0-o0' })
  await flush()
  expect(await ui.find({ type: 'Text', text: /1\/1 정답/ })).toBeDefined()
  expect(fs.json('/session.json').turns[0]).toMatchObject({ understood: true })
})

test('Known은 저장소 단위 학습 기록에 남고, 다음 프롬프트에 들어간다', async ($, on) => {
  const { fs, calls } = await changedTurn($, on)
  const ui = await $.ui.mount(pane())
  await ui.press({ key: 'btn-terms' })
  await flush()
  await ui.press({ key: 'term-retry' })
  await flush()
  expect(fs.json('/learning.json')).toEqual({ known: ['재시도'], stuck: [] })
  expect(fs.find('/learning.json')).toMatch(/explanations\/repo-[0-9a-f]{8}\/learning\.json$/)
  // 다음에 만드는 섹션의 프롬프트에 이미 아는 용어로 들어간다
  await ui.press({ key: 'btn-background' })
  await flush()
  const last = calls.prompts[calls.prompts.length - 1]
  expect(last).toMatch(/## 사용자가 이미 아는 용어[^\n]*\n재시도/)
})

test('Wait, what?은 쉬운 설명을 이어 붙이고 그 섹션을 막혔던 곳으로 기록한다', async ($, on) => {
  const { fs } = await changedTurn($, on)
  const ui = await $.ui.mount(pane())
  await ui.press({ key: 'easy-summary' })
  await flush()
  expect(await ui.find({ type: 'Text', text: '쉽게 말하면 다시 전화를 거는 것과 같습니다.' })).toBeDefined()
  await ui.input({ key: 'easy-ask-summary', text: '401은 왜?' })
  await flush()
  expect(await ui.find({ type: 'Text', text: /401은 다시 보내도 결과가 같기 때문입니다/ })).toBeDefined()
  expect(fs.json('/learning.json').stuck).toEqual(['요약 (로그인 재시도 추가)'])
  expect(fs.json('/views/threads.json').threads.summary).toHaveLength(2)
})

test('diff 창 아래쪽에 요약이 만든 변경별 한 줄 설명이 붙는다', async ($, on) => {
  await changedTurn($, on)
  const ui = await $.ui.mount(pane())
  await ui.press({ key: 'diff' })
  expect(await ui.find({ type: 'Text', text: /api 호출을 retry로 감쌈/ })).toBeDefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: '한 줄 요약' })).toBeDefined()
})
