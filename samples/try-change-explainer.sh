#!/usr/bin/env bash
# change-explainer 체험: 예제 저장소를 만들고, mod를 불러온 Claude Code에 수정 요청을 보낸다.
# Claude가 수정을 마치면 /explain 을 입력하면 된다.
#
# 사용법: samples/try-change-explainer.sh [예제를 만들 폴더]
#   폴더를 주지 않으면 임시 폴더에 만든다. 이미 있는 폴더는 건드리지 않는다.
set -euo pipefail

MOD_DIR="$(cd "$(dirname "$0")/../change-explainer" && pwd)"
DEMO_DIR="${1:-$(mktemp -d "${TMPDIR:-/tmp}/change-explainer-demo.XXXXXX")}"

if [ -e "$DEMO_DIR/.git" ]; then
  echo "이미 저장소가 있는 폴더입니다: $DEMO_DIR" >&2
  echo "비어 있는 새 폴더를 지정하거나, 인자 없이 실행하세요." >&2
  exit 1
fi
mkdir -p "$DEMO_DIR/src"
cd "$DEMO_DIR"

cat > src/api.js <<'EOF'
// 아주 단순한 HTTP 클라이언트 (예제용)
export class HttpError extends Error {
  constructor(status) {
    super('HTTP ' + status)
    this.status = status
  }
}

export const api = {
  async post(path, body) {
    const res = await fetch('https://example.com' + path, { method: 'POST', body: JSON.stringify(body) })
    return { ok: res.ok, status: res.status, json: () => res.json() }
  },
}
EOF

cat > src/login.js <<'EOF'
import { api } from './api.js'

export class LoginError extends Error {
  constructor(status) {
    super('로그인 실패: ' + status)
    this.status = status
  }
}

export async function login(user, password) {
  const res = await api.post('/login', { user, password })
  if (!res.ok) throw new LoginError(res.status)
  console.log('login', res.status)
  return res.json()
}
EOF

cat > src/session.js <<'EOF'
import { login } from './login.js'

// 저장된 계정으로 세션을 다시 연다
export async function refreshSession(saved) {
  const token = await login(saved.user, saved.password)
  return { ...saved, token }
}
EOF

git init -q
git add .
git -c user.email=demo@example.com -c user.name=demo commit -qm "예제 시작"

PROMPT='로그인 API가 가끔 503이나 네트워크 오류로 실패해. src/login.js에서 네트워크 오류나 5xx일 때만 최대 3번까지 200ms, 400ms 기다렸다 재시도하게 해줘. 재시도 로직은 src/retry.js에 따로 만들고, 401 같은 인증 실패는 재시도하지 마. 재시도 테스트도 서브에이전트에게 맡겨서 src/login.test.js로 만들어줘.'

cat <<EOF

예제 저장소: $DEMO_DIR
mod:         $MOD_DIR

곧 Claude Code가 열리고 아래 요청을 보냅니다.
  $PROMPT

Claude가 수정을 마치면 프롬프트에 /explain 을 입력하세요.
  - 1~9: 섹션 펼치기 (펼칠 때 해설을 만듭니다)
  - d: diff  ·  Wait, what?: 더 쉽게  ·  9: 확인 퀴즈  ·  Esc: 닫기
해설 기록은 ~/.claude/explanations/ 아래에 남습니다.

EOF
exec claude --plugin-dir "$MOD_DIR" "$PROMPT"
