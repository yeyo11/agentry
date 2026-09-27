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

ROLES = {'PO': (300, 'Product Owner'), 'AR': (215, 'Arquitecto'), 'DEV': (90, 'Desarrollador'), 'QA': (330, 'QA'), 'DOC': (45, 'Redactor técnico')}


def role(ab):
  h, name = ROLES[ab]
  return f'<span class="role-av sm" style="--hue: {h}" role="img" aria-label="{name}" title="{name}">{ab}</span>'


def live_box(verb, detail, t, who=''):
  # The same two-line live box as the plain board: verb and time, then what the agent runs
  return f'<div class="wi-card-live two"><span class="spin-braille"></span>{who}<span class="c-live grow">{verb}</span><span class="mono t-xs fg-3">{t}</span><span class="mono fg-3 detail">{detail}</span></div>'


def tcard(k, who=None, live=None, body='', foot_lead='', crit=None, comments=None):
  """A board card with a role (or the person, 'Y') as its assignee, as the team board draws it."""
  w = W[k]
  done = w['s'] == 'done'
  cls = 'wi-card' + (' done' if done else '') + (' rail-live' if live or w.get('live') == 'orch' else '')
  lead = '<span class="spin-ring" style="width: 14px; height: 14px" role="img" aria-label="Trabajando"></span>' if (live or w.get('live') == 'orch') else tico(w['t'])
  top = f'<div class="wi-card-top">{lead}<span class="wi-key">{k}</span><span class="grow"></span>{prio(w["p"])}</div>'
  bits = ([epic(w['epic'])] if w.get('epic') else []) + [label(l) for l in w.get('labels', [])]
  assignee = (av() if who == 'Y' else role(who)) if who else ''
  inner = ''
  if w['t'] == 'epic':
    d, n = w['child']
    inner += f'<div class="wi-card-epic"><span class="ms-bar"><i class="done" style="width: {d / n * 100:.0f}%"></i></span><span>{d}/{n} tareas</span></div>'
  if w.get('live') == 'orch':
    inner += '<div class="wi-card-live"><span class="spin-braille"></span><span class="mono t-xs c-live">nodo 3 de 9</span><span class="segbar"><i class="ok"></i><i class="ok"></i><i class="live" style="--p: 55%"></i><i></i><i></i><i></i></span></div>'
  inner += (live or '') + body
  foot = [foot_lead] if foot_lead else []
  if w.get('blocked'):
    foot.append(f'<span class="wi-fact" title="Bloqueada por {w["blocked"]}">{ico("block")}{w["blocked"]}</span>')
  c = crit or w.get('crit')
  if c:
    foot.append(f'<span class="wi-fact" title="Criterios de aceptación">{ico("crit")}{c[0]}/{c[1]}</span>')
  n = comments if comments is not None else w.get('comments')
  if n:
    foot.append(f'<span class="wi-fact" title="Comentarios">{ico("comment")}{n}</span>')
  meta = ''
  if foot:
    footer = f'<div class="wi-card-foot">{"".join(foot)}<span class="grow"></span>{assignee}</div>'
    if bits: meta = f'<div class="wi-card-meta">{"".join(bits)}</div>'
  else:
    # An assignee with no facts beside it joins the meta row, as on the plain board
    footer = ''
    if bits or assignee:
      meta = f'<div class="wi-card-meta">{"".join(bits)}<span class="grow"></span>{assignee}</div>'
  return f'<article class="{cls}" aria-label="{k} · {w["title"]}">{top}<p class="wi-card-title">{w["title"]}</p>{meta}{inner}{footer}</article>'


def tcol(s, cards, who_head, extra=''):
  name = COL_WORD[s]
  n = len(cards) + (DONE_MORE if s == 'done' else 0)
  lim = LIMITS.get(s)
  over = lim is not None and n > lim
  cnt = f'<span class="wi-col-count"><b>{n}</b>/{lim}</span>' if lim else f'<span class="wi-col-count"><b>{n}</b></span>'
  head = f'<div class="wi-col-head">{sico(s)}<span class="t-label">{name}</span>{cnt}<span class="grow"></span>{who_head}</div>'
  warn = f'<div class="wi-col-limit" role="status">{ico("warn")}Sobre el límite: {n} de {lim}</div>' if over else ''
  more = f'<a href="DesktopTareasLista.html" class="wi-col-slot" style="border-style: solid; border-color: var(--line)">y {DONE_MORE} más</a>' if s == 'done' else ''
  return f'<section class="wi-col{" over" if over else ""}" aria-label="{name}">{head}{warn}<div class="wi-col-body">{"".join(cards)}{more}{extra}</div></section>'


TEAM_LIVE = '''<div class="col" style="gap: 4px">
<div class="row" style="padding: 0 10px 4px"><span class="t-label grow">En directo</span><span class="count-pill live">3</span></div>
<a href="DesktopChatTarea.html" class="list-row rail-live" style="padding: 8px 10px 8px 14px; flex-direction: column; align-items: stretch; gap: 3px">
<span class="row" style="gap: 7px"><span class="spin-braille"></span><span class="t-sm ellipsis" style="font-weight: 500">Trabaja en AGN-28: tablero con columnas fijas</span></span>
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
  q = '<div class="member-now" style="min-height: 0; font-size: 12px; align-items: flex-start">' + role('QA') + '<span style="color: var(--fg-2); line-height: 1.4">«La clave cambia al renombrar; el criterio 2 pide que no.»</span></div>'
  waits = '<div class="row t-xs" style="gap: 6px; flex-wrap: wrap"><span class="badge b-idle">te espera</span><span class="fg-2">QA la devolvió tres veces</span></div>'
  approve = f'<div class="col" style="gap: 7px; padding-top: 2px; border-top: 1px solid var(--line)"><span class="row t-xs" style="gap: 6px; padding-top: 6px"><span class="badge b-idle">espera</span><span class="fg-2">QA la dio por buena</span></span><button type="button" class="btn btn-sm" style="width: 100%">{ico("check", "ico ico-sm")}Aprobar y pasar a Hecho</button></div>'
  cols = {
    'backlog': [tcard('AGN-45', 'PO'), tcard('AGN-38'), tcard('AGN-44', 'DOC'), tcard('AGN-41')],
    'todo': [tcard('AGN-47'), tcard('AGN-39', 'Y'), tcard('AGN-36', 'PO'), tcard('AGN-33', 'PO')],
    'in_progress': [tcard('AGN-12'),
                    tcard('AGN-28', 'DEV', live=live_box('Ejecutando', 'pnpm test', '4:12', role('DEV'))),
                    tcard('AGN-30'),
                    tcard('AGN-35', 'DEV', body=q, foot_lead=f'<span class="bounce" title="QA la devolvió una vez de tres posibles">{ico("bounce")}rebote 1 de 3</span>', comments=1),
                    tcard('AGN-31', 'Y', body=waits, foot_lead=f'<span class="bounce" title="QA la devolvió tres veces de tres posibles">{ico("bounce")}rebote 3 de 3</span>')],
    'in_review': [tcard('AGN-29', 'QA', live=live_box('Leyendo', 'work-items.test.ts', '1:05', role('QA'))),
                  tcard('AGN-26', 'QA', body=approve, crit=(5, 5))],
    'done': [tcard(k) for k in by_col('done')],
  }
  heads = {'backlog': role('PO'), 'todo': role('PO'), 'in_progress': role('DEV'), 'in_review': role('QA'),
           'done': '<span class="proj monogram wi-assignee" style="--hue: 24" title="Tú apruebas el paso a Hecho">Y</span>'}
  board = ''.join(tcol(s, cols[s], heads[s]) for s, _ in COLS)
  hd = board_head('claude-wrapper · 15 abiertas · clave <span class="mono">AGN</span>')
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


def with_proj(html, k):
  name = PROJ[k.split('-')[0]][0]
  chip = f'<span class="wi-proj" title="Proyecto">{ico("folder")}{name}</span>'
  if '<div class="wi-card-meta">' in html:
    return html.replace('<div class="wi-card-meta">', f'<div class="wi-card-meta">{chip}', 1)
  return html.replace('</p>', f'</p><div class="wi-card-meta">{chip}</div>', 1)


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
    n = len(keys) + (ALL_DONE - len(keys) if s == 'done' else 0)
    # With every project shown there are no column limits: each project sets its own
    head = f'<div class="wi-col-head">{sico(s)}<span class="t-label">{name}</span><span class="wi-col-count"><b>{n}</b></span><span class="grow"></span></div>'
    cards = ''.join(with_proj(card(k), k) for k in keys)
    more = f'<a href="DesktopTareasLista.html" class="wi-col-slot" style="border-style: solid; border-color: var(--line)">y {ALL_DONE - len(keys)} más</a>' if s == 'done' else ''
    cols += f'<section class="wi-col" aria-label="{name}">{head}<div class="wi-col-body">{cards}{more}</div></section>'
  hd = board_head('Todos los proyectos · 18 abiertas en 2 proyectos con tablero', primary=False)
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
  hd = board_head('claude-wrapper · 15 abiertas · clave <span class="mono">AGN</span>', primary=False)
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
