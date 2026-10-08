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
- **Past work** (`/explain list`): Claude Code keeps every conversation of a project. The list shows every past turn that changed something, newest first, one line each, titled by its commit message (or the files it changed). Open one to explain it. Sessions are read in the background and indexed, so the list opens at once the next time. Edit/Write changes come from the conversation record (exact), Bash changes from the commits you made in that turn's time window. Nothing to configure: no repository paths, no base branches.
- **Token usage.** Every explanation records the tokens it used (input, cache reads, output). The pane shows the turn's total; the list shows the total for the repository.
- **Remembers what you learned.** Terms you know and sections you got stuck on are saved per repository and shape later explanations.

## Requirements

- Claude Code **2.1.287 or later** (tested on 2.1.293). Check with `claude --version`.
- A terminal session (the CLI) or the Desktop app's Code tab. In `claude -p` and the VS Code chat panel, `/explain` answers with text instead of a pane.
- `git` is optional. Without it, Edit/Write changes are still recorded and explained; only changes made through Bash are missed. You do not need to manage or configure anything in git: the mod only reads it.
- Reading past sessions uses `sh`, `grep` and `awk` (macOS and Linux). On Windows the past-session list stays empty; live recording works.

## Install

From a shell:

```bash
claude plugin marketplace add SigLee2247/change-explainer
claude plugin install change-explainer@change-explainer
```

Or inside Claude Code: `/plugin marketplace add SigLee2247/change-explainer`, then `/plugin install change-explainer@change-explainer`.

To try it from a clone without installing:

```bash
git clone https://github.com/SigLee2247/change-explainer change-explainer-repo
claude --plugin-dir ./change-explainer-repo/change-explainer
```

After installing, run `/plugin` and check that `change-explainer` is listed as active. The install may say that 3 options are not set yet; every option has a default, so it works without setting them.

## Use

1. Ask Claude to change some code, as usual.
2. When the turn ends, type `/explain`.
3. Press `1`–`9` to open sections, `d` for the diff, `t` for the work list, `Esc` to close.

`/explain list` opens the work list: this session's turns and your past work. If the session has no recorded change yet, `/explain` opens the list too.

Live recording starts when the mod is loaded. Work from before that is in the list under past sessions, as long as Claude Code still keeps the conversation (30 days by default).

## Settings

Set them with `/plugin configure change-explainer@change-explainer`, or pass `--config KEY=VALUE` to `claude plugin install`.

| Option | Default | Meaning |
| :- | :- | :- |
| `language` | `ko` | Language the explanations are written in: `ko` or `en`. The pane's own labels are Korean for now. |
| `theme` | `dark` | `light` for light terminal themes (diff colors and text). |
| `model` | `session` | Model for explaining past sessions (`haiku`, `sonnet`, `opus` or a model id). `session` uses the session's model. Turns of the current session always fork the current conversation. |

## Where data goes, and what it costs

- Everything is stored locally under `~/.claude/explanations/`: per turn, the before/after snapshots of changed files, the generated sections, your questions and answers, and quiz results. Delete the folder to remove it all.
- The mod runs with your permissions inside Claude Code. It reads your conversation files under `~/.claude/projects/`, runs `git` in the repositories you work in, and calls the model with your plan or API key. It sends nothing anywhere else. Review what it does with `claude plugin validate ./change-explainer`.
- Model calls happen only when you open a section, press Wait, what? or ask a question. The summary is generated when the pane opens. Generated sections are cached and not regenerated unless you press `r`. Current-session explanations fork the conversation, so most of the prompt comes from the prompt cache.
- Every call's token usage is shown in the pane (per turn) and in the list (per repository), and saved in `usage.json`. As a reference, a summary of a past turn with 11 changed files used about 13k input and 4k output tokens on the session model; set `model` to `sonnet` or `haiku` to make past-session explanations cheaper.

## Limitations

- Bash changes are found through git: files outside a git repository, and changes whose paths do not appear in the command (a script that moves to another repository), are missed. Switching branches during a turn shows the branch difference as changes.
- For past sessions, Bash changes are recovered only if they were committed; a commit belongs to the turn in which it was made.
- The "why" is reconstructed from the conversation, not Claude's internal reasoning. Statements without support in the conversation are marked as guesses.
- The pane labels are Korean. Explanations follow the `language` setting.

## Development

```bash
claude --plugin-dir ./change-explainer          # load with hot reload
cd change-explainer && claude plugin test       # 49 tests, no session or network needed
claude plugin validate ./change-explainer --strict
claude plugin validate .                        # the marketplace file
```

- `CHANGE_EXPLAINER_DEV=1` adds `/explain-check <section> [session-id-prefix/turn]`, which generates one section with the real model and prints the JSON and the tokens used.
- `SPEC.md` (Korean) records the design and the decisions behind it.
- `samples/explain-preview` is a fixed-data mod for checking the pane's design; `samples/try-change-explainer.sh` builds a demo repository and starts Claude Code with the mod.

## License

MIT. See [LICENSE](LICENSE).

---

## 한국어

Claude Code가 턴마다 바꾼 코드를 기록하고, **무엇을 왜 어떻게** 바꿨는지 터미널 창에서 해설하는 mod입니다. 이해하지 못한 채 쌓이는 코드(지식 부채)를 줄이는 것이 목적입니다.

**설치**

```bash
claude plugin marketplace add SigLee2247/change-explainer
claude plugin install change-explainer@change-explainer
```

설치 없이 써 보려면 저장소를 받은 뒤 `claude --plugin-dir ./change-explainer/change-explainer`로 시작하세요. Claude Code 2.1.287 이상이 필요합니다.

**사용**

- Claude가 코드를 고친 뒤 `/explain`: 그 턴의 해설 창이 열립니다.
  - `1`~`9`: 섹션 펼치기 (펼칠 때 생성)
  - `d`: diff
  - `t`: 작업 목록
  - `Esc`: 닫기
- `/explain list`: 이 세션의 턴과 지난 작업 목록. 지난 대화에서 실제로 무언가 바꾼 턴이 최근 것부터 한 줄씩(커밋 메시지나 바꾼 파일 이름으로) 나오고, 고르면 해설 창이 열립니다. 저장소 경로나 기준 브랜치 같은 설정은 필요 없습니다.
- 막히면 `Wait, what?`: 누를 때마다 다른 방식으로 다시 설명하고, 그 부분만 따로 질문할 수 있습니다.
- 퀴즈를 다 맞히면 그 턴이 "이해함"으로 남습니다.

**설정** (`/plugin configure change-explainer@change-explainer`)

- `language`: 해설 언어 (ko/en)
- `theme`: 터미널 테마 (dark/light)
- `model`: 지난 세션 해설 모델 (비용을 줄이려면 sonnet이나 haiku)

자세한 내용은 위 영어 표를 참고하세요.

**데이터와 비용**

- 모든 기록은 `~/.claude/explanations/`에만 저장됩니다.
- 모델은 섹션을 펼치거나 질문할 때만 호출하고, 만든 결과는 캐시합니다.
- 해설에 쓴 토큰은 해설 창(턴별)과 작업 목록(저장소 누적)에 보입니다.
- git은 필수가 아닙니다. 없으면 Bash로 바꾼 파일만 놓치고, Edit/Write 변경은 그대로 해설합니다.
