# Issue trackers (plans/code-hosts.md, phase 5, P0 t-p3): importing issues into work items, the issue chips of the
# item page with their sync state, and the issue key on the board card. GitHub Issues and GitLab Issues only: YouTrack
# waited for the recordings of t0b and uses the same screens. The other P0 tasks of the phase (t-p1, the
# Integrations → Trackers screen; t-p2, the project's tracker) have their own functions in trackers.py; this file
# runs on its own and imports common.py, data.py, board.py, tasks.py, reviews.py and hosts.py.
#   python3 trackers_import.py
from data import *
from board import head as bhead, toolbar, epics_first, mhead, mrow, msection, jump, mtoolbar, mproject_chip
from common import P, ico, desktop, mobile, write, tabbar, page
from decisions import scrim
from tasks import _captured, _swap, detail_mr_desktop, detail_mr_mobile
from hosts import mono_ico
import reviews as rev

P.update({
  # an open circle with its centre dot: the sign of an issue on every tracker
  'issue': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 12h.01',
})
P.setdefault('ext', EXT_PATH)

# ---------------------------------------------------------------- data
# host -> tracker's name, host's name, the CLI and its oldest version, the project's scope as the tracker names it,
# the placeholder of the query field and what the query is
TRK = {
  'github': dict(name='GitHub Issues', host='GitHub', cli='gh', ver='2.92.0', scope='yeyo/claude-wrapper', cr='PR'),
  'gitlab': dict(name='GitLab Issues', host='GitLab', cli='glab', ver='1.120.0', scope='pagos/api', cr='MR'),
}

# issue.triage's answer per issue (docs/plans/code-hosts.md, "Phase 5"): word, badge class, icon, what it says.
# A suggestion is not a status: only "ready" takes the accent, the one that needs a person is idle, and "not for
# agents" is neutral. A mark only helps to choose; nothing is imported or moved because of it.
MARK = {
  'ready': ('lista', 'b-accent', 'code', 'Un agente puede empezar con el issue tal como está escrito.'),
  'refine': ('por refinar', 'b-idle', 'edit', 'Falta el objetivo o cómo saber que está hecho.'),
  'person': ('no es para agentes', '', 'user', 'Necesita a una persona: un acceso, una decisión o algo fuera del repositorio.'),
}


def mark_badge(m):
  word, cls, icon, why = MARK[m]
  return f'<span class="badge {cls}" title="{why}">{ico(icon, "ico ico-sm")}{word}</span>'


# n, title, type it will import as, labels, author, age, triage mark, the item it already is (or None)
def iss(n, title, typ, labels, by, ago, mark, imported=None):
  return dict(n=n, title=title, type=typ, labels=labels, by=by, ago=ago, mark=mark, imported=imported)


RESULTS = {
  'github': [
    iss(41, 'El gráfico de uso se corta en pantallas de 320 px', 'bug', ['web', 'móvil'], 'marta-gil', 'hace 2 d', 'ready'),
    iss(38, 'Los límites por columna no se guardan al duplicar un proyecto', 'bug', ['core'], 'dpacheco', 'hace 3 d', 'ready'),
    iss(36, 'Mejorar el rendimiento del tablero cuando hay muchas tareas', 'task', ['web'], 'yeyo-dev', 'hace 5 d', 'refine'),
    iss(33, 'Necesitamos acceso de solo lectura al registro de producción de pagos', 'task', [], 'marta-gil', 'hace 6 d', 'person'),
    iss(31, 'Exportar el tablero a Markdown', 'task', ['web'], 'dpacheco', 'hace 9 d', 'ready', 'AGN-41'),
  ],
  'gitlab': [
    iss(23, 'Error 500 al abrir un chat desde un enlace antiguo', 'bug', ['api'], 'marta.gil', 'hace 1 d', 'ready'),
    iss(21, 'Revisar los textos del asistente de proyecto', 'task', ['docs'], 'dpacheco', 'hace 4 d', 'refine'),
    iss(19, 'Decidir si abrimos el repositorio al público', 'task', [], 'yeyo', 'hace 6 d', 'person'),
    iss(18, 'El FAB tapa la última fila en el iPhone SE', 'bug', ['móvil'], 'marta.gil', 'hace 8 d', 'ready', 'AGN-38'),
    iss(16, 'Limitar el tamaño de los adjuntos a 10 MB', 'task', ['api'], 'dpacheco', 'hace 10 d', 'ready'),
  ],
}
TOTAL = {'github': 23, 'gitlab': 17}
CHOSEN = {'github': (41, 38), 'gitlab': (23, 16)}

UNTRUSTED = ('Los issues los escriben otras personas. Cada tarea lleva el título tal cual y el texto del issue como una cita, '
             '«Desde {host} #n»; el agente la lee como un dato, no como una orden.')


def pending(host):
  return [x for x in RESULTS[host] if not x['imported']]


# ---------------------------------------------------------------- the rows
def row_main(x, with_mark=True):
  imp = (f'<span class="badge">{ico("link", "ico ico-sm")}ya importada</span><span class="wi-key boxed">{x["imported"]}</span>'
         if x['imported'] else '')
  mark = mark_badge(x['mark']) if with_mark and x['mark'] and not x['imported'] else ''
  tags = ''.join(f'<span class="wi-tag">{l}</span>' for l in x['labels'])
  by = (f'<span class="addr-by row" style="gap: 4px 10px; flex-wrap: wrap"><span><span class="mono">{x["by"]}</span> · {x["ago"]}</span>{tags}</span>')
  return (f'<span class="addr-main"><span class="addr-head">{tico("bug") if x["type"] == "bug" else ""}<span class="iss-key">#{x["n"]}</span>{mark}{imp}</span>'
          f'<p class="iss-title">{x["title"]}</p>{by}</span>')


def result_row(x, on, mobile, browse=False, triage=True):
  """One issue. A desktop row is a label with the app's checkbox; on a phone, selecting is a mode: the rows are
  pressed buttons that say Elegido or Elegir in words, and outside the mode they are plain text. An issue that is
  already a work item can not be chosen: it has no checkbox, and says which item it is."""
  main = row_main(x, triage)
  if x['imported']:
    return f'<div class="addr-thread static imported">{"" if mobile else "<span class=\"iss-gap\"></span>"}{main}</div>'
  if mobile and browse:
    return f'<div class="addr-thread static">{main}</div>'
  what = f'Elegir el issue #{x["n"]}'
  if mobile:
    state = (f'<span class="addr-state on">{ico("check", "ico ico-sm")}Elegido</span>' if on
             else f'<span class="addr-state">{ico("plus", "ico ico-sm")}Elegir</span>')
    return (f'<button type="button" class="addr-thread{" on" if on else ""}" aria-pressed="{"true" if on else "false"}" aria-label="{what}">{main}{state}</button>')
  chk = f'<span class="checkbox{" on" if on else ""}" role="checkbox" aria-checked="{"true" if on else "false"}" aria-label="{what}"></span>'
  return f'<label class="addr-thread{" on" if on else ""}">{chk}{main}</label>'


def list_head(host, mobile=False, browse=False, triage=True):
  n = TOTAL[host]
  src = ('<span class="decided-face" title="Lo sugiere issue.triage">sugerido · issue.triage</span>' if triage
         else '<span class="decided-face">sin triaje</span>')
  size = 'btn btn-lg' if mobile else 'btn btn-sm btn-ghost'
  btn = ''
  if triage and not browse:
    wide = ' style="flex: 1 1 100%; justify-content: center"' if mobile else ''
    btn = f'<button type="button" class="{size}"{wide}>Elegir las listas</button>'
  return (f'<div class="row" style="gap: 8px; flex-wrap: wrap"><span class="t-label">Issues abiertos · {n}</span>{src}<span class="grow"></span>{btn}</div>')


def legend():
  return (f'<span class="form-hint">Las marcas las pone <span class="mono">issue.triage</span> sobre los primeros 40 resultados y solo ayudan a elegir. '
          f'<b style="font-weight: 500; color: var(--fg-2)">lista</b>: un agente puede empezar tal como está. '
          f'<b style="font-weight: 500; color: var(--fg-2)">por refinar</b>: falta el objetivo o el criterio de aceptación. '
          f'<b style="font-weight: 500; color: var(--fg-2)">no es para agentes</b>: necesita a una persona.</span>')


def more_row(host, shown):
  return f'<button type="button" class="wi-col-more">Mostrar {TOTAL[host] - shown} más{ico("down", "ico ico-sm")}</button>'


def query_field(host, mobile=False):
  t = TRK[host]
  if host == 'github':
    value, hint = 'is:open', 'Es la búsqueda de GitHub: añade <span class="mono">label:bug</span> o <span class="mono">author:marta-gil</span>. Solo salen issues, no PR.'
  else:
    value, hint = '', 'GitLab busca por texto en el título y la descripción. Solo salen los issues abiertos.'
  lg = ' field-lg' if mobile else ''
  fs = ' style="font-size: 16px"' if mobile else ''
  ph = ' placeholder="Buscar issues"' if not value else ''
  scope = '' if mobile else f'<span class="mono t-xs fg-3" style="white-space: nowrap; padding-right: 8px; border-right: 1px solid var(--line-2)">{t["scope"]}</span>'
  field = (f'<label class="field field-mono{lg} grow">{ico("search", "ico ico-lg" if mobile else "ico")}{scope}'
           f'<input class="mono" value="{value}"{ph} aria-label="Búsqueda en {t["name"]}"{fs}></label>')
  btn = f'<button type="button" class="btn{" btn-lg" if mobile else ""}">Buscar</button>'
  return (f'<div class="col" style="gap: 8px"><div class="row" style="gap: 8px">{field}{btn}</div>'
          f'<span class="form-hint">{hint}</span></div>')


def foot_label(n):
  return f'Importar {n} issues' if n > 1 else ('Importar 1 issue' if n == 1 else 'Elige un issue')


# ---------------------------------------------------------------- the dialog, desktop
def dialog(host, chosen, triage=True):
  t = TRK[host]
  rows = ''.join(result_row(x, x['n'] in chosen, False, triage=triage) for x in RESULTS[host])
  n = len(chosen)
  off = ''
  if not triage:
    off = (f'<div class="callout callout-warn" style="align-items: flex-start">{ico("warn", "ico", "flex-shrink: 0; color: var(--warn); margin-top: 1px")}'
           f'<span><b style="color: var(--fg); font-weight: 500">issue.triage está apagado.</b> Los issues no llevan marca: elige los que quieras.</span></div>')
  body = (f'{query_field(host)}'
          f'<div class="col" style="gap: 8px">{list_head(host, triage=triage)}<div class="addr-list">{rows}</div>{more_row(host, len(RESULTS[host]))}{legend() if triage else ""}</div>'
          f'{off}<div class="callout" style="align-items: flex-start">{ico("lock", "ico", "flex-shrink: 0; color: var(--fg-3); margin-top: 1px")}'
          f'<span>{UNTRUSTED.format(host=t["host"])}</span></div>')
  disabled = '' if n else ' disabled'
  return (f'<div class="scrim" style="z-index: 30"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="imp-title" style="width: 700px">'
          f'<div class="dialog-head">{mono_ico(host)}<div class="col grow" style="gap: 2px"><h2 id="imp-title" class="t-h2">Importar issues de {t["host"]}</h2>'
          f'<span class="mono t-xs fg-3">{t["name"]} · {t["scope"]} · {t["cli"]} {t["ver"]}</span></div>'
          f'<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Cerrar">{ico("x")}</button></div>'
          f'<div class="dialog-body">{body}</div>'
          f'<div class="dialog-foot"><span class="t-xs fg-3">{n} de {len(pending(host))} elegidos</span><span class="grow"></span>'
          f'<button type="button" class="btn btn-ghost">Cancelar</button><button type="button" class="btn btn-primary"{disabled}>{foot_label(n)}</button></div></div></div>')


# ---------------------------------------------------------------- the boards
# What a card says of its issues: the numbers in mono with the link icon, "+1" for the rest. The tracker is the
# project's, so the card says only the number; the title says which tracker.
def fact(host, ns):
  more = f'<span class="more">+{len(ns) - 1}</span>' if len(ns) > 1 else ''
  what = f'Issue #{ns[0]} de {TRK[host]["host"]}' if len(ns) == 1 else 'Issues ' + ', '.join(f'#{n}' for n in ns[:-1]) + f' y #{ns[-1]} de {TRK[host]["host"]}'
  return f'<span class="wi-fact iss-fact" title="{what}">{ico("issue")}#{ns[0]}{more}</span>'


FACTS = {
  'github': {'AGN-41': (31,), 'AGN-44': (29,), 'AGN-39': (17,), 'AGN-31': (38,), 'AGN-35': (8, 9), 'AGN-22': (12,)},
  'gitlab': {'AGN-38': (18,), 'AGN-39': (17,), 'AGN-31': (14,), 'AGN-35': (8, 9)},
}


def issue_card(host, k):
  c = card(k, lead_facts=[fact(host, FACTS[host][k])] if k in FACTS[host] else ())
  if k == 'AGN-22':
    # Done, and the issue's close did not go through: the sync failed, said in a word, with its reason
    foot = f'<div class="wi-card-foot">{fact(host, FACTS[host][k])}</div>'
    strip = (f'<div class="wi-strip fail" role="status">{ico("x", "ico", "color: var(--bad)")}'
             f'<span class="verb"><b>Falló</b> cerrar #12 · {TRK[host]["cli"]} no tiene sesión</span></div>')
    c = c.replace('</article>', foot + strip + '</article>')
  return c


def import_btn(href='DesktopImportarIssues.html', pressed=False):
  p = ' aria-pressed="true"' if pressed else ''
  return f'<a href="{href}" class="btn"{p}>{ico("issue")}Importar issues</a>'


def board_page(overlay='', primary=True, name='', title=''):
  host = 'github'
  cols = ''
  for s, _ in COLS:
    cards = ''.join(issue_card(host, k) for k in epics_first(by_col(s)))
    cols += col(s, epics_first(by_col(s)), cards=cards)
  head = bhead('claude-wrapper · 13 abiertas · clave <span class="mono">AGN</span> · issues de GitHub', primary=primary)
  head = head.replace('<a href="DesktopNuevaTarea.html"', import_btn(pressed=bool(overlay)) + '<a href="DesktopNuevaTarea.html"', 1)
  main = f'''<main class="page" style="gap: 16px; position: relative">
{head}
{toolbar()}
<div class="wi-board">{cols}</div>
</main>'''
  write(name, desktop(title, 'tasks', '<span style="font-weight: 500">Tareas</span>', main, overlay=overlay))


def desktop_import():
  board_page(dialog('github', CHOSEN['github']), primary=False, name='DesktopImportarIssues.html', title='Tablero · importar issues')


def desktop_board():
  board_page(name='DesktopTableroIssues.html', title='Tablero · issues enlazados')


# ---------------------------------------------------------------- the boards, phone
def phone_board(sheet=''):
  host = 'gitlab'
  imp = import_btn('MobileImportarIssues.html').replace('class="btn"', 'class="btn btn-ghost btn-icon btn-lg" aria-label="Importar issues"').replace(
    f'{ico("issue")}Importar issues', ico('issue', 'ico ico-lg'))
  sel = f'<a href="MobileTableroSeleccion.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Seleccionar para orquestar">{ico("tasks", "ico ico-lg")}</a>'
  todo = ''.join(mrow(k, lead=[fact(host, FACTS[host][k])] if k in FACTS[host] else ()) for k in ['AGN-39', 'AGN-36'])
  prog = ''.join(mrow(k, lead=[fact(host, FACTS[host][k])] if k in FACTS[host] else ()) for k in ['AGN-31', 'AGN-35'])
  inner = f'''{mhead('Tareas', None, 'MobileMas.html', mproject_chip() + imp + sel)}
<div class="m-body stack" style="gap: 12px; margin-bottom: 76px">
{mtoolbar()}
{jump('in_progress')}
{msection('todo', by_col('todo'), rows_html=todo)}
{msection('in_progress', by_col('in_progress'), rows_html=prog)}
</div>
<a href="MobileNuevaTarea.html" class="fab" aria-label="Nueva tarea" style="padding: 0; width: 56px">{ico('plus', 'ico ico-lg', 'stroke-width: 2.2')}</a>
{sheet if sheet else tabbar('more')}'''
  return inner


def import_sheet(host, chosen, browse=False):
  t = TRK[host]
  rows = ''.join(result_row(x, x['n'] in chosen, True, browse=browse) for x in RESULTS[host])
  n = len(chosen)
  if browse:
    foot = (f'<div class="row" style="gap: 8px"><button type="button" class="btn btn-lg">Cancelar</button>'
            f'<button type="button" class="btn btn-lg grow" style="justify-content: center">{ico("tasks", "ico ico-lg")}Seleccionar issues</button></div>')
  else:
    disabled = '' if n else ' disabled'
    foot = (f'<div class="row" style="gap: 8px"><button type="button" class="btn btn-lg">Cancelar</button>'
            f'<button type="button" class="btn btn-lg btn-primary grow" style="justify-content: center"{disabled}>{foot_label(n)}</button></div>')
  hint = f'<span class="t-xs fg-3" style="line-height: 1.45">{n} de {len(pending(host))} elegidos · las marcas solo ayudan a elegir</span>' if not browse else ''
  return f'''{scrim()}
<div class="sheet" role="dialog" aria-label="Importar issues" style="z-index: 11; padding-bottom: 24px; display: flex; flex-direction: column; gap: 12px; max-height: 93%">
<div class="grab" style="margin-bottom: 0"></div>
<div class="row" style="gap: 10px">{mono_ico(host)}<div class="col grow" style="gap: 2px"><h2 class="t-h2">Importar issues de {t["host"]}</h2><span class="mono t-xs fg-3" style="overflow-wrap: anywhere">git.inmoseo.net/{t["scope"]} · {t["cli"]} {t["ver"]}</span></div></div>
{query_field(host, True)}
{list_head(host, True, browse)}
<div style="min-height: 0; overflow: hidden; flex: 0 1 auto"><div class="addr-list">{rows}</div></div>
{hint}
{foot}
</div>'''


def mobile_import(name, title, chosen, browse):
  write(name, mobile(title, phone_board(import_sheet('gitlab', chosen, browse)), 'has-fab'))


def mobile_board():
  write('MobileTableroIssues.html', mobile('Tablero · issues enlazados', phone_board(), 'has-fab'))


# ---------------------------------------------------------------- the item page: chips, sync state, Sync again
# sync state -> word, the dot of the chip and the badge of the row. "pending" waits for the merge or for the person,
# so it is idle; "syncing" is one write in flight, the only live one; "outside" is an issue somebody closed on the
# tracker: Agentry adds a note and moves nothing, so it has no status colour.
SYNC = {
  'pending': ('pendiente', 'dot-idle', 'b-idle', 'wait'),
  'syncing': ('sincronizando', None, '', None),
  'synced': ('sincronizada', 'dot-ok', 'b-ok', 'check'),
  'failed': ('falló', 'dot-bad', 'b-bad', 'x'),
  'outside': ('cerrada fuera', None, '', 'info'),
}


def chip(host, n, s):
  word, dot, _, _ = SYNC[s]
  if s == 'syncing':
    d = '<span class="spin-braille" aria-hidden="true"></span>'
  elif dot:
    d = f'<span class="dot {dot}" style="width: 6px; height: 6px"></span>'
  else:
    d = ''
  name = TRK[host]['host']
  return (f'<a href="#" class="iss-chip" target="_blank" rel="noreferrer" aria-label="Abrir el issue #{n} en {name}. Sincronización: {word}">'
          f'<span class="iss-key">#{n}</span><span class="iss-sync">{d}{word}</span>{ext_ico()}</a>')


def sync_badge(s):
  word, _, cls, icon = SYNC[s]
  lead = '<span class="spin-braille" aria-hidden="true"></span>' if s == 'syncing' else ico(icon, 'ico ico-sm')
  return f'<span class="badge {cls}">{lead}{word}</span>'


def issue_row(host, n, title, s, state, why, detail='', acts=(), mobile=False):
  """One linked issue in the panel: key, the sync state in a word, the issue's own state on the tracker, why, and
  what to do. The chips above are the links to the tracker; the row has no link of its own."""
  size = 'btn btn-lg' if mobile else 'btn btn-sm'
  buttons = ''
  for kind, label in acts:
    if kind == 'retry':
      buttons += f'<button type="button" class="{size}">{ico("retry", "ico ico-sm")}{label}</button>'
    else:
      buttons += f'<a href="#" class="pr-remedy" target="_blank" rel="noreferrer">{label}{ext_ico()}</a>'
  acts_html = f'<div class="addr-acts">{buttons}</div>' if buttons else ''
  det = f'<span class="mono t-xs fg-3" style="overflow-wrap: anywhere">{detail}</span>' if detail else ''
  return (f'<div class="addr-done"><div class="addr-head"><span class="iss-key">#{n}</span>{sync_badge(s)}<span class="t-xs fg-3">{state}</span></div>'
          f'<p class="iss-title">{title}</p><span class="addr-why">{why}</span>{det}{acts_html}</div>')


def panel(host, rows, sub, mobile=False):
  name = TRK[host]['host']
  return (f'<section class="fix-panel" aria-label="Issues enlazados"><div class="fix-head"><div class="col grow" style="gap: 4px">'
          f'<span class="fix-title">{ico("issue", "ico", "color: var(--fg-3)")}Issues de {name}<span class="mono t-xs fg-3" style="font-weight: 400">{len(rows)}</span></span>'
          f'<span class="fix-sub">{sub}</span></div></div><div class="addr-list">{"".join(rows)}</div></section>')


def main_rows(mobile=False):
  return [
    issue_row('gitlab', 14, 'Plantillas de proyecto al crear uno nuevo', 'pending', 'abierto en GitLab',
              'Se cierra al fusionar la MR !12. Agentry lo lee de nuevo después y solo lo cierra si sigue abierto.', mobile=mobile),
    issue_row('gitlab', 9, 'Plantillas para bibliotecas y paquetes', 'outside', 'cerrado en GitLab',
              'Lo cerró marta.gil hace 1 d. Agentry lo anota en la tarea y no la mueve: pasarla a Hecho es cosa tuya.', mobile=mobile),
  ]


MAIN_SUB = ('La MR !12 lleva «Closes #14» en su descripción, así que GitLab cierra el issue al fusionarla. '
            'La tarea se importó de estos issues; Agentry solo escribe en el tracker al fusionar.')


def item_desktop():
  h = _captured(detail_mr_desktop)
  chips = f'<div class="row" style="gap: 8px; flex-wrap: wrap" aria-label="Issues enlazados">{chip("gitlab", 14, "pending")}{chip("gitlab", 9, "outside")}</div>'
  h = _swap(h, '</h1>\n<div class="t-body fg-2"', f'</h1>{chips}\n<div class="t-body fg-2"')
  crit = '<section class="col" style="gap: 8px"><div class="row" style="gap: 10px"><h2 class="t-h2">Criterios'
  h = _swap(h, crit, panel('gitlab', main_rows(), MAIN_SUB) + crit)
  write('DesktopTareaIssues.html', h.replace('<title>Agentry · Tarea con MR (desktop)', '<title>Agentry · Tarea con issues (desktop)'))


def item_mobile():
  h = _captured(detail_mr_mobile)
  chips = f'<div class="row" style="gap: 8px; flex-wrap: wrap" aria-label="Issues enlazados">{chip("gitlab", 14, "pending")}{chip("gitlab", 9, "outside")}</div>'
  h = _swap(h, '<h1 class="t-h1">Plantillas de proyecto</h1>', f'<h1 class="t-h1">Plantillas de proyecto</h1>{chips}')
  desc = '<p class="t-sm fg-2" style="margin: 0; line-height: 1.55">'
  # After the MR callout, before the description: the same place as on the desktop
  h = _swap(h, desc, panel('gitlab', main_rows(True), MAIN_SUB, True) + desc)
  write('MobileTareaIssues.html', h.replace('<title>Agentry · Tarea con MR (móvil)', '<title>Agentry · Tarea con issues (móvil)'))


# ---------------------------------------------------------------- the sync states
def state_cells(mobile):
  return [
    ('Pendiente: la MR lleva la palabra de cierre', 'La base es la rama predeterminada: GitLab cierra el issue al fusionar. Idle, porque espera tu fusión.',
     panel('gitlab', [issue_row('gitlab', 14, 'Plantillas de proyecto al crear uno nuevo', 'pending', 'abierto en GitLab',
                                'Se cierra al fusionar la MR !12. Agentry lo lee de nuevo después.', mobile=mobile)],
           'La MR !12 lleva «Closes #14» en su descripción.', mobile)),
    ('Pendiente: la base no es la predeterminada', 'Sin palabra de cierre: GitHub no cierra nada al fusionar en otra rama, así que lo cierra Agentry, y lo vuelve a leer.',
     panel('github', [issue_row('github', 14, 'Plantillas de proyecto al crear uno nuevo', 'pending', 'abierto en GitHub',
                                'La PR #12 va hacia release/0.20, no hacia main: al fusionarla Agentry cierra el issue como «completado».', mobile=mobile)],
           'La PR #12 cita «Refs #14», sin palabra de cierre.', mobile)),
    ('Sincronizando', 'Una escritura en vuelo, sin reintentos: el braille junto a la palabra es lo único vivo.',
     panel('gitlab', [issue_row('gitlab', 14, 'Plantillas de proyecto al crear uno nuevo', 'syncing', 'abierto en GitLab',
                                'Cerrando el issue con glab…', mobile=mobile)],
           'La MR !12 se fusionó hace unos segundos.', mobile)),
    ('Sincronizada', 'El issue está cerrado y Agentry lo ha comprobado leyéndolo de nuevo. El ok va con su palabra.',
     panel('gitlab', [issue_row('gitlab', 14, 'Plantillas de proyecto al crear uno nuevo', 'synced', 'cerrado en GitLab',
                                'Lo cerró la fusión de la MR !12 hace 2 min. Agentry lo leyó de nuevo y no tuvo que hacer nada.', mobile=mobile)],
           'La tarea pasó a Hecho cuando se fusionó la MR !12.', mobile)),
    ('Falló', 'La escritura no se reintenta sola: el motivo va con su código en mono, y el remedio es «Sincronizar de nuevo» y, si falta la sesión, un enlace a la documentación.',
     panel('gitlab', [issue_row('gitlab', 14, 'Plantillas de proyecto al crear uno nuevo', 'failed', 'abierto en GitLab',
                                'No se pudo cerrar el issue: glab no ha iniciado sesión en git.inmoseo.net.', 'tracker-signed-out · hace 1 min',
                                acts=[('retry', 'Sincronizar de nuevo'), ('link', 'Cómo iniciar sesión')], mobile=mobile)],
           'La MR !12 se fusionó y la tarea ya está en Hecho; el issue no.', mobile)),
    ('Cerrado fuera de Agentry', 'Alguien lo cerró en el tracker. Agentry lo anota en la tarea y no mueve nada; sin color de estado.',
     panel('gitlab', [issue_row('gitlab', 9, 'Plantillas para bibliotecas y paquetes', 'outside', 'cerrado en GitLab',
                                'Lo cerró marta.gil hace 1 d. La tarea sigue donde estaba.', mobile=mobile)],
           'Agentry no escribe en este issue hasta que la tarea llegue a Hecho.', mobile)),
  ]


def states_desktop():
  grid = ''.join(rev.cell(*c) for c in state_cells(False))
  head_ = ('<header class="col" style="gap: 6px"><span class="t-label">Issues de un tracker</span>'
           '<h1 class="t-h1">Los estados de la sincronización</h1>'
           '<p class="t-sm fg-2" style="margin: 0; max-width: 820px; line-height: 1.5">Cómo dice la página de la tarea qué pasó con cada issue enlazado, en GitHub y en GitLab. '
           'La sincronización va en un solo sentido, de Agentry al tracker; cada escritura es una sola, y una que falla se ve con su motivo y se repite con un clic. '
           'El estado principal es <a href="DesktopTareaIssues.html" class="c-accent">la propia página de la tarea</a>.</p></header>')
  body = (f'<div class="app col" data-theme="dark" style="width: 1440px; height: 1050px; padding: 32px 40px; gap: 22px; overflow: hidden">{head_}'
          f'<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 26px 28px; align-items: start">{grid}</div></div>')
  write('DesktopTareaIssuesEstados.html', page('Tarea, estados de los issues (desktop)', body))


def states_mobile():
  grid = ''.join(rev.cell(*c) for c in state_cells(True))
  body = (f'<div class="app m-screen" data-theme="dark" style="height: auto; overflow: visible"><div class="m-body stack" style="gap: 22px; overflow: visible; padding-top: 16px">'
          f'<h1 class="t-h1">Estados de los issues</h1>{grid}</div></div>')
  write('MobileTareaIssuesEstados.html', page('Tarea, estados de los issues (móvil)', body, mobile=True))


# ---------------------------------------------------------------- run
if __name__ == '__main__':
  desktop_import()
  desktop_board()
  mobile_import('MobileImportarIssues.html', 'Importar issues', CHOSEN['gitlab'], False)
  mobile_import('MobileImportarIssuesLista.html', 'Importar issues, antes de elegir', (), True)
  mobile_board()
  item_desktop()
  item_mobile()
  states_desktop()
  states_mobile()
