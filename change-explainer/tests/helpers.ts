import { mock } from 'claude-code/testing'

export const HOME = '/home/u'
export const REPO = '/repo'

// 메모리 파일 시스템과 Claude Code의 응답들을 스텁으로 채운다.
// toolFails: 이 파일 경로의 수정은 실패로 돌려준다
export function setup(on: any, initial: Record<string, string>, opts: { toolFails?: string[]; deny?: string[]; headless?: boolean } = {}) {
  const files = new Map<string, string>(Object.entries(initial))
  const writes = new Map<string, string>()
  mock.clock(on, { now: 1000 })
  on('env.get', () => ({ value: HOME }))
  on('session.cwd', () => ({ value: REPO }))
  on('session.id', () => ({ value: 'sess1' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: REPO + '\n', stderr: '' } }))
  on('fs.stat', ($: any, e: any) =>
    files.has(e.path) ? { value: { kind: 'file', size: files.get(e.path)!.length, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' })
  on('fs.read', ($: any, e: any) => (files.has(e.path) ? { value: files.get(e.path) } : { deny: 'ENOENT' }))
  on('fs.write', ($: any, e: any) => {
    writes.set(e.path, e.text)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.surfaces', () => ({ value: opts.headless ? [] : ['terminal'] }))
  on('command.register', () => ({ value: undefined }))
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', ($: any, e: any) => ({ model: 'sonnet', agentId: e.description === 'bg' ? 'agentBg' : 'agentA' }))
  // 수정 도구: 메모리 파일 시스템에 실제로 적용한다
  on('tool.call', ($: any, e: any) => {
    if ((opts.deny || []).includes(e.file_path)) return { deny: 'not allowed' }
    if ((opts.toolFails || []).includes(e.file_path)) return { result: 'String not found', isError: true }
    if (e.tool === 'Write') files.set(e.file_path, e.content)
    if (e.tool === 'Edit') files.set(e.file_path, files.get(e.file_path)!.replace(e.old_string, e.new_string))
    return { result: 'ok' }
  })
  const find = (suffix: string) => [...writes.keys()].find((k) => k.endsWith(suffix))
  const json = (suffix: string) => {
    const k = find(suffix)
    return k ? JSON.parse(writes.get(k)!) : undefined
  }
  return { files, writes, find, json }
}

export const turnStart = ($: any, turnId: string, text: string) => $.turn.start({ turnId, text })
export const turnEnd = ($: any, turnId: string, extra: any = {}) =>
  $.turn.complete({ turnId, answer: '재시도를 추가했습니다.', durationMs: 5, isAborted: false, reason: 'answer', ...extra })
export const edit = ($: any, file_path: string, old_string: string, new_string: string, extra: any = {}) =>
  $.tool.call({ tool: 'Edit', file_path, old_string, new_string, ...extra })

