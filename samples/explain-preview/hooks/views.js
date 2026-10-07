// 해설 창의 각 화면을 그리는 함수들. `el`은 $.ui.resolve(e)가 준 요소 생성자 묶음.
//
// 그리기 규칙
// - 한 줄에 여러 색이 필요하면 Text 하나 안에 Text를 넣는다. 조각을 Box 가로줄로
//   늘어놓으면 좁은 창에서 조각마다 따로 줄바꿈되어 글자가 뒤섞인다.
// - 다이어그램과 코드 줄은 줄바꿈 대신 잘라낸다(wrap: 'truncate-end').
// - 한글은 2칸을 차지하므로 다이어그램 줄에서 한글은 줄 끝에만 둔다.

import { BACKGROUND, BEFORE_AFTER, C, D, FILES, FLOW, HUNKS, KIND_COLOR, LANES, MSGS, QUIZ, TERMS, WALK } from './data.js'

// ── 공통 ─────────────────────────────────────────────────────

// 한 줄(또는 한 문단) 안의 색 조각들: parts = ['plain' | [text, color, bold?], ...]
export function rich(el, parts, opts) {
  return el.Text({
    color: C.fg,
    ...(opts || {}),
    children: parts.map((p) => (typeof p === 'string' ? p : el.Text({ color: p[1], bold: !!p[2], children: [p[0]] }))),
  })
}

// 버튼: Claude Code의 기본 버튼. 터미널에서는 [ d  diff 보기 ], Desktop 앱에서는 네이티브 버튼으로 그려진다.
// 대괄호 버튼은 단축키를 따로 표시하지 않으므로 라벨 앞에 키를 넣는다.
// primary는 화면마다 하나만 두는 주요 버튼(터미널에서 강조색)
export function btn(el, { key, hotkey, label, onPress, primary, dim }) {
  const props = { key, label: hotkey ? hotkey + ' ' + label : label, onPress }
  if (hotkey) props.hotkey = hotkey
  if (primary) props.variant = 'primary'
  if (dim) props.dimColor = true
  return el.Button(props)
}

// 대괄호 없는 글자 링크: 목차처럼 여러 개를 늘어놓을 때. 누를 수 있고, 흐리게 하면 보조 항목
export function link(el, { key, label, onPress, dim }) {
  const props = { key, label, plain: true, onPress }
  if (dim) props.dimColor = true
  return el.Button(props)
}

// 버튼들을 한 줄에 늘어놓고, 넘치면 다음 줄로
export function buttonRow(el, children) {
  return el.Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, rowGap: 0, children })
}

// 터미널 표시 폭: 한글·한자·전각 문자는 2칸
export function widthOf(s) {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xff60) ? 2 : 1
  }
  return w
}

// 색 조각들의 앞에서 n글자를 버린다 (가로 스크롤)
function shift(parts, n) {
  const out = []
  let rest = n
  for (const p of parts) {
    const t = p[0]
    if (rest >= t.length) { rest -= t.length; continue }
    out.push(rest ? [t.slice(rest), p[1], p[2], p[3]] : p)
    rest = 0
  }
  return out
}

export function rule(el, cols) {
  return el.Text({ color: C.rule, wrap: 'truncate-end', children: ['─'.repeat(Math.max(10, cols))] })
}

function heading(el, text) {
  return el.Text({ bold: true, color: C.accent, children: [text] })
}

function block(el, title, children) {
  return el.Box({
    flexDirection: 'column',
    children: [heading(el, title), el.Box({ flexDirection: 'column', paddingLeft: 2, children })],
  })
}

// ── 요약 ─────────────────────────────────────────────────────

// onFile(i): 파일을 누르면 그 파일의 diff를 연다
export function summaryView(el, onFile) {
  return el.Box({
    flexDirection: 'column',
    rowGap: 1,
    children: [
      block(el, '무엇을 바꿨나', [
        ...FILES.map((f, i) =>
          el.Box({
            flexDirection: 'column',
            children: [
              btn(el, { key: 'file-' + i, label: f.path + '  →  diff', onPress: () => onFile(i) }),
              rich(el, [
                '  ',
                [f.tag, f.tagColor],
                '  ',
                ['+' + f.add, C.green],
                f.del ? ' ' : '',
                f.del ? ['−' + f.del, C.red] : '',
                f.agent ? '  ' : '',
                f.agent ? ['서브에이전트', C.purple] : '',
                '  ',
                [f.desc, C.dim],
              ]),
            ],
          }),
        ),
        el.Text({ color: C.faint, children: ['파일을 누르면 그 파일의 diff로 이동합니다.'] }),
      ]),
      block(el, '왜 이렇게 했나', [
        el.Text({ children: ['일시적인 실패(네트워크 오류, 5xx)만 재시도하고, 401 같은 인증 실패는 즉시 실패시켰습니다.'] }),
        el.Text({ color: C.dim, children: ['잘못된 비밀번호를 세 번 보내면 계정 잠금 정책에 걸릴 수 있기 때문입니다.'] }),
      ]),
      block(el, '어떻게 동작하나', [
        rich(el, [['1 ', C.accent], ['retry(fn, { times: 3, when })', C.blue]]),
        el.Text({ color: C.dim, children: ['  실패하면 200ms, 400ms 기다렸다가 다시 호출합니다.'] }),
        rich(el, [['2 ', C.accent], ['isRetryable(err)', C.blue]]),
        el.Text({ color: C.dim, children: ['  네트워크 오류이거나 status가 500 이상이면 재시도 대상입니다.'] }),
        rich(el, [['3 ', C.accent], ['마지막까지 실패하면', C.fg]]),
        el.Text({ color: C.dim, children: ['  원래 에러를 그대로 던집니다. 호출부의 에러 처리는 바뀌지 않습니다.'] }),
      ]),
      block(el, '검토할 점', [
        rich(el, [['! ', C.red, true], '최악의 경우 로그인 응답이 약 1.4초 늦어집니다. 로딩 표시를 확인하세요.']),
        rich(el, [['? ', C.blue, true], '타임아웃 값 자체는 그대로입니다. 원인이 긴 타임아웃이면 별도 조치가 필요합니다.']),
      ]),
    ],
  })
}

// ── 배경 ─────────────────────────────────────────────────────

export function backgroundView(el) {
  return el.Box({
    flexDirection: 'column',
    rowGap: 1,
    children: [
      block(el, '무슨 문제가 있었나', [el.Text({ children: [BACKGROUND.problem] })]),
      block(el, '왜 그랬나', [
        el.Text({ children: [BACKGROUND.cause] }),
        el.Text({ color: C.blue, children: [BACKGROUND.causeAt] }),
      ]),
      block(el, '이번 변경의 목표', [el.Text({ children: [BACKGROUND.goal] })]),
      block(el, '이번에 다루지 않은 것', BACKGROUND.outOfScope.map((x) => rich(el, [['- ', C.faint], [x, C.dim]]))),
    ],
  })
}

// ── 코드 따라가기 ────────────────────────────────────────────
// 단계마다: 제목과 위치 → 코드 조각 → 하는 일 → 이유 → 검토한 다른 방법

function labeled(el, label, color, text) {
  return el.Box({
    flexDirection: 'column',
    children: [
      el.Text({ bold: true, color, children: [label] }),
      el.Box({ paddingLeft: 2, children: [el.Text({ children: [text] })] }),
    ],
  })
}

export function walkView(el) {
  return el.Box({
    flexDirection: 'column',
    rowGap: 1,
    children: [
      el.Text({ color: C.dim, children: ['실제 코드를 순서대로 따라가며 각 줄이 하는 일과 그렇게 한 이유를 설명합니다.'] }),
      ...WALK.map((st, i) =>
        el.Box({
          flexDirection: 'column',
          rowGap: 1,
          children: [
            el.Box({
              flexDirection: 'column',
              children: [
                rich(el, [[(i + 1) + '단계  ', C.accent, true], [st.title, C.title, true]]),
                el.Text({ color: C.blue, wrap: 'truncate-start', children: [st.at] }),
              ],
            }),
            el.Box({
              flexDirection: 'column',
              paddingLeft: 1,
              children: st.code.map((line) =>
                rich(el, [['┃ ', C.faint], [line, C.fg]], { wrap: 'truncate-end' }),
              ),
            }),
            labeled(el, '하는 일', C.green, st.does),
            labeled(el, '이유', C.accent, st.why),
            labeled(el, '검토한 다른 방법', C.purple, st.alt),
          ],
        }),
      ),
    ],
  })
}

// ── 용어 ─────────────────────────────────────────────────────
// known: 이미 아는 용어 id 목록. 아는 용어는 한 줄로 접고, 다음 해설에서도 길게 풀지 않는다

export function termsView(el, known, onToggle) {
  const rows = TERMS.map((t) => {
    const isKnown = known.includes(t.id)
    const button = btn(el, { key: 'term-' + t.id, label: isKnown ? 'Undo' : 'Known', onPress: () => onToggle(t.id) })
    if (isKnown) {
      return el.Box({
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: 2,
        children: [rich(el, [['✓ ', C.green], [t.term, C.dim]]), button],
      })
    }
    return el.Box({
      flexDirection: 'column',
      children: [
        el.Box({
          flexDirection: 'row',
          flexWrap: 'wrap',
          columnGap: 2,
          children: [rich(el, [[t.term, C.title, true], ['  ' + t.en, C.faint]]), button],
        }),
        el.Box({ paddingLeft: 2, children: [el.Text({ children: [t.def] })] }),
      ],
    })
  })
  return el.Box({
    flexDirection: 'column',
    rowGap: 1,
    children: [
      el.Text({ color: C.dim, children: ['이번 변경에 처음 나온 개념입니다. 이미 아는 것은 [Known]을 누르면 다음 해설부터 짧게 넘어갑니다.'] }),
      ...rows,
    ],
  })
}

// ── 확인 퀴즈 ────────────────────────────────────────────────
// st = { order: [[보기 위치...] 문제별], picked: [고른 보기 원래 위치 | null] }. 원래 위치 0이 정답

export function quizView(el, st, on) {
  const answered = st.picked.filter((x) => x !== null).length
  const correct = st.picked.filter((x) => x === 0).length
  const done = answered === QUIZ.length
  return el.Box({
    flexDirection: 'column',
    rowGap: 1,
    children: [
      el.Text({ color: C.dim, children: ['기억에서 떠올리며 풀어 보세요. 다 맞히면 이 턴이 이해함으로 표시됩니다.'] }),
      ...QUIZ.map((qz, i) => {
        const picked = st.picked[i]
        const options = st.order[i].map((orig, j) => {
          const label = String.fromCharCode(65 + j) + '  ' + qz.options[orig]
          if (picked === null) {
            return btn(el, { key: 'q' + i + '-o' + orig, label, onPress: () => on.pick(i, orig) })
          }
          const mark = orig === 0 ? '✓ ' : orig === picked ? '✗ ' : '  '
          const color = orig === 0 ? C.green : orig === picked ? C.red : C.faint
          return el.Text({ color, children: [mark + label] })
        })
        return el.Box({
          flexDirection: 'column',
          children: [
            rich(el, [['Q' + (i + 1) + '  ', C.accent, true], [qz.q, C.title, true]]),
            el.Box({ flexDirection: 'column', paddingLeft: 2, children: options }),
            picked === null ? el.Text({ children: [' '] }) : el.Box({
              paddingLeft: 2,
              children: [rich(el, [[picked === 0 ? '맞았습니다. ' : '틀렸습니다. ', picked === 0 ? C.green : C.red, true], [qz.explain, C.fg]])],
            }),
          ],
        })
      }),
      done
        ? el.Box({
            flexDirection: 'row',
            flexWrap: 'wrap',
            columnGap: 2,
            children: [
              rich(el, [[correct + '/' + QUIZ.length + ' 정답', correct === QUIZ.length ? C.green : C.accent, true],
                [correct === QUIZ.length ? '  이 턴을 이해함으로 표시했습니다.' : '  틀린 문제의 이유를 읽고 다시 풀어 보세요.', C.dim]]),
              correct === QUIZ.length ? el.Text({ children: [''] }) : btn(el, { key: 'quiz-retry', label: '다시 풀기', onPress: on.retry }),
            ],
          })
        : el.Text({ color: C.faint, children: [answered + '/' + QUIZ.length + ' 답함'] }),
    ],
  })
}

// ── 흐름도 (카드) ────────────────────────────────────────────

function card(el, item, width) {
  const color = KIND_COLOR[item.kind]
  const titleColor = item.kind === 'err' ? C.red : item.kind === 'ok' ? C.green : C.title
  const rows = [
    rich(el, [item.n ? [item.n + '  ', C.accent, true] : '', [item.title, titleColor, true]]),
    el.Text({ color: C.dim, children: [item.desc] }),
  ]
  if (item.tag) rows.push(el.Text({ color: C.accent, children: [item.tag] }))
  const props = { flexDirection: 'column', borderStyle: 'round', borderColor: color, paddingX: 1, children: rows }
  if (width) props.width = width
  return el.Box(props)
}

function connector(el, width, label) {
  return el.Box({
    paddingLeft: Math.floor(width / 2),
    children: [rich(el, [['│', C.faint], label ? ['  ' + label, C.dim] : ''])],
  })
}

export function flowView(el, cols) {
  const cardW = Math.min(34, cols - 2)
  // 옆 가지 카드를 나란히 둘 공간이 없으면 카드 아래로 내린다
  const wide = cols >= cardW + 34
  const out = [
    rich(el, [
      ['■ ', C.accent], ['이번에 추가  ', C.dim],
      ['■ ', C.blue], ['조건  ', C.dim],
      ['■ ', C.green], ['정상 종료  ', C.dim],
      ['■ ', C.red], ['에러', C.dim],
    ]),
    el.Text({ children: [' '] }),
  ]
  FLOW.forEach((item, i) => {
    const main = card(el, item, cardW)
    if (item.branch) {
      const arrow = el.Text({ color: KIND_COLOR[item.branch.kind], children: [' ─ ' + item.branch.label + ' ─> '] })
      const side = card(el, item.branch)
      out.push(
        wide
          ? el.Box({ flexDirection: 'row', alignItems: 'center', children: [main, arrow, side] })
          : el.Box({
              flexDirection: 'column',
              children: [
                main,
                el.Box({ flexDirection: 'row', alignItems: 'center', paddingLeft: 3, children: [el.Text({ color: C.faint, children: ['└'] }), arrow, side] }),
              ],
            }),
      )
    } else {
      out.push(main)
    }
    if (i < FLOW.length - 1) out.push(connector(el, cardW, item.next))
  })
  return el.Box({ flexDirection: 'column', children: out })
}

// ── 시퀀스 ───────────────────────────────────────────────────
// 각 호출은 두 줄: 위 줄에 번호와 라벨, 아래 줄에 화살표. 설명은 그 아래 흐린 줄.
// 왼쪽 번호 칸은 고정이고, 나머지는 left만큼 가로로 밀어서 그린다.

const SEQ_GUTTER = 3

function seqGeometry(cols) {
  const laneW = Math.max(12, Math.min(20, Math.floor((cols - SEQ_GUTTER) / LANES.length)))
  const center = (i) => i * laneW + Math.floor(laneW / 2)
  const width = laneW * LANES.length
  // 가장 긴 줄: 라벨 또는 설명이 생명선 오른쪽으로 뻗는 끝
  let longest = width
  MSGS.forEach(([from, to, label, , note]) => {
    const start = Math.min(center(from), center(to)) + 2
    longest = Math.max(longest, start + widthOf(label), start + widthOf(note || ''))
  })
  return { laneW, center, width, longest }
}

// 가로로 밀 수 있는 최대 칸 수
export function seqMaxLeft(cols) {
  const g = seqGeometry(cols)
  return Math.max(0, g.longest - (cols - SEQ_GUTTER))
}

export function seqView(el, cols, left) {
  const { laneW, center, width } = seqGeometry(cols)
  const lifeline = () => {
    const a = new Array(width).fill(' ')
    LANES.forEach((_, i) => { a[center(i)] = '│' })
    return a
  }
  // 번호 칸(고정) + 가로로 민 나머지
  const row = (gutter, parts) =>
    rich(el, [[gutter, C.accent, true], ...shift(parts, left)], { wrap: 'truncate-end' })
  const paint = (cells, start, end, color) => [
    [cells.slice(0, start).join(''), C.faint],
    [cells.slice(start, end).join(''), color],
    [cells.slice(end).join(''), C.faint],
  ]
  // col까지 생명선 + 글. 글 뒤로는 생명선을 그리지 않는다(한글 폭 때문에)
  const textAt = (col, parts) => [[lifeline().slice(0, col).join(''), C.faint], ...parts]

  // 참여자 머리 상자 세 줄을 글자로 그린다 (가로 스크롤이 되도록)
  const boxLine = (fn) => LANES.map((l) => [fn(l).padEnd(laneW, ' '), l.color, true])
  const inner = laneW - 3
  const fit = (name) => (name.length > inner ? name.slice(0, inner - 1) + '…' : name)
  const centerText = (name) => {
    const t = fit(name)
    const pad = inner - t.length
    return ' '.repeat(Math.floor(pad / 2)) + t + ' '.repeat(pad - Math.floor(pad / 2))
  }
  const rows = [
    row('   ', boxLine(() => '╭' + '─'.repeat(inner) + '╮')),
    row('   ', boxLine((l) => '│' + centerText(l.name) + '│')),
    // 아래 테두리의 ┬가 생명선과 같은 칸(레인 안 laneW/2)에 오도록
    row('   ', boxLine(() => '╰' + '─'.repeat(Math.floor(laneW / 2) - 1) + '┬' + '─'.repeat(inner - Math.floor(laneW / 2)) + '╯')),
  ]
  MSGS.forEach(([from, to, label, color, note], i) => {
    const l = Math.min(center(from), center(to))
    const r = Math.max(center(from), center(to))
    rows.push(row(String(i + 1).padStart(2, ' ') + ' ', textAt(l + 2, [[label, color, true]])))
    const a = lifeline()
    if (from === to) {
      // 자기 자신을 부르는 호출: 오른쪽으로 나갔다가 돌아오는 고리
      const c = center(from)
      const b = lifeline()
      a[c] = '├'; a[c + 1] = '─'; a[c + 2] = '╮'
      b[c] = '│'; b[c + 1] = '<'; b[c + 2] = '╯'
      rows.push(row('   ', paint(a, c, c + 3, color)))
      rows.push(row('   ', paint(b, c + 1, c + 3, color)))
    } else {
      for (let k = l + 1; k < r; k++) a[k] = '─'
      if (from < to) a[r - 1] = '>'
      else a[l + 1] = '<'
      rows.push(row('   ', paint(a, l + 1, r, color)))
    }
    if (note) rows.push(row('   ', textAt(l + 2, [[note, C.dim]])))
  })
  rows.push(row('   ', [[lifeline().join(''), C.faint]]))
  return el.Box({ flexDirection: 'column', children: rows })
}

// ── 전후 비교 ────────────────────────────────────────────────

export function baView(el) {
  return el.Box({
    flexDirection: 'column',
    rowGap: 1,
    children: BEFORE_AFTER.map((r) =>
      el.Box({
        flexDirection: 'column',
        children: [
          el.Text({ bold: true, color: C.title, children: [r.when] }),
          rich(el, ['  ', [r.before, C.dim], ['  →  ', C.faint], [r.after, r.color, true]]),
        ],
      }),
    ),
  })
}

// ── 영향 범위 ────────────────────────────────────────────────

export function impactView(el) {
  const item = (path, desc, flag) =>
    el.Box({
      flexDirection: 'column',
      children: [
        el.Text({ color: C.blue, wrap: 'truncate-start', children: [path] }),
        rich(el, ['  ', [desc, C.fg], flag ? ['  ' + flag, C.red, true] : '']),
      ],
    })
  return el.Box({
    flexDirection: 'column',
    rowGap: 1,
    children: [
      block(el, 'login()을 부르는 곳 2', [
        item('src/pages/LoginPage.tsx:41', '로딩 표시 시간이 길어질 수 있습니다.'),
        item('src/auth/session.ts:88', '토큰 갱신에도 재시도가 적용됩니다.', '의도했는지 확인 필요'),
      ]),
      block(el, '새로 생긴 함수', [item('retry(), isRetryable()', '아직 다른 사용처는 없습니다.')]),
      block(el, '확인할 테스트', [
        item('src/auth/login.test.ts', '이번에 추가된 테스트'),
        item('src/auth/session.test.ts', '기존 테스트, 재시도 영향을 받음'),
      ]),
    ],
  })
}

// ── diff (인텔리제이식) ──────────────────────────────────────
// 위쪽 안내·버튼과 아래 설명은 고정하고, 가운데 코드 영역만 위아래(top)·좌우(left)로 민다.

// 강조할 부분 문자열들로 한 줄을 조각낸다: [[글, 글자색, 굵게, 배경색], ...]
function segments(text, highlights, hi, fg) {
  if (!text) return [[' ', fg]]
  const out = []
  let rest = text
  ;(highlights || []).forEach((h) => {
    const i = rest.indexOf(h)
    if (i < 0) return
    if (i > 0) out.push([rest.slice(0, i), fg])
    out.push([h, fg, false, hi])
    rest = rest.slice(i + h.length)
  })
  if (rest) out.push([rest, fg])
  return out
}

// 줄 표시 칸(고정) + 가로로 민 코드
function codeLine(el, mark, num, parts, left) {
  return el.Text({
    wrap: 'truncate-end',
    children: [
      el.Text({ color: C.accent, bold: true, children: [mark] }),
      el.Text({ color: C.faint, children: [num.padStart(4, ' ') + ' '] }),
      ...shift(parts, left).map(([t, fg, bold, bg]) => el.Text(bg ? { color: fg, bold: !!bold, backgroundColor: bg, children: [t] } : { color: fg, bold: !!bold, children: [t] })),
    ],
  })
}

function filled(el, width, bg, child) {
  const props = { width, flexShrink: 0, children: [child] }
  if (bg) props.backgroundColor = bg
  return el.Box(props)
}

// 보고 있는 변경 블록의 파일을 줄 목록으로 만든다 (그리기 전 데이터)
export function diffModel(cols, pos) {
  const cur = HUNKS[pos]
  const file = FILES[cur.f]
  const side = cols >= 96
  const mark = (r) => (r[0] !== 'eq' && r[5] === cur.h ? '>' : ' ')
  const lines = []
  let hunkStart = -1
  let longest = 0
  const note = (r) => { if (hunkStart < 0 && r[5] === cur.h && r[0] !== 'eq') hunkStart = lines.length }
  file.rows.forEach((r) => {
    if (r[0] === 'fold') { lines.push({ fold: r[1] }); return }
    const k = r[0]
    longest = Math.max(longest, (r[2] || '').length + 2, (r[4] || '').length + 2)
    if (side) {
      note(r)
      lines.push({
        mark: mark(r),
        l: {
          num: r[1] == null ? '' : String(r[1]),
          parts: segments(r[2], r[6], k === 'mod' ? D.modHi : null, k === 'del' ? C.dim : C.fg),
          bg: k === 'eq' ? null : k === 'add' ? D.fill : k === 'del' ? D.del : r[2] ? D.mod : D.modFill,
        },
        r: {
          num: r[3] == null ? '' : String(r[3]),
          parts: segments(r[4], r[7], k === 'mod' ? D.modHi : k === 'add' ? D.addHi : null, C.fg),
          bg: k === 'eq' ? null : k === 'add' ? D.add : k === 'del' ? D.fill : D.mod,
        },
      })
      return
    }
    // 통합 보기: 지운 줄(−) 다음에 추가한 줄(+)
    if (k === 'eq') {
      lines.push({ mark: ' ', num: String(r[3]), parts: [['  ' + r[4], C.dim]], bg: null })
      return
    }
    note(r)
    if (r[2] || k === 'del') lines.push({ mark: mark(r), num: String(r[1]), parts: [['− ', C.red], ...segments(r[2], r[6], D.remHi, C.fg)], bg: D.rem })
    if (k !== 'del') lines.push({ mark: mark(r), num: String(r[3]), parts: [['+ ', C.green], ...segments(r[4], r[7], D.addHi, C.fg)], bg: D.add })
  })
  const codeCols = side ? Math.floor((cols - 1) / 2) - 6 : cols - 6
  return { cur, file, side, lines, hunkStart: Math.max(0, hunkStart), maxLeft: Math.max(0, longest - codeCols) }
}

// 코드 영역에 보일 줄 수: 창 높이에서 고정된 위아래 영역을 뺀 만큼
export function diffCodeRows(bodyRows) {
  return Math.max(6, bodyRows - 15)
}

// st = { pos, top, left }. on = { prev, next, nextFile, pickFile, back, up, down, leftward, rightward }
export function diffView(el, cols, bodyRows, st, on) {
  const m = diffModel(cols, st.pos)
  const codeRows = diffCodeRows(bodyRows)
  const top = Math.min(st.top, Math.max(0, m.lines.length - codeRows))
  const left = Math.min(st.left, m.maxLeft)
  const half = Math.floor((cols - 1) / 2)

  const tabs = buttonRow(el, FILES.map((f, i) =>
    btn(el, { key: 'tab-' + i, label: f.name, primary: i === m.cur.f, dim: i !== m.cur.f, onPress: () => on.pickFile(i) }),
  ))

  const nav = buttonRow(el, [
      btn(el, { key: 'prev', hotkey: 'p', label: '이전 변경', dim: st.pos === 0, onPress: on.prev }),
      btn(el, { key: 'next', hotkey: 'n', label: '다음 변경', primary: true, dim: st.pos === HUNKS.length - 1, onPress: on.next }),
      btn(el, { key: 'next-file', hotkey: 'f', label: '다음 파일', onPress: on.nextFile }),
      btn(el, { key: 'back', hotkey: 'b', label: '해설로', onPress: on.back }),
      el.Text({ color: C.accent, children: [' 변경 ' + (st.pos + 1) + '/' + HUNKS.length] }),
  ])

  const scrollBar = buttonRow(el, [
      btn(el, { key: 'up', hotkey: 'k', label: '위', dim: top === 0, onPress: on.up }),
      btn(el, { key: 'down', hotkey: 'j', label: '아래', dim: top + codeRows >= m.lines.length, onPress: on.down }),
      btn(el, { key: 'left', hotkey: 'h', label: '왼쪽', dim: left === 0, onPress: on.leftward }),
      btn(el, { key: 'right', hotkey: 'l', label: '오른쪽', dim: left >= m.maxLeft, onPress: on.rightward }),
      el.Text({
        color: C.faint,
        children: [' 줄 ' + (m.lines.length ? top + 1 : 0) + '–' + Math.min(top + codeRows, m.lines.length) + ' / ' + m.lines.length + (left ? '  ·  가로 +' + left : '') + '  ·  휠로도 스크롤'],
      }),
  ])

  const meta = rich(el, [
    [m.file.path, C.blue],
    '  ',
    [m.file.tag, m.file.tagColor],
    '  ',
    ['+' + m.file.add, C.green],
    m.file.del ? ' ' : '',
    m.file.del ? ['−' + m.file.del, C.red] : '',
    m.file.agent ? ['  ' + m.file.agent, C.purple] : '',
    ['  ·  ' + (m.side ? '좌우 보기' : '통합 보기 (창이 좁음)'), C.faint],
  ], { wrap: 'truncate-end' })

  const code = []
  if (m.side) {
    code.push(el.Box({
      flexDirection: 'row',
      children: [
        filled(el, half, null, el.Text({ color: C.faint, children: ['      변경 전 · 턴 시작 시점'] })),
        el.Text({ color: C.rule, children: ['│'] }),
        filled(el, half, null, el.Text({ color: C.faint, children: ['      변경 후 · 턴 종료 시점'] })),
      ],
    }))
  }
  m.lines.slice(top, top + codeRows).forEach((ln) => {
    if (ln.fold) {
      code.push(el.Box({ justifyContent: 'center', children: [el.Text({ color: C.faint, children: ['··· ' + ln.fold + ' ···'] })] }))
    } else if (m.side) {
      code.push(el.Box({
        flexDirection: 'row',
        children: [
          filled(el, half, ln.l.bg, codeLine(el, ln.mark, ln.l.num, ln.l.parts, left)),
          el.Text({ color: C.rule, children: ['│'] }),
          filled(el, half, ln.r.bg, codeLine(el, ln.mark, ln.r.num, ln.r.parts, left)),
        ],
      }))
    } else {
      code.push(filled(el, cols, ln.bg, codeLine(el, ln.mark, ln.num, ln.parts, left)))
    }
  })

  return el.Box({
    flexDirection: 'column',
    children: [
      rich(el, [['diff  ', C.accent, true], ['파일을 고르거나 n/p로 변경 사이를 이동합니다.', C.dim]]),
      tabs,
      nav,
      scrollBar,
      rule(el, cols),
      meta,
      ...code,
      rule(el, cols),
      el.Box({
        borderStyle: 'round',
        borderColor: C.accent,
        paddingX: 1,
        flexDirection: 'column',
        children: [
          el.Text({ bold: true, color: C.accent, children: ['변경 ' + (st.pos + 1) + ' 설명'] }),
          el.Text({ color: C.title, children: [m.cur.note] }),
        ],
      }),
    ],
  })
}
