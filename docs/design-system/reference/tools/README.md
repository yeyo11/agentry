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
| `decision_parts.py` | the decision engine's pieces: the mark, its popover and Sheet, the project override and the Usage line. Imported by `board.py` and `projects.py`; `DesktopMemoria`, `MobileMemoria*` and the Uso screens carry the same markup, edited as HTML |
| `desktop.py` | desktop only: the board while the team works it (`DesktopTableroEquipo`, hand-drawn before), Tasks with All projects (`DesktopTareasTodos`), suggestions while they run (`DesktopSugerirTareasEnCurso`) and the assistant on an empty project (`DesktopAsistenteVacio`). `DesktopDocumentoEditar` has no generator: it is `DesktopDocumentos` with the editor open, edited as HTML |

```bash
python3 board.py && python3 tasks.py && python3 projects.py && python3 chat.py && python3 ai.py \
  && python3 desktop.py && python3 phone.py && python3 team.py
NS_OUT=/tmp/ns-out python3 board.py   # write somewhere else, to diff against the committed HTML
```

Every rule a screen needs lives in `agentry-ds.css`: a page's own `<style>` holds only the body
background, and inline styles are for layout. A rule two screens share goes into the stylesheet and
into §2 of `docs/design-system.md`.

## Checks

- `python3 lint.py [Screen …]`: tokens only. No hex but `#fff` (text on the gradient), no `rgb()`,
  `hsl()`, pixel radius or millisecond value in a screen. With no names it reads every screen and
  shell piece; the screens from before the ecosystem still carry raw values in their inline styles.
- `node check.mjs [Screen …]`: opens each screen in headless Chrome, in both themes, and lists text
  under 4.5:1 (3:1 at 24 px or more) against the solid fills under it, and on the phone every
  control under 44 × 44 px. Text on a gradient is not measured. A control inside a bigger one (a
  switch inside its cell) counts as the bigger one. Exit code 1 when it finds anything.

## Screenshots

```bash
python3 shoot.py DesktopTablero MobileTablero DSComponentes:1620 DSTablero:2300
python3 sheet.py board-sheet.png MobileTablero-dark MobileTablero-light
```

`shoot.py` captures `reference/screenshots/<Screen>-dark.webp` and `-light.webp` at 1440 × 1024
(desktop) or 390 × 844 at 2× (phone), and the shell pieces at their own size; a `DS*` page needs its
height after a colon. It keeps a PNG of each in `$NS_LOOK` (default `/tmp/ns-look`), which
`sheet.py` lays out side by side. Look at every capture before you finish.
