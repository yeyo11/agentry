# The phone states orchestration 1 left undrawn (proto-fix-phone): wizard steps 1 and 4, selection
# with "Orquestar", the filter sheet, the Activity and Changes tabs of a work item, Tasks with All
# projects, the assistant's Team and Resources proposals, the assistant on an empty project, and
# suggestions while they run. The screens it shares with the desktop reuse the other generators.
from data import *
from board import mhead, mrow, msection, jump, mtoolbar, mview_seg
from tasks import mtask_head, mtask_top, mtask_foot, activity, FILES
from projects import mwizard_head, MODS, TPLS
from ai import (mhead_proj, mark, facts, f, mprop_seg, TEAM, RES, KIND, kind_ico, steps_html, READ,
                SUGG, task_meta, live_verb)

ROLE_HUE = {'PO': 300, 'AR': 215, 'DEV': 90, 'QA': 330, 'DOC': 45}
TEMPLATE_TEAM = [('PO', 'Product Owner', 'opus'), ('AR', 'Arquitecto', 'opus'), ('DEV', 'Desarrollador', 'sonnet'), ('QA', 'QA', 'sonnet')]


def role(ab, name, cls=''):
  return f'<span class="role-av{" " + cls if cls else ""}" style="--hue: {ROLE_HUE.get(ab, 160)}" role="img" aria-label="{name}" title="{name}">{ab}</span>'


def with_css(html, css):
  # A rule the stylesheet does not have yet stays in the page, named in the task's result
  return html.replace('</style>', css + '</style>', 1)


# ---------- New project, steps 1 and 4 ----------
def wizard_origin():
  inner = f'''{mwizard_head(1)}
<div class="m-body stack" style="gap: 14px; padding-top: 10px">
<h2 class="t-h2">Origen</h2>
<div class="form-row"><span class="t-label">Nombre</span><label class="field field-lg"><input value="pagos-api" aria-label="Nombre" style="font-size: 16px"></label></div>
<div class="form-row"><span class="t-label">Directorio</span>
<div class="seg" role="radiogroup" aria-label="Origen del directorio" style="display: flex"><button type="button" role="radio" aria-checked="true" class="on" style="flex: 1 1 0; justify-content: center">{ico('folder', 'ico ico-sm')}Local</button><button type="button" role="radio" aria-checked="false" style="flex: 1 1 0; justify-content: center">{ico('git', 'ico ico-sm')}URL de git</button></div>
<label class="field field-lg mono">{ico('folder', 'ico ico-lg')}<input value="~/Proyectos/pagos-api" aria-label="Directorio" style="font-size: 16px"></label>
<button type="button" class="btn btn-lg">{ico('folder', 'ico')}Elegir un directorio</button>
</div>
<div class="callout" style="padding: 12px">{ico('chats', 'ico fg-3')}<span>El directorio ya tiene <span class="mono">23</span> chats de Claude Code: quedan agrupados en el proyecto.</span></div>
<div class="form-row"><span class="t-label">Prefijo de clave</span><label class="field field-lg mono"><input value="PAG" aria-label="Prefijo de clave" style="font-size: 16px"></label>
<span class="form-hint">Sale del nombre. Las tareas se llamarán <span class="mono fg-2">PAG-1</span>, <span class="mono fg-2">PAG-2</span>… y el número nunca se repite.</span></div>
</div>
<div class="m-foot"><a href="MobileProyectos.html" class="btn btn-lg" style="flex: 0 0 auto">Cancelar</a><a href="MobileNuevoProyecto.html" class="btn btn-primary btn-lg">Siguiente</a></div>'''
  write('MobileNuevoProyectoOrigen.html', mobile('Nuevo proyecto, origen', inner))


def wizard_summary():
  pro = next(t for t in TPLS if t[0] == 'pro')
  mods = ''.join(f'<span class="row t-sm" style="gap: 7px">{ico("check", "ico ico-sm c-ok")}{n}</span>' for _, _, n, _ in MODS)
  team = ''.join(f'<span class="row t-sm" style="gap: 8px">{role(ab, n, "sm")}{n}<span class="model-tag{" opus" if m == "opus" else ""}">{m}</span></span>' for ab, n, m in TEMPLATE_TEAM)

  def prow(k, v, top=False):
    return f'<div class="prop-row" style="font-size: 14px; min-height: 44px{"; align-items: flex-start; padding: 10px 0" if top else ""}"><span class="k">{k}</span><span class="v{" col" if top else ""}"{" style=\"align-items: flex-start; gap: 6px\"" if top else ""}>{v}</span></div>'
  inner = f'''{mwizard_head(4)}
<div class="m-body stack" style="gap: 12px; padding-top: 10px">
<h2 class="t-h2">Resumen</h2>
<div class="card col" style="padding: 14px 16px 6px; gap: 10px">
<div class="row" style="gap: 12px"><span class="proj monogram" style="--hue: 150; width: 40px; height: 40px; border-radius: var(--r-lg); font-size: 13px">PA</span><span class="col grow" style="gap: 2px; min-width: 0"><span style="font-weight: 600; font-size: 15px">pagos-api</span><span class="mono t-xs fg-3">~/Proyectos/pagos-api</span></span><a href="MobileNuevoProyectoOrigen.html" class="btn btn-ghost btn-lg" style="padding: 0 10px">Cambiar</a></div>
<div class="col">
{prow('Plantilla', pro[2])}
{prow('Claves', '<span class="wi-key boxed">PAG-1</span>')}
{prow('Módulos', mods, True)}
{prow('Tipos', tico('epic') + tico('story') + tico('task') + tico('bug') + '<span class="t-xs fg-3">los cuatro</span>')}
{prow('Límites', '<span class="mono t-xs fg-2">en curso 3 · en revisión 3</span>')}
{prow('Equipo', team, True)}
</div>
</div>
<p class="t-xs fg-3" style="margin: 0; padding: 0 4px; line-height: 1.5">Al crearlo, el asistente lee el proyecto y te propone el equipo, los recursos y las primeras tareas. Aceptas cada propuesta por separado; nada se escribe antes.</p>
</div>
<div class="m-foot"><a href="MobileNuevoProyectoModulos.html" class="btn btn-lg" style="flex: 0 0 auto">Volver</a><a href="MobileAsistente.html" class="btn btn-primary btn-lg">{ico('plus', 'ico ico-lg')}Crear proyecto</a></div>'''
  write('MobileNuevoProyectoResumen.html', mobile('Nuevo proyecto, resumen', inner))


# ---------- Board: selection with "Orquestar" ----------
def selection():
  # A phone never shows a box: a chosen row takes the selected-row accent and says "Elegida".
  # Epics cannot be orchestrated, so theirs is not a control at all.
  chosen = ('AGN-36', 'AGN-33')

  def srow(k):
    w = W[k]
    if w['t'] == 'epic':
      d, n = w['child']
      return f'''<div class="wi-mrow" aria-disabled="true">
<span class="row" style="gap: 8px">{tico(w['t'])}<span class="wi-key">{k}</span><span class="grow"></span><span class="t-xs fg-2">las épicas no se orquestan</span></span>
<span class="fg-2" style="font-weight: 500; font-size: 15px; line-height: 1.35">{w['title']}</span>
</div>'''
    on = k in chosen
    meta = []
    if w.get('epic'): meta.append(epic(w['epic']))
    if w.get('blocked'): meta.append(f'<span class="row mono t-xs fg-2" style="gap: 4px">{ico("block", "ico", "width: 12px; height: 12px")}bloqueada por {w["blocked"]}</span>')
    state = f'<span class="row t-xs c-accent" style="gap: 5px; font-weight: 600">{ico("check", "ico ico-sm")}Elegida</span>' if on else '<span class="t-xs fg-3">Tocar para elegir</span>'
    return f'''<button type="button" class="wi-mrow{" sel" if on else ""}" aria-pressed="{"true" if on else "false"}" style="width: 100%; border-width: 0 0 1px; border-style: solid; border-color: var(--line); background: {"var(--sel-bg)" if on else "none"}; color: inherit; font: inherit; text-align: left">
<span class="row" style="gap: 8px">{tico(w['t'])}<span class="wi-key">{k}</span>{prio(w['p'])}<span class="grow"></span>{state}</span>
<span style="font-weight: 500; font-size: 15px; line-height: 1.35">{w['title']}</span>
{f'<span class="row" style="gap: 5px; flex-wrap: wrap">{"".join(meta)}</span>' if meta else ''}
</button>'''
  rows = ''.join(srow(k) for k in by_col('todo'))
  inner = f'''<header class="m-head" style="padding-left: 4px"><a href="MobileTablero.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Salir de la selección">{ico('x', 'ico ico-lg')}</a><span class="col grow" style="gap: 1px"><h1 class="t-h1" style="font-size: 24px">2 elegidas</h1><span class="mono t-xs fg-3">claude-wrapper · para orquestar</span></span></header>
<div class="m-body stack" style="gap: 12px">
{jump('todo')}
<section class="col" style="gap: 8px" aria-label="Por hacer">
<div class="row" style="gap: 8px; padding: 0 2px">{sico('todo')}<span class="t-label" style="color: var(--fg-2)">Por hacer</span><span class="wi-col-count"><b>4</b></span></div>
<div class="card" style="overflow: hidden">{rows}</div>
</section>
<div class="callout" style="padding: 12px">{ico('orch', 'ico fg-3')}<span>Cada tarea elegida será un nodo de la orquestación. <span class="mono">AGN-33</span> está bloqueada por <span class="mono">AGN-36</span>, así que su nodo esperará al de <span class="mono">AGN-36</span>.</span></div>
</div>
<div class="m-foot" style="align-items: center"><span class="col" style="flex: 0 0 auto; gap: 1px; padding: 0 4px"><span class="t-sm" style="font-weight: 600">2 tareas</span><span class="mono t-xs fg-3">2 nodos</span></span><a href="MobileOrquestacion.html" class="btn btn-primary btn-lg">{ico('orch', 'ico ico-lg')}Orquestar</a></div>'''
  write('MobileTableroSeleccion.html', mobile('Tablero, selección', inner))


# ---------- Board: the filter sheet ----------
def filters_sheet():
  def group(name, chips):
    out = ''.join(f'<button type="button" class="chip{" on" if on else ""}" aria-pressed="{"true" if on else "false"}" style="min-width: 48px; justify-content: center">{lead}{txt}</button>' for lead, txt, n, on in chips)
    return f'<div class="col" style="gap: 8px"><span class="t-label">{name}</span><div class="row" style="gap: 8px; flex-wrap: wrap">{out}</div></div>'
  body = ''.join([
    group('Tipo', [(tico('epic'), 'Épica', '2', False), (tico('story'), 'Historia', '6', False), (tico('task'), 'Tarea', '5', False), (tico('bug'), 'Bug', '4', False)]),
    group('Prioridad', [(prio('urgent'), 'Urgente', '1', False), (prio('high'), 'Alta', '6', False), (prio('medium'), 'Media', '7', False), (prio('low'), 'Baja', '3', False)]),
    group('Épica', [('', 'Ecosistema de proyectos', '11', True), ('', 'Móvil', '1', False), ('', 'Coste y uso', '2', False)]),
    group('Etiqueta', [('', 'web', '4', False), ('', 'core', '2', False), ('', 'api', '1', False), ('', 'docs', '1', False), ('', 'móvil', '1', False)]),
    group('Responsable', [(av(), 'yeyo', '4', False), ('', 'Sin responsable', '14', False)]),
    group('Hito', [('', 'v0.20', '15', False), ('', 'v0.21', '9', False), ('', 'Sin hito', '3', False)]),
  ])
  inner = f'''{mhead('Tareas', None, 'MobileMas.html')}
<div class="m-body stack" style="gap: 12px">
{mview_seg('board')}
{mtoolbar(1)}
{jump('todo')}
</div>
<div style="position: absolute; inset: 0; z-index: 10; background: color-mix(in srgb, var(--bg) 60%, transparent)"></div>
<div class="sheet" role="dialog" aria-label="Filtros" style="z-index: 11; padding-bottom: 28px; display: flex; flex-direction: column; gap: 16px">
<div class="grab" style="margin-bottom: 0"></div>
<div class="row" style="gap: 8px"><h2 class="t-h2 grow">Filtros</h2><button type="button" class="btn btn-ghost btn-lg" style="padding: 0 10px">Quitar todos</button></div>
{body}
<a href="MobileTareasLista.html" class="btn btn-primary btn-lg" style="width: 100%">Ver 11 tareas</a>
</div>'''
  write('MobileTableroFiltros.html', mobile('Tablero, filtros', inner))


# ---------- Work item: Activity and Changes ----------
def task_activity():
  inner = f'''{mtask_head()}
<div class="m-body stack" style="gap: 14px">
{mtask_top('activity')}
<div class="activity">{activity()}</div>
</div>
<div class="m-foot" style="align-items: center"><label class="field field-lg grow">{ico('comment', 'ico ico-lg')}<input placeholder="Escribir un comentario" aria-label="Comentario" style="font-size: 16px"></label><button type="button" class="btn btn-lg btn-icon" aria-label="Enviar el comentario" style="flex: 0 0 auto">{ico('send', 'ico ico-lg')}</button></div>'''
  write('MobileTareaActividad.html', mobile('Tarea, actividad', inner))


def task_changes():
  # Paths take a line of their own on a phone, so none is cut
  rows = ''
  for p, a, d, bar in FILES:
    cells = ''.join(f'<i class="{"add" if c == "a" else "del"}"></i>' for c in bar) + '<i></i>' * (5 - len(bar))
    rows += f'<a href="#" class="cell" style="flex-direction: column; align-items: stretch; gap: 4px; padding: 10px 14px"><span class="mono" style="font-size: 13px; overflow-wrap: anywhere">{p}</span><span class="row mono t-xs fg-3" style="gap: 10px"><span>+{a} −{d}</span><span class="diffstat" aria-hidden="true">{cells}</span></span></a>'
  inner = f'''{mtask_head()}
<div class="m-body stack" style="gap: 14px">
{mtask_top('changes')}
<div class="card" style="overflow: hidden">
<div class="row" style="gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--line)">{ico('branch', 'ico fg-3')}<span class="mono t-sm">task/agn-26</span><span class="mono t-xs fg-3 grow">desde main</span><span class="mono t-xs fg-2">+214 −37</span></div>
{rows}
</div>
<p class="t-xs fg-3" style="margin: 0; padding: 0 4px; line-height: 1.5">Lo que cambió en el worktree de la tarea, <span class="mono">.claude/worktrees/task-AGN-26</span>. Nada se fusiona ni abre una pull request solo.</p>
<a href="#" class="btn btn-lg">{ico('git', 'ico')}Ver el diff</a>
</div>
{mtask_foot()}'''
  write('MobileTareaCambios.html', mobile('Tarea, cambios', inner))


# ---------- Tasks with All projects ----------
# google-docs-mcp is a project DesktopProyectos already lists; its three open items join the 15
OTHER = {
  'GDM-4': dict(t='task', title='Documentar los permisos de OAuth', s='backlog', p='low'),
  'GDM-7': dict(t='story', title='Crear documentos desde una plantilla', s='todo', p='medium'),
  'GDM-9': dict(t='bug', title='El token caduca a mitad de una exportación', s='in_progress', p='high', who='Y'),
}
PROJ = {'AGN': ('claude-wrapper', 20, 'CW'), 'GDM': ('google-docs-mcp', 200, 'GD')}


def all_projects():
  def arow(k, w):
    pk = k.split('-')[0]
    name, hue, mono = PROJ[pk]
    live = w.get('live')
    lead = '<span class="spin-ring" style="width: 14px; height: 14px" role="img" aria-label="Trabajando"></span>' if live else tico(w['t'])
    livel = ''
    if live == 'chat':
      livel = '<span class="row t-xs" style="gap: 6px"><span class="spin-braille"></span><span class="c-live">Ejecutando</span><span class="mono fg-3 grow">pnpm test</span><span class="mono fg-3">4:12</span></span>'
    return f'''<a href="MobileTarea.html" class="wi-mrow{" rail-live" if live else ""}">
<span class="row" style="gap: 8px">{lead}<span class="wi-key">{k}</span><span class="grow"></span>{prio(w['p'])}{av() if w.get('who') else ''}</span>
<span style="font-weight: 500; font-size: 15px; line-height: 1.35">{w['title']}</span>
<span class="row t-xs fg-2" style="gap: 6px"><span class="proj monogram" style="--hue: {hue}; width: 18px; height: 18px; border-radius: var(--r-xs); font-size: 11px">{mono[0]}</span>{name}</span>
{livel}
</a>'''

  def section(s, items, n):
    return f'''<section class="col" style="gap: 8px" aria-label="{COL_WORD[s]}">
<div class="row" style="gap: 8px; padding: 0 2px">{sico(s)}<span class="t-label" style="color: var(--fg-2)">{COL_WORD[s]}</span><span class="wi-col-count"><b>{n}</b></span><span class="t-xs fg-3">en 2 proyectos</span></div>
<div class="card" style="overflow: hidden">{''.join(arow(k, w) for k, w in items)}</div>
</section>'''
  # Por hacer: claude-wrapper's four and agentry-site's one; the counts are over every project shown
  todo = [('GDM-7', OTHER['GDM-7'])] + [(k, W[k]) for k in by_col('todo')]
  prog = [('GDM-9', OTHER['GDM-9']), ('AGN-28', W['AGN-28'])]
  chip = f'<button type="button" class="chip project-selector" style="font-size: 14px">Todos los proyectos{ico("down", "ico ico-sm")}</button>'
  inner = f'''{mhead('Tareas', None, 'MobileMas.html', chip + '<span style="width: 8px"></span>')}
<div class="m-body stack" style="gap: 12px; margin-bottom: 76px">
{mview_seg('board')}
<div class="callout" style="padding: 12px">{ico('folder', 'ico fg-3')}<span>18 abiertas en 2 proyectos. Sin límites por columna: cada proyecto tiene los suyos.</span></div>
{section('todo', todo, 5)}
{section('in_progress', prog, 6)}
</div>
<a href="MobileNuevaTarea.html" class="fab" aria-label="Nueva tarea" style="padding: 0; width: 56px">{ico('plus', 'ico ico-lg', 'stroke-width: 2.2')}</a>
{tabbar('more')}'''
  write('MobileTareasTodos.html', mobile('Tareas de todos los proyectos', inner, 'has-fab'))


# ---------- The assistant: Team and Resources proposals ----------
def done_run():
  return f'<section class="ai-run done" aria-label="Sugerencia completada" style="flex-direction: column; align-items: stretch; gap: 6px"><span class="row t-sm" style="gap: 10px">{mark(True)}<span><b style="font-weight: 600">14 propuestas</b> <span class="fg-2">de 61 archivos y 23 chats</span></span></span>{facts(f("Sonnet 5"), f("1 min 12 s"), f("0,08 US$", "cost"), f("chat 4e1f09"))}</section>'


def more_btn():
  return '<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Más acciones">' + ico('more', 'ico ico-lg', 'stroke-width: 3') + '</button>'


def accept_pair(what):
  return f'<div class="sug-acts"><button type="button" class="btn btn-ghost btn-lg" aria-label="Descartar {what}">{ico("x", "ico ico-sm")}Descartar</button><button type="button" class="btn btn-lg" aria-label="Aceptar {what}">{ico("check", "ico ico-sm")}Aceptar</button></div>'


def assistant_team():
  cards = ''
  for x in TEAM:
    tag = '<span class="badge">fuera de la plantilla</span>' if x.get('extra') else ''
    acts = f'<div class="row"><span class="sug-done">{ico("check", "ico ico-sm")}añadido · <span class="mono">.claude/agents/</span></span></div>' if x['st'] == 'accepted' else accept_pair(x['role'])
    cards += f'''<div class="sug-card">
<span class="row" style="gap: 10px"><span class="role-av" style="--hue: {x['hue']}" role="img" aria-label="{x['role']}">{x['ab']}</span><span class="col grow" style="gap: 4px; min-width: 0"><span class="row" style="gap: 8px; flex-wrap: wrap"><span class="sug-title" style="font-size: 15px">{x['role']}</span>{tag}</span><span class="sug-meta"><span class="model-tag{' opus' if x['model'] == 'opus' else ''}">{x['model']}</span><span>escribe: <span class="mono">{x['writes']}</span></span></span></span></span>
{acts}
</div>'''
  inner = f'''{mhead_proj('Asistente de proyecto', 'MobileNuevoProyecto.html', more_btn())}
<div class="m-body stack" style="gap: 12px">
{done_run()}
{mprop_seg('team')}
<div class="row" style="padding: 0 4px; gap: 8px"><span class="t-label grow">3 de 5 aceptados · uno a uno</span></div>
<div class="card grad-border" style="overflow: hidden">{cards}</div>
</div>
<div class="m-foot"><a href="MobileProyecto.html" class="btn btn-primary btn-lg">{ico('right', 'ico ico-lg')}Ir al proyecto</a></div>'''
  write('MobileAsistenteEquipo.html', mobile('Propuestas del asistente, equipo', inner))


def assistant_resources():
  cards = ''
  for x in RES:
    icon, word, _ = KIND[x['k']]
    where = x.get('saved') or ('.claude/' + ('agents/' + x['name'] + '.md' if x['k'] == 'agent' else ('commands/' + x['name'][1:] + '.md' if x['k'] == 'command' else 'skills/' + x['name'] + '/')))
    if x['st'] == 'accepted':
      acts = f'<div class="row"><span class="sug-done">{ico("check", "ico ico-sm")}guardada · <span class="mono">{where}</span></span></div>'
    else:
      acts = f'<div class="sug-acts"><button type="button" class="btn btn-ghost btn-lg" aria-label="Descartar {x["name"]}">{ico("x", "ico ico-sm")}Descartar</button><a href="MobileRecursoPropuesta.html" class="btn btn-lg">{ico("edit", "ico ico-sm")}Revisar</a></div>'
    reason = f'<p class="sug-reason" style="font-size: 14px">{x["why"]}</p>' if x.get('why') else ''
    cards += f'''<div class="sug-card">
<span class="row" style="gap: 10px; align-items: flex-start">{kind_ico(x['k'])}<span class="col grow" style="gap: 4px; min-width: 0"><span class="row" style="gap: 8px"><span class="mono" style="font-weight: 600; font-size: 15px">{x['name']}</span><span class="badge">{word}</span></span><span class="t-sm fg-2" style="line-height: 1.45">{x['desc']}</span>{'' if x['st'] == 'accepted' else f'<span class="mono t-xs fg-3">proyecto · {where}</span>'}</span></span>
{reason}{acts}
</div>'''
  inner = f'''{mhead_proj('Asistente de proyecto', 'MobileNuevoProyecto.html', more_btn())}
<div class="m-body stack" style="gap: 12px">
{done_run()}
{mprop_seg('res')}
<div class="row" style="padding: 0 4px; gap: 8px"><span class="t-label grow">1 de 3 guardada · se revisa en el editor</span></div>
<div class="card grad-border" style="overflow: hidden">{cards}</div>
</div>
<div class="m-foot"><a href="MobileProyecto.html" class="btn btn-primary btn-lg">{ico('right', 'ico ico-lg')}Ir al proyecto</a></div>'''
  write('MobileAsistenteRecursos.html', mobile('Propuestas del asistente, recursos', inner))


# ---------- The assistant on an empty project ----------
def assistant_empty():
  # Nothing to read, so no CLI run and no cost: the template's four roles are offered, each accepted
  # on its own, and the first tasks wait for a sentence about what the project will be.
  rows = ''
  for ab, n, m in TEMPLATE_TEAM:
    rows += f'<div class="cell" style="min-height: 60px; padding-right: 8px">{role(ab, n)}<span class="col grow" style="gap: 3px; min-width: 0"><span style="font-weight: 500">{n}</span><span class="model-tag{" opus" if m == "opus" else ""}" style="align-self: flex-start">{m}</span></span><button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Descartar {n}">{ico("x", "ico")}</button><button type="button" class="btn btn-lg" aria-label="Aceptar {n}">{ico("check", "ico ico-sm")}Aceptar</button></div>'
  inner = f'''{mhead('Asistente de proyecto', 'notas · NOT', 'MobileNuevoProyecto.html')}
<div class="m-body stack" style="gap: 14px">
<div class="callout" style="padding: 12px; align-items: flex-start">{mark(True)}<span class="col" style="gap: 4px"><span style="color: var(--fg); font-weight: 600">No hay nada que leer</span><span><span class="mono">~/Proyectos/notas</span> está vacío: sin archivos, sin chats y sin historial de git. No se ha lanzado ningún chat, así que no hay coste.</span></span></div>
<div class="row" style="padding: 0 4px"><span class="t-label grow">Equipo de la plantilla</span><span class="mono t-xs fg-3">Software profesional</span></div>
<div class="card" style="overflow: hidden">{rows}</div>
<div class="row" style="padding: 0 4px"><span class="t-label grow">Primeras tareas</span></div>
<div class="card col" style="padding: 14px; gap: 10px">
<span class="t-sm fg-2" style="line-height: 1.5">Cuéntame qué vas a construir y te propongo las primeras tareas. También puedes crearlas tú.</span>
<label class="field field-area"><textarea rows="2" aria-label="Qué vas a construir" placeholder="Una app de notas con etiquetas y búsqueda…" style="font-size: 16px"></textarea></label>
<button type="button" class="btn btn-lg">{ico('sparkle', 'ico')}Pedir propuesta</button>
</div>
</div>
<div class="m-foot"><a href="MobileProyecto.html" class="btn btn-primary btn-lg">{ico('right', 'ico ico-lg')}Ir al proyecto</a></div>'''
  write('MobileAsistenteVacio.html', mobile('Asistente de proyecto, sin nada que leer', inner))


# ---------- Suggest tasks while it runs ----------
def suggest_running():
  items = [('done', 'docs', '<span class="path">docs/plans/</span>', '12 documentos'), ('done', 'tasks', 'Las tareas del tablero', '27 tareas'),
           ('now', None, 'Los chats de las últimas dos semanas', '14 de 40'), ('todo', 'git', 'El historial de git', 'después')]
  steps = steps_html(items).replace('<span class="ellipsis">', '<span>')
  inner = f'''<header class="row" style="flex-shrink: 0; padding: 8px 8px; gap: 4px; min-height: 60px">
<a href="MobileTablero.html" class="btn btn-ghost btn-lg" style="padding: 0 10px">Cancelar</a>
<span class="grow" style="text-align: center; font-weight: 600; font-size: 17px">Sugerir tareas</span>
<span style="width: 86px"></span>
</header>
<div class="m-body stack" style="gap: 12px">
<label class="field field-lg">{ico('search', 'ico ico-lg')}<input value="lo que falta para v0.20" aria-label="Qué buscar (opcional)" style="font-size: 16px"></label>
<section class="ai-run live energy" aria-label="Sugerencia en curso" style="padding: 14px">
<div class="ai-run-head">{mark()}<div class="col grow" style="gap: 3px; min-width: 0"><h2 class="ai-run-title">Buscando tareas que falten</h2>{live_verb('Leyendo', 'chats', '0:22')}</div></div>
{facts(f('Sonnet 5'), f('0,02 US$ hasta ahora', 'cost'), f('chat 7c2e1a'))}
<hr class="divider">
{steps}
</section>
<div class="row" style="padding: 0 4px"><span class="t-label grow">Propuestas</span></div>
<div class="card"><div class="sug-wait">{ico('wait')}en espera · aparecen al terminar la lectura</div></div>
<p class="t-xs fg-3" style="margin: 0; padding: 0 4px; line-height: 1.5">Se crean en Backlog solo las que incluyas. El coste cuenta en Uso, como el de cualquier chat.</p>
</div>
<div class="m-foot"><button type="button" class="btn btn-lg" style="flex: 0 0 auto">{ico('x', 'ico ico-lg')}Detener</button><button type="button" class="btn btn-primary btn-lg" disabled>Crear las seleccionadas</button></div>'''
  write('MobileSugerirTareasEnCurso.html', mobile('Sugerir tareas, en curso', inner))


ALL = ['MobileNuevoProyectoOrigen', 'MobileNuevoProyectoResumen', 'MobileTableroSeleccion', 'MobileTableroFiltros', 'MobileTareaActividad',
       'MobileTareaCambios', 'MobileTareasTodos', 'MobileAsistenteEquipo', 'MobileAsistenteRecursos', 'MobileAsistenteVacio', 'MobileSugerirTareasEnCurso']

if __name__ == '__main__':
  wizard_origin(); wizard_summary()
  selection(); filters_sheet()
  task_activity(); task_changes()
  all_projects()
  assistant_team(); assistant_resources(); assistant_empty()
  suggest_running()
