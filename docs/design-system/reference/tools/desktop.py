# Desktop screens drawn by proto-fix-desktop: the board while the team works it (it was hand-drawn and
# drifted from the data set), and the states orchestration 1 left undrawn: the Tasks view with All
# projects, suggestions while they run, and the assistant on an empty project.
from data import *
from board import head as board_head, toolbar as board_toolbar, view_seg, epics_first
from ai import mark, facts, f, chat_link, live_verb, steps_html, team_row, accept_btns, sugg_row, SUGG, TEAM

P.update({
  'flow': 'M5 6h4v4H5zM15 14h4v4h-4zM9 8h4a2 2 0 0 1 2 2v4',
  'bounce': 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  'wait': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  'info': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
})

def tcard(k, who=None, strip=None, lead=(), crit=None, comments=None):
  """A board card with a role (or the person, 'Y') as its assignee, as the team board draws it."""
  return card(k, who=who, strip=strip, lead_facts=lead, crit=crit, comments=comments)


def tcol(s, cards, who_head, extra=''):
  keys = [c.split('aria-label="', 1)[1].split(' ·', 1)[0] for c in cards]
  return col(s, keys, cards=''.join(cards), role_head=who_head, extra=extra)


TEAM_LIVE = '''<div class="col" style="gap: 4px">
<div class="row" style="padding: 0 10px 4px"><span class="t-label grow">En directo</span><span class="count-pill live">3</span></div>
<a href="DesktopChatTarea.html" class="list-row rail-live" style="padding: 8px 10px 8px 14px; flex-direction: column; align-items: stretch; gap: 3px">
<span class="row" style="gap: 7px"><span class="spin-braille"></span><span class="t-sm ellipsis" style="font-weight: 500">Desarrollador implementa AGN-28: tablero con columnas fijas</span></span>
<span class="row t-xs" style="gap: 6px; padding-left: 15px"><span class="c-live">Ejecutando</span><span class="mono fg-3 ellipsis grow">pnpm test</span><span class="mono fg-3">4:12</span></span>
</a>
<a href="DesktopChat.html" class="list-row rail-live" style="padding: 8px 10px 8px 14px; flex-direction: column; align-items: stretch; gap: 3px">
<span class="row" style="gap: 7px"><span class="spin-braille"></span><span class="t-sm ellipsis" style="font-weight: 500">QA verifica AGN-29: historial automático</span></span>
<span class="row t-xs" style="gap: 6px; padding-left: 15px"><span class="c-live">Leyendo</span><span class="mono fg-3 ellipsis grow">work-items.test.ts</span><span class="mono fg-3">1:05</span></span>
</a>
<a href="DesktopOrquestacion.html" class="list-row rail-live" style="padding: 8px 10px 8px 14px; flex-direction: column; align-items: stretch; gap: 6px">
<span class="row" style="gap: 7px"><span class="spin-braille"></span><span class="t-sm ellipsis grow" style="font-weight: 500">ecosystem-foundation</span><span class="mono t-xs fg-3">2/9</span></span>
<span class="segbar" style="height: 4px; margin-left: 15px"><i class="ok"></i><i class="ok"></i><i class="live" style="--p: 55%"></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
</a>
</div>'''


# ---------------------------------------------------------------- the board while the team works it
def team_board_desktop():
  cols = {
    # Two runs at a time (maxParallel 2): the Product Owner's next refine waits its turn
    'backlog': [tcard('AGN-45', 'PO', strip=queue_strip('PO', 'En cola: la refinará cuando quede sitio')), tcard('AGN-38'), tcard('AGN-44', 'DOC'), tcard('AGN-41')],
    'todo': [tcard('AGN-47'), tcard('AGN-39', 'Y'),
             tcard('AGN-36', 'PO', strip=fail_strip('PO', 'al comprobarla', 'ninguna cuenta tenía cupo')),
             tcard('AGN-33', 'PO')],
    'in_progress': [tcard('AGN-12'),
                    tcard('AGN-28', 'DEV', strip=live_strip('DEV', 'Implementando', '4:12', 'pnpm test')),
                    tcard('AGN-30'),
                    tcard('AGN-35', 'DEV', strip=quote_strip('QA', 'La clave cambia al renombrar; el criterio 2 pide que no.'), lead=[bounce(1)], comments=1),
                    tcard('AGN-31', 'Y', strip=wait_strip('QA la devolvió tres veces'), lead=[bounce(3)])],
    'in_review': [tcard('AGN-29', 'QA', strip=live_strip('QA', 'Verificando', '1:05', 'criterio 2 de 2 · work-items.test.ts')),
                  tcard('AGN-26', strip=wait_strip('QA la dio por buena', approve=True))],
    'done': [tcard(k) for k in by_col('done')],
  }
  heads = {'backlog': role('PO'), 'todo': role('PO'), 'in_progress': role('DEV'), 'in_review': role('QA'),
           'done': '<span class="proj monogram wi-assignee" style="--hue: 24" role="img" aria-label="Tú apruebas el paso a Hecho" title="Tú apruebas el paso a Hecho">Y</span>'}
  board = ''.join(tcol(s, cols[s], heads[s]) for s, _ in COLS)
  hd = board_head('claude-wrapper · 13 abiertas · clave <span class="mono">AGN</span>')
  hd = hd.replace(view_seg('board'), f'<a href="DesktopFlujo.html" class="btn">{ico("flow")}Flujo automático<span class="badge">activado</span></a><span style="width: 4px"></span>' + view_seg('board').replace('href="DesktopTablero.html"', 'href="DesktopTableroEquipo.html"'))
  main = f'''<main class="page" style="gap: 16px; position: relative">
{hd}
{board_toolbar()}
<div class="wi-board">{board}</div>
</main>'''
  write('DesktopTableroEquipo.html', desktop('Tablero con equipo', 'tasks', '<span style="font-weight: 500">Tareas</span>', main, live=TEAM_LIVE, agents=3, running=3))


# ---------------------------------------------------------------- Tasks with All projects selected
GDM = {
  'GDM-4': dict(t='task', title='Documentar los permisos de OAuth', s='backlog', p='low', labels=['docs']),
  'GDM-7': dict(t='story', title='Crear documentos desde una plantilla', s='todo', p='medium'),
  'GDM-9': dict(t='bug', title='El token caduca a mitad de una exportación', s='in_progress', p='high', labels=['oauth'], who='Y', crit=(1, 3)),
  'GDM-6': dict(t='task', title='Tests de la exportación a PDF', s='done', p='medium', crit=(2, 2)),
}
PROJ = {'AGN': ('claude-wrapper', 'CW', 20), 'GDM': ('google-docs-mcp', 'GD', 200)}


def proj_chip(k):
  name = PROJ[k.split('-')[0]][0]
  return f'<span class="wi-proj" title="Proyecto">{ico("folder")}{name}</span>'


def with_proj(html, k):
  # Kept for the callers that pass a finished card: the project goes first in its context line
  chip = proj_chip(k)
  if '<div class="wi-card-ctx">' in html:
    return html.replace('<div class="wi-card-ctx">', f'<div class="wi-card-ctx">{chip}', 1)
  return html.replace('</p>', f'</p><div class="wi-card-ctx">{chip}</div>', 1)


ALL = {
  'backlog': ['AGN-45', 'GDM-4', 'AGN-38', 'AGN-44', 'AGN-41'],
  'todo': ['AGN-47', 'GDM-7', 'AGN-39', 'AGN-36', 'AGN-33'],
  'in_progress': ['AGN-12', 'AGN-28', 'GDM-9', 'AGN-30', 'AGN-35', 'AGN-31'],
  'in_review': ['AGN-26', 'AGN-29'],
  'done': ['GDM-6', 'AGN-24', 'AGN-22'],
}
ALL_DONE = 13  # 12 of claude-wrapper and 1 of google-docs-mcp


def all_projects_desktop():
  # The other project's items join the data set for this screen only
  W.update(GDM)
  try:
    _all_projects_desktop()
  finally:
    for k in GDM:
      del W[k]


def _all_projects_desktop():
  cols = ''
  for s, name in COLS:
    keys = ALL[s]
    n = len(counted(keys)) + (ALL_DONE - len(keys) if s == 'done' else 0)
    # With every project shown there are no column limits: each project sets its own
    head = f'<div class="wi-col-head">{sico(s)}<span class="t-label">{name}</span><span class="wi-col-count"><b>{n}</b></span><span class="grow"></span></div>'
    cards = ''.join(card(k, proj=proj_chip(k)) for k in keys)
    more = f'<button type="button" class="wi-col-more">Mostrar {ALL_DONE - len(keys)} más{ico("down", "ico ico-sm")}</button>' if s == 'done' else ''
    cols += f'<section class="wi-col" aria-label="{name}">{head}<div class="wi-col-body">{cards}{more}</div></section>'
  hd = board_head('Todos los proyectos · 16 abiertas en 2 proyectos con tablero', primary=False)
  # A new task needs a project: from All projects the button asks for it first
  hd = hd.replace(f'{ico("plus")}Nueva tarea</a>', f'{ico("plus")}Nueva tarea{ico("down", "ico ico-sm")}</a>')
  toolbar = board_toolbar().replace('<button type="button" class="chip">Tipo', f'<button type="button" class="chip">{ico("folder", "ico ico-sm")}Proyecto{ico("down", "ico ico-sm")}</button><button type="button" class="chip">Tipo')
  main = f'''<main class="page" style="gap: 16px; position: relative">
{hd}
{toolbar}
<div class="row t-xs fg-3" style="gap: 6px; margin-top: -4px">{ico('info', 'ico ico-sm')}<span>Cada tarjeta dice su proyecto. Sin límites por columna: cada proyecto pone los suyos, y se ven al elegirlo. pagos-api aún no tiene tareas.</span></div>
<div class="wi-board">{cols}</div>
</main>'''
  write('DesktopTareasTodos.html', desktop('Tareas de todos los proyectos', 'tasks', '<span style="font-weight: 500">Tareas</span>', main, project='Todos los proyectos'))


# ---------------------------------------------------------------- Suggest tasks while it runs
SUGG_READ = [
  ('done', 'board', 'El tablero', '27 tareas'),
  ('done', 'flag', 'Los hitos abiertos', 'v0.20 · v0.21'),
  ('done', 'docs', '<span class="path">docs/plans/</span>', '12 documentos'),
  ('now', None, 'Los últimos 20 commits', '14 de 20'),
  ('todo', 'chats', 'Los chats de esta semana', 'después'),
]

SUGG_LIVE = TEAM_LIVE.replace('<span class="count-pill live">3</span>', '<span class="count-pill live">3</span>', 1).replace(
  '''<a href="DesktopChat.html" class="list-row rail-live" style="padding: 8px 10px 8px 14px; flex-direction: column; align-items: stretch; gap: 3px">
<span class="row" style="gap: 7px"><span class="spin-braille"></span><span class="t-sm ellipsis" style="font-weight: 500">QA verifica AGN-29: historial automático</span></span>
<span class="row t-xs" style="gap: 6px; padding-left: 15px"><span class="c-live">Leyendo</span><span class="mono fg-3 ellipsis grow">work-items.test.ts</span><span class="mono fg-3">1:05</span></span>''',
  '''<a href="DesktopSugerirTareasEnCurso.html" class="list-row rail-live" style="padding: 8px 10px 8px 14px; flex-direction: column; align-items: stretch; gap: 3px">
<span class="row" style="gap: 7px"><span class="spin-braille"></span><span class="t-sm ellipsis" style="font-weight: 500">Sugerir tareas en claude-wrapper</span></span>
<span class="row t-xs" style="gap: 6px; padding-left: 15px"><span class="c-live">Leyendo</span><span class="mono fg-3 ellipsis grow">git log</span><span class="mono fg-3">0:22</span></span>''')


def suggest_running_desktop():
  cols = ''.join(col(s, epics_first(by_col(s))) for s, _ in COLS)
  hd = board_head('claude-wrapper · 13 abiertas · clave <span class="mono">AGN</span>', primary=False)
  hd = hd.replace('<a href="DesktopNuevaTarea.html"', '<button type="button" class="btn" aria-pressed="true">' + ico('sparkle') + 'Sugerir tareas</button><a href="DesktopNuevaTarea.html"')
  main = f'''<main class="page" style="gap: 16px; position: relative">
{hd}
{board_toolbar()}
<div class="wi-board">{cols}</div>
</main>'''
  run = f'''<section class="ai-run live energy" aria-label="Sugerencia en curso" style="background: var(--bg-1); box-shadow: none">
<div class="ai-run-head">{mark()}<div class="col grow" style="gap: 3px; min-width: 0"><h3 class="ai-run-title">Leyendo el proyecto</h3>{live_verb('Leyendo', 'git log -20')}</div><span class="mono t-sm fg-2 t-num">0:22</span></div>
{facts(f('Sonnet 5'), f('0,02 US$ hasta ahora', 'cost'), chat_link('7c2e1a'), f('--json-schema'))}
{steps_html(SUGG_READ)}
</section>'''
  dialog = f'''<div class="scrim">
<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="st-title" style="width: 780px; max-height: calc(100% - 48px)">
<div class="dialog-head">{mark(True)}<h2 id="st-title" class="t-h2 grow">Sugerir tareas</h2><span class="mono t-xs fg-3">claude-wrapper · se crean en Backlog</span><button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Cerrar">{ico('x')}</button></div>
<div class="dialog-body" style="gap: 14px">
<div class="row" style="gap: 8px"><label class="field grow">{ico('search')}<input value="lo que falta para cerrar v0.20" aria-label="Qué buscar (opcional)" disabled></label></div>
{run}
<div class="sug-wait" style="margin: 0; min-height: 132px">{ico('wait')}Las propuestas aparecen aquí cuando termine de leer, cada una con su porqué</div>
<span class="form-hint" style="margin-top: -4px">Puedes cerrar esta ventana: la sugerencia sigue en su chat y te avisa al terminar.</span>
</div>
<div class="dialog-foot"><span class="t-sm fg-2" style="white-space: nowrap">Aún no hay propuestas</span><span class="grow"></span><button type="button" class="btn">{ico('x', 'ico ico-sm')}Detener</button><button type="button" class="btn btn-primary" disabled>{ico('plus')}Crear las seleccionadas</button></div>
</div>
</div>'''
  write('DesktopSugerirTareasEnCurso.html', desktop('Sugerir tareas, en curso', 'tasks', '<span style="font-weight: 500">Tareas</span>', main,
        overlay=f'<div style="position: absolute; inset: 0; z-index: 30">{dialog}</div>', live=SUGG_LIVE, agents=3, running=3))


# ---------------------------------------------------------------- The assistant on an empty project
def assistant_empty_desktop():
  team = [dict(x, st='pending') for x in TEAM if not x.get('extra')]
  head = f'''<div class="page-head" style="align-items: center">
<div class="row" style="gap: 14px"><a href="DesktopNuevoProyecto.html" class="btn btn-icon" aria-label="Volver">{ico('left')}</a>
<span class="proj monogram" style="--hue: 100; width: 40px; height: 40px; border-radius: var(--r-lg); font-size: 13px">NO</span>
<div class="col" style="gap: 4px"><h1 class="t-h1">Asistente de proyecto</h1><p class="fg-2 t-sm" style="margin: 0">notas · un directorio vacío. Nada se escribe hasta que lo aceptes.</p></div></div>
<div class="row" style="gap: 8px"><a href="#" class="btn">{ico('right')}Ir al proyecto</a></div>
</div>'''
  nothing = f'''<section class="ai-run done" aria-label="Nada que leer">{mark(True)}<span class="t-sm"><b style="font-weight: 600">Nada que leer</b> <span class="fg-2">en <span class="mono">~/Proyectos/notas</span>: ni archivos, ni chats, ni historial de git. No se ha lanzado ningún chat.</span></span><span class="grow"></span>{facts(f('sin coste', 'cost'))}</section>'''
  tasks = f'''<section class="card grad-border" aria-label="Primeras tareas">
<div class="card-head">{ico('tasks', 'ico fg-3')}<h2 class="t-h2" style="white-space: nowrap">Primeras tareas</h2><span class="mono t-xs fg-3 grow">a Backlog</span></div>
<div class="col" style="padding: 16px 18px 18px; gap: 12px">
<p class="t-sm fg-2" style="margin: 0; line-height: 1.55">Sin código que leer, el asistente necesita saber qué vas a construir. Cuéntalo en una frase y te propone las primeras tareas, cada una con su porqué.</p>
<label class="field field-area"><textarea rows="3" aria-label="Qué vas a construir" placeholder="Qué vas a construir…">Una app de notas en Markdown que se sincroniza con una carpeta de Git, con búsqueda y etiquetas.</textarea></label>
<div class="row" style="gap: 10px"><span class="form-hint grow">Abre un chat del CLI con <span class="mono">--json-schema</span>; su coste cuenta en Uso, como el de cualquier chat.</span><button type="button" class="btn btn-primary">{ico('sparkle')}Proponer tareas</button></div>
</div>
</section>'''
  team_card = f'''<section class="card" aria-label="Equipo">
<div class="card-head">{ico('team', 'ico fg-3')}<h2 class="t-h2">Equipo</h2><span class="mono t-xs fg-3 grow">0 de 4 aceptados</span><span class="t-xs fg-3">el de Software profesional</span></div>
<div class="callout" style="margin: 12px 14px 4px">{ico('info', 'ico fg-3')}<span>Con nada que leer, te ofrece el equipo de la plantilla. Acepta cada rol por separado.</span></div>
{''.join(team_row(x) for x in team)}
</section>'''
  res = f'''<section class="card" aria-label="Recursos">
<div class="card-head">{ico('resources', 'ico fg-3')}<h2 class="t-h2 grow">Recursos</h2><span class="mono t-xs fg-3">sin propuestas</span></div>
<div class="sug-wait">{ico('wait')}Cuando haya código, pídelos desde la pestaña Recursos con «Sugerir»</div>
</section>'''
  main = f'''<main class="page" style="gap: 16px">
{head}
{nothing}
<div style="display: grid; grid-template-columns: 1.15fr 1fr; gap: 14px; align-items: start">
{tasks}
<div class="col" style="gap: 14px">{team_card}{res}</div>
</div>
</main>'''
  write('DesktopAsistenteVacio.html', desktop('Asistente en un proyecto vacío', 'projects', pcrumb('notas', ('Asistente', '')), main, project='notas'))


if __name__ == '__main__':
  team_board_desktop()
  all_projects_desktop()
  suggest_running_desktop()
  assistant_empty_desktop()
