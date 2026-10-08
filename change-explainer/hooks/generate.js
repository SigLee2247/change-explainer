// 해설 생성: 모델에 보낼 프롬프트와, 돌아온 JSON의 검증. mods API를 쓰지 않는 순수 함수만 둔다.
//
// 원칙 (SPEC 5장, teach·wait-what 스킬)
// - 모델은 구조(JSON)만 돌려준다. 그리기는 mod가 한다
// - 코드 조각은 모델이 쓰지 않는다. 위치(path:줄)만 받고 mod가 스냅숏에서 읽는다
// - 대화 기록에 근거가 없는 "왜"는 (추정)으로 표시하게 한다
// - 이미 아는 용어(Known)는 짧게, 정의하지 않은 용어는 쓰지 않게 한다

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

const MAX_DIFF_CHARS = 30000
const MAX_ANSWER_CHARS = 4000

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '\n…(생략)' : s || '')

// ── 턴 맥락: 요청문, 답변, 번호 붙은 diff ─────────────────────

// files: [{ path, isNew, skipped, rows, hunks }] (diff.js의 buildRows 결과)
// 변경 블록마다 "변경 N"을 붙인다. 번호는 diff 창의 변경 순서와 같다
export function diffText(files) {
  const out = []
  let n = 0
  for (const f of files) {
    out.push('### ' + f.path + (f.skipped ? '  (내용 생략: ' + f.skipped + ')' : f.isNew ? '  (새 파일)' : '  (수정)'))
    if (f.skipped) continue
    let lastHunk = 0
    for (const r of f.rows) {
      if (r.kind === 'fold') { out.push('    … 변경 없는 ' + r.count + '줄'); continue }
      if (r.hunk && r.hunk !== lastHunk) { n++; lastHunk = r.hunk; out.push('@@ 변경 ' + n) }
      if (r.kind === 'eq') { out.push('  ' + pad(r.right.num) + ' ' + r.right.text); continue }
      if (r.left) out.push('- ' + pad(r.left.num) + ' ' + r.left.text)
      if (r.right) out.push('+ ' + pad(r.right.num) + ' ' + r.right.text)
    }
  }
  return { text: clip(out.join('\n'), MAX_DIFF_CHARS), hunkCount: n }
}

const pad = (n) => String(n).padStart(4, ' ')

// turn: 턴 기록(turn.json), files: 화면용 파일, learning: { known: [용어], stuck: [섹션 제목] }
export function turnContext(turn, files, learning) {
  const d = diffText(files)
  const lines = [
    '## 해설할 턴',
    '사용자 요청: ' + turn.request,
    '',
    ...(turn.answer ? ['Claude의 최종 답변:', clip(turn.answer, MAX_ANSWER_CHARS)] : []),
    '',
    '## 이 턴의 diff',
    '형식: "- 줄번호"는 변경 전 파일의 줄, "+ 줄번호"는 변경 후 파일의 줄, 앞이 공백인 줄은 같은 줄(변경 후 줄번호).',
    '"@@ 변경 N"은 변경 블록 번호.',
    d.text,
  ]
  if (turn.context) {
    lines.push('', '## 이 작업을 하던 대화 (발췌, 오래된 것부터)', '이 대화에 근거해 "왜"를 설명해. 대화에 없는 이유는 (추정)으로 표시해.', clip(turn.context, 16000))
  }
  if (learning && learning.known && learning.known.length) {
    lines.push('', '## 사용자가 이미 아는 용어 (짧게만 언급하고 다시 정의하지 말 것)', learning.known.join(', '))
  }
  if (learning && learning.stuck && learning.stuck.length) {
    lines.push('', '## 사용자가 전에 막혔던 부분 (이번에도 나오면 처음부터 풀어서 설명할 것)', learning.stuck.join(', '))
  }
  return { text: lines.join('\n'), hunkCount: d.hunkCount }
}

// 해설을 쓸 언어 (설정 language): 'ko' 또는 'en'
let language = 'ko'
export function setLanguage(lang) {
  language = lang === 'en' ? 'en' : 'ko'
}

function rules() {
  return [
    language === 'en'
      ? '- Write every text value in English, in short plain sentences. One idea per sentence.'
      : '- 한국어로, 짧고 쉬운 문장으로 쓴다. 한 문장에 하나의 생각.',
    '- 이 대화와 위 diff에 근거해서 쓴다. 대화에 근거가 없는 이유는 문장 끝에 ' + (language === 'en' ? '"(guess)"' : '"(추정)"') + '을 붙인다.',
    '- 정의하지 않은 전문 용어를 쓰지 않는다. 꼭 필요하면 쉬운 말로 풀어서 함께 쓴다.',
    '- 코드는 짧은 식별자(함수 이름 등)만 인용한다. 코드 블록을 쓰지 않는다.',
    '- 답은 JSON 객체 하나뿐이다. 앞뒤에 설명이나 ``` 를 붙이지 않는다.',
  ]
}

// 섹션별 지시와 출력 형식
const SECTION_SPECS = {
  summary: (n) => [
    '이 턴의 변경을 요약해.',
    '형식:',
    '{ "tldr": "무엇이 바뀌었는지 한 문장",',
    '  "files": [{ "path": "diff의 파일 경로 그대로", "desc": "이 파일에서 바뀐 것 한 줄" }],',
    '  "why": ["왜 이렇게 바꿨는지, 사용자의 요청과 연결해서. 1~3문장"],',
    '  "how": [{ "label": "핵심 동작이나 함수 이름", "detail": "어떻게 동작하는지 한두 문장" }],',
    '  "review": [{ "kind": "warn" | "question", "text": "사용자가 확인해야 할 점" }],',
    '  "hunkNotes": ["변경 1 한 줄 설명", "변경 2 한 줄 설명", ...] }',
    'files는 diff의 모든 파일을, hunkNotes는 정확히 ' + n + '개를 변경 번호 순서대로 쓴다. 각 hunkNote는 60자 이내.',
    'how는 2~4개, review는 0~3개.',
  ],
  background: () => [
    '이 변경이 왜 필요했는지 배경을 설명해. 바꾸기 전에 어떤 문제가 있었고 왜 그랬는지.',
    '형식:',
    '{ "problem": "사용자 입장에서 무슨 문제가 있었나",',
    '  "cause": "코드에서 왜 그런 일이 일어났나",',
    '  "causeAt": "원인이 있던 위치. 변경 전 파일 기준 \\"경로:시작-끝\\", 대화에서만 알 수 있으면 \\"대화\\"",',
    '  "goal": "이번 변경의 목표",',
    '  "outOfScope": ["이번에 일부러 다루지 않은 것"] }',
  ],
  walk: () => [
    '변경된 코드를 실행 순서나 이해하기 쉬운 순서로 2~6단계로 나눠 따라가며 설명해.',
    '각 단계의 at은 코드 위치다. mod가 그 줄을 파일에서 직접 읽어 보여 준다.',
    '추가·수정된 코드는 변경 후 줄번호로 "경로:시작-끝", 삭제된 코드는 변경 전 줄번호로 "경로:시작-끝 (삭제)". 한 단계는 15줄 이내.',
    '형식:',
    '{ "steps": [{ "title": "단계 제목 (짧게)", "at": "경로:시작-끝",',
    '  "does": "이 코드가 하는 일", "why": "왜 이렇게 했나", "alt": "검토할 만한 다른 방법과 쓰지 않은 이유. 없으면 빈 문자열" }] }',
  ],
  flow: () => [
    '바뀐 로직의 실행 흐름을 위에서 아래로 이어지는 단계로 정리해. 4~8개.',
    'kind: "step" 일반 단계, "cond" 조건(분기), "changed" 이번에 추가·변경된 단계나 조건, "ok" 정상 종료, "err" 에러 종료.',
    '조건의 한쪽 결과가 옆으로 빠지면 branch로, 다음 단계로 이어지는 쪽의 라벨은 next로 쓴다.',
    'title은 24자 이내, desc는 한 줄.',
    '형식:',
    '{ "nodes": [{ "title": "...", "desc": "...", "kind": "step", "tag": "이번에 추가 같은 표시(선택)", "next": "다음 단계로 가는 조건 라벨(선택)",',
    '  "branch": { "label": "예", "title": "...", "desc": "...", "kind": "ok" } }] }',
  ],
  seq: () => [
    '바뀐 동작에서 누가 누구를 어떤 순서로 부르는지 시퀀스로 정리해.',
    'lanes는 2~5개, 이름은 코드 식별자처럼 짧게(12자 이내). msgs는 4~12개.',
    'kind: "normal", "changed" 이번에 추가된 호출, "fail" 실패 응답, "ok" 성공 응답. 자기 자신 호출은 from과 to가 같다.',
    'label은 16자 이내, note는 그 호출의 의미를 짧게(선택).',
    '형식:',
    '{ "lanes": [{ "name": "LoginPage" }], "msgs": [{ "from": 0, "to": 1, "label": "submit(u, p)", "kind": "normal", "note": "..." }] }',
  ],
  ba: () => [
    '코드가 아니라 동작이 어떻게 달라졌는지 상황별로 비교해. 2~5개.',
    'tone: "better" 좋아짐, "same" 그대로, "worse" 나빠지거나 비용이 생김.',
    '형식:',
    '{ "rows": [{ "when": "상황", "before": "이전 동작", "after": "이후 동작", "tone": "better" }] }',
  ],
  impact: () => [
    '이 변경이 영향을 주는 곳을 정리해: 바뀐 함수를 부르는 곳, 새로 생긴 것, 확인할 테스트.',
    '이 대화에서 실제로 본 위치만 경로로 쓰고, 보지 못한 것은 desc 끝에 (추정)을 붙인다.',
    '형식:',
    '{ "groups": [{ "title": "묶음 제목", "items": [{ "path": "경로:줄 또는 이름", "desc": "어떤 영향", "flag": "꼭 확인할 점(선택)" }] }] }',
  ],
  terms: () => [
    '이 변경을 이해하는 데 필요한 개념 중 사용자가 모를 수 있는 것을 1~5개 골라 정의해. 이미 아는 용어는 빼.',
    'def는 한두 문장, 그 개념이 무엇인지. 이 변경에서 어떻게 쓰였는지도 짧게.',
    '형식:',
    '{ "terms": [{ "id": "영문 소문자-하이픈", "term": "용어", "en": "영어 표현", "def": "정의" }] }',
  ],
  quiz: () => [
    '사용자가 이 변경을 실제로 이해했는지 확인하는 퀴즈 3문제를 만들어. 기억에서 떠올려야 풀리는 문제로.',
    '바뀐 코드의 동작(어떤 입력에서 어떻게 되나)과 설계 이유만 묻는다. 작업 과정(권한, 도구 사용, 테스트를 했는지 등)은 묻지 않는다.',
    '보기는 정확히 3개, 첫 번째가 정답이다(순서는 mod가 섞는다). 세 보기의 단어 수와 길이를 비슷하게 맞추고, 서식이나 길이로 정답이 드러나지 않게 한다.',
    'explain은 왜 그게 정답인지 한두 문장.',
    '형식:',
    '{ "questions": [{ "q": "질문", "options": ["정답", "오답", "오답"], "explain": "..." }] }',
  ],
}

// 프롬프트는 블록 두 개다: 앞은 같은 턴의 모든 요청(섹션, Wait what, 질문)이 똑같이 여는 글이라
// 프롬프트 캐시에 올리고(5분 안의 다음 요청은 약 1/10 값으로 읽는다), 뒤에 이번 요청만의 지시를 붙인다
function shared(ctx) {
  return [
    '[change-explainer 요청: 코드를 고치거나 도구를 쓰지 말고, 요청한 JSON 하나만 답해줘]',
    '사용자가 Claude가 한 변경을 이해하려고 한다. 아래는 그 턴이다.',
    '',
    ctx.text,
    '',
    '## 규칙 (모든 답에)',
    ...rules(),
    '',
  ].join('\n')
}

const blocks = (ctx, lines) => [{ text: shared(ctx), cache: true }, { text: lines.join('\n') }]

// 블록 → 글 하나 (fork는 글만 받는다)
export const joinBlocks = (prompt) => (typeof prompt === 'string' ? prompt : prompt.map((b) => b.text).join(''))

export function sectionPrompt(id, ctx) {
  return blocks(ctx, ['## 지금 만들 것: ' + SECTIONS.find((s) => s.id === id).title, ...SECTION_SPECS[id](ctx.hunkCount)])
}

// Wait, what?: 같은 내용을 더 쉽게, 앞의 설명들과 다른 방식으로
export function easyPrompt(id, ctx, sectionJson, thread) {
  const tried = thread.filter((x) => x.type === 'easy' && x.text).map((x, i) => '설명 ' + (i + 1) + ': ' + x.text)
  const asked = thread.filter((x) => x.type === 'q' && x.a).map((x) => 'Q: ' + x.q + '\nA: ' + x.a)
  return blocks(ctx, [
    '## 지금 할 것: 다시 설명',
    '사용자가 아래 해설 섹션을 읽고 "잠깐, 무슨 말이야?"라고 했다. 이해하지 못했다.',
    '짧게 줄이지 말고, 사용자가 놓쳤을 전제를 채워서 더 쉬운 말로 다시 설명해.',
    tried.length
      ? '아래 설명들은 이미 했지만 통하지 않았다. 같은 비유나 같은 순서를 반복하지 말고, 아직 안 쓴 방식(비유, 전제를 하나씩 짚기, 숫자 예, 실행 순서 따라가기 중)으로 설명해.'
      : '일상의 비유로 시작해도 좋다.',
    '',
    '## 사용자가 막힌 섹션: ' + SECTIONS.find((s) => s.id === id).title,
    JSON.stringify(sectionJson),
    ...(tried.length ? ['', '## 이미 한 설명', ...tried] : []),
    ...(asked.length ? ['', '## 이 섹션에서 사용자가 한 질문과 답', ...asked] : []),
    '',
    '형식: { "text": "다시 설명한 글. 3~6문장" }',
  ])
}

// 질문: sectionId가 있으면 그 섹션과 대화 상자를 맥락으로, 없으면 턴 전체에 대해
export function answerPrompt(question, ctx, section) {
  return blocks(ctx, [
    '## 지금 할 것: 질문에 답하기',
    '사용자가 Claude가 한 변경에 대해 질문했다. 이 대화와 diff에 근거해서 답해.',
    ...(section
      ? ['', '## 질문이 나온 섹션: ' + SECTIONS.find((s) => s.id === section.id).title, JSON.stringify(section.json),
        ...(section.thread.length ? ['', '## 이 섹션에서 이어진 대화', ...section.thread.map((x) => (x.type === 'easy' ? '쉬운 설명: ' + x.text : 'Q: ' + x.q + '\nA: ' + x.a))] : [])]
      : []),
    '',
    '## 질문',
    question,
    '',
    '형식: { "text": "답. 필요한 만큼, 보통 2~6문장" }',
  ])
}

// 형식이 틀렸을 때 한 번 더 요청하는 말
export function retryPrompt(error) {
  return '[change-explainer 요청] 방금 답이 요청한 JSON 형식이 아니었다(' + error + '). 같은 내용을 JSON 객체 하나로만 다시 답해줘. 앞뒤 설명이나 ``` 없이.'
}

// ── 응답 해석과 검증 ─────────────────────────────────────────

// 응답 글에서 JSON 객체 하나를 꺼낸다 (``` 로 감싸거나 앞뒤에 말을 붙여도)
export function parseReply(text) {
  if (!text) return { ok: false, error: '빈 응답' }
  const s = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, error: 'JSON 객체가 없음' }
  try {
    return { ok: true, value: JSON.parse(s.slice(start, end + 1)) }
  } catch (err) {
    return { ok: false, error: 'JSON 해석 실패' }
  }
}

const str = (v, max) => (typeof v === 'string' ? (max && v.length > max ? v.slice(0, max - 1) + '…' : v) : '')
const arr = (v) => (Array.isArray(v) ? v : [])
const oneOf = (v, list, d) => (list.includes(v) ? v : d)

// 섹션별로 필요한 필드를 확인하고, 모자란 곳은 안전한 기본값으로 채운다. 핵심 필드가 없으면 실패
const VALIDATORS = {
  summary: (v, ctx) => {
    if (!str(v.tldr)) return 'tldr 없음'
    const notes = arr(v.hunkNotes).map((x) => str(x, 80))
    while (notes.length < ctx.hunkCount) notes.push('')
    return {
      tldr: str(v.tldr),
      files: arr(v.files).map((f) => ({ path: str(f && f.path), desc: str(f && f.desc) })).filter((f) => f.path),
      why: arr(v.why).map((x) => str(x)).filter(Boolean),
      how: arr(v.how).map((h) => ({ label: str(h && h.label), detail: str(h && h.detail) })).filter((h) => h.label || h.detail),
      review: arr(v.review).map((r) => ({ kind: oneOf(r && r.kind, ['warn', 'question'], 'question'), text: str(r && r.text) })).filter((r) => r.text),
      hunkNotes: notes.slice(0, ctx.hunkCount),
    }
  },
  background: (v) => {
    if (!str(v.problem) && !str(v.cause)) return 'problem, cause 없음'
    return { problem: str(v.problem), cause: str(v.cause), causeAt: str(v.causeAt), goal: str(v.goal), outOfScope: arr(v.outOfScope).map((x) => str(x)).filter(Boolean) }
  },
  walk: (v) => {
    const steps = arr(v.steps).map((s) => ({ title: str(s && s.title, 60), at: str(s && s.at), does: str(s && s.does), why: str(s && s.why), alt: str(s && s.alt) })).filter((s) => s.title && s.does)
    return steps.length ? { steps: steps.slice(0, 8) } : 'steps 없음'
  },
  flow: (v) => {
    const kinds = ['step', 'cond', 'changed', 'ok', 'err']
    const nodes = arr(v.nodes).map((n) => ({
      title: str(n && n.title, 40),
      desc: str(n && n.desc),
      kind: oneOf(n && n.kind, kinds, 'step'),
      tag: str(n && n.tag, 40),
      next: str(n && n.next, 20),
      branch: n && n.branch && str(n.branch.title)
        ? { label: str(n.branch.label, 12), title: str(n.branch.title, 40), desc: str(n.branch.desc), kind: oneOf(n.branch.kind, kinds, 'step') }
        : null,
    })).filter((n) => n.title)
    return nodes.length >= 2 ? { nodes: nodes.slice(0, 12) } : '단계가 2개 미만'
  },
  seq: (v) => {
    const lanes = arr(v.lanes).map((l) => ({ name: str(l && l.name, 16) })).filter((l) => l.name).slice(0, 6)
    if (lanes.length < 2) return '참여자가 2개 미만'
    const ok = (i) => Number.isInteger(i) && i >= 0 && i < lanes.length
    const msgs = arr(v.msgs)
      .filter((m) => m && ok(m.from) && ok(m.to))
      .map((m) => ({ from: m.from, to: m.to, label: str(m.label, 24), kind: oneOf(m.kind, ['normal', 'changed', 'fail', 'ok'], 'normal'), note: str(m.note, 60) }))
    return msgs.length ? { lanes, msgs: msgs.slice(0, 16) } : '호출이 없음'
  },
  ba: (v) => {
    const rows = arr(v.rows).map((r) => ({ when: str(r && r.when), before: str(r && r.before), after: str(r && r.after), tone: oneOf(r && r.tone, ['better', 'same', 'worse'], 'same') })).filter((r) => r.when)
    return rows.length ? { rows } : '비교가 없음'
  },
  impact: (v) => {
    const groups = arr(v.groups).map((g) => ({
      title: str(g && g.title),
      items: arr(g && g.items).map((i) => ({ path: str(i && i.path), desc: str(i && i.desc), flag: str(i && i.flag) })).filter((i) => i.path || i.desc),
    })).filter((g) => g.title && g.items.length)
    return groups.length ? { groups } : '영향 범위가 없음'
  },
  terms: (v) => {
    const terms = arr(v.terms).map((t, i) => ({ id: str(t && t.id, 40) || 'term-' + i, term: str(t && t.term, 40), en: str(t && t.en, 40), def: str(t && t.def) })).filter((t) => t.term && t.def)
    return { terms }
  },
  quiz: (v) => {
    const questions = arr(v.questions)
      .map((q) => ({ q: str(q && q.q), options: arr(q && q.options).map((o) => str(o, 80)).filter(Boolean), explain: str(q && q.explain) }))
      .filter((q) => q.q && q.options.length === 3)
    return questions.length ? { questions: questions.slice(0, 5) } : '보기가 3개인 문제가 없음'
  },
  text: (v) => (str(v.text) ? { text: str(v.text) } : 'text 없음'),
}

// 응답 글 → { ok: true, value } 또는 { ok: false, error }
export function validate(kind, text, ctx) {
  const parsed = parseReply(text)
  if (!parsed.ok) return parsed
  if (!parsed.value || typeof parsed.value !== 'object') return { ok: false, error: 'JSON 객체가 아님' }
  const result = VALIDATORS[kind](parsed.value, ctx || { hunkCount: 0 })
  return typeof result === 'string' ? { ok: false, error: result } : { ok: true, value: result }
}

// ── 코드 위치 ────────────────────────────────────────────────

// "경로:시작-끝" 또는 "경로:줄 (삭제)" → { path, start, end, deleted }
export function parseAt(at) {
  const m = /^\s*(.+?):(\d+)(?:\s*[-–~]\s*(\d+))?\s*(\(삭제\))?\s*$/.exec(at || '')
  if (!m) return null
  const start = Number(m[2])
  const end = Math.max(start, Number(m[3] || m[2]))
  return { path: m[1].trim(), start, end: Math.min(end, start + 14), deleted: !!m[4] }
}
