// 작업 목록 창: 이 세션의 턴과 지난 작업. 한 줄 = 바뀐 턴 하나 (세션으로 묶지 않는다).
//
// st = {
//   status, progress, error,
//   turns: [{ seq, turnId, title, files, added, removed, understood }],     이 세션 (실시간 기록)
//   past: [{ sessionId, id, seq, request, at, subjects, fileNames, files, commits, understood }]
//                                                                            지난 세션들의 바뀐 턴 (최근 것부터, 불러오며 채워진다)
//   usage: { calls, input, output, cacheRead, cacheWrite }                   이 저장소에서 해설에 쓴 토큰
// }

import { C, btn, buttonRow, link, rich, rule } from './common.js'

// 1234 → 1.2k
export const k = (n) => (n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n))

export function usageText(u) {
  if (!u || !u.calls) return '아직 없음'
  return '호출 ' + u.calls + '회 · 입력 ' + k(u.input + u.cacheRead + u.cacheWrite) + ' (캐시 읽기 ' + k(u.cacheRead) + ') · 출력 ' + k(u.output)
}

const mark = (understood) => (understood ? ['✓ 이해함', C.green, true] : ['○ 아직', C.faint])
const sep = ['  ·  ', C.faint]

// 지난 턴의 제목: 커밋 메시지, 없으면 바꾼 파일 이름 ("가자" 같은 요청만으로는 무슨 일인지 모른다)
function pastTitle(t) {
  if (t.subjects.length) return t.subjects[0] + (t.subjects.length > 1 ? '  외 커밋 ' + (t.subjects.length - 1) + '개' : '')
  return t.fileNames.slice(0, 3).join(', ') + (t.fileNames.length > 3 ? ' 외 ' + (t.fileNames.length - 3) + '개' : '')
}

export function listView(el, cols, st, on) {
  const out = [
    rich(el, [['작업 목록  ', C.accent, true], ['고르면 해설 창이 열립니다. 아직 이해하지 않은 턴은 ○', C.dim]]),
    rich(el, [['해설에 쓴 토큰 (이 저장소 누적)  ', C.faint], [usageText(st.usage), C.dim]], { wrap: 'truncate-end' }),
    el.Box({ marginTop: 1, children: [buttonRow(el, [
      btn(el, { key: 'refresh', hotkey: 'r', label: '다시 찾기', dim: st.status === 'loading', onPress: on.refresh }),
      ...(on.back ? [btn(el, { key: 'back', hotkey: 'b', label: '해설로', onPress: on.back })] : []),
    ])] }),
  ]

  // 지난 턴을 여는 중이거나 실패했으면 목록 위에 (긴 목록 아래에 두면 보이지 않는다)
  if (st.opening) out.push(el.Text({ color: C.accent, children: [st.progress] }))
  if (st.error) out.push(el.Text({ color: C.red, children: [st.error] }))
  out.push(rule(el, cols), el.Text({ bold: true, color: C.title, children: ['이 세션'] }))
  if (!st.turns.length) out.push(el.Text({ color: C.faint, children: ['  아직 기록된 변경이 없습니다.'] }))
  for (const t of [...st.turns].reverse()) {
    out.push(el.Box({
      flexDirection: 'column',
      children: [
        link(el, { key: 'turn-' + t.turnId, label: '#' + t.seq + '  ' + t.title, onPress: () => on.openTurn(t) }),
        rich(el, ['  ', ['파일 ' + t.files + '  ', C.dim], ['+' + t.added, C.green], ' ', ['−' + t.removed, C.red], sep, mark(t.understood)], { wrap: 'truncate-end' }),
      ],
    }))
  }

  out.push(rule(el, cols), rich(el, [['지난 작업', C.title, true], st.status === 'loading' ? ['  ' + (st.progress || '찾는 중…'), C.dim] : '']))
  if (!st.past.length && st.status !== 'loading') out.push(el.Text({ color: C.faint, children: ['  이 프로젝트의 지난 대화에서 바뀐 것이 없습니다.'] }))
  for (const t of st.past) {
    out.push(el.Box({
      flexDirection: 'column',
      children: [
        link(el, { key: 'past-' + t.id, label: pastTitle(t), onPress: () => on.openPast(t) }),
        rich(el, ['  ', [t.at, C.dim], sep, [t.request, C.dim], sep, mark(t.understood)], { wrap: 'truncate-end' }),
      ],
    }))
  }

  return el.Box({ flexDirection: 'column', children: out })
}
