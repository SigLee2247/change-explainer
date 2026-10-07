// 샘플 데이터: "로그인 실패 시 재시도 추가" 턴 하나.
// 실제 mod에서는 이 모양의 데이터를 모델(구조)과 diff 계산(코드)이 채운다.

export const C = {
  fg: '#d6d6d6',
  title: '#f0f0f0',
  dim: '#858b94',
  faint: '#5c6370',
  rule: '#2f3238',
  accent: '#e3a857',
  blue: '#79b8ff',
  green: '#7fc79a',
  red: '#f08c7c',
  purple: '#c3a6ff',
}

// diff 배경색 (인텔리제이 다크 테마 계열)
export const D = {
  add: '#1f3a28', addHi: '#2f6e41',
  mod: '#1c2c43', modHi: '#2f5a8f', modFill: '#151d29',
  del: '#2a2c31', fill: '#16171a',
  rem: '#3a2326', remHi: '#6e2f36',
}

export const SECTIONS = [
  { id: 'summary', key: '1', title: '요약' },
  { id: 'background', key: '2', title: '배경' },
  { id: 'walk', key: '3', title: '코드 따라가기' },
  { id: 'flow', key: '4', title: '흐름도' },
  { id: 'seq', key: '5', title: '시퀀스' },
  { id: 'ba', key: '6', title: '전후 비교' },
  { id: 'impact', key: '7', title: '영향 범위' },
  { id: 'terms', key: '8', title: '용어' },
  { id: 'quiz', key: '9', title: '확인 퀴즈' },
]

export const TURN = {
  n: 5,
  title: '로그인 실패 시 재시도 추가',
  request: '로그인 API가 가끔 타임아웃 나는데 재시도 좀 넣어줘',
  when: '오늘 14:02',
  tldr: '네트워크 오류와 5xx 응답일 때만 로그인 요청을 최대 3번 재시도하도록 바꿨습니다.',
}

export const FLOW = [
  { n: 1, title: 'login(u, p)', desc: 'LoginPage에서 호출', kind: 'step' },
  { n: 2, title: 'api(u, p) 호출', desc: '5번에서 재시도하면 여기로 돌아옴', kind: 'step' },
  {
    n: 3, title: 'res.ok ?', desc: '응답이 성공인지', kind: 'cond', next: '아니오',
    branch: { label: '예', title: '응답 반환', desc: '정상 종료', kind: 'ok' },
  },
  {
    n: 4, title: '재시도 대상인가?', desc: '네트워크 오류 또는 5xx', tag: '이번에 추가 · isRetryable()', kind: 'changed', next: '예',
    branch: { label: '아니오', title: '에러 그대로 던짐', desc: '401 등 인증 실패', kind: 'err' },
  },
  {
    n: 5, title: '시도 횟수 < 3 ?', desc: '최대 3번까지', tag: '이번에 추가 · retry()', kind: 'changed', next: '아니오',
    branch: { label: '예', title: '200ms × 2ⁿ 대기', desc: '그다음 2번으로 돌아감', kind: 'changed' },
  },
  { n: 6, title: '마지막 에러를 던짐', desc: '호출부의 기존 에러 처리로 전달', kind: 'err' },
]

export const KIND_COLOR = { step: C.faint, cond: C.blue, changed: C.accent, ok: C.green, err: C.red }

export const LANES = [
  { name: 'LoginPage', color: C.dim },
  { name: 'login()', color: C.fg },
  { name: 'retry()', color: C.accent },
  { name: 'Auth API', color: C.blue },
]

// [from, to, label, color, note]
export const MSGS = [
  [0, 1, 'submit(u, p)', C.fg, ''],
  [1, 2, 'retry(fn, 3)', C.accent, '이번에 추가된 재시도 래퍼'],
  [2, 3, '1차 호출', C.fg, ''],
  [3, 2, '503', C.red, '서버 과부하로 실패'],
  [2, 2, '200ms 대기', C.accent, '5xx라서 재시도 대상'],
  [2, 3, '2차 호출', C.fg, ''],
  [3, 2, '200 OK', C.green, '성공'],
  [2, 1, 'res', C.fg, ''],
  [1, 0, 'ok', C.fg, '사용자는 재시도를 모름'],
]

export const BEFORE_AFTER = [
  { when: '네트워크 끊김', before: '즉시 에러', after: '최대 3회 재시도 후 에러', color: C.green },
  { when: '서버 503', before: '즉시 에러', after: '재시도, 보통 2차에서 성공', color: C.green },
  { when: '비밀번호 틀림 (401)', before: '즉시 에러', after: '즉시 에러 (변화 없음)', color: C.dim },
  { when: '최악 응답 시간', before: '약 0.3초', after: '약 1.7초', color: C.red },
]

const added = (lines) => lines.map((t, i) => ['add', null, '', i + 1, t, 1])

// diff 행: ['eq'|'add'|'del'|'mod', 왼쪽 줄번호, 왼쪽 글, 오른쪽 줄번호, 오른쪽 글, 변경 블록 번호, 왼쪽 강조, 오른쪽 강조]
// ['fold', 설명]: 변경 없는 줄 접힘
export const FILES = [
  {
    name: 'login.ts', path: 'src/auth/login.ts', tag: '수정', tagColor: C.blue, add: 6, del: 2,
    desc: 'api 호출을 retry()로 감싸고 로그 한 줄 제거',
    rows: [
      ['fold', '변경 없는 9줄'],
      ['eq', 10, "import { api } from '../lib/api'", 10, "import { api } from '../lib/api'"],
      ['add', null, '', 11, "import { retry, isRetryable } from '../lib/retry'", 1],
      ['eq', 11, '', 12, ''],
      ['eq', 12, 'export async function login(u: string, p: string) {', 13, 'export async function login(u: string, p: string) {'],
      ['mod', 13, "  const res = await api.post('/login', { u, p })", 14, "  const res = await retry(() => api.post('/login', { u, p }), {", 2, [], ['retry(() => ', '), {']],
      ['mod', null, '', 15, '    times: 3,', 2, [], ['    times: 3,']],
      ['mod', null, '', 16, '    when: isRetryable,', 2, [], ['    when: isRetryable,']],
      ['mod', null, '', 17, '  })', 2, [], ['  })']],
      ['eq', 14, '  if (!res.ok) throw new LoginError(res.status)', 18, '  if (!res.ok) throw new LoginError(res.status)'],
      ['del', 15, "  log.info('login', res.status)", null, '', 3],
      ['eq', 16, '  return res.json()', 19, '  return res.json()'],
      ['eq', 17, '}', 20, '}'],
      ['fold', '변경 없는 4줄'],
    ],
  },
  {
    name: 'retry.ts', path: 'src/lib/retry.ts', tag: '새 파일', tagColor: C.green, add: 18, del: 0,
    desc: 'retry(), isRetryable() 헬퍼',
    rows: added([
      'export function isRetryable(err: unknown) {',
      '  if (err instanceof NetworkError) return true',
      '  return err instanceof HttpError && err.status >= 500',
      '}',
      '',
      'export async function retry<T>(',
      '  fn: () => Promise<T>,',
      '  { times, when }: RetryOptions,',
      '): Promise<T> {',
      '  for (let n = 0; ; n++) {',
      '    try {',
      '      return await fn()',
      '    } catch (err) {',
      '      if (n + 1 >= times || !when(err)) throw err',
      '      await sleep(200 * 2 ** n)',
      '    }',
      '  }',
      '}',
    ]),
  },
  {
    name: 'login.test.ts', path: 'src/auth/login.test.ts', tag: '새 파일', tagColor: C.green, add: 18, del: 0,
    desc: '재시도 테스트 3개', agent: '서브에이전트 · general-purpose',
    rows: added([
      "describe('login retry', () => {",
      "  it('503 다음 200이면 성공', async () => {",
      '    api.post.mockRejectedOnce(http(503)).mockResolvedOnce(ok())',
      "    await expect(login('a', 'b')).resolves.toBeDefined()",
      '  })',
      "  it('401은 재시도하지 않음', async () => {",
      '    api.post.mockRejectedOnce(http(401))',
      "    await expect(login('a', 'b')).rejects.toThrow(LoginError)",
      '    expect(api.post).toHaveBeenCalledTimes(1)',
      '  })',
      "  it('3회 모두 실패하면 에러', async () => { /* … */ })",
      '})',
    ]),
  },
]

// 변경 블록 목록 (파일 순서대로). note는 해설 요약에서 함께 만들어지는 한 줄 설명
export const HUNKS = [
  { f: 0, h: 1, note: 'retry 모듈 import 추가' },
  { f: 0, h: 2, note: 'api 호출을 retry()로 감쌈. 최대 3회, isRetryable(err)일 때만 재시도' },
  { f: 0, h: 3, note: '로그 한 줄 삭제. 재시도 중 같은 로그가 반복 출력되지 않도록' },
  { f: 1, h: 1, note: '재시도 헬퍼 신규 작성. 200ms × 2ⁿ 지수 백오프, 마지막 에러는 그대로 던짐' },
  { f: 2, h: 1, note: '서브에이전트가 작성한 테스트 3개. 503 후 성공, 401 즉시 실패, 3회 모두 실패' },
]

// 질문 입력창 샘플 답변 (실제 mod에서는 현재 대화를 fork해서 답한다)
export const SAMPLE_ANSWER =
  '(샘플 답변) 401을 재시도하지 않은 이유는, 잘못된 비밀번호로 여러 번 요청하면 계정 잠금 정책에 걸리기 때문입니다. 실제 mod에서는 현재 대화를 바탕으로 답합니다.'

// ── 배경: 원래 어떤 문제가 있었나 ──
export const BACKGROUND = {
  problem: '로그인 API가 가끔 타임아웃이나 503으로 실패하면, 사용자는 곧바로 "로그인 실패" 화면을 봤습니다.',
  cause: '서버가 잠깐 바쁠 때 생기는 일시적인 실패인데, 기존 login()은 한 번 실패하면 바로 에러를 던졌습니다.',
  causeAt: 'src/auth/login.ts:13-14 (변경 전)',
  goal: '일시적인 실패는 사용자가 모르게 다시 시도하고, 비밀번호가 틀린 것 같은 진짜 실패는 지금처럼 바로 알려 줍니다.',
  outOfScope: ['요청 타임아웃 값 자체', '서버가 바빠지는 원인'],
}

// ── 코드 따라가기: 단계마다 코드 조각, 하는 일, 이유, 검토한 다른 방법 ──
export const WALK = [
  {
    title: '재시도 래퍼 만들기',
    at: 'src/lib/retry.ts:6-18',
    code: [
      'export async function retry<T>(fn, { times, when }) {',
      '  for (let n = 0; ; n++) {',
      '    try {',
      '      return await fn()',
      '    } catch (err) {',
      '      if (n + 1 >= times || !when(err)) throw err',
      '      await sleep(200 * 2 ** n)',
      '    }',
      '  }',
      '}',
    ],
    does: 'fn을 호출하고, 실패하면 기다렸다가 다시 호출합니다. 최대 times번까지 시도하고, when(err)가 false면 바로 멈춥니다.',
    why: '재시도 규칙을 login() 안에 직접 쓰지 않고 함수로 분리했습니다. 나중에 다른 API 호출에도 그대로 쓸 수 있습니다.',
    alt: 'HTTP 클라이언트 전체(인터셉터)에 재시도를 거는 방법도 있습니다. 하지만 그러면 결제처럼 멱등하지 않은 요청까지 중복으로 보낼 수 있어서 쓰지 않았습니다.',
  },
  {
    title: '재시도 대상 판별',
    at: 'src/lib/retry.ts:1-4',
    code: [
      'export function isRetryable(err: unknown) {',
      '  if (err instanceof NetworkError) return true',
      '  return err instanceof HttpError && err.status >= 500',
      '}',
    ],
    does: '네트워크 오류이거나 서버 오류(5xx)일 때만 true를 돌려줍니다.',
    why: '401(인증 실패)은 다시 보내도 결과가 같습니다. 잘못된 비밀번호를 반복해서 보내면 계정 잠금 정책에 걸릴 수 있습니다.',
    alt: '모든 에러를 재시도하는 방법은 401까지 세 번 보내게 되어 쓰지 않았습니다.',
  },
  {
    title: '기다리는 시간을 두 배씩 늘리기',
    at: 'src/lib/retry.ts:15',
    code: ['      await sleep(200 * 2 ** n)'],
    does: '첫 실패 뒤에는 200ms, 두 번째 실패 뒤에는 400ms를 기다립니다. 이것을 지수 백오프라고 합니다.',
    why: '바쁜 서버에 곧바로 다시 요청하면 부하가 더 커집니다. 기다리는 시간을 늘리면 서버가 회복할 시간이 생깁니다.',
    alt: '항상 200ms를 기다리는 고정 대기도 있습니다. 단순하지만 서버가 회복하기 전에 다시 실패할 가능성이 큽니다.',
  },
  {
    title: 'login()에 적용',
    at: 'src/auth/login.ts:14-17',
    code: [
      "  const res = await retry(() => api.post('/login', { u, p }), {",
      '    times: 3,',
      '    when: isRetryable,',
      '  })',
    ],
    does: 'api.post 호출을 retry로 감쌌습니다. 최대 3번, 재시도 대상일 때만 다시 시도합니다.',
    why: '호출하는 쪽(LoginPage)은 바꾸지 않고 login() 안에서만 해결했습니다. 화면 코드는 재시도가 있는지 몰라도 됩니다.',
    alt: 'LoginPage에서 재시도하는 방법은 화면 코드에 네트워크 규칙이 섞여서 쓰지 않았습니다.',
  },
  {
    title: '로그 한 줄 삭제',
    at: 'src/auth/login.ts:15 (삭제)',
    code: ["  log.info('login', res.status)"],
    does: '로그인 응답마다 남기던 로그를 지웠습니다.',
    why: '재시도가 생기면서 같은 로그가 한 번 로그인에 여러 줄 찍힐 수 있었습니다.',
    alt: '로그를 retry 안으로 옮기는 방법도 있습니다. 필요하면 다음 작업에서 시도 횟수와 함께 남기는 것을 검토하세요.',
  },
]

// ── 용어: 이번 변경에 처음 나온 개념 ──
export const TERMS = [
  { id: 'transient', term: '일시적인 실패', en: 'transient failure', def: '잠시 뒤 다시 시도하면 성공할 수 있는 실패. 네트워크 끊김, 서버 과부하(503) 등.' },
  { id: 'backoff', term: '지수 백오프', en: 'exponential backoff', def: '재시도할 때마다 기다리는 시간을 두 배로 늘리는 방식. 여기서는 200ms 다음 400ms.' },
  { id: 'idempotent', term: '멱등성', en: 'idempotency', def: '같은 요청을 여러 번 보내도 한 번 보낸 것과 결과가 같은 성질. 재시도해도 안전한지 판단하는 기준.' },
  { id: '5xx', term: '5xx', en: 'server error', def: '서버 쪽 문제를 뜻하는 HTTP 상태 코드(500~599). 요청을 보낸 쪽의 잘못이 아닐 수 있음.' },
]

// ── 확인 퀴즈: 보기는 단어 수를 맞추고, 순서는 mod 코드가 섞는다. 첫 번째 보기가 정답 ──
export const QUIZ = [
  {
    q: '서버가 401(인증 실패)을 돌려주면 login()은 어떻게 동작하나요?',
    options: ['재시도 없이 바로 실패한다', '3회 재시도 후 실패한다', '한 번만 다시 시도한다'],
    explain: 'isRetryable()이 401에 false를 돌려주므로 retry()가 바로 에러를 던집니다.',
  },
  {
    q: '세 번째 호출 전에는 얼마나 기다리나요?',
    options: ['400ms를 기다린다', '200ms를 기다린다', '800ms를 기다린다'],
    explain: '첫 실패 뒤 200ms, 두 번째 실패 뒤 400ms를 기다립니다. 세 번째 호출은 두 번째 실패 뒤입니다.',
  },
  {
    q: '재시도를 HTTP 클라이언트 전체에 걸지 않은 이유는?',
    options: ['중복되면 안 되는 요청이 있어서', '인터셉터가 비동기 요청을 지원하지 않아서', '로그인 요청은 클라이언트를 거치지 않아서'],
    explain: '결제처럼 멱등하지 않은 요청이 재시도로 두 번 실행될 수 있기 때문입니다.',
  },
]

// ── Wait, what?: 섹션을 더 쉬운 말로, 빠진 전제를 채워 다시 설명 (wait-what 스킬) ──
export const EASY = {
  summary: '로그인할 때 서버가 잠깐 바빠서 실패하면, 프로그램이 알아서 조금 기다렸다가 다시 시도하게 만들었습니다. 비밀번호가 틀린 경우는 다시 시도해도 소용없으니 바로 알려 줍니다.',
  background: '식당에 전화했는데 통화 중이면 바로 포기하지 않고 잠시 뒤 다시 거는 것과 같습니다. 원래 코드는 통화 중이면 바로 포기했습니다.',
  walk: '새 함수 retry()가 "실패하면 기다렸다가 다시"를 맡고, isRetryable()이 "다시 해 볼 만한 실패인지"를 판단합니다. login()은 이 둘을 조합해서 쓰기만 합니다.',
  flow: '위에서 아래로 읽으면 됩니다. 성공하면 끝, 다시 해 볼 만한 실패면 기다렸다가 2번으로 돌아가고, 아니면 에러로 끝납니다.',
  seq: '왼쪽에서 오른쪽으로 요청이 가고, 오른쪽에서 왼쪽으로 응답이 옵니다. retry()가 중간에서 실패를 받아 한 번 더 보내는 것이 이번 변경입니다.',
  ba: '바뀐 것은 "서버가 잠깐 바쁠 때"뿐입니다. 비밀번호가 틀린 경우는 전과 똑같습니다.',
  impact: 'login()을 부르는 곳은 코드를 고치지 않아도 되지만, 응답이 늦어질 수 있으니 로딩 표시와 토큰 갱신 쪽을 한 번 확인하라는 뜻입니다.',
  terms: '모르는 용어가 있으면 [Known]을 누르지 말고 두세요. 다음 해설에서도 계속 풀어서 설명합니다.',
  quiz: '정답을 고르면 이유가 바로 나옵니다. 틀려도 괜찮습니다. 이유를 읽고 다시 풀면 됩니다.',
}

// 같은 섹션에서 Wait, what?을 또 누르면: 회차마다 다른 비유로, 막힌 전제를 하나씩 짚어 다시 설명.
// 실제 mod에서는 앞의 설명들을 모델에 함께 넘겨 "이것들과 다르게" 새로 만든다
export const EASY_AGAIN = {
  background: [
    '이번에는 전제부터 짚어 보겠습니다. ① 서버도 바쁠 때가 있습니다. ② 바쁠 때 온 요청은 실패로 돌아옵니다. ③ 그런데 몇백 ms 뒤에는 대개 한가해집니다. 그래서 "조금 기다렸다 다시"가 효과가 있습니다.',
    '숫자로 보면: 서버가 1초에 100개를 처리할 수 있는데 순간 150개가 몰리면 50개는 실패합니다. 0.2초 뒤에는 몰렸던 요청이 빠져서 다시 보내면 대부분 처리됩니다.',
  ],
  walk: [
    '역할로 나눠 보면 쉽습니다. retry()는 "몇 번, 얼마나 기다렸다 다시 할지"만 압니다. isRetryable()은 "이 실패가 다시 해 볼 만한지"만 압니다. login()은 둘에게 일을 맡기는 관리자입니다.',
    '실행 순서로 따라가 보면: login()이 retry()를 부름 → retry()가 api.post를 부름 → 503 실패 → isRetryable()에게 물어봄(예) → 200ms 쉼 → 다시 api.post → 성공 → login()에게 결과 전달.',
  ],
}
// 준비된 설명이 떨어졌을 때 (샘플 전용). 같은 글을 반복하지 않는다
export const EASY_AGAIN_DEFAULT = '(샘플) 준비된 설명은 여기까지입니다. 실제 mod에서는 앞의 설명들과 겹치지 않게 새로 만듭니다.'
// 이 회차부터는 더 설명하기보다 어디가 막히는지 묻는다
export const EASY_ASK_AFTER = 3

// 섹션 안에서 추가 질문을 했을 때의 샘플 답변
export const SECTION_ANSWER = '(샘플 답변) 실제 mod에서는 이 섹션의 내용과 앞의 쉬운 설명을 바탕으로, 현재 대화를 fork해서 답합니다.'
