// diff 창 (인텔리제이식). 위쪽 안내·버튼과 아래쪽 위치 설명은 고정하고,
// 가운데 코드 영역만 위아래(top)·좌우(left)로 민다.
//
// files: [{ path, isNew, skipped, added, removed, agents, rows, hunks }]  (rows는 diff.js의 buildRows)

import { C, D, btn, buttonRow, linkRow, link, rich, rule, shift } from './common.js'

// 창이 이 너비 이상이면 좌우 비교, 좁으면 통합 보기
export const SIDE_BY_SIDE_COLS = 96

// 모든 파일의 변경 블록을 순서대로: [{ f: 파일 위치, h: 블록 번호 }]
export function hunkList(files) {
  const out = []
  files.forEach((file, f) => {
    for (let h = 1; h <= (file.hunks || 0); h++) out.push({ f, h })
  })
  return out
}

// 바뀐 구간 [[시작, 끝)]으로 한 줄을 색 조각으로 나눈다
function segments(text, ranges, hi, fg) {
  if (!text) return [[' ', fg]]
  if (!hi || !ranges || !ranges.length) return [[text, fg]]
  const out = []
  let at = 0
  for (const [s, e] of ranges) {
    if (s > at) out.push([text.slice(at, s), fg])
    out.push([text.slice(s, e), fg, false, hi])
    at = e
  }
  if (at < text.length) out.push([text.slice(at), fg])
  return out
}

function codeLine(el, mark, num, parts, left) {
  return rich(el, [[mark, C.accent, true], [String(num).padStart(4, ' ') + ' ', C.faint], ...shift(parts, left)], { wrap: 'truncate-end' })
}

function filled(el, width, bg, child) {
  const props = { width, flexShrink: 0, children: [child] }
  if (bg) props.backgroundColor = bg
  return el.Box(props)
}

const sideBg = (row, side) => {
  const has = row[side] !== null
  if (row.kind === 'eq') return null
  if (row.kind === 'add') return side === 'left' ? D.fill : D.add
  if (row.kind === 'del') return side === 'left' ? D.del : D.fill
  return has ? D.mod : D.modFill
}

// 보고 있는 파일을 화면 줄 목록으로 만든다 (그리기 전 데이터)
export function diffModel(cols, files, pos) {
  const hunks = hunkList(files)
  const cur = hunks[pos] || { f: 0, h: 0 }
  const file = files[cur.f]
  const side = cols >= SIDE_BY_SIDE_COLS
  const lines = []
  let hunkStart = -1
  let longest = 0
  const mark = (row) => (row.hunk && row.hunk === cur.h ? '>' : ' ')
  const startHere = (row) => { if (hunkStart < 0 && row.hunk === cur.h) hunkStart = lines.length }

  const rows = (file && file.rows) || []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.kind === 'fold') { lines.push({ fold: row.count }); continue }
    longest = Math.max(longest, ((row.left && row.left.text) || '').length + 2, ((row.right && row.right.text) || '').length + 2)
    if (side) {
      startHere(row)
      const hiL = row.kind === 'mod' ? D.modHi : null
      const hiR = row.kind === 'mod' ? D.modHi : null
      lines.push({
        mark: mark(row),
        l: { num: row.left ? row.left.num : '', parts: segments(row.left && row.left.text, row.left && row.left.hi, hiL, row.kind === 'del' ? C.dim : C.fg), bg: sideBg(row, 'left') },
        r: { num: row.right ? row.right.num : '', parts: segments(row.right && row.right.text, row.right && row.right.hi, hiR, C.fg), bg: sideBg(row, 'right') },
      })
      continue
    }
    // 통합 보기: 한 블록의 지운 줄(−)을 모두 보여 준 뒤 추가한 줄(+)
    if (row.kind === 'eq') {
      lines.push({ mark: ' ', num: row.right.num, parts: [['  ' + row.right.text, C.dim]], bg: null })
      continue
    }
    const block = []
    while (i < rows.length && rows[i].hunk === row.hunk && rows[i].kind !== 'fold') block.push(rows[i++])
    i--
    startHere(row)
    for (const r of block) {
      if (r.left) lines.push({ mark: mark(r), num: r.left.num, parts: [['− ', C.red], ...segments(r.left.text, r.left.hi, D.remHi, C.fg)], bg: D.rem })
    }
    for (const r of block) {
      if (r.right) lines.push({ mark: mark(r), num: r.right.num, parts: [['+ ', C.green], ...segments(r.right.text, r.right.hi, D.addHi, C.fg)], bg: D.add })
    }
  }
  const codeCols = side ? Math.floor((cols - 1) / 2) - 6 : cols - 6
  return { hunks, cur, file, side, lines, hunkStart: Math.max(0, hunkStart), maxLeft: Math.max(0, longest - codeCols) }
}

// 코드 영역에 보일 줄 수: 창 높이에서 고정된 위아래 영역을 뺀 만큼
export function diffCodeRows(bodyRows) {
  return Math.max(6, bodyRows - 13)
}

// 변경 블록의 줄 범위를 "14–17줄"처럼
function hunkRange(file, h) {
  const nums = (file.rows || []).filter((r) => r.hunk === h).map((r) => (r.right || r.left).num)
  if (!nums.length) return ''
  const a = Math.min(...nums)
  const b = Math.max(...nums)
  return a === b ? a + '줄' : a + '–' + b + '줄'
}

// st = { turn, files, pos, top, left }. on = { prev, next, nextFile, pickFile, up, down, leftward, rightward, back? }
export function diffView(el, cols, bodyRows, st, on) {
  const m = diffModel(cols, st.files, st.pos)
  const codeRows = diffCodeRows(bodyRows)
  const top = Math.min(st.top, Math.max(0, m.lines.length - codeRows))
  const left = Math.min(st.left, m.maxLeft)
  const half = Math.floor((cols - 1) / 2)
  const file = m.file

  const header = rich(el, [
    ['diff  ', C.accent, true],
    ['#' + st.turn.seq + '  ', C.accent],
    [st.turn.title, C.title, true],
    ['   파일 ' + st.files.length + '개  ', C.dim],
    ['+' + st.turn.added, C.green], ' ', ['−' + st.turn.removed, C.red],
  ], { wrap: 'truncate-end' })

  // 파일 탭: 대괄호 없는 링크. 보고 있는 파일은 밝게
  const tabs = linkRow(el, st.files.map((f, i) =>
    link(el, { key: 'tab-' + i, label: f.path.split('/').pop(), dim: i !== m.cur.f, onPress: () => on.pickFile(i) }),
  ))

  const nav = buttonRow(el, [
    btn(el, { key: 'prev', hotkey: 'p', label: '이전 변경', dim: st.pos === 0, onPress: on.prev }),
    btn(el, { key: 'next', hotkey: 'n', label: '다음 변경', primary: true, dim: st.pos >= m.hunks.length - 1, onPress: on.next }),
    btn(el, { key: 'next-file', hotkey: 'f', label: '다음 파일', dim: st.files.length < 2, onPress: on.nextFile }),
    ...(on.back ? [btn(el, { key: 'back', hotkey: 'b', label: '해설로', onPress: on.back })] : []),
    el.Text({ color: C.accent, children: [m.hunks.length ? ' 변경 ' + (st.pos + 1) + '/' + m.hunks.length : ' 변경 없음'] }),
  ])

  const scroll = buttonRow(el, [
    btn(el, { key: 'up', hotkey: 'k', label: '위', dim: top === 0, onPress: on.up }),
    btn(el, { key: 'down', hotkey: 'j', label: '아래', dim: top + codeRows >= m.lines.length, onPress: on.down }),
    btn(el, { key: 'left', hotkey: 'h', label: '왼쪽', dim: left === 0, onPress: on.leftward }),
    btn(el, { key: 'right', hotkey: 'l', label: '오른쪽', dim: left >= m.maxLeft, onPress: on.rightward }),
    el.Text({
      color: C.faint,
      children: [' 줄 ' + (m.lines.length ? top + 1 : 0) + '–' + Math.min(top + codeRows, m.lines.length) + ' / ' + m.lines.length + (left ? '  ·  가로 +' + left : '') + '  ·  휠로도 스크롤'],
    }),
  ])

  const agents = file && file.agents && file.agents.length ? '  서브에이전트 · ' + file.agents.map((a) => a.type || a.agentId).join(', ') : ''
  const meta = !file ? el.Text({ color: C.dim, children: ['바뀐 파일이 없습니다.'] }) : rich(el, [
    [file.path, C.blue],
    '  ',
    file.skipped ? ['내용 생략', C.dim] : file.isNew ? ['새 파일', C.green] : ['수정', C.blue],
    '  ',
    ['+' + file.added, C.green], ' ', ['−' + file.removed, C.red],
    agents ? [agents, C.purple] : '',
    ['  ·  ' + (m.side ? '좌우 보기' : '통합 보기 (창이 좁음)'), C.faint],
  ], { wrap: 'truncate-end' })

  const code = []
  if (file && file.skipped) {
    const why = { 'too-large': '4MB가 넘는 파일', binary: '바이너리 파일', unreadable: '읽을 수 없는 파일' }[file.skipped] || file.skipped
    code.push(el.Text({ color: C.dim, children: ['  ' + why + '이라 내용을 비교하지 않았습니다.'] }))
  } else {
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
        code.push(el.Box({ justifyContent: 'center', children: [el.Text({ color: C.faint, children: ['··· 변경 없는 ' + ln.fold + '줄 ···'] })] }))
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
  }

  // 아래쪽: 지금 보고 있는 변경의 위치. 변경별 한 줄 해설은 해설 생성 단계에서 붙는다
  const where = file && m.hunks.length && !file.skipped
    ? rich(el, [['변경 ' + (st.pos + 1) + '  ', C.accent, true], [file.path + '  ' + hunkRange(file, m.cur.h), C.fg], st.notes && st.notes[st.pos] ? ['  ' + st.notes[st.pos], C.dim] : ''])
    : el.Text({ children: [' '] })

  return el.Box({
    flexDirection: 'column',
    children: [header, tabs, nav, scroll, rule(el, cols), meta, ...code, rule(el, cols), where],
  })
}
