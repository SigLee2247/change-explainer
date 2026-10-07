// 해설 창. 섹션 데이터는 모델이 만든 JSON(generate.js의 검증을 거친 것)이다.
//
// st = {
//   turn, files,                      턴 기록과 화면용 파일
//   sections: { id: { status, data, error } }   status: none | loading | done | error
//   open: { id: bool }, current,      펼친 섹션, r(다시 만들기)의 대상
//   threads: { id: [{ type: 'easy', text } | { type: 'q', q, a }] }   Wait, what? 대화 (null이면 만드는 중)
//   qa: [{ q, a }], known: [용어], quiz: { order, picked }, understood, seqLeft,
//   codeFor: (at) => { title, lines: [{ num, text }] } | null    코드 위치를 스냅숏에서 읽은 결과
// }

import { SECTIONS } from '../generate.js'
import { C, btn, buttonRow, link, linkRow, rich, rule } from './common.js'
import { flowView, seqMaxLeft, seqView } from './diagrams.js'

// 이 회차부터는 더 설명하기보다 어디가 막히는지 묻는다
export const EASY_ASK_AFTER = 3
export const STEP_COLS = 8

function heading(el, text) {
  return el.Text({ bold: true, color: C.accent, children: [text] })
}

function block(el, title, children) {
  return el.Box({ flexDirection: 'column', children: [heading(el, title), el.Box({ flexDirection: 'column', paddingLeft: 2, children })] })
}

function labeled(el, label, color, text) {
  return el.Box({
    flexDirection: 'column',
    children: [el.Text({ bold: true, color, children: [label] }), el.Box({ paddingLeft: 2, children: [el.Text({ children: [text] })] })],
  })
}

// ── 섹션들 ───────────────────────────────────────────────────

function summaryView(el, data, files, onFile) {
  const descOf = (path) => (data.files.find((f) => f.path === path) || {}).desc || ''
  const children = [
    block(el, '무엇을 바꿨나', [
      ...files.map((f, i) =>
        el.Box({
          flexDirection: 'column',
          children: [
            btn(el, { key: 'file-' + i, label: f.path + '  →  diff', onPress: () => onFile(i) }),
            rich(el, [
              '  ',
              f.skipped ? ['내용 생략', C.dim] : f.isNew ? ['새 파일', C.green] : ['수정', C.blue],
              '  ', ['+' + f.added, C.green], f.removed ? ' ' : '', f.removed ? ['−' + f.removed, C.red] : '',
              f.agents.length ? ['  서브에이전트', C.purple] : '',
              descOf(f.path) ? ['  ' + descOf(f.path), C.dim] : '',
            ]),
          ],
        }),
      ),
    ]),
  ]
  if (data.why.length) children.push(block(el, '왜 이렇게 했나', data.why.map((w) => el.Text({ children: [w] }))))
  if (data.how.length) {
    children.push(block(el, '어떻게 동작하나', data.how.flatMap((h, i) => [
      rich(el, [[(i + 1) + ' ', C.accent], [h.label, C.blue]]),
      el.Box({ paddingLeft: 2, children: [el.Text({ color: C.dim, children: [h.detail] })] }),
    ])))
  }
  if (data.review.length) {
    children.push(block(el, '검토할 점', data.review.map((r) =>
      rich(el, [r.kind === 'warn' ? ['! ', C.red, true] : ['? ', C.blue, true], r.text]),
    )))
  }
  return el.Box({ flexDirection: 'column', rowGap: 1, children })
}

function backgroundView(el, data) {
  const children = []
  if (data.problem) children.push(block(el, '무슨 문제가 있었나', [el.Text({ children: [data.problem] })]))
  if (data.cause) {
    children.push(block(el, '왜 그랬나', [
      el.Text({ children: [data.cause] }),
      ...(data.causeAt ? [el.Text({ color: C.blue, children: [data.causeAt] })] : []),
    ]))
  }
  if (data.goal) children.push(block(el, '이번 변경의 목표', [el.Text({ children: [data.goal] })]))
  if (data.outOfScope.length) children.push(block(el, '이번에 다루지 않은 것', data.outOfScope.map((x) => rich(el, [['- ', C.faint], [x, C.dim]]))))
  return el.Box({ flexDirection: 'column', rowGap: 1, children })
}

function walkView(el, data, codeFor) {
  return el.Box({
    flexDirection: 'column',
    rowGap: 1,
    children: [
      el.Text({ color: C.dim, children: ['실제 코드를 순서대로 따라가며 각 줄이 하는 일과 그렇게 한 이유를 설명합니다.'] }),
      ...data.steps.map((st, i) => {
        const code = codeFor(st.at)
        return el.Box({
          flexDirection: 'column',
          rowGap: 1,
          children: [
            el.Box({
              flexDirection: 'column',
              children: [
                rich(el, [[(i + 1) + '단계  ', C.accent, true], [st.title, C.title, true]]),
                el.Text({ color: C.blue, wrap: 'truncate-start', children: [st.at || '(위치 없음)'] }),
              ],
            }),
            code
              ? el.Box({
                  flexDirection: 'column',
                  paddingLeft: 1,
                  children: code.lines.map((ln) => rich(el, [[String(ln.num).padStart(4, ' ') + ' ┃ ', C.faint], [ln.text, code.deleted ? C.dim : C.fg]], { wrap: 'truncate-end' })),
                })
              : el.Text({ color: C.faint, children: ['  (이 위치의 코드를 스냅숏에서 찾지 못했습니다)'] }),
            labeled(el, '하는 일', C.green, st.does),
            ...(st.why ? [labeled(el, '이유', C.accent, st.why)] : []),
            ...(st.alt ? [labeled(el, '검토한 다른 방법', C.purple, st.alt)] : []),
          ],
        })
      }),
    ],
  })
}

function baView(el, data) {
  const tone = { better: C.green, same: C.dim, worse: C.red }
  return el.Box({
    flexDirection: 'column',
    rowGap: 1,
    children: data.rows.map((r) =>
      el.Box({
        flexDirection: 'column',
        children: [
          el.Text({ bold: true, color: C.title, children: [r.when] }),
          rich(el, ['  ', [r.before, C.dim], ['  →  ', C.faint], [r.after, tone[r.tone], true]]),
        ],
      }),
    ),
  })
}

function impactView(el, data) {
  return el.Box({
    flexDirection: 'column',
    rowGap: 1,
    children: data.groups.map((g) =>
      block(el, g.title, g.items.map((it) =>
        el.Box({
          flexDirection: 'column',
          children: [
            el.Text({ color: C.blue, wrap: 'truncate-start', children: [it.path || '-'] }),
            rich(el, ['  ', [it.desc, C.fg], it.flag ? ['  ' + it.flag, C.red, true] : '']),
          ],
        }),
      )),
    ),
  })
}

function termsView(el, data, known, onToggle) {
  if (!data.terms.length) return el.Text({ color: C.dim, children: ['새로 알아야 할 용어가 없습니다.'] })
  const rows = data.terms.map((t) => {
    const isKnown = known.includes(t.term)
    const button = btn(el, { key: 'term-' + t.id, label: isKnown ? 'Undo' : 'Known', onPress: () => onToggle(t.term) })
    if (isKnown) {
      return el.Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, children: [rich(el, [['✓ ', C.green], [t.term, C.dim]]), button] })
    }
    return el.Box({
      flexDirection: 'column',
      children: [
        el.Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, children: [rich(el, [[t.term, C.title, true], t.en ? ['  ' + t.en, C.faint] : '']), button] }),
        el.Box({ paddingLeft: 2, children: [el.Text({ children: [t.def] })] }),
      ],
    })
  })
  return el.Box({
    flexDirection: 'column',
    rowGap: 1,
    children: [el.Text({ color: C.dim, children: ['이 변경에 필요한 개념입니다. 이미 아는 것은 [Known]을 누르면 다음 해설부터 짧게 넘어갑니다.'] }), ...rows],
  })
}

// quiz = { order: [[보기 원래 위치...]], picked: [고른 원래 위치 | null] }. 원래 위치 0이 정답
function quizView(el, data, quiz, on) {
  const answered = quiz.picked.filter((x) => x !== null).length
  const correct = quiz.picked.filter((x) => x === 0).length
  const total = data.questions.length
  const done = answered === total
  return el.Box({
    flexDirection: 'column',
    rowGap: 1,
    children: [
      el.Text({ color: C.dim, children: ['기억에서 떠올리며 풀어 보세요. 다 맞히면 이 턴이 이해함으로 표시됩니다.'] }),
      ...data.questions.map((qz, i) => {
        const picked = quiz.picked[i]
        const options = quiz.order[i].map((orig, j) => {
          const label = String.fromCharCode(65 + j) + '  ' + qz.options[orig]
          if (picked === null) return btn(el, { key: 'q' + i + '-o' + orig, label, onPress: () => on.pick(i, orig) })
          const mark = orig === 0 ? '✓ ' : orig === picked ? '✗ ' : '  '
          return el.Text({ color: orig === 0 ? C.green : orig === picked ? C.red : C.faint, children: [mark + label] })
        })
        return el.Box({
          flexDirection: 'column',
          children: [
            rich(el, [['Q' + (i + 1) + '  ', C.accent, true], [qz.q, C.title, true]]),
            el.Box({ flexDirection: 'column', paddingLeft: 2, children: options }),
            picked === null
              ? el.Text({ children: [' '] })
              : el.Box({ paddingLeft: 2, children: [rich(el, [[picked === 0 ? '맞았습니다. ' : '틀렸습니다. ', picked === 0 ? C.green : C.red, true], [qz.explain, C.fg]])] }),
          ],
        })
      }),
      done
        ? el.Box({
            flexDirection: 'row',
            flexWrap: 'wrap',
            columnGap: 2,
            children: [
              rich(el, [[correct + '/' + total + ' 정답', correct === total ? C.green : C.accent, true],
                [correct === total ? '  이 턴을 이해함으로 표시했습니다.' : '  틀린 문제의 이유를 읽고 다시 풀어 보세요.', C.dim]]),
              ...(correct === total ? [] : [btn(el, { key: 'quiz-retry', label: '다시 풀기', onPress: on.quizRetry })]),
            ],
          })
        : el.Text({ color: C.faint, children: [answered + '/' + total + ' 답함'] }),
    ],
  })
}

// ── Wait, what? 대화 상자 ───────────────────────────────────

function threadBox(el, id, thread, on) {
  const busy = thread.some((x) => (x.type === 'easy' ? x.text === null : x.a === null))
  const rounds = thread.filter((x) => x.type === 'easy').length
  const askFirst = rounds >= EASY_ASK_AFTER
  let round = 0
  const ask = { key: 'easy-ask-' + id, label: '이 부분 질문', placeholder: '어디가 막히는지 적고 Enter', value: '', submitLabel: '묻기', onSubmit: (v) => { if (v.trim()) on.askSection(id, v.trim()) } }
  if (askFirst) ask.autoFocus = true
  return el.Box({
    key: 'easy-box-' + id,
    marginLeft: 2,
    marginTop: 1,
    borderStyle: 'round',
    borderColor: C.blue,
    paddingX: 1,
    flexDirection: 'column',
    rowGap: 1,
    children: [
      el.Text({ bold: true, color: C.blue, children: ['Wait, what?  쉬운 말로 다시 설명'] }),
      ...thread.map((x) => {
        if (x.type === 'easy') {
          round += 1
          return el.Box({
            flexDirection: 'column',
            children: [
              el.Text({ bold: true, color: C.blue, children: ['설명 ' + round] }),
              x.text === null ? el.Text({ color: C.dim, children: ['쉬운 말로 다시 설명하는 중…'] }) : el.Text({ children: [x.text] }),
            ],
          })
        }
        return el.Box({
          flexDirection: 'column',
          children: [
            rich(el, [['Q  ', C.accent, true], [x.q, C.title]]),
            x.a === null ? el.Text({ color: C.dim, children: ['   답을 만드는 중…'] }) : rich(el, [['A  ', C.green, true], [x.a, C.fg]]),
          ],
        })
      }),
      ...(askFirst ? [rich(el, [['세 번 설명했는데도 막힌다면 ', C.dim], ['어느 문장, 어느 단어', C.accent, true], ['에서 막히는지 아래에 적어 주세요. 그 지점부터 다시 설명합니다.', C.dim]])] : []),
      buttonRow(el, [btn(el, {
        key: 'easy-again-' + id,
        label: askFirst ? 'Wait, what?  그래도 한 번 더' : 'Wait, what?  아직 모르겠어요',
        primary: !askFirst,
        dim: busy || askFirst,
        onPress: () => { if (!busy) on.easy(id) },
      })]),
      el.Input(ask),
    ],
  })
}

function statusOf(sec) {
  if (sec.status === 'done') return ['● 생성됨', C.green]
  if (sec.status === 'loading') return ['◌ 만드는 중', C.accent]
  if (sec.status === 'error') return ['✗ 만들지 못함 · r로 다시', C.red]
  return ['○ 펼치면 생성', C.faint]
}

// ── 해설 창 전체 ─────────────────────────────────────────────

export function explainView(el, cols, st, on) {
  const t = st.turn
  const summary = st.sections.summary
  const changed = st.files
  const allOpen = SECTIONS.every((s) => st.open[s.id])
  const agents = [...new Set(changed.flatMap((f) => f.agents.map((a) => a.type || 'subagent')))]
  const when = new Date(t.endedAt || t.startedAt)
  const hhmm = String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0')

  const header = el.Box({
    flexDirection: 'column',
    children: [
      rich(el, [['#' + t.seq + '  ', C.accent, true], [t.title, C.title, true]]),
      rich(el, [
        ['파일 ' + changed.length + '개  ', C.dim], ['+' + t.added, C.green], ' ', ['−' + t.removed, C.red],
        agents.length ? ['  ·  서브에이전트 ' + agents.join(', '), C.dim] : '',
        ['  ·  ' + hhmm + '  ·  ', C.dim],
        st.understood ? ['✓ 이해함 (퀴즈 통과)', C.green, true] : ['○ 아직 확인 안 함', C.faint],
      ], { wrap: 'truncate-end' }),
      el.Text({ children: [' '] }),
      rich(el, [['요청 ', C.faint], [t.request, C.dim]]),
      el.Box({
        marginTop: 1,
        borderStyle: 'round',
        borderColor: summary.status === 'error' ? C.red : C.accent,
        paddingX: 1,
        flexDirection: 'column',
        children: [
          el.Text({ bold: true, color: C.accent, children: ['한 줄 요약'] }),
          summary.status === 'done'
            ? el.Text({ color: C.title, children: [summary.data.tldr] })
            : summary.status === 'error'
              ? el.Text({ color: C.red, children: ['요약을 만들지 못했습니다: ' + summary.error + '  (r로 다시)'] })
              : el.Text({ color: C.dim, children: ['현재 대화를 바탕으로 요약을 만드는 중…'] }),
        ],
      }),
      el.Box({ marginTop: 1, children: [buttonRow(el, [
        btn(el, { key: 'diff', hotkey: 'd', label: 'diff', primary: true, onPress: () => on.openDiff() }),
        btn(el, { key: 'all', hotkey: 'a', label: allOpen ? '모두 접기' : '모두 펼치기', onPress: () => on.toggleAll(!allOpen) }),
        btn(el, { key: 'regen', hotkey: 'r', label: '다시 만들기', dim: st.sections[st.current].status === 'loading', onPress: on.regen }),
        btn(el, { key: 'go-quiz', hotkey: 'q', label: '퀴즈', onPress: on.goQuiz }),
      ])] }),
      el.Box({
        marginTop: 1,
        children: [linkRow(el, SECTIONS.map((sec) => link(el, {
          key: 'toc-' + sec.id,
          label: sec.key + ' ' + sec.title,
          dim: !st.open[sec.id],
          onPress: () => on.toc(sec.id),
        })))],
      }),
    ],
  })

  const body = []
  SECTIONS.forEach((s) => {
    const sec = st.sections[s.id]
    const [status, statusColor] = statusOf(sec)
    const isOpen = !!st.open[s.id]
    const thread = st.threads[s.id]
    body.push(rule(el, cols))
    body.push(el.Box({
      key: 'sec-' + s.id,
      flexDirection: 'row',
      justifyContent: 'space-between',
      children: [
        btn(el, { key: 'btn-' + s.id, hotkey: s.key, label: s.title + (isOpen ? '  ▾' : '  ▸'), onPress: () => on.toggle(s.id) }),
        el.Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            ...(isOpen && sec.status === 'done' && !thread ? [btn(el, { key: 'easy-' + s.id, label: 'Wait, what?', primary: true, onPress: () => on.easy(s.id) })] : []),
            el.Text({ color: statusColor, children: [status] }),
          ],
        }),
      ],
    }))
    if (!isOpen) return
    if (thread) body.push(threadBox(el, s.id, thread, on))
    if (sec.status === 'loading') {
      body.push(el.Box({ paddingLeft: 2, paddingY: 1, children: [el.Text({ color: C.dim, children: ['현재 대화를 바탕으로 만드는 중…'] })] }))
      return
    }
    if (sec.status === 'error') {
      body.push(el.Box({ paddingLeft: 2, paddingY: 1, children: [el.Text({ color: C.red, children: ['만들지 못했습니다: ' + sec.error + '. r을 누르면 다시 만듭니다.'] })] }))
      return
    }
    if (sec.status !== 'done') return
    const inner = cols - 2
    const d = sec.data
    let view
    if (s.id === 'summary') view = summaryView(el, d, changed, on.openDiff)
    else if (s.id === 'background') view = backgroundView(el, d)
    else if (s.id === 'walk') view = walkView(el, d, st.codeFor)
    else if (s.id === 'flow') view = flowView(el, d, inner)
    else if (s.id === 'ba') view = baView(el, d)
    else if (s.id === 'impact') view = impactView(el, d)
    else if (s.id === 'terms') view = termsView(el, d, st.known, on.toggleKnown)
    else if (s.id === 'quiz') view = quizView(el, d, st.quiz, on)
    else {
      const maxLeft = seqMaxLeft(d, inner)
      const left = Math.min(st.seqLeft, maxLeft)
      const diagram = seqView(el, d, inner, left)
      view = maxLeft === 0 ? diagram : el.Box({
        flexDirection: 'column',
        rowGap: 1,
        children: [
          buttonRow(el, [
            btn(el, { key: 'seq-left', hotkey: 'h', label: '왼쪽', dim: left === 0, onPress: () => on.seqShift(-STEP_COLS, maxLeft) }),
            btn(el, { key: 'seq-right', hotkey: 'l', label: '오른쪽', dim: left >= maxLeft, onPress: () => on.seqShift(STEP_COLS, maxLeft) }),
            el.Text({ color: C.faint, children: [' 창보다 넓은 다이어그램' + (left ? '  ·  가로 +' + left : '')] }),
          ]),
          diagram,
        ],
      })
    }
    body.push(el.Box({ paddingLeft: 2, paddingY: 1, children: [view] }))
  })
  body.push(rule(el, cols))

  const ask = el.Box({
    flexDirection: 'column',
    rowGap: 1,
    children: [
      el.Text({ bold: true, color: C.accent, children: ['질문하기'] }),
      ...st.qa.map((x, i) => el.Box({
        key: 'qa-' + i,
        flexDirection: 'column',
        paddingLeft: 2,
        children: [
          rich(el, [['Q  ', C.accent, true], [x.q, C.title]]),
          x.a === null ? el.Text({ color: C.dim, children: ['   답을 만드는 중…'] }) : rich(el, [['A  ', C.green, true], [x.a, C.fg]]),
        ],
      })),
      el.Input({ key: 'ask', label: '질문', placeholder: '이 변경에 대해 궁금한 점을 입력하고 Enter', value: '', submitLabel: '묻기', onSubmit: (v) => { if (v.trim()) on.ask(v.trim()) } }),
      el.Text({ color: C.faint, children: ['본 대화에는 남지 않습니다.'] }),
    ],
  })

  return el.Box({
    flexDirection: 'column',
    children: [
      header,
      el.Text({ children: [' '] }),
      ...body,
      ask,
      rule(el, cols),
      el.Text({ color: C.faint, children: ['휠·↑↓·PgUp/PgDn 위아래  목차로 섹션 이동  1–9 펼치기·접기  Esc 닫기'] }),
      el.Text({ color: C.faint, children: ['대화 기록을 바탕으로 재구성한 해설입니다. 실제 내부 추론과 다를 수 있습니다.'] }),
    ],
  })
}
