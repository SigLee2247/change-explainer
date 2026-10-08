// 작업 목록 창: 이 세션의 턴과, 저장소별 브랜치(워크트리) 작업. 고르면 해설 창이 열린다.
//
// st = {
//   status: 'loading' | 'done', progress,
//   turns: [{ seq, turnId, title, files, added, removed, understood }],
//   repos: [{ key, name, base, baseOptions: [브랜치], items: [{ id, path, branch, ticket, ahead, files, added, removed, date, subject, understood, dirty }] }],
// }

import { C, btn, buttonRow, link, rich, rule } from './common.js'

const day = (iso) => (iso ? iso.slice(5, 10) : '')

function meta(el, x) {
  return rich(el, [
    '    ',
    x.ahead !== undefined ? ['커밋 ' + x.ahead + '  ·  ', C.dim] : '',
    ['파일 ' + x.files + '  ', C.dim],
    ['+' + x.added, C.green], ' ', ['−' + x.removed, C.red],
    x.dirty ? ['  ·  커밋 안 한 변경 있음', C.accent] : '',
    x.date ? ['  ·  ' + day(x.date), C.dim] : '',
    ['  ·  ', C.dim],
    x.understood ? ['✓ 이해함', C.green, true] : ['○ 아직', C.faint],
  ], { wrap: 'truncate-end' })
}

export function listView(el, cols, st, on) {
  const out = [
    rich(el, [['작업 목록  ', C.accent, true], ['고르면 해설 창이 열립니다. 아직 이해하지 않은 작업은 ○', C.dim]]),
    el.Box({ marginTop: 1, children: [buttonRow(el, [
      btn(el, { key: 'refresh', hotkey: 'r', label: '다시 찾기', dim: st.status === 'loading', onPress: on.refresh }),
      ...(on.back ? [btn(el, { key: 'back', hotkey: 'b', label: '해설로', onPress: on.back })] : []),
    ])] }),
  ]

  if (st.turns.length) {
    out.push(rule(el, cols), el.Text({ bold: true, color: C.title, children: ['이 세션의 턴'] }))
    for (const t of [...st.turns].reverse()) {
      out.push(el.Box({
        flexDirection: 'column',
        children: [
          link(el, { key: 'turn-' + t.turnId, label: '#' + t.seq + '  ' + t.title, onPress: () => on.openTurn(t) }),
          meta(el, t),
        ],
      }))
    }
  }

  for (const repo of st.repos) {
    out.push(rule(el, cols))
    out.push(el.Box({
      flexDirection: 'row',
      flexWrap: 'wrap',
      columnGap: 2,
      children: [
        el.Text({ bold: true, color: C.title, children: [repo.name] }),
        el.Select({
          key: 'base-' + repo.key,
          label: '기준',
          value: repo.base,
          options: repo.baseOptions.map((b) => ({ value: b, label: b === 'auto' ? '자동: 브랜치를 만든 시점' : b })),
          onSelect: (value) => on.setBase(repo, value),
        }),
      ],
    }))
    if (!repo.items.length) {
      out.push(el.Text({ color: C.faint, children: ['  진행 중인 브랜치 작업이 없습니다.'] }))
      continue
    }
    for (const x of repo.items) {
      out.push(el.Box({
        flexDirection: 'column',
        children: [
          link(el, { key: 'item-' + x.id, label: (x.ticket ? x.ticket + '  ' : '') + (x.subject || x.branch), onPress: () => on.openBranch(repo, x) }),
          rich(el, ['    ', [x.branch, C.blue], ['  ' + x.path.split('/').pop() + '  ·  기준 ' + x.baseLabel, C.faint]], { wrap: 'truncate-end' }),
          meta(el, x),
        ],
      }))
    }
  }

  if (st.status === 'loading') {
    out.push(rule(el, cols), el.Text({ color: C.dim, children: [st.progress || '작업을 찾는 중…'] }))
  } else if (!st.turns.length && !st.repos.length) {
    out.push(rule(el, cols), el.Text({ color: C.dim, children: ['가져올 작업이 없습니다. 이 프로젝트의 대화 기록에서 다룬 git 저장소를 찾지 못했습니다.'] }))
  }
  if (st.error) out.push(el.Text({ color: C.red, children: [st.error] }))
  return el.Box({ flexDirection: 'column', rowGap: 0, children: out })
}
