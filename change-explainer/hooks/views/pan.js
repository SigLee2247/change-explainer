// 가로로 넓은 내용(시퀀스 다이어그램, diff 코드, 코드 줄)을 담는 창 (Client 모듈).
// 휠과 트랙패드의 가로 움직임은 mod에 전달되지 않는다. 그래서 마우스로 끌거나 ←/→(h/l) 키로 가로 이동한다.
// 클릭하면 이 창이 키를 받으므로, 쓰지 않는 키는 훅 모듈로 넘긴다(post). Esc로 창 단축키로 돌아간다.
//
// props = {
//   id: 'seq' | 'diff' | 'walk-3' …   훅 모듈이 위치를 기억하는 이름
//   left: 가로 위치 (창의 h/l 버튼이 바꾸면 따라간다)
//   rows: [{ segs: [{ fixed: parts, parts, bg }], sep }   segs가 둘이면 반씩 나누고 sep 색의 │로 가른다
//          | { center: [text, color] }]                   가운데 정렬, 밀지 않는다 (접힌 줄 표시 등)
//   hint: 넓을 때 아래에 보일 안내 색
// }
// part = [text, color, bold?, background?]. fixed는 밀지 않는 앞부분(줄 번호 등), parts만 민다.

const STEP = 8

// 한글 등 넓은 글자는 2칸
function wide(c) {
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6)
}

function cells(s) {
  let n = 0
  for (const ch of s) n += wide(ch.codePointAt(0)) ? 2 : 1
  return n
}

const textOf = (parts) => (parts || []).map((p) => p[0]).join('')

// 색 조각들의 앞에서 n글자를 버린다
function shift(parts, n) {
  const out = []
  let rest = n
  for (const p of parts || []) {
    const t = p[0]
    if (rest >= t.length) { rest -= t.length; continue }
    out.push(rest ? [t.slice(rest), p[1], p[2], p[3]] : p)
    rest = 0
  }
  return out
}

// 가장 많이 밀 수 있는 만큼: 가장 긴 줄이 창 끝에 닿을 때까지
function maxLeftOf(rows, columns) {
  let max = 0
  for (const row of rows || []) {
    if (!row.segs) continue
    const width = row.segs.length > 1 ? Math.floor((columns - 1) / row.segs.length) : columns
    for (const seg of row.segs) max = Math.max(max, cells(textOf(seg.parts)) - (width - cells(textOf(seg.fixed))))
  }
  return Math.max(0, max)
}

export default function Pan(props, surface) {
  const { Box, Text } = surface.elements
  const p = props || {}
  let st = surface.state
  if (!st) {
    st = { left: p.left || 0, seen: p.left || 0, max: 0, drag: null }
    const move = (left) => {
      const s = surface.state
      const next = Math.max(0, Math.min(s.max, left))
      if (next === s.left) return
      surface.setState({ ...s, left: next })
      surface.post({ pan: s.id, left: next })
    }
    // 끌기: 누른 곳에서 오른쪽으로 끌면 내용이 따라 오른쪽으로 (왼쪽 내용이 보인다)
    surface.onPointer((e) => {
      const s = surface.state
      if (!s) return
      if (e.type === 'down' && e.button === 'left') surface.setState({ ...s, drag: { x: e.x, left: s.left } })
      else if (e.type === 'move' && s.drag && e.button) move(s.drag.left - (e.x - s.drag.x))
      else if (e.type === 'up' && s.drag) surface.setState({ ...surface.state, drag: null })
    })
    surface.onKey((e) => {
      const s = surface.state
      if (!s) return
      if (e.key === 'right' || e.key === 'l') move(s.left + STEP)
      else if (e.key === 'left' || e.key === 'h') move(s.left - STEP)
      else if (e.key === 'home') move(0)
      else if (e.key === 'end') move(s.max)
      else surface.post({ pan: s.id, key: e.key })
    })
    surface.setState(st)
  }
  // 창의 h/l 버튼으로 위치가 바뀌었으면 따라간다
  st.id = p.id
  if ((p.left || 0) !== st.seen) {
    st.seen = p.left || 0
    st.left = st.seen
  }
  const columns = surface.columns || 80
  st.max = maxLeftOf(p.rows, columns)
  const left = Math.min(st.left, st.max)

  const line = (parts) => Text({
    wrap: 'truncate-end',
    children: parts.map((q) => {
      const t = { color: q[1], bold: !!q[2], children: [q[0]] }
      if (q[3]) t.backgroundColor = q[3]
      return Text(t)
    }),
  })
  const out = (p.rows || []).map((row) => {
    if (row.center) return Box({ justifyContent: 'center', children: [Text({ color: row.center[1], children: [row.center[0]] })] })
    const width = row.segs.length > 1 ? Math.floor((columns - 1) / row.segs.length) : columns
    const boxes = []
    row.segs.forEach((seg, i) => {
      if (i) boxes.push(Text({ color: row.sep, children: ['│'] }))
      const b = { width, flexShrink: 0, children: [line([...(seg.fixed || []), ...shift(seg.parts, left)])] }
      if (seg.bg) b.backgroundColor = seg.bg
      boxes.push(Box(b))
    })
    return Box({ flexDirection: 'row', children: boxes })
  })
  if (st.max > 0 && p.hint) {
    out.push(Text({ color: p.hint, wrap: 'truncate-end', children: ['끌거나 클릭 후 ←/→ 로 가로 이동' + (left ? '  ·  가로 +' + left : '') + '  ·  Esc: 창 단축키로'] }))
  }
  return Box({ flexDirection: 'column', children: out })
}
