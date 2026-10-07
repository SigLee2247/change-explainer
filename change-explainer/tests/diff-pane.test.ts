import { expect, test } from 'claude-code/testing'
import { edit, setup, turnEnd, turnStart } from './helpers.ts'

const pane = (bodyColumns: number, bodyRows = 40) => ({
  plugin: 'change-explainer',
  component: 'Pane',
  requestId: 'change-explainer',
  surface: 'terminal',
  viewport: { columns: 200, rows: 60 },
  props: { title: '변경 해설', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
}) as any

// 두 파일을 고친 턴 하나를 기록하고 /explain으로 창을 연다
async function twoFileTurn($: any, on: any) {
  setup(on, { '/repo/src/login.ts': 'import api\n\nexport function login() {\n  return api.post(u)\n}\n' })
  await turnStart($, 't1', '로그인 재시도 추가')
  await edit($, '/repo/src/login.ts', 'return api.post(u)', 'return retry(() => api.post(u))')
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/retry.ts', content: 'export function retry(fn) {\n  return fn()\n}\n' })
  await turnEnd($, 't1')
  expect(await $.command.run({ command: 'explain', args: '' })).toEqual({})
}

test('넓은 창: 좌우 비교로 실제 변경을 그리고, 줄 안에서 바뀐 부분을 강조한다', async ($, on) => {
  await twoFileTurn($, on)
  const ui = await $.ui.mount(pane(120))
  expect(await ui.find({ type: 'Text', text: /좌우 보기/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /변경 1\/2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /src\/login\.ts  4줄/ })).toBeDefined()
  // 줄 안 강조: 바뀐 부분만 배경색이 칠해진 조각
  const line: any = await ui.find({ type: 'Text', text: /return retry\(\(\) => api\.post\(u\)\)/ })
  const highlighted = line.children.filter((c: any) => c.props && c.props.backgroundColor === '#2f5a8f').map((c: any) => c.children[0])
  expect(highlighted).toEqual(['retry(() => ', ')'])
})

test('n으로 다음 파일의 변경으로 넘어가고, 새 파일은 오른쪽만 채운다', async ($, on) => {
  await twoFileTurn($, on)
  const ui = await $.ui.mount(pane(120))
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: /변경 2\/2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /src\/retry\.ts  1–3줄/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /새 파일/ })).toBeDefined()
})

test('좁은 창: 통합 보기로 지운 줄 다음에 추가한 줄', async ($, on) => {
  await twoFileTurn($, on)
  const ui = await $.ui.mount(pane(60))
  expect(await ui.find({ type: 'Text', text: /통합 보기/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '− ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '+ ' })).toBeDefined()
})

test('긴 파일은 코드 영역만 j/k로 스크롤하고, 변경으로 이동하면 그 위치로 간다', async ($, on) => {
  const lines = Array.from({ length: 60 }, (_, i) => 'line ' + i)
  setup(on, { '/repo/big.ts': lines.join('\n') + '\n' })
  await turnStart($, 't1', '두 군데 고쳐줘')
  await edit($, '/repo/big.ts', 'line 2\n', 'LINE 2\n')
  await edit($, '/repo/big.ts', 'line 50\n', 'LINE 50\n')
  await turnEnd($, 't1')
  await $.command.run({ command: 'explain', args: '' })
  // 높이 20줄: 코드 영역은 7줄
  const ui = await $.ui.mount(pane(120, 20))
  expect(await ui.find({ type: 'Text', text: /줄 1–7 \/ \d+/ })).toBeDefined()
  await ui.press({ key: 'down' })
  expect(await ui.find({ type: 'Text', text: /줄 6–12 \/ \d+/ })).toBeDefined()
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: /변경 2\/2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'LINE 50' })).toBeDefined()
})

test('기록된 변경이 없으면 /explain은 안내만 한다', async ($, on) => {
  setup(on, {})
  expect((await $.command.run({ command: 'explain', args: '' })).text).toMatch(/아직 기록된 변경이 없습니다/)
})
