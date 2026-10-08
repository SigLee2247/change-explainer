// 화면 공통 도우미. `el`은 $.ui.resolve(e)가 준 요소 생성자 묶음.
//
// 그리기 규칙 (SPEC 4.6)
// - 한 줄에 여러 색이 필요하면 Text 하나 안에 Text를 넣는다. 조각을 Box 가로줄로
//   늘어놓으면 좁은 창에서 조각마다 따로 줄바꿈되어 글자가 뒤섞인다.
// - 다이어그램과 코드 줄은 줄바꿈 대신 잘라낸다(wrap: 'truncate-end').
// - 한글은 2칸을 차지하므로 다이어그램 줄에서 한글은 줄 끝에만 둔다.

const DARK = {
  C: {
    fg: '#d6d6d6', title: '#f0f0f0', dim: '#858b94', faint: '#5c6370', rule: '#2f3238',
    accent: '#e3a857', blue: '#79b8ff', green: '#7fc79a', red: '#f08c7c', purple: '#c3a6ff',
  },
  // diff 배경색 (인텔리제이 다크 테마 계열)
  D: {
    add: '#1f3a28', addHi: '#2f6e41', mod: '#1c2c43', modHi: '#2f5a8f', modFill: '#151d29',
    del: '#2a2c31', fill: '#16171a', rem: '#3a2326', remHi: '#6e2f36',
  },
}

const LIGHT = {
  C: {
    fg: '#1f2328', title: '#0d1117', dim: '#57606a', faint: '#8c959f', rule: '#d0d7de',
    accent: '#9a6700', blue: '#0969da', green: '#1a7f37', red: '#cf222e', purple: '#8250df',
  },
  D: {
    add: '#dafbe1', addHi: '#aceebb', mod: '#ddf4ff', modHi: '#b6e3ff', modFill: '#f1f8ff',
    del: '#eaeef2', fill: '#f6f8fa', rem: '#ffebe9', remHi: '#ffcecb',
  },
}

// 화면이 쓰는 색. applyTheme으로 바꾼다
export const C = { ...DARK.C }
export const D = { ...DARK.D }

// 설정 theme: 'dark'(기본) 또는 'light'
export function applyTheme(name) {
  const t = name === 'light' ? LIGHT : DARK
  Object.assign(C, t.C)
  Object.assign(D, t.D)
}

// 한 줄(또는 한 문단) 안의 색 조각들: parts = ['plain' | [text, color, bold?, background?], ...]
export function rich(el, parts, opts) {
  return el.Text({
    color: C.fg,
    ...(opts || {}),
    children: parts.map((p) => {
      if (typeof p === 'string') return p
      const props = { color: p[1], bold: !!p[2], children: [p[0]] }
      if (p[3]) props.backgroundColor = p[3]
      return el.Text(props)
    }),
  })
}

export function rule(el, cols) {
  return el.Text({ color: C.rule, wrap: 'truncate-end', children: ['─'.repeat(Math.max(10, cols))] })
}

// 버튼: Claude Code 기본 버튼. 터미널에서는 [ d diff ], Desktop 앱에서는 네이티브 버튼.
// 대괄호 버튼은 단축키를 따로 표시하지 않으므로 라벨 앞에 키를 넣는다. primary는 화면마다 하나
export function btn(el, { key, hotkey, label, onPress, primary, dim }) {
  const props = { key, label: hotkey ? hotkey + ' ' + label : label, onPress }
  if (hotkey) props.hotkey = hotkey
  if (primary) props.variant = 'primary'
  if (dim) props.dimColor = true
  return el.Button(props)
}

// 대괄호 없는 글자 링크: 목차·파일 탭처럼 여러 개를 늘어놓을 때
export function link(el, { key, label, onPress, dim }) {
  const props = { key, label, plain: true, onPress }
  if (dim) props.dimColor = true
  return el.Button(props)
}

// 가운뎃점으로 구분한 링크 줄
export function linkRow(el, links) {
  return el.Box({
    flexDirection: 'row',
    flexWrap: 'wrap',
    children: links.flatMap((l, i) => [...(i ? [el.Text({ color: C.faint, children: ['  ·  '] })] : []), l]),
  })
}

export function buttonRow(el, children) {
  return el.Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, children })
}

// 색 조각들의 앞에서 n글자를 버린다 (가로 스크롤)
export function shift(parts, n) {
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
