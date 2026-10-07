import { expect, mock, test } from 'claude-code/testing'

const pane = (bodyColumns: number, bodyRows = 40) => ({
  plugin: 'explain-preview',
  component: 'Pane',
  requestId: 'explain-preview',
  surface: 'terminal',
  viewport: { columns: 160, rows: 50 },
  props: {
    title: '변경 해설',
    isFocused: true,
    bodyColumns,
    placement: 'dock',
    scroll: { offset: 0, bodyRows },
    view: {},
  },
}) as const

// 창 그리기에 필요한 Claude Code 응답들을 스텁으로 채우고, 저장소에 쓴 값을 돌려준다
function stubs(on: any, initial: Record<string, unknown> = {}) {
  const clock = mock.clock(on)
  const saved = new Map<string, unknown>(Object.entries(initial))
  on('store.get', ($: any, e: any) => ({ value: saved.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  return { clock, saved }
}

for (const cols of [40, 60, 100]) {
  test(`${cols}칸 창에서 모든 섹션이 펼쳐지고 그려진다`, async ($, on) => {
    const { clock } = stubs(on)
    const ui = await $.ui.mount(pane(cols))
    expect(await ui.find({ type: 'Text', text: /재시도 대상인가/ })).toBeUndefined()

    await ui.press({ key: 'all' })
    expect(await ui.find({ type: 'Text', text: /만드는 중/ })).toBeDefined()

    await clock.advance(800)
    expect(await ui.find({ type: 'Text', text: '재시도 대상인가?' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Auth API' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '최대 3회 재시도 후 에러' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /의도했는지 확인 필요/ })).toBeDefined()
    await ui.unmount()
  })
}

test('목차에서 섹션을 누르면 펼쳐진다', async ($, on) => {
  const { clock } = stubs(on)
  const ui = await $.ui.mount(pane(60))
  await ui.press({ key: 'toc-walk' })
  await clock.advance(800)
  expect(await ui.find({ type: 'Text', text: '재시도 대상 판별' })).toBeDefined()
  expect(await ui.find({ key: 'toc-walk' })).toMatchObject({ props: { label: '3 코드 따라가기 ●' } })
})

test('섹션 제목을 누르면 그 섹션만 펼쳐진다', async ($, on) => {
  const { clock } = stubs(on)
  const ui = await $.ui.mount(pane(60))
  await ui.press({ key: 'btn-seq' })
  await clock.advance(800)
  expect(await ui.find({ type: 'Text', text: 'Auth API' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '재시도 대상인가?' })).toBeUndefined()
})

test('요약의 파일을 누르면 그 파일의 diff가 열린다', async ($, on) => {
  stubs(on)
  const ui = await $.ui.mount(pane(110))
  await ui.press({ key: 'file-1' })
  expect(await ui.find({ type: 'Text', text: /좌우 보기/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /재시도 헬퍼 신규 작성/ })).toBeDefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: '한 줄 요약' })).toBeDefined()
})

test('좁은 창의 diff는 통합 보기이고 n/f로 이동한다', async ($, on) => {
  stubs(on)
  const ui = await $.ui.mount(pane(60))
  await ui.press({ key: 'diff' })
  expect(await ui.find({ type: 'Text', text: /통합 보기/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '변경 1/5' })).toBeDefined()
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: /api 호출을 retry\(\)로 감쌈/ })).toBeDefined()
  await ui.press({ key: 'next-file' })
  expect(await ui.find({ type: 'Text', text: 'src/lib/retry.ts' })).toBeDefined()
})

test('r은 마지막으로 펼친 섹션을 다시 만든다', async ($, on) => {
  const { clock } = stubs(on)
  const ui = await $.ui.mount(pane(80))
  await ui.press({ key: 'btn-flow' })
  await clock.advance(800)
  expect(await ui.find({ key: 'regen' })).toMatchObject({ props: { label: 'r  다시 만들기 (흐름도)' } })
  await ui.press({ key: 'regen' })
  expect(await ui.find({ type: 'Text', text: /만드는 중/ })).toBeDefined()
  await clock.advance(800)
  expect(await ui.find({ type: 'Text', text: '재시도 대상인가?' })).toBeDefined()
})

test('퀴즈를 다 맞히면 이해함으로 표시되고 저장된다', async ($, on) => {
  const { clock, saved } = stubs(on)
  const ui = await $.ui.mount(pane(80))
  await ui.press({ key: 'go-quiz' })
  await clock.advance(800)
  // 보기 순서는 섞이지만 키는 원래 위치를 따른다: o0이 정답
  await ui.press({ key: 'q0-o1' })
  expect(await ui.find({ type: 'Text', text: /틀렸습니다/ })).toBeDefined()
  expect(saved.get('understood')).toBeUndefined()
  // 다시 풀기는 세 문제를 모두 답한 뒤에만 나온다
  await ui.press({ key: 'q1-o0' })
  await ui.press({ key: 'q2-o0' })
  await ui.press({ key: 'quiz-retry' })
  await ui.press({ key: 'q0-o0' })
  await ui.press({ key: 'q1-o0' })
  await ui.press({ key: 'q2-o0' })
  expect(await ui.find({ type: 'Text', text: '3/3 정답' })).toBeDefined()
  expect(saved.get('understood')).toBe(true)
  expect(await ui.find({ type: 'Text', text: '✓ 이해함 (퀴즈 통과)' })).toBeDefined()
})

test('코드 따라가기는 단계마다 코드, 하는 일, 이유, 다른 방법을 보여 준다', async ($, on) => {
  const { clock } = stubs(on)
  const ui = await $.ui.mount(pane(80))
  await ui.press({ key: 'btn-walk' })
  await clock.advance(800)
  expect(await ui.find({ type: 'Text', text: '재시도 대상 판별' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'src/lib/retry.ts:1-4' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '검토한 다른 방법' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /멱등하지 않은 요청까지/ })).toBeDefined()
})

test('Wait, what?은 여러 번 누를 수 있고, 그 부분만 따로 질문할 수 있다', async ($, on) => {
  const { clock } = stubs(on)
  const ui = await $.ui.mount(pane(80))
  await ui.press({ key: 'btn-background' })
  await clock.advance(800)
  await ui.press({ key: 'easy-background' })
  expect(await ui.find({ type: 'Text', text: /쉬운 말로 다시 설명하는 중/ })).toBeDefined()
  await clock.advance(800)
  expect(await ui.find({ type: 'Text', text: /통화 중이면/ })).toBeDefined()

  // 한 번으로 모자라면 다시: 다른 설명이 이어 붙는다
  await ui.press({ key: 'easy-again-background' })
  await clock.advance(800)
  expect(await ui.find({ type: 'Text', text: '설명 2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /전제부터 짚어/ })).toBeDefined()

  // 세 번째는 또 다른 설명, 그 뒤로는 같은 글을 반복하지 않고 질문을 권한다
  await ui.press({ key: 'easy-again-background' })
  await clock.advance(800)
  expect(await ui.find({ type: 'Text', text: /숫자로 보면/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /어느 문장, 어느 단어/ })).toBeDefined()
  await ui.press({ key: 'easy-again-background' })
  await clock.advance(800)
  expect(await ui.find({ type: 'Text', text: /준비된 설명은 여기까지/ })).toBeDefined()

  // 그 부분만 따로 질문
  await ui.input({ key: 'easy-ask-background', text: '몇백 ms면 정말 한가해져?' })
  await clock.advance(800)
  expect(await ui.find({ type: 'Text', text: '몇백 ms면 정말 한가해져?' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /이 섹션의 내용과 앞의 쉬운 설명/ })).toBeDefined()
})

test('이미 아는 용어는 저장되고 한 줄로 접힌다', async ($, on) => {
  const { clock, saved } = stubs(on)
  const ui = await $.ui.mount(pane(80))
  await ui.press({ key: 'btn-terms' })
  await clock.advance(800)
  expect(await ui.find({ type: 'Text', text: /두 배로 늘리는 방식/ })).toBeDefined()
  await ui.press({ key: 'term-backoff' })
  expect(saved.get('known')).toEqual(['backoff'])
  expect(await ui.find({ type: 'Text', text: /두 배로 늘리는 방식/ })).toBeUndefined()
})

test('질문하면 답이 아래에 붙는다', async ($, on) => {
  const { clock } = stubs(on)
  const ui = await $.ui.mount(pane(80))
  await ui.input({ key: 'ask', text: '401은 왜 재시도 안 해?' })
  expect(await ui.find({ type: 'Text', text: '401은 왜 재시도 안 해?' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /답을 만드는 중/ })).toBeDefined()
  await clock.advance(800)
  expect(await ui.find({ type: 'Text', text: /계정 잠금 정책/ })).toBeDefined()
})

test('펼쳐 둔 섹션을 기억했다가 창을 열 때 다시 펼친다', async ($, on) => {
  const { clock, saved } = stubs(on, { open: { summary: true, flow: true } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  await $.command.run({ command: 'explain-sample', args: '' })
  await clock.advance(800)
  const ui = await $.ui.mount(pane(80))
  expect(await ui.find({ type: 'Text', text: '재시도 대상인가?' })).toBeDefined()
  await ui.press({ key: 'btn-seq' })
  expect(saved.get('open')).toMatchObject({ summary: true, flow: true, seq: true })
})

test('diff 코드 영역은 j/k로 위아래, h/l로 좌우 스크롤한다', async ($, on) => {
  stubs(on)
  // 높이 21줄: 코드 영역은 6줄만 보인다
  const ui = await $.ui.mount(pane(110, 21))
  await ui.press({ key: 'file-1' })
  expect(await ui.find({ type: 'Text', text: /줄 1–6 \/ 18/ })).toBeDefined()
  await ui.press({ key: 'down' })
  expect(await ui.find({ type: 'Text', text: /줄 6–11 \/ 18/ })).toBeDefined()
  await ui.press({ key: 'up' })
  expect(await ui.find({ type: 'Text', text: /줄 1–6 \/ 18/ })).toBeDefined()

  // 좁은 창이라 긴 줄이 잘리는 파일: 오른쪽으로 밀면 가로 밀림이 표시된다
  await ui.press({ key: 'tab-2' })
  await ui.press({ key: 'right' })
  expect(await ui.find({ type: 'Text', text: /가로 \+8/ })).toBeDefined()
  await ui.press({ key: 'left' })
  expect(await ui.find({ type: 'Text', text: /가로 \+/ })).toBeUndefined()
  await ui.press({ key: 'back' })
})

test('좁은 창의 시퀀스는 h/l로 좌우 스크롤한다', async ($, on) => {
  const { clock } = stubs(on)
  const ui = await $.ui.mount(pane(40))
  await ui.press({ key: 'btn-seq' })
  await clock.advance(800)
  await ui.press({ key: 'seq-right' })
  expect(await ui.find({ type: 'Text', text: /가로 \+8/ })).toBeDefined()
})
