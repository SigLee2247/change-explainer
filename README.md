# change-explainer

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that explains what Claude changed in your code, and why, so you understand the change before you move on.

When Claude edits code, the result stays but the reasoning disappears into the conversation. Changes you never really understood pile up as knowledge debt. change-explainer records every change Claude makes, per turn, and explains it in a pane inside the terminal when you ask.

[한국어 안내는 아래에 있습니다.](#한국어)

## What it does

- **Records each turn's changes.** Files edited with Edit/Write, and files changed through Bash (`sed -i`, `cat >`, `git commit`), including in other repositories and worktrees. Subagent changes go to the turn that started them.
- **Explains on demand.** `/explain` opens a pane for the last changed turn. Sections are generated only when you open them:

  | Key | Section |
  | :- | :- |
  | 1 | Summary: what changed, why, how it works, what to check |
  | 2 | Background: the problem before the change and its cause |
  | 3 | Code walkthrough: real code lines (read from the snapshots, never written by the model), what each does, why, alternatives |
  | 4 | Flow chart (bordered cards) |
  | 5 | Sequence diagram |
  | 6 | Before / after behavior |
  | 7 | Impact: callers, new functions, tests to check |
  | 8 | Terms: new concepts, mark the ones you already know |
  | 9 | Quiz: answer all correctly to mark the turn as understood |

- **Wait, what?** If a section does not land, press it. Each press explains again in a different way (analogy, premises one by one, numbers, execution order), and you can ask a question about that section.
- **IntelliJ-style diff** (`d`): side by side on wide panes, unified on narrow ones, changed words highlighted, only the code area scrolls.
- **Past work per branch** (`/explain list`): finds the repositories your project's conversations touched, lists every worktree branch with work on it (ticket key, commits, files), and explains a branch from where it was created, with the conversation that produced it as context.
- **Remembers what you learned.** Terms you know and sections you got stuck on are saved per repository and shape later explanations.

## Requirements

- Claude Code **2.1.287 or later** (tested on 2.1.293). Check with `claude --version`.
- A terminal session (the CLI) or the Desktop app's Code tab. In `claude -p` and the VS Code chat panel, `/explain` answers with text instead of a pane.
- `git`. Finding past work from conversations uses `sh`, `grep` and `awk` (macOS and Linux). On Windows that part is skipped.

## Install

From a shell:

```bash
claude plugin marketplace add <owner>/<repo>      # this repository on GitHub, or its git URL
claude plugin install change-explainer@change-explainer
```

Or inside Claude Code: `/plugin marketplace add <owner>/<repo>`, then `/plugin install change-explainer@change-explainer`.

To try it from a clone without installing:

```bash
git clone <repo-url> change-explainer-repo
claude --plugin-dir ./change-explainer-repo/change-explainer
```

After installing, run `/plugin` and check that `change-explainer` is listed as active. The install may say that 5 options are not set yet; every option has a default, so it works without setting them.

## Use

1. Ask Claude to change some code, as usual.
2. When the turn ends, type `/explain`.
3. Press `1`–`9` to open sections, `d` for the diff, `t` for the work list, `Esc` to close.

`/explain list` opens the work list: this session's turns and past branch work. If the session has no recorded change yet, `/explain` opens the list too.

Only changes made after the mod is loaded are recorded per turn. Earlier work is available per branch in the list.

## Settings

Set them with `/plugin configure change-explainer@change-explainer`, or pass `--config KEY=VALUE` to `claude plugin install`.

| Option | Default | Meaning |
| :- | :- | :- |
| `language` | `ko` | Language the explanations are written in: `ko` or `en`. The pane's own labels are Korean for now. |
| `theme` | `dark` | `light` for light terminal themes (diff colors and text). |
| `model` | `session` | Model for explaining past work (`haiku`, `sonnet`, `opus` or a model id). `session` uses the session's model. Turns of the current session always fork the current conversation. |
| `base_branches` | `develop,main` | Fallback bases for branch work when the branch's creation point is not in the reflog. Each repository can pick its own base in the list. |
| `ticket_pattern` | `[A-Z][A-Z0-9]+-\d+` | Regular expression for ticket keys in branch names (Jira style by default; for example `#\d+` for GitHub issues). |

## Where data goes, and what it costs

- Everything is stored locally under `~/.claude/explanations/`: per turn, the before/after snapshots of changed files, the generated sections, your questions and answers, and quiz results. Delete the folder to remove it all.
- The mod runs with your permissions inside Claude Code. It reads your conversation files under `~/.claude/projects/`, runs `git` in the repositories you work in, and calls the model with your plan or API key. It sends nothing anywhere else. Review what it does with `claude plugin validate ./change-explainer`.
- Model calls happen only when you open a section, press Wait, what?, ask a question or take the quiz. The summary is generated when the pane opens. Generated sections are cached and not regenerated unless you press `r`. Current-session explanations fork the conversation, so most of the prompt comes from the prompt cache.

## Limitations

- Bash changes are found through git: files outside a git repository, and changes whose paths do not appear in the command (a script that moves to another repository), are missed. Switching branches during a turn shows the branch difference as changes.
- The "why" is reconstructed from the conversation, not Claude's internal reasoning. Statements without support in the conversation are marked as guesses.
- The pane labels are Korean. Explanations follow the `language` setting.

## Development

```bash
claude --plugin-dir ./change-explainer          # load with hot reload
cd change-explainer && claude plugin test       # 50 tests, no session or network needed
claude plugin validate ./change-explainer --strict
claude plugin validate .                        # the marketplace file
```

- `CHANGE_EXPLAINER_DEV=1` adds `/explain-check <section> [ticket or branch]`, which generates one section with the real model and prints the JSON.
- `SPEC.md` (Korean) records the design and the decisions behind it.
- `samples/explain-preview` is a fixed-data mod for checking the pane's design; `samples/try-change-explainer.sh` builds a demo repository and starts Claude Code with the mod.

---

## 한국어

Claude Code가 턴마다 바꾼 코드를 기록하고, **무엇을 왜 어떻게** 바꿨는지 터미널 창에서 해설하는 mod입니다. 이해하지 못한 채 쌓이는 코드(지식 부채)를 줄이는 것이 목적입니다.

**설치**

```bash
claude plugin marketplace add <owner>/<repo>
claude plugin install change-explainer@change-explainer
```

설치 없이 써 보려면 저장소를 받은 뒤 `claude --plugin-dir ./<저장소>/change-explainer`로 시작하세요. Claude Code 2.1.287 이상이 필요합니다.

**사용**

- Claude가 코드를 고친 뒤 `/explain`: 그 턴의 해설 창이 열립니다.
  - `1`~`9`: 섹션 펼치기 (펼칠 때 생성)
  - `d`: diff
  - `t`: 작업 목록
  - `Esc`: 닫기
- `/explain list`: 이 세션의 턴과, 브랜치(티켓) 단위의 지난 작업 목록. 고르면 해설 창이 열립니다.
- 막히면 `Wait, what?`: 누를 때마다 다른 방식으로 다시 설명하고, 그 부분만 따로 질문할 수 있습니다.
- 퀴즈를 다 맞히면 그 턴이 "이해함"으로 남습니다.

**설정** (`/plugin configure change-explainer@change-explainer`)

- `language`: 해설 언어 (ko/en)
- `theme`: 터미널 테마 (dark/light)
- `model`: 지난 작업 해설 모델
- `base_branches`: 기준 브랜치 후보
- `ticket_pattern`: 티켓 키 형식

자세한 내용은 위 영어 표를 참고하세요.

**데이터와 비용**

- 모든 기록은 `~/.claude/explanations/`에만 저장됩니다.
- 모델은 섹션을 펼치거나 질문할 때만 호출하고, 만든 결과는 캐시합니다.
