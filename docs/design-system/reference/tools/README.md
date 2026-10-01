# Prototype tools

The scripts that write, check and capture the Night Shift prototypes of the project ecosystem
([plans/project-ecosystem.md](../../../plans/project-ecosystem.md)). They were written in `/tmp` by
the `proto-foundation` and `proto-ai` tasks and brought here by `proto-fix-system`, so the next task
does not have to redraw a screen by hand.

**The HTML in `reference/` is the source of truth.** The generators reproduced every screen they
write byte for byte when they were brought in (2026-09-27): the hand fixes `proto-index` made to the
HTML were ported back into them. A task that changes a generated screen changes its generator too,
or says in its result that the two parted. Screens with no generator (the team, flow, memory and
documents screens of `proto-team`, and every screen from before the ecosystem) are edited as HTML.
The design review of `feat/project-ecosystem` (2026-09-28) added `team.py` and edited the
hand-written team screens in place; [../../ecosystem-review.md](../../ecosystem-review.md) lists
what changed on each screen.

Python 3.12 or later (the generators use backslashes inside f-strings) with Pillow, and Chrome (`CHROME_BIN`, default `/usr/bin/google-chrome`); Node 22 for
`check.mjs`. Run everything from this folder.

| Script | Writes |
|---|---|
| `common.py` | the shell (sidebar, top bar, tab bar), the icons and `desktop()` / `mobile()` / `write()`. Not run on its own |
| `data.py` | the one data set of `claude-wrapper`: the work items, their columns, epics and milestones, and `card()` / `col()` |
| `phone.py` | the phone-only states: wizard steps 1 and 4, board selection and filters, a work item's Activity and Changes, Tasks with All projects, the assistant's Team and Resources proposals, the assistant with nothing to read, and suggestions while they run. Run after the others; it imports them |
| `board.py` | `DesktopTablero`, `MobileTablero` |
| `tasks.py` | the empty board, the list, the work item, the new task form and the milestones, both sizes |
| `projects.py` | the project wizard, the project page and its settings, both sizes |
| `chat.py` | `DesktopChatTarea`, `MobileChatTarea` |
| `ai.py` | the assistant, suggested tasks and resources with AI, both sizes |
| `team.py` | the screens the design review added: Team activity (`DesktopEquipoActividad`, `MobileEquipoActividad`), a failed flow run's chat (`DesktopChatFlujo`, `MobileChatFlujo`), the phone board while the team works it (`MobileTableroEquipo`, hand-drawn before) and the board's spec page `DSTablero`. Run after `desktop.py`; it imports it |
| `decisions.py` | the Decisions tab of Settings: its sections, the consent dialog, History and the provider warning, both sizes. Runs on its own |
| `checks.py` | the CI checks' screens of [plans/code-hosts.md](../../../plans/code-hosts.md), phase 2. `k-p3` writes `DSChecks` (the fix states on the board card and the item page, the fix dialog and its Sheet, `checks.fix`) and the Decisions tab variants `DesktopAjustesDecisionesChecks` and `MobileAjustesDecisionesChecks`; it patches `decisions.py`'s point list while it draws them. Runs on its own; `k-p1` and `k-p2` add their screens to the same file |
| `providers.py` | Settings → Providers and the first-run step of [plans/multi-provider.md](../../../plans/multi-provider.md), both sizes: the list with Codex's binary override open, other states and a row being dragged, the phone's order and binary Sheets, and first run found, checking and nothing found. Runs on its own (imports `common.py` and `decisions.py`) |
| `chatproviders.py` | the provider on the chat page and the chats list of [plans/multi-provider.md](../../../plans/multi-provider.md), phase 3 `p1`: `DesktopChat`, `MobileChat`, `DesktopChats` and `MobileChats` (written as HTML before the generators; the first run lifts them into the shared shell and swaps their pixel radii for tokens, later runs leave them alone), plus a Codex and a Copilot chat (`DesktopChatCodex`, `DesktopChatCopilot`, `MobileChatCodex`, `MobileChatCopilot`) and the phone's details Sheet with the native id (`MobileChatDetalles`). Runs on its own; imports `common.py` and `providers.py` |
| `checks.py` | the screens of [plans/code-hosts.md](../../../plans/code-hosts.md) phase 2 (checks): `k-p2` is the orchestration's checks with the log tail and the Push the fix state (`DesktopOrquestacionChecks`, `…ChecksSubir`, the phone pair). `k-p1` and `k-p3` add their own functions under their own banners. Runs on its own; imports `common.py`, `data.py`, `decisions.py` and `hosts.py` (the orchestration's steps) |
| `hosts.py` | the code hosts' screens of [plans/code-hosts.md](../../../plans/code-hosts.md): Settings → Integrations (the list with GitLab's binary override open, the other states, nothing installed), both sizes, and the phone's binary Sheet, plus `DSIntegraciones` (the states sheet of the project's host line; the line itself is drawn by `projects.py`). Runs on its own; imports `providers.py` and `projects.py` for the shared pieces; `p3` adds the readiness notes (the "Los siete avisos" section of `DSIntegraciones`) and the orchestration's merge request (`DesktopOrquestacionMR`, `…MRSubir` and the phone pair), and imports `data.py` and `board.py`. The item page and board variants (`DesktopTareaMR`, `MobileTareaMR`, `DesktopTableroMR`) come from `tasks.py` and `board.py` |
| `checks.py` | the checks of a change request ([plans/code-hosts.md](../../../plans/code-hosts.md), phase 2 P0). `k-p1`: the item page's checks (`DesktopTareaChecks`, `MobileTareaChecks`, the phone's log and row Sheets, and the two states sheets). Runs on its own; imports `common.py`, `data.py`, `decisions.py` and `tasks.py` (the item page it extends) |
| `reviews.py` | the reviews of a change request ([plans/code-hosts.md](../../../plans/code-hosts.md), phase 3 P0). `r-p1`: the threads in the diff (`DesktopRevisionHilos`, `…HilosNota`, `…HilosPlegados` and the phone trio: an open thread with a suggestion, the resolved and outdated folds, the draft note and the composer, inline on a desktop and a Sheet on a phone). `r-p2`: the review block of the item page (`DesktopTareaRevision`, `…Envio`, the phone pair and the states sheets `DesktopTareaRevisionEstados`, `MobileTareaRevisionEstados`). `r-p3`: `DSRevision`, the Address with an agent dialog and its Sheet, the `review.triage` marks, the item page while the Developer works and the "Atendido en" follow-up. Runs on its own; imports `common.py`, `data.py`, `decisions.py`, `tasks.py` and `checks.py` |
