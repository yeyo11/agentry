from data import *
from board import head, toolbar, view_seg, mhead, mtoolbar, mproject_chip, jump, msection, mrow, mview_seg


# ---------- Empty board ----------
def empty_desktop():
  main = f'''<main class="page" style="gap: 16px">
{head('pagos-api · 0 tareas · clave <span class="mono">PAG</span>', primary=False).replace('<button type="button" class="btn">' + ico('tasks') + 'Seleccionar</button>', '')}
<section class="card glow-top empty-state" style="flex: 1 1 auto; justify-content: center; padding: 64px 24px; gap: 16px; background-size: 100% 320px">
<div class="app" data-theme="dark" style="display: inline-block; background: transparent">{empty_board_svg('il-lg')}</div>
<h2 class="t-h1" style="font-size: 22px">Aún no hay tareas</h2>
<p>El tablero de pagos-api está vacío. Crea la primera tarea aquí, o desde cualquier mensaje de un chat con «Crear una tarea con este mensaje».</p>
<div class="row" style="gap: 8px"><a href="DesktopNuevaTarea.html" class="btn btn-primary">{ico('plus')}Crear la primera tarea</a></div>
<span class="row mono t-xs fg-3" style="gap: 6px; margin-top: 6px"><span class="kbd">N</span>para crear una tarea desde cualquier vista del tablero</span>
</section>
</main>'''
  html = desktop('Tablero vacío', 'tasks', '<span style="font-weight: 500">Tareas</span>', main, project='pagos-api')
  write('DesktopTableroVacio.html', html.replace('<span class="grow">Tareas</span><span class="count">15</span>', '<span class="grow">Tareas</span>'))


def empty_mobile():
  inner = f'''{mhead('Tareas', None, 'MobileMas.html', mproject_chip() + '<span style="width: 8px"></span>')}
<div class="m-body stack" style="gap: 12px">
{mview_seg('board')}
<section class="empty-state" style="flex: 1 1 auto; justify-content: center; padding: 16px 8px 40px; gap: 14px">
<div class="app" data-theme="dark" style="display: inline-block; background: transparent">{empty_board_svg('')}</div>
<h2 class="t-h1" style="font-size: 22px">Aún no hay tareas</h2>
<p>El tablero de pagos-api está vacío. Crea la primera tarea aquí, o desde un mensaje de cualquier chat.</p>
<a href="MobileNuevaTarea.html" class="btn btn-primary btn-lg" style="width: 100%; margin-top: 4px">{ico('plus', 'ico ico-lg')}Crear la primera tarea</a>
</section>
</div>
{tabbar('more')}'''
  write('MobileTableroVacio.html', mobile('Tablero vacío', inner).replace('claude-wrapper<svg', 'pagos-api<svg'))


# ---------- List ----------
ECO = [k for k, w in W.items() if w.get('epic') == 'eco']
UPD = {'AGN-44': '3 d', 'AGN-36': '1 d', 'AGN-33': '1 d', 'AGN-28': 'ahora', 'AGN-30': 'ahora', 'AGN-35': '5 h', 'AGN-26': '12 min', 'AGN-29': '2 h', 'AGN-24': '1 d'}


def lrow(k):
  w = W[k]
  live = w.get('live')
  cls = 'wi-row' + (' rail-live' if live else '') + (' done' if w['s'] == 'done' else '')
  lead = '<span class="spin-ring" style="width: 14px; height: 14px" role="img" aria-label="Trabajando"></span>' if live else tico(w['t'])
  st = ''
  if live == 'chat':
    st = '<span class="row t-xs" style="gap: 6px; width: 170px"><span class="spin-braille"></span><span class="c-live">Ejecutando</span><span class="mono fg-3 ellipsis">pnpm test</span></span>'
  elif live == 'orch':
    st = '<span class="row t-xs" style="gap: 6px; width: 170px"><span class="spin-braille"></span><span class="mono c-live ellipsis">nodo 3 de 9</span><span class="segbar grow" style="height: 4px"><i class="ok"></i><i class="ok"></i><i class="live" style="--p: 55%"></i><i></i><i></i></span></span>'
  elif w.get('blocked'):
    st = f'<span class="row mono t-xs fg-3" style="gap: 5px; width: 170px">{ico("block", "ico ico-sm")}bloqueada por {w["blocked"]}</span>'
  else:
    st = '<span style="width: 170px"></span>'
  labels = ''.join(label(l) for l in w.get('labels', []))
  crit = f'{w["crit"][0]}/{w["crit"][1]}' if w.get('crit') else ''
  who = av() if w.get('who') else unassigned()
  return f'''<a href="DesktopTarea.html" class="{cls}">{lead}<span class="wi-key">{k}</span><span class="wi-row-title">{w['title']}</span>{st}<span class="row" style="gap: 4px; width: 90px">{labels}</span><span class="mono t-xs fg-3" style="width: 34px">{crit}</span><span class="row" style="gap: 6px; width: 78px">{prio(w['p'])}<span class="t-xs fg-2">{PRIO_WORD[w['p']]}</span></span>{who}<span class="mono t-xs fg-3" style="width: 48px; text-align: right">{UPD.get(k, '')}</span></a>'''


def lgroup(s, keys):
  n = len(keys)
  lim = LIMITS.get(s)
  tot = len(by_col(s))
  over = lim is not None and tot > lim
  warn = f'<span class="badge b-warn">{ico("warn", "ico", "width: 11px; height: 11px")}sobre el límite · {tot} de {lim}</span>' if over else ''
  return f'<div class="wi-group">{sico(s)}<span class="t-label">{COL_WORD[s]}</span><span class="wi-col-count"><b>{n}</b></span>{warn}</div>' + ''.join(lrow(k) for k in keys)


def list_desktop():
  groups = ''.join(lgroup(s, by_col(s, ECO)) for s, _ in COLS if by_col(s, ECO))
  main = f'''<main class="page" style="gap: 16px">
{head('claude-wrapper · 11 de 27 con los filtros', on='list')}
{toolbar({'epic': 'Ecosistema de proyectos'})}
<div class="card" style="overflow: hidden">
<div class="row th" style="gap: 12px; height: 34px; padding: 0 14px; border-bottom: 1px solid var(--line)"><span style="width: 14px"></span><span style="width: 52px">Clave</span><span class="grow">Título</span><span style="width: 170px">Ahora</span><span style="width: 90px">Etiquetas</span><span style="width: 34px">Crit.</span><span style="width: 78px">Prioridad</span><span style="width: 20px"></span><span style="width: 48px; text-align: right">Cambio</span></div>
{groups}
<a href="DesktopTablero.html" class="row t-sm fg-2" style="gap: 8px; height: 40px; padding: 0 14px; border-top: 1px solid var(--line)">{ico('down', 'ico ico-sm')}Mostrar las otras 2 hechas de esta épica</a>
</div>
<span class="row t-xs fg-3 mono" style="gap: 6px">{ico('filter', 'ico ico-sm')}Ordenadas por su posición en el tablero · <span class="kbd">J</span><span class="kbd">K</span> para moverte</span>
</main>'''
  write('DesktopTareasLista.html', desktop('Lista de tareas', 'tasks', '<span style="font-weight: 500">Tareas</span>', main))


def list_mobile():
  secs = ''
  for s, n in COLS:
    ks = by_col(s, ECO)
    if not ks: continue
    lim = LIMITS.get(s)
    tot = len(by_col(s))
    over = lim is not None and tot > lim
    warn = f'<span class="badge b-warn">{ico("warn", "ico", "width: 11px; height: 11px")}{tot}/{lim}</span>' if over else ''
    rows = ''
    for k in ks:
      w = W[k]
      live = w.get('live')
      lead = '<span class="spin-ring" style="width: 14px; height: 14px" role="img" aria-label="Trabajando"></span>' if live else tico(w['t'])
      rows += f'<a href="MobileTarea.html" class="wi-row{" rail-live" if live else ""}{" done" if s == "done" else ""}" style="min-height: 52px; font-size: 15px">{lead}<span class="wi-key" style="width: 50px">{k}</span><span class="wi-row-title">{w["title"]}</span>{prio(w["p"])}</a>'
    secs += f'<section class="col" style="gap: 6px"><div class="row" style="gap: 8px; padding: 0 2px">{sico(s)}<span class="t-label" style="color: var(--fg-2)">{n}</span><span class="wi-col-count"><b>{len(ks)}</b></span><span class="grow"></span>{warn}</div><div class="card" style="overflow: hidden">{rows}</div></section>'
  inner = f'''{mhead('Tareas', None, 'MobileMas.html', mproject_chip() + '<span style="width: 8px"></span>')}
<div class="m-body stack" style="gap: 12px">
{mview_seg('list')}
{mtoolbar(1)}
<div class="row" style="gap: 6px"><button type="button" class="chip on" style="height: 36px; font-size: 13.5px">Épica: Ecosistema de proyectos<span aria-label="Quitar filtro">{ico('x', 'ico ico-sm')}</span></button><span class="mono t-xs fg-3">11 de 27</span></div>
{secs}
</div>
<a href="MobileNuevaTarea.html" class="fab" aria-label="Nueva tarea" style="padding: 0; width: 56px">{ico('plus', 'ico ico-lg', 'stroke-width: 2.2')}</a>
{tabbar('more')}'''
  write('MobileTareasLista.html', mobile('Lista de tareas', inner, 'has-fab'))


# ---------- Work item detail (AGN-26) ----------
CRIT = [
  (True, 'Las cinco plantillas viven en código como datos, con sus módulos y su configuración.', 'yeyo', '1 d'),
  (True, '<span class="mono">GET /projects/templates</span> las lista en el orden del asistente.', 'chat 4c1d0e', '1 d'),
  (True, 'Crear un proyecto con una plantilla preselecciona sus módulos.', 'chat 4c1d0e', '1 d'),
  (True, 'Personalizada no activa ningún módulo.', 'yeyo', '40 min'),
  (False, 'Los proyectos ya importados siguen con todos los módulos desactivados.', '', ''),
]


def crit_rows(mobile=False):
  out = ''
  for on, t, who, when in CRIT:
    by = ''
    if on:
      mark = av(cls='wi-assignee') if who == 'yeyo' else '<span class="agent-mark" style="width: 18px; height: 18px; font-size: 8.5px">›_</span>'
      by = f'<span class="ac-by">{mark}{who} · {when}</span>' if not mobile else f'<span class="ac-by">{mark}{when}</span>'
    out += f'<div class="ac-row{" on" if on else ""}"{" style=\"min-height: 52px\"" if mobile else ""}><span class="checkbox{" on" if on else ""}" role="checkbox" aria-checked="{"true" if on else "false"}"></span><span class="ac-text">{t}</span>{by}</div>'
  return out


LINKS = [
  ('chats', 'Trabaja en AGN-26: plantillas de proyecto', 'chat 4c1d0e · la llevó a revisión', '<span class="badge b-ok">' + '✓ terminado</span>', '1,84 US$'),
  ('orch', 'ecosystem-foundation › project-modules', 'nodo del grafo · la tarea siguió su estado', '<span class="badge b-ok">✓ hecha</span>', '3,12 US$'),
  ('chats', 'Trabaja en AGN-26: plantillas de proyecto', 'chat 91ab22 · no movió la tarea', '<span class="badge b-bad">interrumpido</span>', '0,41 US$'),
]


def link_rows():
  return ''.join(f'<a href="{"DesktopOrquestacion.html" if i == "orch" else "DesktopChat.html"}" class="link-row" style="align-items: flex-start"><span class="link-ico">{ico(i)}</span><span class="col grow" style="gap: 4px; min-width: 0"><span class="t-sm ellipsis" style="font-weight: 500">{t}</span><span class="row" style="gap: 8px">{b}<span class="mono t-xs fg-3">{c}</span></span><span class="mono t-xs fg-3 ellipsis">{m}</span></span></a>' for i, t, m, b, c in LINKS)


FILES = [('core/src/project-templates.ts', 142, 0, 'aaaaa'), ('core/src/project-settings.ts', 38, 12, 'aaad'), ('api/src/routes/projects.ts', 21, 19, 'aadd'), ('core/test/project-templates.test.ts', 13, 6, 'aad')]


def diff_rows():
  out = ''
  for p, a, d, bar in FILES:
    cells = ''.join(f'<i class="{"add" if c == "a" else "del"}"></i>' for c in bar) + '<i></i>' * (5 - len(bar))
    out += f'<div class="diff-file"><span class="path">{p}</span><span class="n">+{a} −{d}</span><span class="diffstat" aria-hidden="true">{cells}</span></div>'
  return out


def activity(compact=False):
  items = [
    ('h', 'plus', 'Creada en <b>Backlog</b>', 'yeyo', '3 d'),
    ('h', 'play', 'Pasó de Por hacer a <b>En curso</b>', 'automático · empezó el chat 4c1d0e', '1 d'),
    ('a', '', 'He dejado las cinco plantillas como datos en <code>project-templates.ts</code> y la ruta que las lista. Queda el criterio 5: los proyectos ya importados deben leerse sin módulos, y eso depende de <span class="mono">AGN-24</span>.', 'chat 4c1d0e', '1 d'),
    ('h', 'move', 'Pasó de En curso a <b>En revisión</b>', 'automático · el turno del chat terminó bien', '1 d'),
    ('p', '', 'AGN-24 ya está hecha. Revisa el criterio 5 contra un proyecto importado antes de darla por buena.', 'yeyo', '40 min'),
    ('h', 'check', 'Criterio 4 marcado', 'yeyo', '40 min'),
  ]
  if compact: items = items[1:]
  out = ''
  for kind, i, t, who, when in items:
    if kind == 'h':
      out += f'<div class="hist"><span class="hist-ico"><span>{ico(i)}</span></span><span class="col grow" style="gap: 1px; min-width: 0"><span>{t}</span><span class="cause">{who}</span></span><time>{when}</time></div>'
    elif kind == 'a':
      out += f'<div class="comment agent"><span class="agent-mark">›_</span><div class="comment-body"><div class="comment-head"><b>Agente</b><span class="badge">agente</span><span class="mono t-xs fg-3">{who}</span><time>{when}</time></div><span>{t}</span></div></div>'
    else:
      out += f'<div class="comment">{av(cls="avatar")}<div class="comment-body"><div class="comment-head"><b>yeyo</b><time>{when}</time></div><span>{t}</span></div></div>'
  return out


def detail_desktop():
  props = f'''<div class="prop-row" style="border-top: 0"><span class="k">Estado</span><span class="v"><button type="button" class="btn btn-sm" style="gap: 7px">{sico('in_review')}En revisión{ico('down', 'ico ico-sm')}</button></span></div>
<div class="prop-row"><span class="k">Prioridad</span><span class="v">{prio('medium')}<span>Media</span></span></div>
<div class="prop-row"><span class="k">Tipo</span><span class="v">{tico('story')}<span>Historia</span></span></div>
<div class="prop-row"><span class="k">Responsable</span><span class="v">{av()}<span>yeyo</span></span></div>
<div class="prop-row"><span class="k">Épica</span><span class="v">{epic('eco')}</span></div>
<div class="prop-row"><span class="k">Hito</span><span class="v"><span class="ms-name" style="font-size: 12.5px">v0.20</span><span class="ms-bar" style="width: 64px; height: 4px"><i class="done" style="width: 47%"></i><i class="doing" style="width: 27%"></i></span></span></div>
<div class="prop-row"><span class="k">Etiquetas</span><span class="v">{label('core')}{label('api')}<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Añadir etiqueta" style="width: 22px; height: 22px">{ico('plus', 'ico ico-sm')}</button></span></div>
<div class="prop-row"><span class="k">Creada</span><span class="v mono t-xs fg-2">hace 3 d · yeyo</span></div>'''
  aside = f'''<aside aria-label="Propiedades de la tarea" class="col" style="width: 340px; flex-shrink: 0; border-left: 1px solid var(--line); background: var(--bg-1); padding: 20px 18px; gap: 22px; overflow: hidden">
<section class="col" style="gap: 0">{props}</section>
<section class="col" style="gap: 8px"><div class="row"><span class="t-label grow">Chats y orquestaciones</span><span class="count">3</span></div>{link_rows()}</section>
<section class="col" style="gap: 8px"><div class="row"><span class="t-label grow">Cambios en su worktree</span></div>
<div class="card" style="overflow: hidden; border-radius: var(--r-lg)"><div class="row" style="gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line)">{ico('branch', 'ico ico-sm fg-3')}<span class="mono t-xs">task/agn-26</span><span class="mono t-xs fg-3 grow">desde main</span><span class="mono t-xs fg-2">+214 −37</span></div>{diff_rows()}</div>
<div class="row" style="gap: 8px"><a href="#" class="btn btn-sm grow">{ico('git', 'ico ico-sm')}Ver el diff</a><a href="#" class="btn btn-sm btn-ghost">Abrir el worktree</a></div>
</section>
</aside>'''
  main = f'''<div class="row" style="flex: 1 1 auto; min-height: 0; align-items: stretch; gap: 0">
<div class="col grow stack" style="padding: 22px 32px 0; gap: 20px; overflow: hidden; min-width: 0">
<div class="row" style="gap: 10px">
<a href="DesktopTablero.html" class="btn btn-icon btn-sm" aria-label="Volver al tablero">{ico('left')}</a>
{tico('story', True)}<span class="wi-key boxed">AGN-26</span><span class="badge">{sico('in_review')}en revisión</span>
<span class="grow"></span>
<button type="button" class="btn btn-ghost btn-icon" aria-label="Copiar el enlace">{ico('link')}</button>
<button type="button" class="btn btn-ghost btn-icon" aria-label="Más acciones">{ico('more', 'ico', 'stroke-width: 3')}</button>
<button type="button" class="btn">{ico('check')}Mover a Hecho</button>
<a href="DesktopChatTarea.html" class="btn btn-primary">{ico('play')}Trabajar en ella</a>
</div>
<div class="col" style="gap: 10px"><h1 class="t-h1" style="font-size: 26px">Plantillas de proyecto</h1>
<div class="t-body fg-2" style="line-height: 1.6; max-width: 720px">Un proyecto nuevo elige una plantilla que preselecciona módulos, tipos de tarea, límites por columna y el equipo inicial con el modelo de cada rol. Cinco plantillas integradas: <b style="color: var(--fg); font-weight: 500">Simple</b>, <b style="color: var(--fg); font-weight: 500">Software profesional</b>, <b style="color: var(--fg); font-weight: 500">Biblioteca o paquete</b>, <b style="color: var(--fg); font-weight: 500">Investigación o documentación</b> y <b style="color: var(--fg); font-weight: 500">Personalizada</b>. Sin plantillas guardadas por el usuario.</div></div>
<section class="col" style="gap: 8px"><div class="row" style="gap: 10px"><h2 class="t-h2">Criterios de aceptación</h2><span class="mono t-xs fg-3">4/5</span><span class="ms-bar" style="width: 90px; height: 4px"><i class="done" style="width: 80%"></i></span><span class="grow"></span><button type="button" class="btn btn-ghost btn-sm">{ico('plus', 'ico ico-sm')}Añadir criterio</button></div>
<div class="card" style="overflow: hidden; border-radius: var(--r-lg)">{crit_rows()}</div></section>
<section class="col" style="gap: 8px"><div class="row"><h2 class="t-h2 grow">Relaciones</h2><button type="button" class="btn btn-ghost btn-sm">{ico('plus', 'ico ico-sm')}Relacionar</button></div>
<div class="card" style="overflow: hidden; border-radius: var(--r-lg)">
<a href="#" class="rel-row"><span class="rel-kind">Bloquea</span>{sico('todo')}<span class="wi-key">AGN-33</span><span class="grow ellipsis">Enlazar tareas con chats y orquestaciones</span><span class="t-xs fg-3">Por hacer</span></a>
<a href="#" class="rel-row"><span class="rel-kind">Bloqueada por</span>{sico('done')}<span class="wi-key">AGN-24</span><span class="grow ellipsis">Ajustes por proyecto en un JSON</span><span class="t-xs c-ok">Hecha</span></a>
</div></section>
<section class="col" style="gap: 12px"><div class="row" style="gap: 10px"><h2 class="t-h2 grow">Actividad</h2><div class="seg" role="tablist" aria-label="Actividad"><button type="button" class="on">Todo</button><button type="button">Comentarios <span class="count">2</span></button><button type="button">Historial <span class="count">4</span></button></div></div>
<div class="activity">{activity()}</div>
</section>
</div>
{aside}
</div>'''
  write('DesktopTarea.html', desktop('Tarea', 'tasks', '<a href="DesktopTablero.html" class="fg-2">Tareas</a><span class="fg-3">/</span><span class="mono" style="font-weight: 500">AGN-26</span>', main))


def detail_mobile():
  inner = f'''<header class="row" style="flex-shrink: 0; padding: 8px 4px; gap: 4px">
<a href="MobileTablero.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver">{ico('left', 'ico ico-lg', 'stroke-width: 2')}</a>
<span class="row grow" style="gap: 8px">{tico('story', True)}<span class="wi-key boxed">AGN-26</span></span>
<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Más acciones">{ico('more', 'ico ico-lg', 'stroke-width: 3')}</button>
</header>
<div class="m-body stack" style="gap: 14px">
<h1 class="t-h1" style="font-size: 24px">Plantillas de proyecto</h1>
<div class="row" style="gap: 6px; flex-wrap: wrap"><button type="button" class="chip" style="height: 36px">{sico('in_review')}En revisión{ico('down', 'ico ico-sm')}</button><button type="button" class="chip" style="height: 36px">{prio('medium')}Media</button><button type="button" class="chip" style="height: 36px">{av()}yeyo</button></div>
<div class="row" style="gap: 6px">{epic('eco')}<span class="ms-name" style="font-size: 12px">v0.20</span>{label('core')}{label('api')}</div>
<p class="t-sm fg-2" style="margin: 0; line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden">Un proyecto nuevo elige una plantilla que preselecciona módulos, tipos de tarea, límites por columna y el equipo inicial con el modelo de cada rol. Cinco plantillas integradas.</p>
<div class="seg" role="tablist" aria-label="Secciones" style="display: flex"><button type="button" class="on" style="flex: 1 1 0; justify-content: center; height: 36px; font-size: 14px">Detalle</button><button type="button" style="flex: 1 1 0; justify-content: center; height: 36px; font-size: 14px">Actividad <span class="count">6</span></button><button type="button" style="flex: 1 1 0; justify-content: center; height: 36px; font-size: 14px">Cambios</button></div>
<div class="row" style="gap: 8px; padding: 0 2px"><span class="t-label grow">Criterios de aceptación</span><span class="mono t-xs fg-3">4/5</span></div>
<div class="card" style="overflow: hidden">{crit_rows(True)}</div>
<div class="row" style="gap: 8px; padding: 0 2px"><span class="t-label grow">Chats y orquestaciones</span><span class="count">3</span></div>
<div class="col" style="gap: 8px">{link_rows()}</div>
</div>
<div class="m-foot"><button type="button" class="btn btn-lg btn-icon" aria-label="Mover a Hecho" style="flex: 0 0 auto">{ico('check', 'ico ico-lg')}</button><a href="MobileChatTarea.html" class="btn btn-primary btn-lg">{ico('play', 'ico ico-lg')}Trabajar en ella</a></div>'''
  write('MobileTarea.html', mobile('Tarea', inner))


# ---------- New task ----------
def select_btn(label_txt, lead=''):
  return f'<button type="button" class="field" style="width: 100%; justify-content: flex-start; cursor: pointer; color: var(--fg)">{lead}<span class="grow t-sm ellipsis" style="text-align: left">{label_txt}</span>{ico("down", "ico ico-sm fg-3")}</button>'


def new_task_desktop():
  from board import head as bhead, toolbar as btool
  cols = ''.join(col(s, by_col(s)) for s, _ in COLS)
  main = f'''<main class="page" style="gap: 16px">
{bhead('claude-wrapper · 15 abiertas · clave <span class="mono">AGN</span>', primary=False)}
{btool()}
<div class="wi-board">{cols}</div>
</main>'''
  types = ''.join(f'<button type="button" role="radio" aria-checked="{"true" if t == "task" else "false"}" class="{"on" if t == "task" else ""}">{tico(t)}{TYPE_WORD[t]}</button>' for t in ('epic', 'story', 'task', 'bug'))
  crit = ''.join(f'<div class="row" style="gap: 8px"><span class="fg-3" aria-hidden="true">{ico("dots-v", "ico ico-sm")}</span><label class="field grow" style="height: 34px"><input value="{v}" aria-label="Criterio {i}"></label><button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Quitar criterio {i}">{ico("x", "ico ico-sm")}</button></div>' for i, v in ((1, 'La columna muestra su límite y el número de tareas'), (2, 'Pasarse del límite no bloquea el movimiento')))
  dialog = f'''<div class="scrim">
<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="nt-title" style="width: 680px">
<div class="dialog-head"><h2 id="nt-title" class="t-h2 grow" style="font-size: 16px">Nueva tarea</h2><span class="mono t-xs fg-3">claude-wrapper · será <span class="fg-2">AGN-48</span></span><button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Cerrar">{ico('x')}</button></div>
<div class="dialog-body">
<div class="seg" role="radiogroup" aria-label="Tipo" style="align-self: flex-start">{types}</div>
<label class="field field-lg"><input value="Límite por columna en el tablero" aria-label="Título" style="font-size: 16px; font-weight: 500"></label>
<div class="form-row"><span class="row"><span class="t-label grow" style="color: var(--fg-2)">Descripción</span><span class="row mono t-xs fg-3" style="gap: 5px">{ico('md', 'ico ico-sm')}Markdown</span></span>
<label class="field field-area"><textarea rows="3" aria-label="Descripción">Cada columna puede tener un límite opcional. Pasarse se permite y la columna lo dice en ámbar, con una palabra; nunca bloquea el movimiento.</textarea></label></div>
<div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px">
<div class="form-row"><span class="t-label">Columna</span>{select_btn('Backlog', sico('backlog'))}</div>
<div class="form-row"><span class="t-label">Prioridad</span>{select_btn('Media', prio('medium'))}</div>
<div class="form-row"><span class="t-label">Responsable</span>{select_btn('Sin responsable', unassigned())}</div>
<div class="form-row"><span class="t-label">Épica</span>{select_btn('Ecosistema de proyectos', '<span class="wi-epic" style="--hue: 18; padding: 0; background: none; width: 8px"></span>')}</div>
<div class="form-row"><span class="t-label">Hito</span>{select_btn('<span class="mono">v0.20</span>')}</div>
<div class="form-row"><span class="t-label">Etiquetas</span><div class="field" style="gap: 5px">{label('web')}<input placeholder="Añadir…" aria-label="Etiquetas"></div></div>
</div>
<div class="form-row"><span class="row"><span class="t-label grow" style="color: var(--fg-2)">Criterios de aceptación</span><span class="mono t-xs fg-3">2</span></span>{crit}<button type="button" class="btn btn-ghost btn-sm" style="align-self: flex-start">{ico('plus', 'ico ico-sm')}Añadir criterio</button></div>
</div>
<div class="dialog-foot"><label class="row t-sm fg-2" style="gap: 8px; cursor: pointer"><span class="checkbox" role="checkbox" aria-checked="false"></span>Crear otra</label><span class="grow"></span><button type="button" class="btn btn-ghost">Cancelar</button><button type="button" class="btn btn-primary">{ico('plus')}Crear tarea</button></div>
</div>
</div>'''
  write('DesktopNuevaTarea.html', desktop('Nueva tarea', 'tasks', '<span style="font-weight: 500">Tareas</span>', main, overlay=f'<div style="position: absolute; inset: 0; z-index: 30">{dialog}</div>'))


def new_task_mobile():
  types = ''.join(f'<button type="button" role="radio" aria-checked="{"true" if t == "task" else "false"}" class="{"on" if t == "task" else ""}" style="flex: 1 1 0; justify-content: center; height: 40px; font-size: 13.5px">{tico(t)}{TYPE_WORD[t]}</button>' for t in ('epic', 'story', 'task', 'bug'))

  def cell(k, v):
    return f'<button type="button" class="cell" style="width: 100%; min-height: 52px; background: none; border-left: 0; border-right: 0; border-top: 0; text-align: left"><span class="fg-3" style="width: 104px">{k}</span><span class="row grow" style="gap: 8px; min-width: 0">{v}</span>{ico("right", "ico fg-3")}</button>'
  inner = f'''<header class="row" style="flex-shrink: 0; padding: 8px 8px; gap: 4px; min-height: 60px">
<a href="MobileTablero.html" class="btn btn-ghost btn-lg" style="padding: 0 10px">Cancelar</a>
<span class="grow" style="text-align: center; font-weight: 600; font-size: 17px">Nueva tarea</span>
<span class="mono t-xs fg-3" style="width: 86px; text-align: right; padding-right: 8px">AGN-48</span>
</header>
<div class="m-body stack" style="gap: 14px">
<div class="seg" role="radiogroup" aria-label="Tipo" style="display: flex">{types}</div>
<label class="field field-lg"><input value="Límite por columna en el tablero" aria-label="Título" style="font-size: 16px; font-weight: 500"></label>
<label class="field field-area" style="min-height: 104px"><textarea rows="3" aria-label="Descripción" style="font-size: 16px">Cada columna puede tener un límite opcional. Pasarse se permite y nunca bloquea el movimiento.</textarea></label>
<div class="card" style="overflow: hidden">
{cell('Columna', sico('backlog') + 'Backlog')}
{cell('Prioridad', prio('medium') + 'Media')}
{cell('Épica', epic('eco'))}
{cell('Hito', '<span class="mono">v0.20</span>')}
{cell('Responsable', '<span class="fg-2">Sin responsable</span>')}
</div>
<div class="row" style="padding: 0 4px"><span class="t-label grow">Criterios de aceptación</span><span class="mono t-xs fg-3">1</span></div>
<div class="card" style="overflow: hidden"><div class="cell" style="min-height: 52px"><span class="grow t-sm">Pasarse del límite no bloquea el movimiento</span><button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Quitar criterio">{ico('x', 'ico')}</button></div><button type="button" class="cell c-accent" style="width: 100%; min-height: 52px; background: none; border: 0; font-weight: 500">{ico('plus')}Añadir criterio</button></div>
</div>
<div class="m-foot"><button type="button" class="btn btn-primary btn-lg">{ico('plus', 'ico ico-lg')}Crear tarea</button></div>'''
  write('MobileNuevaTarea.html', mobile('Nueva tarea', inner))


# ---------- Milestones ----------
MS_OPEN = [
  ('v0.20', 'Ecosistema de proyectos', 'Módulos, plantillas, el tablero y el enlace de las tareas con chats y orquestaciones.', 7, 4, 15, {'backlog': 2, 'todo': 2, 'in_progress': 3, 'in_review': 1, 'done': 7}),
  ('v0.21', 'Equipo y memoria', 'Roles con su modelo, flujo por columna, diario del proyecto y propuestas de memoria.', 0, 0, 9, {'backlog': 9, 'todo': 0, 'in_progress': 0, 'in_review': 0, 'done': 0}),
]
MS_CLOSED = [('v0.19', 'Night Shift', 12), ('v0.18', 'Slash commands en el compositor', 6), ('v0.17', 'Programaciones', 8)]


def ms_card(ms, current=False, mobile=False):
  name, title, desc, d, g, n, cols = ms
  pct = round(d / n * 100)
  counts = ''.join(f'<span class="row" style="gap: 5px">{sico(s)}<span class="mono t-xs fg-2">{cols[s]}</span></span>' for s, _ in COLS)
  cls = 'card col' + (' grad-border' if current else '')
  big = f'<span class="t-num{" grad-text" if current else ""}" style="font-size: {28 if mobile else 30}px; font-weight: 600; letter-spacing: -0.035em">{pct} %</span>'
  if mobile:
    return f'''<a href="MobileTablero.html" class="{cls}" style="padding: 16px; gap: 10px">
<span class="row" style="gap: 8px">{ico('flag', 'ico fg-3')}<span class="ms-name">{name}</span><span class="grow"></span><span class="badge">abierto</span></span>
<span style="font-weight: 600; font-size: 15px">{title}</span>
<span class="row" style="align-items: baseline; gap: 10px">{big}<span class="t-sm fg-2">{d} de {n} hechas</span></span>
<span class="ms-bar"><i class="done" style="width: {d / n * 100:.1f}%"></i><i class="doing" style="width: {g / n * 100:.1f}%"></i></span>
<span class="ms-legend"><span><i class="done"></i>{d} hechas</span><span><i class="doing"></i>{g} en marcha</span><span><i></i>{n - d - g} pendientes</span></span>
</a>'''
  return f'''<article class="{cls}" style="padding: 18px; gap: 14px">
<div class="row" style="gap: 12px; align-items: flex-start">{ico('flag', 'ico fg-3', 'margin-top: 3px')}<div class="col grow" style="gap: 4px; min-width: 0"><span class="row" style="gap: 10px"><span class="ms-name" style="font-size: 14px">{name}</span><span style="font-weight: 600; font-size: 15px">{title}</span><span class="badge">abierto</span></span><span class="t-sm fg-2">{desc}</span></div>{big}</div>
<span class="ms-bar"><i class="done" style="width: {d / n * 100:.1f}%"></i><i class="doing" style="width: {g / n * 100:.1f}%"></i></span>
<div class="row" style="gap: 16px"><span class="ms-legend"><span><i class="done"></i>{d} hechas</span><span><i class="doing"></i>{g} en curso o en revisión</span><span><i></i>{n - d - g} pendientes</span></span><span class="grow"></span><span class="row" style="gap: 12px">{counts}</span><span style="width: 1px; height: 18px; background: var(--line-2)"></span><a href="DesktopTablero.html" class="btn btn-sm btn-ghost">Ver en el tablero</a><button type="button" class="btn btn-sm btn-ghost btn-icon" aria-label="Acciones de {name}">{ico('more', 'ico', 'stroke-width: 3')}</button></div>
</article>'''


def closed_rows(mobile=False):
  out = ''
  for name, title, n in MS_CLOSED:
    if mobile:
      out += f'<div class="cell" style="min-height: 56px"><span class="ms-name" style="width: 52px">{name}</span><span class="grow t-sm ellipsis">{title}</span><span class="badge b-ok">✓ cerrado</span></div>'
    else:
      out += f'<div class="wi-row" style="min-height: 48px">{ico("flag", "ico fg-3")}<span class="ms-name" style="width: 56px">{name}</span><span class="wi-row-title">{title}</span><span class="ms-bar" style="width: 180px"><i class="done" style="width: 100%"></i></span><span class="mono t-xs fg-2" style="width: 96px; white-space: nowrap">{n}/{n} · 100 %</span><span class="badge b-ok">✓ cerrado</span><button type="button" class="btn btn-sm btn-ghost">Reabrir</button></div>'
  return out


def milestones_desktop():
  main = f'''<main class="page" style="gap: 18px">
<div class="page-head" style="align-items: center"><div class="col" style="gap: 4px"><h1 class="t-h1">Tareas</h1><p class="fg-2 t-sm" style="margin: 0">claude-wrapper · 2 hitos abiertos y 3 cerrados. Un hito agrupa tareas; su progreso sale de ellas, sin fechas.</p></div>
<div class="row" style="gap: 8px">{view_seg('ms')}<span style="width: 8px"></span><button type="button" class="btn btn-primary">{ico('plus')}Nuevo hito</button></div></div>
<section class="col" style="gap: 10px"><div class="row" style="gap: 8px"><span class="t-label">Abiertos</span><span class="count">2</span></div>
{ms_card(MS_OPEN[0], True)}
{ms_card(MS_OPEN[1])}
</section>
<section class="col" style="gap: 10px"><div class="row" style="gap: 8px"><span class="t-label">Cerrados</span><span class="count">3</span></div>
<div class="card" style="overflow: hidden">{closed_rows()}</div>
</section>
</main>'''
  write('DesktopHitos.html', desktop('Hitos', 'tasks', '<a href="DesktopTablero.html" class="fg-2">Tareas</a><span class="fg-3">/</span><span style="font-weight: 500">Hitos</span>', main))


def milestones_mobile():
  inner = f'''{mhead('Hitos', 'claude-wrapper', 'MobileTablero.html', f'<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Nuevo hito">{ico("plus", "ico ico-lg")}</button>')}
<div class="m-body stack" style="gap: 12px">
{mview_seg('ms')}
<div class="row" style="padding: 0 4px; gap: 8px"><span class="t-label">Abiertos</span><span class="count">2</span></div>
{ms_card(MS_OPEN[0], True, True)}
{ms_card(MS_OPEN[1], False, True)}
<div class="row" style="padding: 4px 4px 0; gap: 8px"><span class="t-label">Cerrados</span><span class="count">3</span></div>
<div class="card" style="overflow: hidden">{closed_rows(True)}</div>
</div>
{tabbar('more')}'''
  write('MobileHitos.html', mobile('Hitos', inner))


if __name__ == '__main__':
  empty_desktop(); empty_mobile()
  list_desktop(); list_mobile()
  detail_desktop(); detail_mobile()
  new_task_desktop(); new_task_mobile()
  milestones_desktop(); milestones_mobile()
