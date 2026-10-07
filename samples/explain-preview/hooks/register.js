// explain-preview: change-explainer 해설 창의 디자인을 터미널에서 확인하기 위한 샘플.
// 고정된 예시 데이터(로그인 재시도 추가)로 그리며, 모델을 호출하지 않는다.
// "만드는 중"과 질문 답변은 잠깐 기다리는 것만 흉내 낸다.

import { C, EASY, EASY_AGAIN, EASY_AGAIN_DEFAULT, EASY_ASK_AFTER, FILES, HUNKS, QUIZ, SAMPLE_ANSWER, SECTION_ANSWER, SECTIONS, TURN } from './data.js'
import {
  backgroundView, baView, btn, buttonRow, diffCodeRows, diffModel, diffView, flowView, impactView, quizView, rich, rule,
  seqMaxLeft, seqView, summaryView, termsView, walkView,
} from './views.js'

const PANE = 'explain-preview'
const WANT_COLUMNS = 100
const FAKE_DELAY_MS = 700
const STEP_ROWS = 5
const STEP_COLS = 8

// 화면: 'explain'(해설) 또는 'diff'
let mode = 'explain'
// diff: 보고 있는 변경 블록(HUNKS 위치), 코드 영역의 위쪽 줄과 가로 밀림
let pos = 0
let diffTop = 0
let diffLeft = 0
// 마지막으로 그린 diff 코드 영역의 크기: 휠 스크롤의 한계를 정할 때 쓴다
let diffBounds = { maxTop: 0 }
// 시퀀스 다이어그램의 가로 밀림
let seqLeft = 0
// 섹션별 펼침 여부(다음에도 기억)와 생성 상태(none → loading → done)
let open = { summary: true }
let gen = Object.fromEntries(SECTIONS.map((s) => [s.id, s.id === 'summary' ? 'done' : 'none']))
// 섹션별 Wait, what? 대화: { [섹션 id]: [{ type: 'easy', text } | { type: 'q', q, a }] }
// text나 a가 null이면 만드는 중
let easy = {}
// 이미 아는 용어 id 목록 (다음에도 기억): 다음 해설에서는 짧게 넘어간다
let known = []
// 확인 퀴즈: 문제별 보기 순서(섞은 결과)와 고른 보기. 보기 원래 위치 0이 정답
let quiz = newQuiz()
// 마지막으로 펼친 섹션: r(다시 만들기)의 대상. j/k가 이동할 섹션 위치
let current = 'summary'
let cursor = 0
// 퀴즈를 다 맞혀서 이 턴을 이해했다고 표시했는지 (다음에도 기억)
let understood = false
// 질문과 답변: [{ q, a }], a가 null이면 답을 만드는 중
let qa = []

const titleOf = (id) => SECTIONS.find((s) => s.id === id).title

// 보기 순서를 섞는다. 모델은 정답을 첫 번째에 두는 버릇이 있어서 순서는 코드가 정한다
function shuffled(n) {
  const a = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function newQuiz() {
  return { order: QUIZ.map((q) => shuffled(q.options.length)), picked: QUIZ.map(() => null) }
}
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))

// 섹션 생성을 흉내 낸다. 실제 mod에서는 여기서 $.model.fork로 구조를 받아 온다
function generate($, id) {
  gen = { ...gen, [id]: 'loading' }
  $.ui.invalidate('ui.render')
  $.clock.after(FAKE_DELAY_MS, () => {
    gen = { ...gen, [id]: 'done' }
    if (id === 'quiz') quiz = newQuiz()
    $.ui.invalidate('ui.render')
  })
}

// 섹션 대화의 i번째 항목을 채운다
function fill(id, i, patch) {
  easy = { ...easy, [id]: easy[id].map((x, j) => (j === i ? { ...x, ...patch } : x)) }
}

// Wait, what?: 같은 내용을 더 쉬운 말로, 빠진 전제를 채워 다시 설명한다 (짧게 줄이는 것이 아님).
// 여러 번 누를 수 있고, 두 번째부터는 다른 비유로 설명한다
function explainEasier($, id) {
  const thread = easy[id] || []
  const round = thread.filter((x) => x.type === 'easy').length
  const i = thread.length
  easy = { ...easy, [id]: [...thread, { type: 'easy', text: null }] }
  $.ui.invalidate('ui.render')
  $.clock.after(FAKE_DELAY_MS, () => {
    const again = EASY_AGAIN[id] || []
    fill(id, i, { text: round === 0 ? EASY[id] : again[round - 1] || EASY_AGAIN_DEFAULT })
    $.ui.invalidate('ui.render')
  })
}

// 섹션 안에서 추가 질문: 답은 그 섹션 대화에 이어 붙는다
function askInSection($, id, q) {
  const thread = easy[id] || []
  const i = thread.length
  easy = { ...easy, [id]: [...thread, { type: 'q', q, a: null }] }
  $.ui.invalidate('ui.render')
  $.clock.after(FAKE_DELAY_MS, () => {
    fill(id, i, { a: SECTION_ANSWER })
    $.ui.invalidate('ui.render')
  })
}

function statusOf(id) {
  if (gen[id] === 'done') return ['● 생성됨', C.green]
  if (gen[id] === 'loading') return ['◌ 만드는 중', C.accent]
  return ['○ 펼치면 생성', C.faint]
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    // 지난번에 펼쳐 둔 섹션과 이해함 표시를 불러온다
    const savedOpen = await $.store.get('open')
    if (savedOpen && typeof savedOpen === 'object') open = { ...savedOpen, summary: savedOpen.summary !== false }
    understood = (await $.store.get('understood')) === true
    const savedKnown = await $.store.get('known')
    if (Array.isArray(savedKnown)) known = savedKnown
    try {
      await $.command.register({
        name: 'explain-sample',
        description: '변경 해설 창 디자인 샘플 열기',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('/explain-sample 등록 실패: ' + err)
    }
    return next(e)
  })

  on('command.run', { command: 'explain-sample' }, async ($) => {
    mode = 'explain'
    // 기억해 둔 섹션은 창을 열 때 바로 만든다 (사용자가 늘 보는 섹션이라서)
    SECTIONS.forEach((s) => { if (open[s.id] && gen[s.id] === 'none') generate($, s.id) })
    await $.ui.open({ id: PANE, title: '변경 해설', focus: true, closeOnEscape: true, columns: WANT_COLUMNS })
    return {}
  })

  // diff 화면에서는 휠과 스크롤 키로 창 전체가 아니라 코드 영역만 움직인다
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (mode !== 'diff') return next(e)
    diffTop = clamp(diffTop + e.by, 0, diffBounds.maxTop)
    $.ui.invalidate('ui.render')
    return {}
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const el = $.ui.resolve(e)
    const cols = e.props.bodyColumns || 80
    const bodyRows = (e.props.scroll && e.props.scroll.bodyRows) || 30
    const redraw = () => $.ui.invalidate('ui.render')
    const saveOpen = () => { $.store.set('open', open).catch(() => {}) }
    // 스크롤할 수 없는 곳(테스트 등)에서는 그냥 둔다
    const reveal = (key) => { $.ui.scroll({ in: PANE, to: { key }, block: 'start' }).catch(() => {}) }

    const toggle = (id, show) => {
      open = { ...open, [id]: !open[id] }
      if (open[id]) {
        current = id
        cursor = SECTIONS.findIndex((s) => s.id === id)
        if (gen[id] === 'none') generate($, id)
      }
      saveOpen()
      redraw()
      if (show && open[id]) reveal('sec-' + id)
    }

    // 변경 블록으로 이동: 그 블록이 코드 영역 위쪽에 오도록 맞춘다
    const goTo = (n) => {
      pos = clamp(n, 0, HUNKS.length - 1)
      diffTop = Math.max(0, diffModel(cols, pos).hunkStart - 2)
      diffLeft = 0
      redraw()
    }
    const showDiff = (fileIdx) => {
      mode = 'diff'
      goTo(fileIdx === undefined ? pos : HUNKS.findIndex((h) => h.f === fileIdx))
      $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {})
    }

    // ── diff 화면 ──
    if (mode === 'diff') {
      const m = diffModel(cols, pos)
      diffBounds = { maxTop: Math.max(0, m.lines.length - diffCodeRows(bodyRows)) }
      diffTop = clamp(diffTop, 0, diffBounds.maxTop)
      diffLeft = clamp(diffLeft, 0, m.maxLeft)
      return diffView(el, cols, bodyRows, { pos, top: diffTop, left: diffLeft }, {
        prev: () => goTo(pos - 1),
        next: () => goTo(pos + 1),
        nextFile: () => showDiff((HUNKS[pos].f + 1) % FILES.length),
        pickFile: (i) => showDiff(i),
        back: () => { mode = 'explain'; redraw() },
        up: () => { diffTop = clamp(diffTop - STEP_ROWS, 0, diffBounds.maxTop); redraw() },
        down: () => { diffTop = clamp(diffTop + STEP_ROWS, 0, diffBounds.maxTop); redraw() },
        leftward: () => { diffLeft = clamp(diffLeft - STEP_COLS, 0, m.maxLeft); redraw() },
        rightward: () => { diffLeft = clamp(diffLeft + STEP_COLS, 0, m.maxLeft); redraw() },
      })
    }

    // ── 해설 화면 ──
    const allOpen = SECTIONS.every((s) => open[s.id])

    const header = el.Box({
      flexDirection: 'column',
      children: [
        rich(el, [['#' + TURN.n + '  ', C.accent, true], [TURN.title, C.title, true]]),
        rich(el, [
          ['파일 ' + FILES.length + '개  ', C.dim],
          ['+' + FILES.reduce((a, f) => a + f.add, 0), C.green], ' ',
          ['−' + FILES.reduce((a, f) => a + f.del, 0), C.red],
          ['  ·  서브에이전트 1  ·  ' + TURN.when + '  ·  ', C.dim],
          understood ? ['✓ 이해함 (퀴즈 통과)', C.green, true] : ['○ 아직 확인 안 함', C.faint],
        ], { wrap: 'truncate-end' }),
        el.Text({ children: [' '] }),
        rich(el, [['요청 ', C.faint], [TURN.request, C.dim]]),
        el.Box({
          marginTop: 1,
          borderStyle: 'round',
          borderColor: C.accent,
          paddingX: 1,
          flexDirection: 'column',
          children: [
            el.Text({ bold: true, color: C.accent, children: ['한 줄 요약'] }),
            el.Text({ color: C.title, children: [TURN.tldr] }),
          ],
        }),
        el.Box({ marginTop: 1, children: [buttonRow(el, [
          btn(el, { key: 'diff', hotkey: 'd', label: 'diff 보기', primary: true, onPress: () => showDiff() }),
          btn(el, { key: 'all', hotkey: 'a', label: allOpen ? '모두 접기' : '모두 펼치기', onPress: () => {
            const target = !allOpen
            SECTIONS.forEach((s) => { if (!!open[s.id] !== target) toggle(s.id, false) })
          } }),
          btn(el, { key: 'regen', hotkey: 'r', label: '다시 만들기 (' + titleOf(current) + ')', dim: gen[current] === 'loading', onPress: () => {
            if (gen[current] === 'loading') return
            if (!open[current]) toggle(current, true)
            else generate($, current)
          } }),
          btn(el, { key: 'go-quiz', hotkey: 'q', label: understood ? '퀴즈 다시 보기' : '퀴즈로 확인', onPress: () => {
            if (!open.quiz) toggle('quiz', true)
            else reveal('sec-quiz')
          } }),
          btn(el, { key: 'sec-next', hotkey: 'j', label: '다음 섹션', onPress: () => {
            cursor = clamp(cursor + 1, 0, SECTIONS.length - 1)
            reveal('sec-' + SECTIONS[cursor].id)
          } }),
          btn(el, { key: 'sec-prev', hotkey: 'k', label: '이전 섹션', onPress: () => {
            cursor = clamp(cursor - 1, 0, SECTIONS.length - 1)
            reveal('sec-' + SECTIONS[cursor].id)
          } }),
        ])] }),
      ],
    })

    const body = []
    SECTIONS.forEach((s) => {
      const [status, statusColor] = statusOf(s.id)
      body.push(rule(el, cols))
      body.push(
        el.Box({
          key: 'sec-' + s.id,
          flexDirection: 'row',
          justifyContent: 'space-between',
          children: [
            btn(el, { key: 'btn-' + s.id, hotkey: s.key, label: s.title + (open[s.id] ? '  ▾' : '  ▸'), onPress: () => toggle(s.id, true) }),
            el.Box({
              flexDirection: 'row',
              columnGap: 2,
              children: [
                ...(open[s.id] && gen[s.id] === 'done' && !easy[s.id]
                  ? [btn(el, { key: 'easy-' + s.id, label: 'Wait, what?', primary: true, onPress: () => explainEasier($, s.id) })]
                  : []),
                el.Text({ color: statusColor, children: [status] }),
              ],
            }),
          ],
        }),
      )
      // Wait, what? 대화 상자: 쉬운 설명들과 추가 질문이 이어진다
      if (open[s.id] && easy[s.id]) {
        const thread = easy[s.id]
        const busy = thread.some((x) => (x.type === 'easy' ? x.text === null : x.a === null))
        // 여러 번 설명해도 모르겠다면, 더 설명하기보다 어디가 막히는지 듣는 편이 낫다
        const rounds = thread.filter((x) => x.type === 'easy').length
        const askFirst = rounds >= EASY_ASK_AFTER
        let round = 0
        body.push(el.Box({
          key: 'easy-box-' + s.id,
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
                    x.text === null
                      ? el.Text({ color: C.dim, children: ['쉬운 말로 다시 설명하는 중…'] })
                      : el.Text({ children: [x.text] }),
                  ],
                })
              }
              return el.Box({
                flexDirection: 'column',
                children: [
                  rich(el, [['Q  ', C.accent, true], [x.q, C.title]]),
                  x.a === null
                    ? el.Text({ color: C.dim, children: ['   답을 만드는 중…'] })
                    : rich(el, [['A  ', C.green, true], [x.a, C.fg]]),
                ],
              })
            }),
            askFirst
              ? rich(el, [['세 번 설명했는데도 막힌다면 ', C.dim], ['어느 문장, 어느 단어', C.accent, true], ['에서 막히는지 아래에 적어 주세요. 그 지점부터 다시 설명합니다.', C.dim]])
              : el.Text({ children: [''] }),
            buttonRow(el, [
              btn(el, {
                key: 'easy-again-' + s.id,
                label: askFirst ? 'Wait, what?  그래도 한 번 더' : 'Wait, what?  아직 모르겠어요',
                primary: !askFirst,
                dim: busy || askFirst,
                onPress: () => { if (!busy) explainEasier($, s.id) },
              }),
            ]),
            el.Input(Object.assign({
              key: 'easy-ask-' + s.id,
              label: '이 부분 질문',
              placeholder: '어디가 막히는지 적고 Enter',
              value: '',
              submitLabel: '묻기',
              onSubmit: (value) => {
                const q = value.trim()
                if (q) askInSection($, s.id, q)
              },
            }, askFirst ? { autoFocus: true } : {})),
          ],
        }))
      }
      if (open[s.id] && gen[s.id] === 'loading') {
        body.push(el.Box({ paddingLeft: 2, paddingY: 1, children: [el.Text({ color: C.dim, children: ['현재 대화를 바탕으로 만드는 중…'] })] }))
      }
      if (open[s.id] && gen[s.id] === 'done') {
        const inner = cols - 2
        let view
        if (s.id === 'summary') view = summaryView(el, (i) => showDiff(i))
        else if (s.id === 'background') view = backgroundView(el)
        else if (s.id === 'walk') view = walkView(el)
        else if (s.id === 'terms') {
          view = termsView(el, known, (id) => {
            known = known.includes(id) ? known.filter((x) => x !== id) : [...known, id]
            redraw()
            $.store.set('known', known).catch(() => {})
          })
        } else if (s.id === 'quiz') {
          view = quizView(el, quiz, {
            pick: (i, orig) => {
              quiz = { ...quiz, picked: quiz.picked.map((x, j) => (j === i ? orig : x)) }
              const allRight = quiz.picked.every((x) => x === 0)
              if (allRight && !understood) {
                understood = true
                $.store.set('understood', true).catch(() => {})
                $.ui.toast('#' + TURN.n + ' 턴을 이해함으로 표시했습니다')
              }
              redraw()
            },
            retry: () => { quiz = newQuiz(); redraw() },
          })
        } else if (s.id === 'flow') view = flowView(el, inner)
        else if (s.id === 'ba') view = baView(el)
        else if (s.id === 'impact') view = impactView(el)
        else {
          // 시퀀스: 창보다 넓으면 좌우로 밀어 볼 수 있다
          const maxLeft = seqMaxLeft(inner)
          seqLeft = clamp(seqLeft, 0, maxLeft)
          const diagram = seqView(el, inner, seqLeft)
          view = maxLeft === 0 ? diagram : el.Box({
            flexDirection: 'column',
            rowGap: 1,
            children: [
              buttonRow(el, [
                btn(el, { key: 'seq-left', hotkey: 'h', label: '왼쪽', dim: seqLeft === 0, onPress: () => { seqLeft = clamp(seqLeft - STEP_COLS, 0, maxLeft); redraw() } }),
                btn(el, { key: 'seq-right', hotkey: 'l', label: '오른쪽', dim: seqLeft >= maxLeft, onPress: () => { seqLeft = clamp(seqLeft + STEP_COLS, 0, maxLeft); redraw() } }),
                el.Text({ color: C.faint, children: [' 창보다 넓은 다이어그램' + (seqLeft ? '  ·  가로 +' + seqLeft : '')] }),
              ]),
              diagram,
            ],
          })
        }
        body.push(el.Box({ paddingLeft: 2, paddingY: 1, children: [view] }))
      }
    })
    body.push(rule(el, cols))

    // ── 질문하기 ──
    const ask = el.Box({
      flexDirection: 'column',
      rowGap: 1,
      children: [
        el.Text({ bold: true, color: C.accent, children: ['질문하기'] }),
        ...qa.map((x, i) =>
          el.Box({
            key: 'qa-' + i,
            flexDirection: 'column',
            paddingLeft: 2,
            children: [
              rich(el, [['Q  ', C.accent, true], [x.q, C.title]]),
              x.a === null
                ? el.Text({ color: C.dim, children: ['   답을 만드는 중…'] })
                : rich(el, [['A  ', C.green, true], [x.a, C.fg]]),
            ],
          }),
        ),
        el.Input({
          key: 'ask',
          label: '질문',
          placeholder: '이 변경에 대해 궁금한 점을 입력하고 Enter',
          value: '',
          submitLabel: '묻기',
          onSubmit: (value) => {
            const q = value.trim()
            if (!q) return
            const i = qa.length
            qa = [...qa, { q, a: null }]
            redraw()
            $.ui.scroll({ in: PANE, to: { key: 'qa-' + i }, block: 'nearest' }).catch(() => {})
            $.clock.after(FAKE_DELAY_MS, () => {
              qa = qa.map((x, j) => (j === i ? { ...x, a: SAMPLE_ANSWER } : x))
              $.ui.invalidate('ui.render')
            })
          },
        }),
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
        el.Text({ color: C.faint, children: ['휠·↑↓·PgUp/PgDn 위아래  j/k 섹션 이동  1–9 펼치기  Esc 닫기'] }),
        el.Text({ color: C.faint, children: ['대화 기록을 바탕으로 재구성한 해설입니다. 실제 내부 추론과 다를 수 있습니다.'] }),
      ],
    })
  })
}
