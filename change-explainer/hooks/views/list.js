// 작업 목록 창: 이 세션의 턴과 지난 세션들. 지난 세션은 펼치면 그 세션의 턴을 대화 기록에서 복원한다.
//
// st = {
//   status, progress, error,
//   turns: [{ seq, turnId, title, files, added, removed, understood }],          이 세션 (실시간 기록)
//   sessions: [{ id, title, at, status: 'idle' | 'loading' | 'open', turns }],   지난 세션
//     turns: [{ seq, id, request, files, commits, subjects, fileNames, understood }]  (실제로 바뀐 것이 있는 턴만)
//   usage: { calls, input, output, cacheRead, cacheWrite }                        이 저장소에서 해설에 쓴 토큰
// }

import { C, btn, buttonRow, link, rich, rule } from './common.js'

// 1234 → 1.2k
export const k = (n) => (n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n))

export function usageText(u) {
  if (!u || !u.calls) return '아직 없음'
  return '호출 ' + u.calls + '회 · 입력 ' + k(u.input + u.cacheRead + u.cacheWrite) + ' (캐시 읽기 ' + k(u.cacheRead) + ') · 출력 ' + k(u.output)
}

const mark = (understood) => (understood ? ['✓ 이해함', C.green, true] : ['○ 아직', C.faint])

export function listView(el, cols, st, on) {
  const out = [
    rich(el, [['작업 목록  ', C.accent, true], ['고르면 해설 창이 열립니다. 아직 이해하지 않은 턴은 ○', C.dim]]),
    rich(el, [['해설에 쓴 토큰 (이 저장소 누적)  ', C.faint], [usageText(st.usage), C.dim]], { wrap: 'truncate-end' }),
    el.Box({ marginTop: 1, children: [buttonRow(el, [
      btn(el, { key: 'refresh', hotkey: 'r', label: '다시 찾기', dim: st.status === 'loading', onPress: on.refresh }),
      ...(on.back ? [btn(el, { key: 'back', hotkey: 'b', label: '해설로', onPress: on.back })] : []),
    ])] }),
  ]

  out.push(rule(el, cols), el.Text({ bold: true, color: C.title, children: ['이 세션'] }))
  if (!st.turns.length) out.push(el.Text({ color: C.faint, children: ['  아직 기록된 변경이 없습니다.'] }))
  for (const t of [...st.turns].reverse()) {
    out.push(el.Box({
      flexDirection: 'column',
      children: [
        link(el, { key: 'turn-' + t.turnId, label: '#' + t.seq + '  ' + t.title, onPress: () => on.openTurn(t) }),
        rich(el, ['    ', ['파일 ' + t.files + '  ', C.dim], ['+' + t.added, C.green], ' ', ['−' + t.removed, C.red], ['  ·  ', C.dim], mark(t.understood)], { wrap: 'truncate-end' }),
      ],
    }))
  }

  out.push(rule(el, cols), el.Text({ bold: true, color: C.title, children: ['지난 세션'] }))
  if (!st.sessions.length && st.status !== 'loading') out.push(el.Text({ color: C.faint, children: ['  이 프로젝트의 지난 대화 기록이 없습니다.'] }))
  for (const ses of st.sessions) {
    const isOpen = ses.status === 'open'
    out.push(link(el, { key: 'ses-' + ses.id, label: (isOpen ? '▾ ' : '▸ ') + ses.at + '  ' + ses.title, onPress: () => on.toggleSession(ses) }))
    if (ses.status === 'loading') out.push(el.Text({ color: C.dim, children: ['    대화 기록에서 턴을 복원하는 중…'] }))
    if (!isOpen) continue
    if (!ses.turns.length) {
      out.push(el.Text({ color: C.faint, children: ['    파일을 바꾼 턴이 없습니다.'] }))
      continue
    }
    for (const t of ses.turns) {
      out.push(el.Box({
        flexDirection: 'column',
        paddingLeft: 4,
        children: [
          link(el, { key: 'past-' + t.id, label: '#' + t.seq + '  ' + t.request.split('\n')[0].slice(0, 70), onPress: () => on.openPast(ses, t) }),
          // 짧은 요청("가자")만으로는 무슨 턴인지 모른다: 커밋 메시지와 바꾼 파일을 함께
          ...t.subjects.slice(0, 3).map((subject) => rich(el, ['    ', ['커밋  ', C.faint], [subject, C.fg]], { wrap: 'truncate-end' })),
          ...(t.subjects.length > 3 ? [rich(el, ['    ', ['커밋  외 ' + (t.subjects.length - 3) + '개', C.faint]])] : []),
          ...(t.fileNames.length ? [rich(el, ['    ', ['파일  ', C.faint], [t.fileNames.slice(0, 4).join(', ') + (t.fileNames.length > 4 ? ' 외 ' + (t.fileNames.length - 4) + '개' : ''), C.dim]], { wrap: 'truncate-end' })] : []),
          rich(el, ['    ', mark(t.understood)], { wrap: 'truncate-end' }),
        ],
      }))
    }
  }

  if (st.status === 'loading') out.push(rule(el, cols), el.Text({ color: C.dim, children: [st.progress || '찾는 중…'] }))
  if (st.error) out.push(el.Text({ color: C.red, children: [st.error] }))
  return el.Box({ flexDirection: 'column', children: out })
}
