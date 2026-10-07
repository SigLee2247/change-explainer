// 흐름도(테두리 카드)와 시퀀스(레인 다이어그램). 모델이 준 구조를 mod가 칸을 계산해 그린다.

import { C, rich, shift } from './common.js'

const KIND_COLOR = { step: C.faint, cond: C.blue, changed: C.accent, ok: C.green, err: C.red }

// ── 흐름도 ───────────────────────────────────────────────────
// data: { nodes: [{ title, desc, kind, tag, next, branch }] }

function card(el, item, n, width) {
  const color = KIND_COLOR[item.kind] || C.faint
  const titleColor = item.kind === 'err' ? C.red : item.kind === 'ok' ? C.green : C.title
  const rows = [rich(el, [n ? [n + '  ', C.accent, true] : '', [item.title, titleColor, true]])]
  if (item.desc) rows.push(el.Text({ color: C.dim, children: [item.desc] }))
  if (item.tag) rows.push(el.Text({ color: C.accent, children: [item.tag] }))
  const props = { flexDirection: 'column', borderStyle: 'round', borderColor: color, paddingX: 1, children: rows }
  if (width) props.width = width
  return el.Box(props)
}

export function flowView(el, data, cols) {
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
  data.nodes.forEach((item, i) => {
    const main = card(el, item, i + 1, cardW)
    if (item.branch) {
      const arrow = el.Text({ color: KIND_COLOR[item.branch.kind] || C.faint, children: [' ─ ' + (item.branch.label || '') + ' ─> '] })
      const side = card(el, item.branch, 0)
      out.push(
        wide
          ? el.Box({ flexDirection: 'row', alignItems: 'center', children: [main, arrow, side] })
          : el.Box({
              flexDirection: 'column',
              children: [main, el.Box({ flexDirection: 'row', alignItems: 'center', paddingLeft: 3, children: [el.Text({ color: C.faint, children: ['└'] }), arrow, side] })],
            }),
      )
    } else {
      out.push(main)
    }
    if (i < data.nodes.length - 1) {
      out.push(el.Box({ paddingLeft: Math.floor(cardW / 2), children: [rich(el, [['│', C.faint], item.next ? ['  ' + item.next, C.dim] : ''])] }))
    }
  })
  return el.Box({ flexDirection: 'column', children: out })
}

// ── 시퀀스 ───────────────────────────────────────────────────
// data: { lanes: [{ name }], msgs: [{ from, to, label, kind, note }] }
// 호출마다 위 줄에 번호와 라벨, 아래 줄에 화살표, 그 아래 흐린 설명.
// 라벨과 설명은 줄 끝에만 둔다(한글 폭 때문에). 왼쪽 번호 칸은 고정, 나머지는 left만큼 가로로 민다.

const GUTTER = 3
const LANE_COLORS = [C.dim, C.fg, C.accent, C.blue, C.purple, C.green]
const MSG_COLOR = { normal: C.fg, changed: C.accent, fail: C.red, ok: C.green }

function widthOf(s) {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xff60) ? 2 : 1
  }
  return w
}

function geometry(data, cols) {
  const laneW = Math.max(12, Math.min(20, Math.floor((cols - GUTTER) / data.lanes.length)))
  const center = (i) => i * laneW + Math.floor(laneW / 2)
  const width = laneW * data.lanes.length
  let longest = width
  data.msgs.forEach((m) => {
    const start = Math.min(center(m.from), center(m.to)) + 2
    longest = Math.max(longest, start + widthOf(m.label), start + widthOf(m.note || ''))
  })
  return { laneW, center, width, longest }
}

export function seqMaxLeft(data, cols) {
  return Math.max(0, geometry(data, cols).longest - (cols - GUTTER))
}

export function seqView(el, data, cols, left) {
  const { laneW, center, width } = geometry(data, cols)
  const lifeline = () => {
    const a = new Array(width).fill(' ')
    data.lanes.forEach((_, i) => { a[center(i)] = '│' })
    return a
  }
  const row = (gutter, parts) => rich(el, [[gutter, C.accent, true], ...shift(parts, left)], { wrap: 'truncate-end' })
  const paint = (cells, start, end, color) => [
    [cells.slice(0, start).join(''), C.faint],
    [cells.slice(start, end).join(''), color],
    [cells.slice(end).join(''), C.faint],
  ]
  const textAt = (col, parts) => [[lifeline().slice(0, col).join(''), C.faint], ...parts]

  // 참여자 머리 상자 세 줄. 아래 테두리의 ┬가 생명선과 같은 칸에 온다
  const inner = laneW - 3
  const colorOf = (i) => LANE_COLORS[i % LANE_COLORS.length]
  const fit = (name) => (name.length > inner ? name.slice(0, inner - 1) + '…' : name)
  const middle = (name) => {
    const t = fit(name)
    const padTotal = inner - t.length
    return ' '.repeat(Math.floor(padTotal / 2)) + t + ' '.repeat(padTotal - Math.floor(padTotal / 2))
  }
  const boxLine = (fn) => data.lanes.map((l, i) => [fn(l).padEnd(laneW, ' '), colorOf(i), true])
  const rows = [
    row('   ', boxLine(() => '╭' + '─'.repeat(inner) + '╮')),
    row('   ', boxLine((l) => '│' + middle(l.name) + '│')),
    row('   ', boxLine(() => '╰' + '─'.repeat(Math.floor(laneW / 2) - 1) + '┬' + '─'.repeat(inner - Math.floor(laneW / 2)) + '╯')),
  ]
  data.msgs.forEach((m, i) => {
    const color = MSG_COLOR[m.kind] || C.fg
    const l = Math.min(center(m.from), center(m.to))
    const r = Math.max(center(m.from), center(m.to))
    rows.push(row(String(i + 1).padStart(2, ' ') + ' ', textAt(l + 2, [[m.label, color, true]])))
    const a = lifeline()
    if (m.from === m.to) {
      const c = center(m.from)
      const b = lifeline()
      a[c] = '├'; a[c + 1] = '─'; a[c + 2] = '╮'
      b[c] = '│'; b[c + 1] = '<'; b[c + 2] = '╯'
      rows.push(row('   ', paint(a, c, c + 3, color)))
      rows.push(row('   ', paint(b, c + 1, c + 3, color)))
    } else {
      for (let k = l + 1; k < r; k++) a[k] = '─'
      if (m.from < m.to) a[r - 1] = '>'
      else a[l + 1] = '<'
      rows.push(row('   ', paint(a, l + 1, r, color)))
    }
    if (m.note) rows.push(row('   ', textAt(l + 2, [[m.note, C.dim]])))
  })
  rows.push(row('   ', [[lifeline().join(''), C.faint]]))
  return el.Box({ flexDirection: 'column', children: rows })
}
