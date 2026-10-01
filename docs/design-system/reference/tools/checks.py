from contextlib import contextmanager
# Checks of a change request (plans/code-hosts.md, phase 2, P0). One function per task, each under its own
# banner: k-p1 is the item page's checks. k-p2 and k-p3 add theirs below. Runs on its own: it imports
# common.py and tasks.py (the item page it extends).
#   python3 checks.py
from data import *
from common import P, ico, desktop, mobile, write, tabbar, page
from decisions import scrim
import decisions as dec
from hosts import orch_steps
from tasks import _captured, _swap, detail_desktop, mtask_head, wrap_paths, diff_rows, MR_BRANCH
from board import mrow

P.setdefault('ext', EXT_PATH)

# ---------------------------------------------------------------- shared
# host id -> name, noun, number, CLI
HOST = {
  'github': ('GitHub', 'PR', '#12', 'gh'),
  'gitlab': ('GitLab', 'MR', '!12', 'glab'),
}

# state -> word, badge class, mark icon (None: the ring spinner), mark colour. A status colour always has its word.
# Only a running check is live. A failure the pipeline allows is a warning, never a failure; a manual job
# waits for the person, so it is idle.
STATE = {
  'failed': ('fallida', 'b-bad', 'x', 'bad'),
  'allowed': ('fallo permitido', 'b-warn', 'warn', 'warn'),
  'running': ('en marcha', 'b-live', None, ''),
  'queued': ('en cola', '', 'wait', ''),
  'passed': ('superada', 'b-ok', 'check', 'ok'),
  'skipped': ('omitida', '', 'block', ''),
  'manual': ('manual', 'b-idle', 'play', 'idle'),
}
# group key, title, the states it holds. An allowed failure sits with the failures, as GitLab lists it, but
# does not count as one.
GROUPS = [
  ('failed', 'Fallidas', ('failed', 'allowed')),
  ('running', 'En marcha', ('running', 'queued')),
  ('passed', 'Superadas', ('passed',)),
  ('skipped', 'Omitidas', ('skipped', 'manual')),
]


def c(name, stage, st, dur='', **kw):
  return dict(name=name, stage=stage, st=st, dur=dur, **kw)


# The item page's pipeline: GitLab, because the MR !12 of DesktopTareaMR is one and only GitLab has a failure
# the pipeline allows. Job ids are the ones the API gives.
GL = [
  c('unit-tests', 'test', 'failed', '2:14', id=4817, reason='script_failure'),
  c('e2e-chrome', 'test', 'failed', '6:03', id=4818, reason='script_failure'),
  c('lint-docs', 'test', 'allowed', '0:48', id=4819, reason='script_failure'),
  c('build', 'build', 'passed', '1:32', id=4811),
  c('typecheck', 'build', 'passed', '1:05', id=4812),
  c('lint', 'build', 'passed', '0:41', id=4813),
  c('audit', 'build', 'passed', '0:22', id=4814),
  c('package', 'deploy', 'skipped', ''),
  c('deploy-preview', 'deploy', 'manual', ''),
]
# GitHub's check runs: no stage, the workflow takes its place. Names as the workflow gives them.
GH = [
  c('test (node 22)', 'CI', 'failed', '3:52', id=61902),
  c('codecov/patch', 'Codecov', 'failed', '', id=0, other=True),
  c('lint', 'CI', 'passed', '0:38', id=61898),
  c('typecheck', 'CI', 'passed', '1:12', id=61899),
  c('test (node 20)', 'CI', 'passed', '3:41', id=61901),
  c('build', 'CI', 'passed', '1:49', id=61903),
]
GH_PASS = [
  c('lint', 'CI', 'passed', '0:38', id=61898), c('typecheck', 'CI', 'passed', '1:12', id=61899),
  c('test (node 20)', 'CI', 'passed', '3:41', id=61901), c('test (node 22)', 'CI', 'passed', '3:52', id=61902),
  c('build', 'CI', 'passed', '1:49', id=61903),
]
GH_RUN = [
  c('lint', 'CI', 'passed', '0:38', id=61898), c('typecheck', 'CI', 'passed', '1:12', id=61899),
  c('test (node 20)', 'CI', 'running', '2:07', id=61901), c('test (node 22)', 'CI', 'running', '2:07', id=61902),
  c('build', 'CI', 'queued', '', id=61903),
]

# (line number, text, an annotation points here) or a gap with the lines it leaves out
TAIL_GL = [
  (131, '✓ test/project-settings.test.ts (9)', 0), (132, '❯ test/templates-apply.test.ts (6 | 1 failed)', 0),
  (133, "  × applies the template's column limits to a new project", 1), (134, '    → expected 3 to be 5 // Object.is equality', 1),
  ('gap', 166), (301, 'FAIL  test/templates-apply.test.ts > applies the template\'s column limits', 0),
  (302, 'AssertionError: expected 3 to be 5', 1), (303, ' ❯ test/templates-apply.test.ts:58:31', 0),
  (304, '      Tests  1 failed | 79 passed (80)', 0),
  (305, 'ERROR: Job failed: exit code 1', 1),
]
TAIL_GH = [
  (88, '✓ test/project-settings.test.ts (9)', 0), (89, '❯ test/templates-apply.test.ts (6 | 1 failed)', 0),
  (90, "  × applies the template's column limits to a new project", 1),
  ('gap', 212), (302, 'AssertionError: expected 3 to be 5', 1), (303, ' ❯ test/templates-apply.test.ts:58:31', 0),
  (304, '##[error]Process completed with exit code 1.', 1),
]
# GitHub check-run annotations: level word, path:line, message. Runner annotations use the path .github.
ANNS = [
  ('error', 'packages/core/test/templates-apply.test.ts:58', 'AssertionError: expected 3 to be 5'),
  ('error', '.github', 'Process completed with exit code 1.'),
  ('warning', 'packages/core/src/project-templates.ts:142', "'limits' is assigned a value but never used."),
]
LEVEL = {'error': ('error', 'b-bad'), 'warning': ('aviso', 'b-warn'), 'notice': ('nota', '')}
REASON = {'script_failure': 'El script terminó con salida 1.'}


def mark(st):
  word, cls, icon, colour = STATE[st]
  inner = '<span class="spin-ring" aria-hidden="true"></span>' if icon is None else ico(icon)
  return f'<span class="check-mark {colour}" aria-hidden="true">{inner}</span>'


def badge(st):
  word, cls, _, _ = STATE[st]
  return f'<span class="badge {cls}">{word}</span>'.replace('badge "', 'badge"')


def host_link(host, mobile=False, what=None):
  name = HOST[host][0]
  return f'<a href="#" class="btn {"btn-lg" if mobile else "btn-sm btn-ghost"}" target="_blank" rel="noreferrer">{ext_ico()}{what or f"Abrir en {name}"}</a>'


# ---------------------------------------------------------------- the list
def row(ck, mobile, sel=None, menu_open=False):
  on = sel == ck['name']
  cls = 'check-row' + (' on' if on else '') + (' rail-live' if ck['st'] == 'running' else '')
  dur = f'<span class="check-dur">{ck["dur"] or "—"}</span>'
  if mobile:
    main = (f'<button type="button" class="check-main" aria-expanded="{"true" if on else "false"}" aria-label="Ver el registro de {ck["name"]}">{mark(ck["st"])}'
            f'<span class="check-name"><b>{ck["name"]}</b></span>'
            f'<span class="meta">{badge(ck["st"])}<span class="mono t-xs fg-3 ellipsis">{ck["stage"]}</span><span class="grow"></span>{dur}</span></button>')
  else:
    main = (f'<button type="button" class="check-main" aria-expanded="{"true" if on else "false"}" aria-label="Ver el registro de {ck["name"]}">{mark(ck["st"])}'
            f'<span class="check-name"><b>{ck["name"]}</b><span class="stage">{ck["stage"]}</span></span>{badge(ck["st"])}{dur}</button>')
  more = (f'<button type="button" class="check-more" aria-label="Más acciones de {ck["name"]}" aria-haspopup="menu" aria-expanded="{"true" if menu_open else "false"}">'
          f'{ico("more", "ico", "stroke-width: 3")}</button>')
  return f'<div class="{cls}">{main}{more}</div>'


def group_head(key, title, items, open_, mobile):
  n = sum(1 for i in items if i['st'] != 'allowed')
  extra = sum(1 for i in items if i['st'] == 'allowed')
  count = f'{n}' + (f' · {extra} permitida' + ('s' if extra > 1 else '') if extra else '')
  return (f'<button type="button" class="check-group-head" aria-expanded="{"true" if open_ else "false"}">{ico("down" if open_ else "right", "ico ico-sm fg-3")}'
          f'<span class="t-label">{title}</span><span class="n">{count}</span></button>')


def check_list(checks, mobile, sel=None, menu=None, open_groups=('failed', 'running')):
  out = []
  for key, title, states in GROUPS:
    items = [x for x in checks if x['st'] in states]
    if not items:
      continue
    open_ = key in open_groups
    out.append(group_head(key, title, items, open_, mobile))
    if open_:
      out.extend(row(x, mobile, sel, menu == x['name']) for x in items)
  return f'<div class="check-list" role="group" aria-label="Comprobaciones">{"".join(out)}</div>'


def summary(checks):
  words = []
  for st, one, many in (('failed', 'fallida', 'fallidas'), ('running', 'en marcha', 'en marcha'), ('passed', 'superada', 'superadas')):
    n = sum(1 for x in checks if x['st'] == st)
    if n:
      words.append(f'{n} {one if n == 1 else many}')
  return ' · '.join(words)


def rollup(checks):
  sts = {x['st'] for x in checks}
  if not checks:
    return 'none'
  return 'failing' if 'failed' in sts else 'pending' if sts & {'running', 'queued'} else 'passing'


# ---------------------------------------------------------------- the log tail
def notes(host, ck):
  """What the host says about the failure, above the tail: GitHub's annotations, or GitLab's failure_reason."""
  if host == 'github':
    rows = ''.join(f'<div class="check-note"><span class="badge {LEVEL[lv][1]}">{LEVEL[lv][0]}</span><span class="col" style="gap: 2px; min-width: 0"><span class="where">{where}</span><span>{msg}</span></span></div>'
                   for lv, where, msg in ANNS)
    return f'<div class="check-notes"><span class="t-label">Anotaciones · {len(ANNS)}</span>{rows}</div>'
  why = (f'<div class="check-note"><span class="badge b-bad">fallida</span><span class="col" style="gap: 2px; min-width: 0">'
         f'<span class="where">{ck.get("reason", "script_failure")}</span><span>{REASON[ck.get("reason", "script_failure")]}</span></span></div>')
  return f'<div class="check-notes"><span class="t-label">Motivo según GitLab</span>{why}</div>'


def tail(host):
  lines = []
  for ln in (TAIL_GL if host == 'gitlab' else TAIL_GH):
    if ln[0] == 'gap':
      lines.append(f'<div class="check-gap">⋯ {ln[1]} líneas omitidas</div>')
    else:
      no, text, hit = ln
      lines.append(f'<div class="check-line{" hit" if hit else ""}"><span class="no">{no}</span><span>{text}</span></div>')
  return f'<span class="t-label" style="padding: 0 14px">Final del registro</span><div class="check-tail" role="log" aria-label="Final del registro">{"".join(lines)}</div>'


def foot_note(host):
  return '<div class="check-log-foot"><span>Últimas 200 líneas · 16 KiB · Agentry oculta los posibles secretos</span></div>'


def unavailable(host):
  name = HOST[host][0]
  line = {'github': 'gh: HTTP 404: Not Found (repos/yeyo/claude-wrapper/actions/jobs/61898/logs)',
          'gitlab': 'glab: 404 Not Found (projects/218/jobs/4813/trace)'}[host]
  return (f'<div class="pr-not-ready" role="note" data-reason="log-unavailable" style="padding: 0 14px 14px">{ico("warn", "ico")}'
          f'<div class="col" style="gap: 4px; min-width: 0"><span>El registro de esta comprobación ya no está en {name}, o el trabajo no llegó a empezar.</span>'
          f'<span class="detail">{line}</span><span class="row" style="gap: 4px 16px"><a href="#" class="pr-remedy">Abrir en {name}{ext_ico()}</a></span></div></div>')


def log_head(host, ck):
  detail = f'trabajo {ck["id"]} · {ck["stage"]}' + (f' · {ck["dur"]}' if ck['dur'] else '')
  return (f'<div class="check-log-head">{mark(ck["st"])}<b style="font-weight: 500">{ck["name"]}</b>{badge(ck["st"])}'
          f'<span class="mono t-xs fg-3">{detail}</span><span class="grow"></span>{host_link(host)}'
          f'<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Cerrar el registro">{ico("x")}</button></div>')


def log_panel(host, ck, gone=False):
  body = unavailable(host) if gone else notes(host, ck) + tail(host) + foot_note(host)
  return f'<div class="check-log" id="check-log" role="region" aria-label="Registro de {ck["name"]}">{log_head(host, ck)}{body}</div>'


# ---------------------------------------------------------------- the menu of a row
def menu_items(host, ck):
  name = HOST[host][0]
  if ck.get('other'):
    return [('retry', 'Repetir esta comprobación', True, 'Esta comprobación viene de otro servicio: repítela allí.'), ('ext', 'Abrir su página', False, '')]
  items = []
  if ck['st'] == 'manual':
    items.append(('play', 'Ejecutar esta comprobación', False, ''))
  else:
    items.append(('retry', 'Repetir esta comprobación', False, ''))
  items.append(('ext', f'Abrir en {name}', False, ''))
  return items


def menu(host, ck, top):
  rows = ''
  for icon, label, dis, why in menu_items(host, ck):
    rows += (f'<button type="button" class="menu-item" role="menuitem"{" disabled aria-describedby=" + chr(34) + "why" + chr(34) if dis else ""}>{ico(icon, "ico ico-sm")}{label}</button>'
             + (f'<span id="why" class="menu-why">{why}</span>' if why else ''))
  return f'<div class="menu check-menu" role="menu" aria-label="Acciones de {ck["name"]}" style="top: {top}px">{rows}</div>'


# ---------------------------------------------------------------- the section
def actions(checks, mobile, disabled=False):
  failed = any(x['st'] == 'failed' for x in checks)
  running = any(x['st'] in ('running', 'queued') for x in checks)
  d = ' disabled' if disabled else ''
  lg = ' btn-lg' if mobile else ' btn-sm'
  out = []
  if failed:
    out.append(f'<button type="button" class="btn{lg}"{d}>{ico("retry", "ico ico-sm" if not mobile else "ico")}Repetir las fallidas</button>')
  if running:
    out.append(f'<button type="button" class="btn btn-ghost{lg}"{d}>Cancelar</button>')
  if failed:
    out.append(f'<button type="button" class="btn btn-primary{lg}"{d}>{ico("sparkle", "ico ico-sm" if not mobile else "ico")}Arreglar las comprobaciones fallidas</button>')
  return out


def more_button(mobile):
  return (f'<button type="button" class="btn btn-ghost btn-icon{" btn-lg" if mobile else " btn-sm"}" aria-label="Más acciones de las comprobaciones" aria-haspopup="menu">'
          f'{ico("more", "ico", "stroke-width: 3")}</button>')


def section(host, checks, mobile=False, sel=None, menu_for=None, menu_top=118, open_groups=('failed', 'running'), panel=None, gone=False,
            ci=False, limited=None, quiet=None):
  noun, num = HOST[host][1:3]
  sub = summary(checks)
  badges = ci_badge(rollup(checks)) if ci else ''
  limit_note = ''
  if limited:
    limit_note = (f'<div class="callout callout-warn" role="note" style="align-items: flex-start">{ico("warn", "ico", "flex-shrink: 0; color: var(--warn); margin-top: 1px")}'
                  f'<span class="col grow" style="gap: 4px"><span class="row" style="gap: 8px"><span class="badge b-warn">límite de la API</span></span>'
                  f'<span>El límite de la API de {HOST[host][0]} para tu cuenta está agotado hasta las <span class="mono">{limited[1]}</span>. Agentry espera hasta entonces.</span>'
                  f'<span class="check-asof">Lista leída a las {limited[0]}</span></span></div>')
  acts = actions(checks, mobile, disabled=bool(limited))
  if mobile:
    head = (f'<div class="row" style="gap: 8px; padding: 0 2px"><span class="t-label grow">Comprobaciones</span><span class="mono t-xs fg-3">{sub}</span>{badges}'
            f'{more_button(True) if checks else ""}</div>')
    acts_html = f'<div class="col" style="gap: 8px">{"".join(acts)}</div>' if acts else ''
    top = f'{head}{limit_note}{acts_html}'
  else:
    head = (f'<div class="row" style="gap: 10px; flex-wrap: wrap"><span class="col" style="gap: 2px"><h2 class="t-h2">Comprobaciones</h2><span class="mono t-xs fg-3">{sub}</span></span>{badges}'
            f'<span class="grow"></span>{"".join(acts)}{more_button(False) if checks else ""}</div>')
    top = f'{head}{limit_note}'
  if quiet:
    inner = f'<div class="check-quiet">{ico("block")}<div class="col" style="gap: 4px"><span>{quiet[0]}</span><span class="t-xs fg-3">{quiet[1]}</span></div></div>'
  else:
    inner = check_list(checks, mobile, sel, menu_for, open_groups)
    if panel and not mobile:
      inner += log_panel(host, panel, gone)
  extra = ''
  if panel and mobile and not quiet:
    # On a phone the log is a Sheet; here it is drawn under the list so each state shows what the Sheet holds
    body = unavailable(host) if gone else notes(host, panel) + tail(host) + foot_note(host)
    extra = (f'<span class="t-label" style="padding: 0 2px">Hoja del registro de {panel["name"]}</span>'
             f'<div class="card" style="overflow: hidden; border-radius: var(--r-lg); padding: 12px 0 0">{body}'
             f'<div style="padding: 0 14px 14px">{host_link(host, True)}</div></div>')
  card = f'<div class="card" style="overflow: hidden; border-radius: var(--r-lg)">{inner}</div>'
  pop = ''
  if menu_for and not mobile:
    ck = next(x for x in checks if x['name'] == menu_for)
    pop = menu(host, ck, menu_top)
  return f'<section class="col" aria-label="Comprobaciones" style="gap: 10px; position: relative">{top}{card}{pop}{extra}</section>'


# ---------------------------------------------------------------- the item page
def mr_panel(host, mobile=False):
  name, noun, num, _ = HOST[host]
  size = 'btn btn-lg' if mobile else 'btn btn-sm'
  return f'''<section class="callout" aria-label="{"Merge request" if host == "gitlab" else "Pull request"}" style="align-items: flex-start; flex-wrap: wrap">{ico('branch', 'ico fg-3', 'flex-shrink: 0; margin-top: 2px')}
<div class="col grow" style="gap: 6px; min-width: 0"><span class="row" style="gap: 8px; flex-wrap: wrap"><b style="color: var(--fg); font-weight: 500">La {noun} {num} espera que la fusiones en {name}</b>{ci_badge('failing')}</span>
<span>Cuando se fusione, la tarea pasará sola a Hecho.</span></div>
{"" if mobile else f'<a href="#" class="{size}" target="_blank" rel="noreferrer">{ext_ico()}Abrir {noun} {num} en {name}</a>'}</section>'''


def pr_link_row(host):
  name, noun, num, _ = HOST[host]
  return (f'<a href="#" class="pr-row" target="_blank" rel="noreferrer" aria-label="Abrir {noun} {num} en {name}"><span class="pr-num">{noun} {num}</span>'
          f'<span class="pr-branch">task/agn-26 → main</span>{ci_badge("failing")}{ext_ico()}</a>')


def item_desktop(name, title, **kw):
  h = _captured(detail_desktop)
  h = _swap(h, '<span class="badge b-idle">te espera</span>', '<span class="badge b-idle">espera tu fusión</span>')
  # The description keeps two lines: the checks are what this screen is about
  h = _swap(h, 'style="line-height: 1.6; max-width: 720px"', 'style="line-height: 1.6; max-width: 720px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden"')
  crit = '<section class="col" style="gap: 8px"><div class="row" style="gap: 10px"><h2 class="t-h2">Criterios'
  h = _swap(h, crit, mr_panel('gitlab') + section('gitlab', GL, **kw) + crit)
  diff = '<div class="row" style="gap: 8px"><a href="#" class="btn btn-sm grow">'
  h = _swap(h, diff, pr_link_row('gitlab') + diff)
  write(name, h.replace('<title>Agentry · Tarea (desktop)', f'<title>Agentry · {title} (desktop)'))


def foot_mr():
  return (f'<div class="m-foot"><a href="#" class="btn btn-lg" style="flex: 0 0 auto" target="_blank" rel="noreferrer">{ext_ico("ico ico-lg")}Abrir MR !12</a>'
          f'<a href="MobileChatTarea.html" class="btn btn-primary btn-lg">{ico("play", "ico ico-lg")}Trabajar en ella</a></div>')


def item_mobile(name, title, overlay='', **kw):
  # The page as it looks scrolled down to the checks: the header stays, the title and the description are above the merge request's panel
  body = (f'{mr_panel("gitlab", True)}{section("gitlab", GL, True, **kw)}')
  head = mtask_head().replace('<span class="badge b-idle">te espera</span>', '<span class="badge b-idle">espera tu fusión</span>')
  inner = f'{head}\n<div class="m-body stack" style="gap: 14px">{body}</div>\n{foot_mr()}\n{overlay}'
  write(name, mobile(title, inner))


def log_sheet(host, ck, gone=False):
  body = unavailable(host) if gone else notes(host, ck) + tail(host) + foot_note(host)
  return f'''{scrim()}
<div class="sheet" role="dialog" aria-label="Registro de {ck["name"]}" style="z-index: 11; padding: 10px 0 28px; display: flex; flex-direction: column; gap: 10px; max-height: 80%; overflow: hidden">
<div class="grab" style="margin-bottom: 0"></div>
<div class="row" style="gap: 10px; padding: 0 4px 0 16px">{mark(ck["st"])}<span class="col grow" style="gap: 2px; min-width: 0"><b style="font-weight: 500; font-size: 15px">{ck["name"]}</b><span class="mono t-xs fg-3">trabajo {ck["id"]} · {ck["stage"]} · {ck["dur"]}</span></span>{badge(ck["st"])}<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Cerrar el registro">{ico("x", "ico ico-lg")}</button></div>
<div class="col" style="gap: 10px; min-height: 0; overflow: hidden">{body}</div>
<div style="padding: 0 16px">{host_link(host, True)}</div>
</div>'''


def menu_sheet(host, ck):
  rows = ''
  for icon, label, dis, why in menu_items(host, ck):
    rows += f'<button type="button" class="menu-item" role="menuitem"{" disabled" if dis else ""} style="height: auto; padding: 0 12px">{ico(icon, "ico")}{label}</button>'
    if why:
      rows += f'<span class="menu-why" style="padding: 0 12px 8px 38px; font-size: 13px; color: var(--fg-3)">{why}</span>'
  return f'''{scrim()}
<div class="sheet" role="dialog" aria-label="Acciones de {ck["name"]}" style="z-index: 11; padding-bottom: 28px; display: flex; flex-direction: column; gap: 6px">
<div class="grab"></div>
<div class="col" style="gap: 2px; padding: 0 4px 6px"><b style="font-weight: 500; font-size: 15px">{ck["name"]}</b><span class="mono t-xs fg-3">{ck["stage"]} · {STATE[ck["st"]][0]}</span></div>
<div class="col" style="gap: 2px">{rows}</div>
<button type="button" class="btn btn-lg" style="justify-content: center; margin-top: 6px">Cancelar</button>
</div>'''


# ---------------------------------------------------------------- states
def cell(label, body):
  return f'<div class="col" style="gap: 8px; min-width: 0"><span class="t-label" style="padding: 0 2px">{label}</span>{body}</div>'


def states(mobile):
  gh_fail = GH
  sel_gh = next(x for x in gh_fail if x['name'] == 'test (node 22)')
  other = next(x for x in gh_fail if x.get('other'))
  gone_ck = next(x for x in GH_PASS if x['name'] == 'lint')
  cells = [
    ('Sin comprobaciones', section('github', [], mobile, ci=True, quiet=('Esta PR no tiene comprobaciones.', 'Si el repositorio tiene CI, aparecerán aquí en cuanto GitHub la ponga en marcha.'))),
    ('Todas superadas', section('github', GH_PASS, mobile, open_groups=('passed',))),
    ('En marcha', section('github', GH_RUN, mobile, open_groups=('running', 'passed'))),
    ('Límite de la API agotado', section('github', GH, mobile, limited=('10:42', '11:20'))),
    ('Registro no disponible', section('github', GH_PASS, mobile, sel='lint', open_groups=('passed',), panel=gone_ck, gone=True)),
    ('Anotaciones y una comprobación de otro servicio',
     section('github', gh_fail, mobile, sel='test (node 22)', menu_for='codecov/patch', menu_top=152, panel=sel_gh)),
  ]
  return cells


def states_desktop():
  grid = ''.join(cell(l, b) for l, b in states(False))
  head = ('<header class="col" style="gap: 6px"><span class="t-label">Comprobaciones de una PR · GitHub</span>'
          '<h1 class="t-h1">Los estados de la lista</h1>'
          '<p class="t-sm fg-2" style="margin: 0; max-width: 820px; line-height: 1.5">La lista de una PR de GitHub sin comprobaciones, con todas superadas, en marcha, con el límite de la API agotado, '
          'con un registro que ya no existe y con anotaciones. El estado con una fallida y un fallo permitido es <a href="DesktopTareaChecks.html" class="c-accent">la propia página de la tarea</a>.</p></header>')
  body = (f'<div class="app col" data-theme="dark" style="width: 1440px; height: 1620px; padding: 32px 40px; gap: 22px; overflow: hidden">{head}'
          f'<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 26px 28px; align-items: start">{grid}</div></div>')
  write('DesktopTareaChecksEstados.html', page('Tarea, estados de las comprobaciones (desktop)', body))


def states_mobile():
  grid = ''.join(cell(l, b) for l, b in states(True))
  # The phone has no panel: a log is a Sheet, drawn on its own screen
  body = (f'<div class="app m-screen" data-theme="dark" style="height: auto; overflow: visible"><div class="m-body stack" style="gap: 22px; overflow: visible; padding-top: 16px">'
          f'<h1 class="t-h1">Estados de las comprobaciones</h1>{grid}</div></div>')
  write('MobileTareaChecksEstados.html', page('Tarea, estados de las comprobaciones (móvil)', body, mobile=True))


# ---------------------------------------------------------------- k-p1 · the item page's checks
def k_p1():
  item_desktop('DesktopTareaChecks.html', 'Tarea con comprobaciones', sel='unit-tests', menu_for='unit-tests', menu_top=112, panel=GL[0])
  item_mobile('MobileTareaChecks.html', 'Tarea con comprobaciones')
  item_mobile('MobileTareaChecksRegistro.html', 'Tarea, registro de una comprobación', overlay=log_sheet('gitlab', GL[0]), sel='unit-tests')
  item_mobile('MobileTareaChecksMenu.html', 'Tarea, acciones de una comprobación', overlay=menu_sheet('gitlab', GL[0]), sel='unit-tests')
  states_desktop()
  states_mobile()

# Checks (plans/code-hosts.md, phase 2, P0): the screens of a change request's CI checks and of the fix for
# them. k-p2 is the orchestration's: its checks with a log tail (DesktopOrquestacionChecks, MobileOrquestacionChecks)
# and the state where the fix waits for the person (…ChecksSubir). k-p1 and k-p3 add their own functions below,
# each under its own banner. Imports common.py, data.py and the orchestration's steps from hosts.py; runs on its own.
#   python3 checks.py

# ---------------------------------------------------------------- k-p2 · the orchestration's checks
# A GitLab project (git.inmoseo.net): the noun is MR and the number !14. Its pipeline has a child pipeline, one
# allowed failure and a manual job; GitLab has no annotations, so what stands above a log is the job's
# failure_reason and exit code.
BRANCH = 'orch/spanish-copy'
HEAD = 'a81d3f0'
FIXED = '4f9c1e2'

# word, badge class, icon: a status colour always with its word
ST = {
  'failed': ('fallido', 'b-bad', 'x'),
  'allowed': ('fallo permitido', 'b-warn', 'warn'),
  'running': ('en curso', 'b-live', None),
  'passed': ('superado', 'b-ok', 'check'),
  'skipped': ('omitido', '', 'block'),
}

# name, stage, state, duration, job id
FAILING = [('test:unit', 'test', 'failed', '2:41', 88213), ('lint:i18n', 'test', 'failed', '0:48', 88214)]
ALLOWED = [('audit:deps', 'test', 'allowed', '0:22', 88215)]
RUNNING = [('e2e:chrome', 'e2e · pipeline hijo', 'running', '1:12', 88230)]
PASSED_N = 11

TAIL = [
  ('', '$ pnpm --filter @agentry/core test'),
  ('', ' RUN  v3.2.4 /builds/pagos/api/packages/core'),
  ('', ' ✓ src/orchestration/stages.test.ts (18 tests) 412 ms'),
  ('', ' ✓ src/orchestration/integration.test.ts (9 tests) 1204 ms'),
  ('', ' ❯ src/i18n/glossary.test.ts (6 tests | 1 failed) 87 ms'),
  ('', '   × keeps the es copy in sentence case'),
  ('mark', 'AssertionError: expected "Abrir Merge Request" to equal "Abrir merge request"'),
  ('', '   at src/i18n/glossary.test.ts:41:22'),
  ('', ' Test Files  1 failed | 24 passed (25)'),
  ('', '      Tests  1 failed | 311 passed (312)'),
  ('', '   Duration  2m38s'),
  ('mark', 'ERROR: Job failed: exit code 1'),
]


def spin(size=10):
  return f'<span class="spin-ring" style="width: {size}px; height: {size}px"></span>'


def state_badge(s):
  word, cls, icon = ST[s]
  lead = spin() if s == 'running' else ico(icon, 'ico ico-sm')
  return f'<span class="badge {cls}">{lead}{word}</span>'.replace('badge "', 'badge"')


def check_row(c, on=False, mobile=False):
  name, stage, s, dur, _ = c
  more = (f'<button type="button" class="btn btn-ghost btn-icon {"btn-lg" if mobile else "btn-sm"}" aria-label="Más acciones de {name}">'
          f'{ico("more", "ico", "stroke-width: 3")}</button>')
  d = f'<span class="ochk-dur">{dur or "–"}</span>'
  if mobile:
    sub = f'<span class="row" style="gap: 8px; margin-top: 3px">{state_badge(s)}<span class="ochk-stage">{stage}</span></span>'
    main = (f'<button type="button" class="ochk-main" aria-label="Ver el log de {name}" style="flex-direction: column; align-items: stretch; justify-content: center; gap: 0">'
            f'<span class="row" style="gap: 8px"><span class="ochk-name">{name}</span>{d}</span>{sub}</button>')
  else:
    main = (f'<button type="button" class="ochk-main" aria-label="Ver el log de {name}"><span class="ochk-state">{state_badge(s)}</span>'
            f'<span class="ochk-name">{name}</span><span class="ochk-stage">{stage}</span>{d}</button>')
  return f'<div class="ochk-row{" on" if on else ""}">{main}{more}</div>'


def group(title, rows, mobile=False, open_=None):
  head = f'<div class="ochk-group-head"><span class="t-label">{title}</span><span class="count">{len(rows)}</span></div>'
  return f'<div class="ochk-group">{head}{"".join(check_row(r, r[0] == open_, mobile) for r in rows)}</div>'


def fold(text, mobile=False):
  h = 'min-height: var(--touch)' if mobile else 'height: 32px'
  return (f'<button type="button" class="ochk-fold btn btn-ghost" style="justify-content: flex-start; {h}">'
          f'{ico("right", "ico ico-sm fg-3")}{text}</button>')


def list_body(open_='test:unit', mobile=False):
  return (group('Fallan', FAILING, mobile, open_) + group('Fallo permitido', ALLOWED, mobile)
          + group('En curso', RUNNING, mobile)
          + fold(f'Superados <span class="count">{PASSED_N}</span>', mobile) + fold('Omitidos <span class="count">1</span>', mobile))


def ochk_log_panel(mobile=False):
  c = FAILING[0]
  link = f'<a href="#" class="btn btn-sm" target="_blank" rel="noreferrer" aria-label="Abrir test:unit en GitLab">{ext_ico()}Abrir en GitLab</a>'
  head = '' if mobile else (f'<div class="ochk-log-head"><span class="mono" style="font-size: 13px; font-weight: 500">{c[0]}</span>{state_badge("failed")}'
                            f'<span class="mono t-xs fg-3">{c[3]} · job {c[4]}</span><span class="grow"></span>{link}</div>')
  why = ('<div class="ochk-why"><span class="t-label">Por qué falló</span>'
         '<dl><dt>failure_reason</dt><dd>script_failure</dd><dt>exit code</dt><dd>1</dd></dl>'
         '<span class="t-xs fg-3" style="line-height: 1.45">GitLab no da anotaciones: lo que ves es el motivo del job y el final de su log.</span></div>')
  lines = ''.join(f'<span class="mark">{t}</span>' if k else f'<span>{t}</span>' for k, t in TAIL)
  tail = ('<div class="ochk-tail-note">Últimas 12 de 214 líneas · secretos ocultos</div>'
          f'<pre class="ochk-tail" aria-label="Final del log de test:unit">{lines}</pre>')
  return f'<section class="ochk-log" aria-label="Log de test:unit">{head}{why}{tail}</section>'


def mr_row(ci='failing', state='esperando fusión'):
  return (f'<a href="#" class="pr-row" target="_blank" rel="noreferrer" aria-label="Abrir MR !14 en GitLab" style="min-height: 44px"><span class="pr-num">MR !14</span>'
          f'<span class="pr-branch">{BRANCH} → main</span><span class="badge b-idle">{state}</span>{ci_badge(ci)}{ext_ico()}</a>')


def orch_head():
  return f'''<div class="row" style="gap: 12px">
<a href="DesktopOrquestaciones.html" class="btn btn-icon btn-sm" aria-label="Volver a orquestaciones">{ico('left')}</a>
<h1 class="t-h1">spanish-copy</h1>
<span class="badge b-ok" style="height: 24px">{ico('check', 'ico ico-sm')}completada</span>
<span class="grow"></span>
<button type="button" class="btn">{ico('folder')}Ver worktree</button>
</div>'''


def ochk_summary(text):
  return f'<span class="mono t-xs fg-2" style="font-variant-numeric: tabular-nums">{text}</span>'


def fix_card(mobile=False):
  rows = [
    ('test:unit', True, 'corregido', 'Era de esta rama: el texto «Abrir Merge Request» no seguía el glosario. Ya está corregido y probado en local.'),
    ('lint:i18n', False, 'sin tocar', 'Incierto: falla en un archivo que esta rama no cambia. No he cambiado nada.'),
  ]
  rs = ''.join(f'<div class="ochk-result"><span class="ochk-name">{n}</span>'
               f'<span class="badge{" b-ok" if k else ""}">{ico("check" if k else "block", "ico ico-sm")}{w}</span>'
               f'<span class="why">{t}</span></div>' for n, k, w, t in rows)
  facts = f'<div class="ochk-fix-facts"><span>commit {FIXED}</span><span>3 archivos · +14 −6</span><span>en {BRANCH}</span></div>'
  btns = '' if mobile else (
    f'<div class="row" style="gap: 8px"><span class="t-xs fg-3 grow" style="line-height: 1.45">La MR !14 sigue en el commit {HEAD} hasta que lo subas. Si no te convence, el chat del arreglo sigue abierto.</span>'
    f'<a href="DesktopChat.html" class="btn">{ico("chats")}Ver el chat</a><button type="button" class="btn btn-primary">{ico("branch")}Subir el arreglo</button></div>')
  return ('<section class="ochk-fix grad-border" aria-label="Arreglo listo">'
          '<div class="row" style="gap: 10px"><h2 class="t-h2 grow">Arreglo listo para subir</h2><span class="badge b-idle">te espera</span></div>'
          '<p class="t-sm fg-2" style="margin: 0; line-height: 1.55">Agentry ha corregido 1 de los 2 checks que fallaban y lo ha confirmado en la rama de integración. '
          f'No sube nada hasta que pulses «Subir el arreglo».</p>{facts}<div class="col">{rs}</div>{btns}</section>')


def mr_card_head():
  return '<div class="row" style="gap: 10px"><h2 class="t-h2 grow">Su merge request</h2><span class="mono t-xs fg-2">6/6 ramas de tarea fusionadas</span></div>'


def desktop_main(variant):
  if variant == 'fail':
    acts = (f'<button type="button" class="btn">{ico("retry")}Volver a ejecutar los fallidos</button>'
            f'<button type="button" class="btn">{ico("x")}Cancelar</button><span class="grow"></span>'
            f'<button type="button" class="btn btn-primary">{ico("sparkle")}Arreglar los checks</button>')
    note = (f'<span class="t-xs fg-3" style="line-height: 1.45">Un chat intentará arreglar los checks en el worktree de integración y los confirmará en <span class="mono">{BRANCH}</span>. '
            'Nada se sube hasta que pulses «Subir el arreglo».</span>')
    zone = (f'<section class="card card-pad col" style="gap: 14px">{mr_card_head()}{mr_row()}'
            '<hr style="border: 0; border-top: 1px solid var(--line); margin: 0; width: 100%">'
            f'<div class="row" style="gap: 10px; flex-wrap: wrap"><h2 class="t-h2 grow">Checks</h2>{ochk_summary("2 fallan · 1 fallo permitido · 1 en curso · 11 superados")}</div>'
            f'<div class="row" style="gap: 8px; flex-wrap: wrap">{acts}</div>{note}'
            f'<div style="display: grid; grid-template-columns: minmax(0, 1fr) 440px; gap: 18px; align-items: start"><div class="col" style="gap: 6px">{list_body()}</div>{ochk_log_panel()}</div></section>')
  else:
    zone = (f'<section class="card card-pad col" style="gap: 14px">{mr_card_head()}{mr_row()}</section>{fix_card()}'
            f'<section class="card card-pad col" style="gap: 10px"><div class="row" style="gap: 10px"><h2 class="t-h2 grow">Checks</h2>{ochk_summary(f"commit {HEAD} · 2 fallan · 11 superados")}</div>'
            f'{group("Fallan", FAILING)}{fold(f"Superados <span class=count>{PASSED_N}</span>")}</section>')
  return f'''<main class="page" style="gap: 18px">
{orch_head()}
{orch_steps('wait')}
{zone}
</main>'''


def checks_desktop(name, variant):
  crumb = '<a href="DesktopOrquestaciones.html" class="fg-2">Orquestaciones</a><span class="fg-3">/</span><span style="font-weight: 500">spanish-copy</span>'
  write(name, desktop('Orquestación con checks', 'orch', crumb, desktop_main(variant)))


def m_head():
  return (f'<header class="row" style="flex-shrink: 0; padding: 8px 4px; gap: 2px"><a href="MobileOrquestaciones.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver">{ico("left", "ico ico-lg", "stroke-width: 2")}</a>'
          f'<span class="col grow" style="gap: 2px"><span style="font-weight: 600; font-size: 16px">spanish-copy</span><span class="row t-xs mono c-ok" style="gap: 6px">{ico("check", "ico ico-sm")}completada</span></span>'
          f'<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Más acciones">{ico("more", "ico ico-lg", "stroke-width: 3")}</button></header>')


def ochk_log_sheet():
  c = FAILING[0]
  return f'''{scrim()}
<div class="sheet" role="dialog" aria-label="Log de test:unit" style="z-index: 11; padding-bottom: 20px; display: flex; flex-direction: column; gap: 10px; max-height: 86%">
<div class="grab" style="margin-bottom: 0"></div>
<div class="row" style="gap: 8px"><span class="mono grow" style="font-size: 15px; font-weight: 500">{c[0]}</span><button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Cerrar">{ico("x", "ico ico-lg")}</button></div>
<div class="row" style="gap: 8px; flex-wrap: wrap">{state_badge("failed")}<span class="mono t-xs fg-3">{c[3]} · job {c[4]}</span></div>
<div style="overflow: hidden; display: flex; flex-direction: column; min-height: 0">{ochk_log_panel(True)}</div>
<a href="#" class="btn btn-lg" style="justify-content: center" target="_blank" rel="noreferrer">{ext_ico("ico ico-lg")}Abrir en GitLab</a>
</div>'''


def checks_mobile(name, variant):
  chips = ''.join(f'<span class="badge b-ok" style="height: 28px; flex-shrink: 0">✓ {s}</span>' for s in ['etapas', 'integración', 'verificación'])
  chips += '<span class="badge b-idle" style="height: 28px; flex-shrink: 0">MR !14</span>'
  mr = (f'<a href="#" class="pr-row" target="_blank" rel="noreferrer" aria-label="Abrir MR !14 en GitLab"><span class="pr-num">MR !14</span><span class="pr-branch">{BRANCH} → main</span>'
        f'<span class="badge b-idle">esperando fusión</span>{ci_badge("failing")}</a>')
  if variant == 'fail':
    body = (f'<section class="card col" style="padding: 14px; gap: 10px">{mr}'
            f'<span class="t-label">Checks</span>{ochk_summary("2 fallan · 1 fallo permitido · 1 en curso · 11 superados")}'
            f'<div class="col" style="gap: 4px">{list_body(None, True)}</div></section>')
    foot = (f'<div class="m-foot"><button type="button" class="btn btn-lg">{ico("retry", "ico ico-lg")}Volver a ejecutar</button>'
            f'<button type="button" class="btn btn-lg btn-primary grow" style="justify-content: center">{ico("sparkle", "ico ico-lg")}Arreglar los checks</button></div>')
    sheet_ = ochk_log_sheet()
  else:
    body = (f'<section class="card col" style="padding: 14px; gap: 10px">{mr}</section>{fix_card(True)}'
            f'<section class="card col" style="padding: 14px; gap: 6px"><div class="row"><span class="t-label grow">Checks</span>{ochk_summary(f"commit {HEAD}")}</div>'
            f'{group("Fallan", FAILING, True)}</section>')
    foot = (f'<div class="m-foot"><a href="MobileChat.html" class="btn btn-lg">{ico("chats", "ico ico-lg")}Ver el chat</a>'
            f'<button type="button" class="btn btn-lg btn-primary grow" style="justify-content: center">{ico("branch", "ico ico-lg")}Subir el arreglo</button></div>')
    sheet_ = ''
  inner = f'{m_head()}\n<div class="m-body" style="gap: 14px"><div class="row" style="gap: 6px; overflow: hidden">{chips}</div>{body}</div>\n{foot}\n{sheet_}'
  write(name, mobile('Orquestación con checks', inner, 'glow-top', 'background-size: 100% 300px'))


# ================================================================ k-p3 · the fix states and the decision
# One work item, AGN-26, on a GitLab project: its MR !12 has three failing checks on the head a1b2c3d. What
# changes from screen to screen is who started the fix (a person's click or the checks.fix decision) and
# how far it got (fixing, awaiting-verify, waiting for "Subir el arreglo").
REF = 'MR !12'
FIX_HEAD = 'a1b2c3d'
ORIGIN = {'person': 'a petición tuya', 'decision': 'decidido por checks.fix'}

# name, duration, what the Developer's result says: (cause, fixed, sentence)
FIX_FAILING = [
  ('lint', '0:42', ('branch', True, 'Lo rompía esta rama: una importación sin usar en la plantilla nueva.')),
  ('unit', '3:18', ('branch', True, 'Lo rompía esta rama: la prueba esperaba el orden antiguo de las columnas.')),
  ('docs-links', '1:05', ('not-branch', False, 'No es de esta rama: el sitio enlazado no respondía.')),
]
# A failure that is allowed (allow_failure): a warning on the host, never sent to the Developer
FIX_ALLOWED = ('e2e', '5:02')


def pframe(inner, pad='14px', height=None):
  h = f'height: {height}px' if height else 'height: auto'
  return (f'<div class="app m-screen" data-theme="dark" style="width: 390px; {h}; border-radius: var(--r-xl); border: 1px solid var(--line-2); overflow: hidden; padding: {pad}">'
          f'{inner}</div>')


def attempts(used, of, count=False):
  """Attempts of those allowed for this head, in words and in segments: neutral, because running out is
  not a status the way a failure is. On a fix that runs it says which attempt it is; before one starts
  (count=True) it says how many are used."""
  segs = ''.join(f'<i class="used"></i>' if i < used else '<i></i>' for i in range(of))
  word = f'{used} de {of} usados' if count else f'intento {used} de {of}'
  return f'<span class="fix-attempts" aria-label="{used} de {of} intentos usados"><span>{word}</span><span class="segbar attempts" aria-hidden="true">{segs}</span></span>'


# ---------------------------------------------------------------- the board card and its strips
def fix_strip(state, origin='person', n=1, of=2):
  """What the card's strip says in each state. The Developer and QA at work are live (cyan, braille, rail);
  the wait for the person is idle; spent attempts are a warn stop."""
  if state == 'fixing':
    return live_strip('DEV', f'Arregla {len(FIX_FAILING)} checks de la {REF}', '1:48', f'intento {n} de {of} · {ORIGIN[origin]}')
  if state == 'verify':
    tail = 'se sube sola si la da por buena' if origin == 'person' else 'esperará tu «Subir el arreglo»'
    return live_strip('QA', 'Verifica el arreglo', '0:52', f'{REF} · intento {n} de {of} · {tail}')
  if state == 'push':
    return (f'<div class="wi-strip wait"><span class="badge b-idle">te espera</span><span class="verb">QA dio por bueno el arreglo</span>'
            f'<span class="detail" style="padding-left: 0">{REF} sigue con la CI fallida de <span class="mono">{FIX_HEAD}</span> · intento {n} de {of}</span>'
            f'<button type="button" class="btn btn-sm">{ico("move", "ico ico-sm")}Subir el arreglo</button></div>')
  return (f'<div class="wi-strip warn" role="status">{ico("warn", "ico", "color: var(--warn)")}'
          f'<span class="verb"><b style="color: var(--warn); font-weight: 600">Sin intentos</b> · la CI sigue fallida tras {of} arreglos</span>'
          f'<span class="detail">{REF} · límite de {of} por commit · <span class="mono">{FIX_HEAD}</span></span></div>')


BOARD_STATES = [
  ('fixing', 'person', 'fixing · person', 'En curso',
   'Tu clic mueve la tarjeta a En curso, como un movimiento tuyo, con la causa pr.checks-fix. El desarrollador empieza con los checks fallidos en su prompt.'),
  ('fixing', 'decision', 'fixing · decision', 'En curso',
   'Lo mueve el sistema, con la misma causa. La tarjeta dice quién lo ha empezado: la decisión, no tú.'),
  ('verify', 'person', 'awaiting-verify · person', 'En revisión',
   'QA verifica como siempre. Tu clic quedó recordado: si da el arreglo por bueno, se sube solo, sin segundo clic.'),
  ('verify', 'decision', 'awaiting-verify · decision', 'En revisión',
   'QA verifica igual. Lo que empezó la decisión no se sube solo, ni aprobado.'),
  ('push', 'decision', 'waiting · approval', 'En revisión',
   'El arreglo de una decisión espera en En revisión. «Subir el arreglo» es siempre un clic tuyo. Es neutro en la tarjeta: el degradado es de la página.'),
  ('spent', 'decision', 'sin intentos', 'En revisión',
   'Los intentos de este commit se han gastado: la decisión no empieza otro. Tú sí puedes, desde la tarea.'),
]


def board_row(state, origin, code, column, note):
  strip = fix_strip(state, origin, n=2 if state == 'spent' else 1)
  who = 'DEV' if state == 'fixing' else 'QA' if state == 'verify' else None
  head = (f'<div class="col" style="gap: 6px"><span class="mono t-sm" style="font-weight: 500">{code}</span>'
          f'<span class="row t-xs fg-2" style="gap: 6px">{sico("in_progress" if column == "En curso" else "in_review")}{column}</span>'
          f'<span class="t-xs fg-3" style="line-height: 1.45">{note}</span></div>')
  return (f'<div style="display: grid; grid-template-columns: 240px 340px 390px; gap: 48px; align-items: start; padding: 18px 0; border-top: 1px solid var(--line)">'
          f'{head}{card("AGN-26", who=who, strip=strip)}'
          f'{pframe(f"<div class=m-body style=gap:12px;overflow:visible>{mrow("AGN-26", who=who, strip=strip)}</div>", pad="14px 0 16px")}</div>')


def board_section():
  cols = ('<div style="display: grid; grid-template-columns: 240px 340px 390px; gap: 48px; padding-bottom: 8px">'
          '<span class="t-label">Estado</span><span class="t-label">Tarjeta del tablero</span><span class="t-label">Móvil</span></div>')
  rows = ''.join(board_row(*s) for s in BOARD_STATES)
  return (f'<section class="col" style="gap: 0"><span class="t-label" style="padding-bottom: 14px">La tarjeta mientras se arregla</span>{cols}{rows}</section>')


# ---------------------------------------------------------------- the item page
def check_rows(results=False, skipped=True):
  """The checks the Developer received. Each is a failure on the host (a bad badge with its word); once the
  Developer has run, the result says whether the branch caused it and whether it was fixed."""
  out = []
  for name, dur, (cause, fixed, sentence) in FIX_FAILING:
    why = ''
    if results:
      word = '<span class="c-ok" style="font-weight: 500">Arreglado</span>' if fixed else '<span style="font-weight: 500; color: var(--fg)">Sin cambios</span>'
      why = f'<span class="verdict">{word} · {sentence}</span>'
    out.append(f'<li class="fix-check"><span class="name">{name}</span><span class="badge b-bad">{ico("x", "ico ico-sm")}fallido</span><span class="dur">{dur}</span>{why}</li>')
  if skipped:
    out.append(f'<li class="fix-check skipped"><span class="name">{FIX_ALLOWED[0]}</span><span class="badge b-warn">puede fallar</span><span class="dur">{FIX_ALLOWED[1]}</span>'
               f'<span class="verdict">Se permite que falle: no se envía al desarrollador.</span></li>')
  return f'<ul class="fix-checks" aria-label="Checks">{"".join(out)}</ul>'


def fix_panel(state, origin, mobile=False):
  size = 'btn btn-lg' if mobile else 'btn btn-sm'
  chat = f'<a href="DesktopChatTarea.html" class="{size}">{ico("chats", "ico ico-sm")}Ver el chat'
  if state == 'fixing':
    sub = (f'Lo has pedido tú. Si QA da por bueno el arreglo, se sube solo. Mover la tarjeta mientras tanto retira ese permiso.' if origin == 'person'
           else 'Lo ha decidido <span class="mono">checks.fix</span> con confianza <span class="mono">0,91</span>. Cuando QA lo dé por bueno, te esperará para subirlo.')
    return (f'<section class="fix-panel live rail-live" aria-label="Arreglo de los checks"><div class="fix-head">'
            f'<div class="col grow" style="gap: 4px"><span class="fix-title"><span class="spin-braille" aria-hidden="true"></span>El desarrollador arregla los checks<time class="mono t-xs fg-3" style="font-weight: 400">1:48</time></span><span class="fix-sub">{sub}</span></div>'
            f'{attempts(1, 2)}</div>{check_rows()}<div class="fix-foot">{chat} del desarrollador</a></div></section>')
  if state == 'verify':
    sub = ('Tu clic quedó recordado: si QA da el arreglo por bueno, se sube solo. Mover la tarjeta mientras tanto retira ese permiso.' if origin == 'person'
           else 'Lo empezó <span class="mono">checks.fix</span>: aunque QA lo apruebe, no se sube hasta que lo hagas tú.')
    return (f'<section class="fix-panel live rail-live" aria-label="Arreglo de los checks"><div class="fix-head">'
            f'<div class="col grow" style="gap: 4px"><span class="fix-title"><span class="spin-braille" aria-hidden="true"></span>QA verifica el arreglo<time class="mono t-xs fg-3" style="font-weight: 400">0:52</time></span><span class="fix-sub">{sub}</span></div>'
            f'{attempts(1, 2)}</div>{check_rows(results=True, skipped=False)}<div class="fix-foot">{chat} de QA</a></div></section>')
  primary = 'btn btn-lg btn-primary' if mobile else 'btn btn-sm btn-primary'
  wide = ' style="flex: 1 1 100%; justify-content: center"' if mobile else ''
  return (f'<section class="fix-panel wait" aria-label="Arreglo de los checks"><div class="fix-head">'
          f'<div class="col grow" style="gap: 4px"><span class="fix-title">{ico("wait", "ico", "color: var(--idle)")}QA dio por bueno el arreglo<span class="badge b-idle">te espera</span></span>'
          f'<span class="fix-sub">Nada se ha subido todavía: la {REF} sigue con el commit <span class="mono">{FIX_HEAD}</span>. Al subirlo, la {REF} recoge el commit nuevo y la CI vuelve a correr.</span></div>'
          f'{attempts(1, 2)}</div>{check_rows(results=True, skipped=False)}'
          f'<div class="fix-foot"><button type="button" class="{primary}"{wide}>{ico("move", "ico ico-sm")}Subir el arreglo</button>'
          f'<a href="DesktopCambios.html" class="{size}">{ico("git", "ico ico-sm")}Ver el diff</a>'
          f'<span class="grow"></span><span class="mono t-xs fg-3" style="font-variant-numeric: tabular-nums">+18 −6 · 2 archivos</span></div></section>')


def item_status(state):
  if state == 'fixing':
    return f'<span class="badge">{sico("in_progress")}en curso</span><span class="badge"><span class="spin-braille" aria-hidden="true"></span>arreglando checks</span>'
  if state == 'verify':
    return f'<span class="badge">{sico("in_review")}en revisión</span><span class="badge"><span class="spin-braille" aria-hidden="true"></span>QA verifica</span>'
  return f'<span class="badge">{sico("in_review")}en revisión</span><span class="badge b-idle">espera tu subida</span>'


def item_excerpt(state, origin, mobile=False):
  mr = (f'<a href="#" class="pr-row" target="_blank" rel="noreferrer" aria-label="Abrir {REF} en GitLab"><span class="pr-num">{REF}</span>'
        f'<span class="pr-branch">{MR_BRANCH}</span>{ci_badge("failing")}{ext_ico()}</a>')
  if mobile:
    head = (f'<div class="row" style="gap: 6px; flex-wrap: wrap"><a href="MobileTablero.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver al tablero" style="margin-left: -10px">{ico("left", "ico ico-lg", "stroke-width: 2")}</a>'
            f'{tico("story", True)}<span class="wi-key boxed">AGN-26</span></div>'
            f'<div class="row" style="gap: 6px; flex-wrap: wrap">{item_status(state)}</div>'
            f'<h1 class="t-h2" style="font-size: 17px; line-height: 1.35">Plantillas de proyecto</h1>')
    return (f'<div class="col" style="gap: 12px">{head}<span class="t-label" style="padding: 0 2px">Su merge request</span>{mr}{fix_panel(state, origin, True)}</div>')
  head = (f'<div class="row" style="gap: 10px; flex-wrap: wrap"><a href="DesktopTablero.html" class="btn btn-icon btn-sm" aria-label="Volver al tablero">{ico("left")}</a>'
          f'{tico("story", True)}<span class="wi-key boxed">AGN-26</span>{item_status(state)}<span class="grow"></span>'
          f'<a href="DesktopChatTarea.html" class="btn btn-sm">{ico("chats", "ico ico-sm")}Ver el chat</a></div>')
  return (f'<div class="card col" style="padding: 18px; gap: 14px">{head}<h1 class="t-h1" style="font-size: 22px">Plantillas de proyecto</h1>'
          f'<div class="row" style="gap: 10px"><h2 class="t-h2 grow">Su merge request</h2></div>{mr}{fix_panel(state, origin)}</div>')


ITEM_STATES = [
  ('fixing', 'decision', 'fixing', 'La decisión ha empezado el arreglo; la tarea ya está en En curso. La zona dice quién, con qué confianza y en qué intento va.'),
  ('verify', 'person', 'awaiting-verify', 'El desarrollador ha terminado. Por cada check, su veredicto: arreglado, o sin cambios si no era de esta rama. QA verifica.'),
  ('push', 'decision', 'waiting · approval', '«Subir el arreglo» es la única acción primaria de la zona, con el degradado. Aún no se ha subido nada: la MR sigue con la CI fallida.'),
]


def item_section():
  rows = ''
  for state, origin, code, note in ITEM_STATES:
    head = (f'<div class="col" style="gap: 6px"><span class="mono t-sm" style="font-weight: 500">{code}</span>'
            f'<span class="row t-xs fg-2" style="gap: 6px">{ORIGIN[origin]}</span><span class="t-xs fg-3" style="line-height: 1.45">{note}</span></div>')
    rows += (f'<div style="display: grid; grid-template-columns: 220px minmax(0, 1fr) 390px; gap: 40px; align-items: start; padding: 18px 0; border-top: 1px solid var(--line)">'
             f'{head}{item_excerpt(state, origin)}{pframe(item_excerpt(state, origin, True))}</div>')
  return f'<section class="col" style="gap: 0"><span class="t-label" style="padding-bottom: 14px">La página de la tarea</span>{rows}</section>'


# ---------------------------------------------------------------- the fix dialog and its Sheet
def dialog_notes(variant, mobile=False):
  note = (f'<div class="callout" style="align-items: flex-start">{ico("info", "ico", "flex-shrink: 0; color: var(--fg-3); margin-top: 1px")}'
          f'<span>Como lo pides tú, el arreglo se sube solo cuando QA lo dé por bueno. Mover la tarjeta antes retira ese permiso.</span></div>')
  if variant == 'beyond':
    note += (f'<div class="callout callout-warn" style="align-items: flex-start">{ico("warn", "ico", "flex-shrink: 0; color: var(--warn); margin-top: 1px")}'
             f'<span><b style="color: var(--fg); font-weight: 500">Los 2 intentos de este commit ya están hechos.</b> El límite solo frena a las decisiones: tú puedes intentarlo otra vez, y este sería el tercero.</span></div>')
  return note


def dialog_facts(variant):
  used = 0 if variant == 'first' else 2
  left = 2 - used
  word = '2 intentos disponibles' if left == 2 else 'Sin intentos de decisión'
  cell = lambda k, v: f'<div class="col" style="gap: 4px; min-width: 0"><span class="t-label">{k}</span>{v}</div>'
  return ('<div class="row" style="gap: 12px 28px; flex-wrap: wrap; align-items: flex-start">'
          + cell('Lo arregla', '<span class="mono t-sm">Desarrollador · sonnet</span>')
          + cell('Worktree', '<span class="mono t-sm">task/agn-26</span>')
          + cell('Intentos con este commit', f'<span class="row" style="gap: 10px">{attempts(used, 2, True)}<span class="t-xs fg-2">{word}</span></span>')
          + '</div>')


def fix_dialog(variant):
  body = (f'<p class="t-sm fg-2" style="margin: 0; line-height: 1.55">El desarrollador de la tarea recibe el final del log de cada check fallido y arregla lo que haya roto esta rama. '
          f'No sube nada por su cuenta.</p>'
          f'<div class="col" style="gap: 8px"><span class="t-label">Checks que recibe</span>{check_rows()}'
          f'<span class="t-xs fg-3">Los 5 checks superados no se envían.</span></div>'
          f'{dialog_notes(variant)}{dialog_facts(variant)}')
  dialog = f'''<div class="scrim" style="z-index: 5">
<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="fix-title-{variant}" style="width: 560px">
<div class="dialog-head">{ico("git", "ico fg-3")}<div class="col grow" style="gap: 2px"><h2 id="fix-title-{variant}" class="t-h2">Arreglar los checks de la {REF}</h2><span class="mono t-xs fg-3">{MR_BRANCH} · {FIX_HEAD}</span></div><button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Cerrar">{ico("x")}</button></div>
<div class="dialog-body">{body}</div>
<div class="dialog-foot"><span class="grow"></span><button type="button" class="btn btn-ghost">Cancelar</button><button type="button" class="btn btn-primary">Arreglar {len(FIX_FAILING)} checks</button></div>
</div></div>'''
  return (f'<div class="app" data-theme="dark" style="position: relative; width: 640px; height: 800px; border-radius: var(--r-xl); border: 1px solid var(--line-2); overflow: hidden; background: var(--bg-1)">{dialog}</div>')


def fix_sheet(variant):
  mr = (f'<a href="#" class="pr-row" aria-label="Abrir {REF} en GitLab"><span class="pr-num">{REF}</span><span class="pr-branch">{MR_BRANCH}</span>{ci_badge("failing")}{ext_ico()}</a>')
  behind = f'<div class="m-body" style="gap: 12px"><div class="row" style="gap: 6px">{tico("story", True)}<span class="wi-key boxed">AGN-26</span></div>{mr}</div>'
  sheet = f'''{dec.scrim()}
<div class="sheet" role="dialog" aria-label="Arreglar los checks" style="z-index: 11; padding-bottom: 28px; display: flex; flex-direction: column; gap: 12px; max-height: 96%; overflow: hidden">
<div class="grab" style="margin-bottom: 0"></div>
<div class="col" style="gap: 2px"><h2 class="t-h2">Arreglar los checks de la {REF}</h2><span class="mono t-xs fg-3">{MR_BRANCH} · {FIX_HEAD}</span></div>
<p class="t-sm fg-2" style="margin: 0; line-height: 1.5">El desarrollador recibe el final del log de cada check fallido y arregla lo que haya roto esta rama. No sube nada por su cuenta.</p>
<div class="col" style="gap: 8px"><span class="t-label">Checks que recibe</span>{check_rows()}</div>
{dialog_notes(variant, True)}{dialog_facts(variant)}
<div class="row" style="gap: 8px"><button type="button" class="btn btn-lg">Cancelar</button><button type="button" class="btn btn-lg btn-primary grow" style="justify-content: center">Arreglar {len(FIX_FAILING)} checks</button></div>
</div>'''
  return pframe(behind + sheet, pad='0', height=960)


def dialog_section():
  rows = ''
  for variant, title, note in [
      ('first', 'Primer intento', 'Qué checks recibe el desarrollador, qué se queda fuera y cuántos intentos quedan. Un clic en «Arreglar» es la aprobación de subirlo tras QA.'),
      ('beyond', 'Intentos de decisión agotados', 'El límite del proyecto (2 por commit) frena a checks.fix, no a la persona: se dice, y el intento cuenta.')]:
    rows += (f'<div class="col" style="gap: 12px"><div class="col" style="gap: 4px"><span class="t-sm" style="font-weight: 600">{title}</span><span class="t-xs fg-3" style="line-height: 1.45; max-width: 760px">{note}</span></div>'
             f'<div style="display: grid; grid-template-columns: 640px 390px; gap: 48px; align-items: start">{fix_dialog(variant)}{fix_sheet(variant)}</div></div>')
  return f'<section class="col" style="gap: 28px"><span class="t-label">El diálogo de arreglar, y su Sheet en el móvil</span>{rows}</section>'


# ---------------------------------------------------------------- checks.fix in Settings → Decisions
CHECKS_FIX = ('checks.fix', 'Decidir si arreglar los checks fallidos de una rama', 'A', 'P', 7)
GROUP_NAME = 'Alojamiento del código'
# count, acted, mean confidence, agreement (%, n): did the pushed head turn the rollup passing, useful,
# not useful, unavailable, cost, runs saved
METRICS_CHECKS = ('14', '57 %', '0,90', ('86 %', '7'), '3', '0', '0', '0,004 US$', '0')


@contextmanager
def with_point(mode='off'):
  """The Decisions tab with the 23rd point: a group of its own, between Revisión and Avisos."""
  nested = CHECKS_FIX in dec.POINTS
  saved = (dec.POINTS, dec.GROUPS, dec.point_row)
  if not nested:
    dec.GROUPS = dec.GROUPS[:7] + [GROUP_NAME] + dec.GROUPS[7:]
    dec.POINTS = [(p[0], p[1], p[2], p[3], p[4] + 1 if p[4] >= 7 else p[4]) for p in dec.POINTS] + [CHECKS_FIX]
  dec.METRICS['j'] = METRICS_CHECKS
  if not nested:
    dec.point_row = lambda p, cli, _row=dec.point_row: with_notes(_row(p, cli)) if p[0] == 'checks.fix' else _row(p, cli)
  was = dec.STATE.get('checks.fix')
  dec.STATE['checks.fix'] = {'off': ('off', 0.85, None, None), 'shadow': ('shadow', 0.85, ('ok', 1), 'j'), 'active': ('active', 0.85, ('ok', 1), 'j')}[mode]
  try:
    yield
  finally:
    if was is not None:
      dec.STATE['checks.fix'] = was
    else:
      dec.STATE.pop('checks.fix', None)
    if not nested:
      dec.POINTS, dec.GROUPS, dec.point_row = saved
      dec.METRICS.pop('j', None)


def limits_notes():
  return (f'<div class="dp-note" style="align-items: flex-start">{ico("info", "ico ico-sm", "flex-shrink: 0; margin-top: 2px")}<span>'
          f'Pregunta si los cambios de la rama han causado los fallos, de un modo que el desarrollador pueda arreglar: <span class="mono">branch-fixable</span>, <span class="mono">not-branch</span> o <span class="mono">needs-person</span>. '
          f'Solo la primera, por encima del umbral, empieza un arreglo.</span></div>'
          f'<div class="dp-note" style="align-items: flex-start">{ico("lock", "ico ico-sm", "flex-shrink: 0; margin-top: 2px")}<span>'
          f'Además, quedan intentos con el commit (<span class="mono">2</span>; se cambian en <a href="DesktopProyectoAjustes.html" class="pr-remedy">Ajustes del proyecto</a>), el flujo tiene hueco y no se ha gastado su límite de coste. '
          f'Lo que arregla espera «Subir el arreglo»: nunca se sube solo.</span></div>')


def with_notes(r):
  """A point's row with what limits it, before its metrics."""
  notes = limits_notes()
  if '<div class="dp-metrics"' in r:
    return r.replace('<div class="dp-metrics"', notes + '<div class="dp-metrics"', 1)
  return r[:r.rindex('</div>')] + notes + '</div>'


def point_mcell(mode):
  badge = {'off': '<span class="fg-3">Apagado</span>', 'shadow': '<span class="badge">Sombra</span>', 'active': '<span class="badge b-accent">Activo</span>'}[mode]
  return (f'<a href="#" class="cell stacked" style="min-height: 64px"><span class="row" style="gap: 10px"><span class="grow" style="font-weight: 500; font-size: 14px; line-height: 1.35">{CHECKS_FIX[1]}</span>{ico("right", "ico fg-3")}</span>'
          f'<span class="row t-xs" style="gap: 10px"><span class="mono fg-3 ellipsis grow">checks.fix</span><span class="fg-2">Actúa</span>{badge}</span></a>')


def point_sheet_checks(mode='active'):
  with with_point(mode):
    m, thr, consent, mk = dec.state_of('checks.fix', False)
    metrics = dec.metrics_grid(mk, False)
    sheet = f'''{dec.scrim()}
<div class="sheet" role="dialog" aria-label="{CHECKS_FIX[1]}" style="z-index: 11; padding-bottom: 28px; display: flex; flex-direction: column; gap: 14px; max-height: 96%; overflow: hidden">
<div class="grab" style="margin-bottom: 0"></div>
<div class="col" style="gap: 2px"><h2 class="t-h2">{CHECKS_FIX[1]}</h2><span class="mono t-xs fg-3">checks.fix · por proyecto · Actúa</span></div>
<div class="col" style="gap: 8px"><span class="t-label">Modo</span>{dec.seg("Modo de checks.fix", dec.MODES, m, phone=True)}</div>
<div class="col" style="gap: 2px"><span class="row"><span class="t-label grow">Umbral</span><span class="mono t-sm">{dec.num(thr)}</span></span>{dec.slider(thr, label="Umbral de checks.fix")}<span class="form-hint">Actúa solo si la confianza lo supera; si no, no empieza nada.</span></div>
<div class="callout" style="align-items: flex-start">{ico("lock", "ico", "flex-shrink: 0; color: var(--fg-3); margin-top: 1px")}<span>Solo arregla si quedan intentos con el commit (<span class="mono">2</span>), el flujo tiene hueco y no se ha gastado su límite de coste. Lo que arregla espera «Subir el arreglo».</span></div>
<div class="row" style="gap: 10px"><span class="t-label grow">Consentimiento</span>{dec.consent_cell(consent, m)}</div>
<div class="col" style="gap: 8px"><span class="t-label">Últimos 7 días</span>{metrics}</div>
<div class="row" style="gap: 8px"><a href="MobileProyectoAjustes.html" class="btn btn-lg grow" style="justify-content: center">Intentos por commit</a><button type="button" class="btn btn-lg grow">Ver en el historial</button></div>
</div>'''
  return sheet


def decision_section():
  rows, cells = '', ''
  caps = {'off': 'Apagado, como empieza todo punto', 'shadow': 'Sombra: pregunta y compara, no arranca nada', 'active': 'Activo: por encima del umbral empieza un arreglo'}
  for mode in ('off', 'shadow', 'active'):
    with with_point(mode):
      row = dec.point_row(CHECKS_FIX, False)
    rows += (f'<div class="col" style="gap: 8px"><span class="t-sm" style="font-weight: 600">{caps[mode]}</span>'
             f'<div class="card" style="overflow: hidden"><div class="dp-group"><div class="dp-group-head"><span class="t-label grow">{GROUP_NAME}</span><span class="mono t-xs fg-3">1</span></div>{row}</div></div></div>')
    cells += point_mcell(mode)
  phone = pframe(f'<div class="col" style="gap: 6px"><span class="t-label" style="padding: 0 4px">{GROUP_NAME}</span><div class="card" style="overflow: hidden">{cells}</div></div>')
  intro = ('<p class="t-sm fg-2" style="margin: 0; max-width: 820px; line-height: 1.5">Un punto más en la pestaña Decisiones de Ajustes, en un grupo propio entre Revisión y Avisos: 23 puntos en 10 grupos. '
           'Es un punto que actúa, por proyecto y apagado de entrada. Con el CLI como proveedor no hay confianza calibrada, así que «Activo» sigue pidiendo Jev, como en los demás puntos que actúan.</p>')
  return (f'<section class="col" style="gap: 14px"><span class="t-label">checks.fix en Ajustes → Decisiones</span>{intro}'
          f'<div style="display: grid; grid-template-columns: minmax(0, 1fr) 390px; gap: 40px; align-items: start"><div class="col" style="gap: 22px">{rows}</div>'
          f'<div class="col" style="gap: 8px"><span class="t-sm" style="font-weight: 600">Móvil: la lista, y la hoja de un punto</span>{phone}'
          f'{pframe(point_sheet_checks_behind(), pad="0", height=900)}</div></div></section>')


def point_sheet_checks_behind():
  return f'<div class="m-body" style="gap: 12px"><div class="col" style="gap: 6px"><span class="t-label" style="padding: 0 4px">{GROUP_NAME}</span><div class="card" style="overflow: hidden">{point_mcell("active")}</div></div></div>' + point_sheet_checks('active')


# ---------------------------------------------------------------- the sheet of rules and the page
RULES = [
  ('01', 'Quien lo pide decide quién lo sube',
   'Un arreglo que pides tú se sube solo cuando QA lo da por bueno: tu clic ya era la aprobación. Uno que empieza checks.fix espera «Subir el arreglo», siempre un clic tuyo. Mover la tarjeta entre medias retira el permiso.'),
  ('02', 'Solo se mueve lo que trabaja',
   'El desarrollador y QA son agentes en marcha: rail, braille y tiempo en cian. Esperarte a ti no se mueve: es idle, con la palabra «te espera». Los intentos gastados son un alto en aviso, con su palabra.'),
  ('03', 'Una acción primaria por zona',
   '«Arreglar {n} checks» y «Subir el arreglo» son el degradado de su zona y nunca coinciden: uno antes del arreglo, el otro cuando espera. En la tarjeta del tablero y en el móvil de la lista, neutros.'),
  ('04', 'Los intentos se ven',
   'Intento n de m, en mono y con sus tramos neutros. El límite del proyecto frena a la decisión, no a la persona: el diálogo lo dice y el intento cuenta igual.'),
]


def rules_section():
  cards = ''.join(f'<div class="card col" style="padding: 18px; gap: 8px"><span class="mono t-xs fg-3">{n}</span><h2 class="t-h2">{t}</h2>'
                  f'<p class="t-sm fg-2" style="margin: 0; line-height: 1.5">{x.replace("{n}", str(len(FIX_FAILING)))}</p></div>' for n, t, x in RULES)
  return f'<section style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px">{cards}</section>'


DS_HEIGHT = 7900


def ds_checks():
  head = ('<header class="col" style="gap: 8px"><span class="t-label">Agentry design system · alojamientos de código · checks</span>'
          '<h1 class="t-display" style="margin: 0">Arreglar los checks</h1>'
          '<p class="fg-2" style="margin: 0; max-width: 900px; line-height: 1.55">Qué ve la persona mientras Agentry arregla los checks fallidos de una MR o una PR: la tarjeta, la página de la tarea, '
          'el diálogo que lo empieza y el punto de decisión que puede empezarlo solo. Una palabra junto a cada color, una acción primaria por zona, y nada se sube sin que lo haya aprobado una persona.</p></header>')
  sections = [rules_section(), board_section(), item_section(), dialog_section(), decision_section()]
  body = (f'<div class="app col" data-theme="dark" style="width: 1440px; height: {DS_HEIGHT}px; padding: 56px 64px; gap: 40px; overflow: hidden">'
          f'{head}{"".join(sections)}</div>')
  write('DSChecks.html', page('Design system · Checks', body))


def captured(fn, *a, **kw):
  """Runs a decisions.py generator that writes one screen and returns its HTML instead."""
  got, real = [], dec.write
  dec.write = lambda name, html: got.append(html)
  try:
    fn(*a, **kw)
  finally:
    dec.write = real
  return got[0]


# Where the point sits behind the viewport, measured in Chrome (see the report of k-p3)
DESKTOP_OFFSET = 3330
MOBILE_OFFSET = 3475


def decisions_desktop():
  with with_point('active'):
    h = captured(dec.desktop_page, 'x', 'Ajustes, decisión de arreglar checks', offset=DESKTOP_OFFSET, tall=1024)
  h = h.replace('22 puntos · 9 grupos', '23 puntos · 10 grupos')
  write('DesktopAjustesDecisionesChecks.html', h)


def decisions_mobile():
  with with_point('active'):
    h = captured(dec.mobile_page, 'x', 'Ajustes, un punto de decisión: arreglar checks', sheet=point_sheet_checks('active'), offset=MOBILE_OFFSET)
  write('MobileAjustesDecisionesChecks.html', h)


def all_k_p3():
  ds_checks()
  decisions_desktop()
  decisions_mobile()




# ---------------------------------------------------------------- run
if __name__ == '__main__':
  k_p1()
  checks_desktop('DesktopOrquestacionChecks.html', 'fail')
  checks_desktop('DesktopOrquestacionChecksSubir.html', 'push')
  checks_mobile('MobileOrquestacionChecks.html', 'fail')
  checks_mobile('MobileOrquestacionChecksSubir.html', 'push')
  all_k_p3()
