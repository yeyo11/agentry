from data import *
from board import mhead
from decision_parts import *
from providers_rotation import project_providers_card

MODS = [
  ('board', 'board', 'Tablero', 'Tareas en cinco columnas, hitos, y su enlace con chats y orquestaciones.'),
  ('team', 'team', 'Equipo', 'Agentes con un rol, un modelo y lo que pueden escribir, en .claude/agents/.'),
  ('documents', 'docs', 'Documentos', 'La carpeta docs/ del repositorio y los documentos que escriben los agentes.'),
  ('memory', 'memory', 'Memoria compartida', 'CLAUDE.md, la memoria del proyecto y un diario que recibe cada agente.'),
]
TPLS = [
  ('simple', 'blank', 'Simple', 'Un nombre y un directorio. Sin módulos.', ()),
  ('pro', 'code', 'Software profesional', 'Todos los módulos, los cuatro tipos de tarea y un equipo de cuatro roles.', ('board', 'team', 'documents', 'memory')),
  ('lib', 'package', 'Biblioteca o paquete', 'Tablero, documentos y memoria. Límite de 2 en curso.', ('board', 'documents', 'memory')),
  ('research', 'flask', 'Investigación o documentación', 'Documentos y memoria, y un tablero sin bugs.', ('board', 'documents', 'memory')),
  ('custom', 'settings', 'Personalizada', 'Todo desactivado: eliges cada módulo.', ()),
]
MOD_ICON = {k: i for k, i, _, _ in MODS}


def module_card(k, on=True, note='', big=False):
  _, icon, name, desc = next(m for m in MODS if m[0] == k)
  sw = f'<button type="button" class="switch{" switch-lg" if big else ""}{" on" if on else ""}" role="switch" aria-checked="{"true" if on else "false"}" aria-label="{name}"></button>'
  n = f'<span class="module-note">{note}</span>' if note else ''
  return f'<label class="module-card{" on" if on else ""}"{" style=\"min-height: 64px\"" if big else ""}><span class="module-ico">{ico(icon)}</span><span class="module-text"><span class="module-name">{name}</span><span class="module-desc">{desc}</span>{n}</span>{sw}</label>'


def tpl_card(t, on=False, row=False):
  k, icon, name, desc, mods = t
  glyphs = ''.join(f'<span class="tpl-mod{" on" if m in mods else ""}" title="{dict((a, c) for a, _, c, _ in MODS)[m]}">{ico(MOD_ICON[m])}</span>' for m, _, _, _ in MODS)
  radio = f'<span class="radio{" on" if on else ""}" aria-hidden="true"></span>'
  if row:
    return f'<button type="button" role="radio" aria-checked="{"true" if on else "false"}" class="tpl-card{" on" if on else ""}" style="flex-direction: row; align-items: center; gap: 12px; min-height: 64px"><span class="tpl-ico">{ico(icon)}</span><span class="col" style="gap: 6px; flex: 1 1 0; min-width: 0"><span class="tpl-name" style="font-size: 15px">{name}</span><span class="tpl-desc" style="font-size: 13px">{desc}</span><span class="tpl-mods">{glyphs}</span></span>{radio.replace("radio", "radio", 1).replace("aria-hidden", "style=\"position: static\" aria-hidden")}</button>'
  return f'<button type="button" role="radio" aria-checked="{"true" if on else "false"}" class="tpl-card{" on" if on else ""}">{radio}<span class="tpl-ico">{ico(icon)}</span><span class="col" style="gap: 4px"><span class="tpl-name">{name}</span><span class="tpl-desc">{desc}</span></span><span class="tpl-mods">{glyphs}</span></button>'


def steps(active, names=('Origen', 'Plantilla', 'Módulos', 'Resumen')):
  out = []
  for i, n in enumerate(names, 1):
    cls = 'step' + (' on' if i == active else (' done' if i < active else ''))
    lead = ico('check', 'ico ico-sm') if i < active else f'<span class="n">{i}</span>'
    out.append(f'<div class="{cls}"{" aria-current=\"step\"" if i == active else ""}><span class="step-name">{lead}{n}</span></div>')
  return f'<div class="steps" aria-label="Pasos">{"".join(out)}</div>'


def section(n, title, sub, body, right=''):
  return f'''<section class="col" style="gap: 12px">
<div class="row" style="gap: 10px"><span class="count-pill" style="background: var(--bg-3); color: var(--fg-2)">{n}</span><h2 class="t-h2">{title}</h2><span class="t-sm fg-3 grow">{sub}</span>{right}</div>
{body}
</section>'''


def new_project_desktop():
  origin = f'''<div class="card card-pad" style="display: grid; grid-template-columns: 1.1fr 1.6fr 0.8fr; gap: 14px; align-items: start">
<div class="form-row"><span class="row" style="min-height: 28px"><span class="t-label">Nombre</span></span><label class="field"><input value="pagos-api" aria-label="Nombre"></label></div>
<div class="form-row"><span class="row" style="justify-content: space-between; min-height: 28px"><span class="t-label" style="color: var(--fg-2)">Directorio</span><span class="seg" role="radiogroup" aria-label="Origen" style="padding: 2px"><button type="button" role="radio" aria-checked="true" class="on" style="height: 24px; font-size: 12px">Local</button><button type="button" role="radio" aria-checked="false" style="height: 24px; font-size: 12px">URL de git</button></span></span><label class="field mono">{ico('folder')}<input value="~/Proyectos/pagos-api" aria-label="Directorio"><button type="button" class="btn btn-ghost btn-sm" style="margin-right: -8px; font-family: var(--sans)">Elegir…</button></label></div>
<div class="form-row"><span class="row" style="min-height: 28px"><span class="t-label">Prefijo de clave</span></span><label class="field mono"><input value="PAG" aria-label="Prefijo de clave"></label></div>
<span class="form-hint" style="grid-column: 1 / -1">El directorio ya tiene <span class="mono">23</span> chats de Claude Code: quedan agrupados en el proyecto. Las tareas se llamarán <span class="mono fg-2">PAG-1</span>, <span class="mono fg-2">PAG-2</span>…</span>
</div>'''
  tpls = f'<div role="radiogroup" aria-label="Plantilla" style="display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px">{"".join(tpl_card(t, t[0] == "pro") for t in TPLS)}</div>'
  mods = f'<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px">{"".join(module_card(k) for k, *_ in MODS)}</div>'
  summary = f'''<aside class="card col" style="width: 336px; flex-shrink: 0; padding: 18px; gap: 16px; align-self: flex-start">
<div class="row" style="gap: 10px"><span class="count-pill" style="background: var(--bg-3); color: var(--fg-2)">4</span><h2 class="t-h2 grow">Resumen</h2></div>
<div class="row" style="gap: 12px"><span class="proj monogram" style="--hue: 150; width: 40px; height: 40px; border-radius: var(--r-lg); font-size: 13px">PA</span><span class="col grow" style="gap: 2px; min-width: 0"><span style="font-weight: 600; font-size: 15px">pagos-api</span><span class="mono t-xs fg-3 ellipsis">~/Proyectos/pagos-api</span></span></div>
<div class="col" style="gap: 0">
<div class="prop-row"><span class="k">Plantilla</span><span class="v">Software profesional</span></div>
<div class="prop-row"><span class="k">Claves</span><span class="v"><span class="wi-key boxed">PAG-1</span></span></div>
<div class="prop-row" style="align-items: flex-start; padding-top: 10px"><span class="k">Módulos</span><span class="v col" style="align-items: flex-start; gap: 6px">{''.join(f'<span class="row t-sm" style="gap: 7px">{ico("check", "ico ico-sm c-ok")}{n}</span>' for _, _, n, _ in MODS)}</span></div>
<div class="prop-row"><span class="k">Tipos</span><span class="v row" style="gap: 8px">{tico('epic')}{tico('story')}{tico('task')}{tico('bug')}<span class="t-xs fg-3">los cuatro</span></span></div>
<div class="prop-row"><span class="k">Límites</span><span class="v mono t-xs fg-2">en curso 3 · en revisión 3</span></div>
<div class="prop-row" style="align-items: flex-start; padding-top: 10px"><span class="k">Equipo</span><span class="v col" style="align-items: flex-start; gap: 4px"><span class="t-sm">4 roles de la plantilla</span><span class="t-xs fg-3" style="line-height: 1.45">Después de crear el proyecto, el asistente lo lee y te propone el equipo miembro a miembro.</span></span></div>
</div>
<div class="col" style="gap: 8px"><button type="button" class="btn btn-primary btn-lg" style="width: 100%">{ico('plus')}Crear proyecto</button><a href="DesktopProyectos.html" class="btn btn-ghost" style="width: 100%">Cancelar</a></div>
</aside>'''
  main = f'''<main class="page" style="gap: 20px">
<div class="page-head" style="align-items: center"><div class="row" style="gap: 12px"><a href="DesktopProyectos.html" class="btn btn-icon" aria-label="Volver a proyectos">{ico('left')}</a><div class="col" style="gap: 3px"><h1 class="t-h1">Nuevo proyecto</h1><p class="fg-2 t-sm" style="margin: 0">Un directorio, una plantilla y los módulos que quieras. Todo se puede cambiar después.</p></div></div></div>
<div class="row" style="gap: 22px; align-items: flex-start">
<div class="col grow" style="gap: 22px">
{section(1, 'Origen', '', origin)}
{section(2, 'Plantilla', 'Preselecciona módulos, tipos de tarea, límites y el equipo inicial.', tpls)}
{section(3, 'Módulos', 'Los que la plantilla ha preseleccionado.', mods, '<span class="row t-xs fg-3" style="gap: 6px">' + ico('eyeoff', 'ico ico-sm') + 'Desactivar un módulo lo oculta y conserva sus datos</span>')}
</div>
{summary}
</div>
</main>'''
  write('DesktopNuevoProyecto.html', desktop('Nuevo proyecto', 'projects', '<a href="DesktopProyectos.html" class="fg-2">Proyectos</a><span class="fg-3">/</span><span style="font-weight: 500">Nuevo proyecto</span>', main, project='Todos los proyectos'))


def mwizard_head(step):
  return f'''<header class="row" style="flex-shrink: 0; padding: 8px 4px 4px; gap: 4px">
<a href="MobileProyectos.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Cerrar">{ico('x', 'ico ico-lg')}</a>
<span class="col grow" style="gap: 1px"><span style="font-weight: 600; font-size: 17px">Nuevo proyecto</span><span class="mono t-xs fg-3">paso {step} de 4 · pagos-api</span></span>
</header>
<div style="padding: 4px 16px 6px">{steps(step, ('Origen', 'Plantilla', 'Módulos', 'Resumen'))}</div>'''


def new_project_mobile():
  inner = f'''{mwizard_head(2)}
<div class="m-body stack" style="gap: 10px; padding-top: 10px">
<h2 class="t-h2">Elige una plantilla</h2>
<p class="t-sm fg-2" style="margin: -4px 0 4px">Preselecciona módulos, tipos de tarea, límites y el equipo inicial.</p>
<div role="radiogroup" aria-label="Plantilla" class="col" style="gap: 8px">{"".join(tpl_card(t, t[0] == "pro", row=True) for t in TPLS)}</div>
</div>
<div class="m-foot"><button type="button" class="btn btn-lg" style="flex: 0 0 auto">Volver</button><button type="button" class="btn btn-primary btn-lg">Siguiente</button></div>'''
  write('MobileNuevoProyecto.html', mobile('Nuevo proyecto', inner))
  inner = f'''{mwizard_head(3)}
<div class="m-body stack" style="gap: 10px; padding-top: 10px">
<h2 class="t-h2">Módulos</h2>
<p class="t-sm fg-2" style="margin: -4px 0 4px">Software profesional los activa todos. Puedes cambiarlos ahora o en los ajustes del proyecto.</p>
<div class="col" style="gap: 8px">{module_card('board', big=True)}{module_card('team', big=True)}{module_card('documents', False, ico('eyeoff') + 'oculto, sin datos todavía', big=True)}{module_card('memory', big=True)}</div>
<div class="callout" style="padding: 12px">{ico('eyeoff', 'ico fg-3')}<span>Desactivar un módulo oculta su pestaña y conserva sus datos. Al activarlo vuelve todo.</span></div>
</div>
<div class="m-foot"><button type="button" class="btn btn-lg" style="flex: 0 0 auto">Volver</button><button type="button" class="btn btn-primary btn-lg">Siguiente</button></div>'''
  write('MobileNuevoProyectoModulos.html', mobile('Nuevo proyecto, módulos', inner))


def proj_head(actions=True, task_primary=True):
  # The assistant is an occasional visit, so it is the quiet one of the three: ghost, with its sparkle.
  # "Nueva tarea" is the primary only on the Summary; a tab with its own primary (Añadir miembro) lowers it.
  tp = ' btn-primary' if task_primary else ''
  acts = f'<div class="row" style="gap: 8px"><a href="DesktopAsistentePropuestas.html" class="btn btn-ghost">{ico("sparkle")}Asistente</a><a href="DesktopNuevoChat.html" class="btn">{ico("chats")}Nuevo chat aquí</a><a href="DesktopNuevaTarea.html" class="btn{tp}">{ico("plus")}Nueva tarea</a></div>' if actions else ''
  return f'''<div class="proj-head">
<span class="proj monogram" style="--hue: 20">CW</span>
<span class="col grow" style="gap: 4px"><span class="row" style="gap: 10px"><h1 class="t-h1">claude-wrapper</h1><span class="wi-key boxed">AGN</span><span class="badge">Software profesional</span></span><span class="mono t-xs fg-3">~/Escritorio/claude-wrapper · 186 chats · 15 worktrees</span></span>
{acts}
</div>'''


def proj_tabs(on):
  # The eight tabs of the plan, in its order (Worktrees is not a module: it is always there). Settings draws the strip without Documents, because that
  # screen shows the module switched off. Memory counts the proposals waiting, in idle.
  memory = '<span class="count-pill" style="background: var(--idle-soft); color: var(--idle)" title="3 propuestas esperan tu aprobación" aria-label="3 propuestas esperan tu aprobación">3</span>'
  tabs = [('overview', 'overview', 'Resumen', ''), ('board', 'board', 'Tablero', '13'), ('team', 'team', 'Equipo', '5'), ('documents', 'docs', 'Documentos', '23'),
          ('memory', 'memory', 'Memoria', memory), ('resources', 'resources', 'Recursos', '12'), ('worktrees', 'branch', 'Worktrees', '15'), ('settings', 'settings', 'Ajustes', '')]
  if on == 'settings':
    tabs = [t for t in tabs if t[0] != 'documents']
  hrefs = {'overview': 'DesktopProyecto.html', 'board': 'DesktopTablero.html', 'team': 'DesktopEquipo.html', 'documents': 'DesktopDocumentos.html',
           'memory': 'DesktopMemoria.html', 'resources': 'DesktopRecursos.html', 'worktrees': '#', 'settings': 'DesktopProyectoAjustes.html'}
  def count(c):
    return c if c.startswith('<') else (f'<span class="count">{c}</span>' if c else '')
  out = ''.join(f'<a href="{hrefs[k]}" role="tab" aria-selected="{"true" if k == on else "false"}" class="tab{" on" if k == on else ""}">{ico(i)}{n}{count(c)}</a>' for k, i, n, c in tabs)
  return f'<nav class="tabs proj-tabs" role="tablist" aria-label="Secciones del proyecto">{out}</nav>'


# ---------------------------------------------------------------- the project's host line (plans/code-hosts.md, P0 p2)
# Detected from the origin remote, never chosen. variant -> what the line shows. `mono` is the host's
# monogram and hue (never red, green or cyan); a host no CLI knows has none and gets the git icon.
HOST_LINES = {
  'gh-ready': dict(host='github.com', path='yeyochico/claude-wrapper', mono=('GH', 262), cli='gh 2.92.0', account='yeyochico', state='ready',
                   reason='gh tiene sesión en github.com y responde.', noun='PR', ref='#12'),
  'gl-ready': dict(host='gitlab.inmoseo.net', path='equipo/pagos-api', mono=('GL', 35), cli='glab 1.120.0', account='yeyo', state='ready',
                   reason='glab tiene sesión en gitlab.inmoseo.net y responde.', noun='MR', ref='!12'),
  'unsupported': dict(host='git.acme.internal', path='equipo/facturas', mono=None, cli='', account='', state='unsupported',
                      reason='Agentry no puede llegar a git.acme.internal: ni gh ni glab tienen sesión en él.',
                      action=('Ir a Integraciones', 'DesktopIntegraciones.html', False)),
  'signed-out': dict(host='github.com', path='yeyochico/claude-wrapper', mono=('GH', 262), cli='gh 2.92.0', account='', state='signed-out',
                     reason='gh no tiene sesión en github.com.', noun='PR', ref='#12',
                     action=('Ver cómo iniciar sesión', '#', True)),
}
HOST_STATE = {'ready': ('Listo', 'b-ok', 'dot-ok'), 'signed-out': ('Sin sesión', 'b-warn', 'dot-warn'), 'unsupported': ('No disponible', 'b-warn', 'dot-warn')}
P.setdefault('ext', 'M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5')


def host_badge(v):
  word, cls, dot = HOST_STATE[v['state']]
  return f'<span class="badge {cls}"><span class="dot {dot}" style="width: 6px; height: 6px"></span>{word}</span>'


def host_icon(v):
  if v['mono']:
    letters, hue = v['mono']
    name = 'GitHub' if letters == 'GH' else 'GitLab'
    return f'<span class="proj monogram" style="--hue: {hue}" role="img" aria-label="{name}" title="{name}">{letters}</span>'
  return f'<span class="proj" style="background: var(--bg-3); color: var(--fg-2)" role="img" aria-label="Host sin CLI" title="Host sin CLI">{ico("git")}</span>'


def host_meta(v):
  if not v['cli']:
    return 'ninguna CLI conoce este host'
  return v['cli'] + (f' · {v["account"]}' if v['account'] else ' · sin cuenta')


def host_action(v, lg=False):
  if 'action' not in v:
    return ''
  label, href, ext = v['action']
  size = ' btn-lg' if lg else ''
  style = ' style="justify-content: center"' if lg else ''
  return f'<a href="{href}" class="btn{size}"{style}>{label}{ico("ext", "ico ico-sm") if ext else ""}</a>'


def host_hint(v):
  if v['state'] == 'unsupported':
    return 'Sin un host conocido Agentry no abre ni sigue PR ni MR de este proyecto.'
  if v['state'] == 'signed-out':
    return f'Hasta que tenga sesión, Agentry no abre ni sigue {v["noun"]} ({v["ref"]}) de este proyecto.'
  return f'Las propuestas de cambio de este proyecto son {v["noun"]}: se leen como <span class="mono fg-2">{v["ref"]}</span>.'


def host_line(variant='gh-ready', stacked=False):
  """The line itself: host icon, hostname/path in mono, the CLI and its account, the readiness word,
  and under it the reason with its one action. Desktop puts the word on the right, a phone stacks."""
  v = HOST_LINES[variant]
  ident = (f'<div class="host-line-id"><span class="host-path"><b>{v["host"]}</b>/{v["path"]}</span>'
           f'<span class="mono t-xs fg-3">{host_meta(v)}</span></div>')
  if stacked:
    why = f'<div class="host-line-why">{host_badge(v)}<p class="prov-reason">{v["reason"]}</p>{host_action(v, lg=True)}</div>'
    return f'<div class="host-line stacked"><div class="host-line-main">{host_icon(v)}{ident}</div>{why}</div>'
  why = f'<div class="host-line-why"><p class="prov-reason">{v["reason"]}</p>{host_action(v)}</div>'
  return f'<div class="host-line"><div class="host-line-main">{host_icon(v)}{ident}{host_badge(v)}</div>{why}</div>'


def host_card(variant='gh-ready'):
  v = HOST_LINES[variant]
  return (f'<section class="card col" style="padding: 18px; gap: 14px" aria-labelledby="sec-host"><div class="row"><h2 class="t-h2 grow" id="sec-host">Alojamiento del código</h2>'
          f'<span class="mono t-xs fg-3">detectado del remoto origin</span></div>{host_line(variant)}'
          f'<span class="form-hint">{host_hint(v)}</span></section>')


def mhost_section(variant='gh-ready'):
  v = HOST_LINES[variant]
  return (f'<div class="col" style="gap: 8px"><span class="t-label" style="padding: 0 4px">Repositorio</span>'
          f'<section class="card" style="padding: 14px" aria-label="Alojamiento del código">{host_line(variant, stacked=True)}</section>'
          f'<span class="form-hint" style="padding: 0 4px">Detectado del remoto origin; no se elige. {host_hint(v)}</span></div>')


def project_settings_desktop():
  limits = ''.join(f'<div class="form-row" style="gap: 6px"><span class="row t-xs fg-2" style="gap: 6px">{sico(s)}{n}</span><label class="field mono" style="height: 34px"><input value="{LIMITS.get(s, "")}" placeholder="—" aria-label="Límite de {n}" style="font-size: 13px"></label></div>' for s, n in COLS)
  main = f'''<main class="page" style="gap: 18px">
{proj_head(False)}
{proj_tabs('settings')}
<div class="row" style="gap: 18px; align-items: flex-start">
<div class="col" style="flex: 1 1 0; gap: 18px; min-width: 0">
<section class="card col" style="padding: 18px; gap: 16px"><h2 class="t-h2">General</h2>
<div class="form-row"><span class="t-label">Nombre</span><label class="field"><input value="claude-wrapper" aria-label="Nombre"></label></div>
<div class="form-row"><span class="t-label">Prefijo de clave</span><label class="field mono" style="width: 160px"><input value="AGN" aria-label="Prefijo de clave"></label><span class="form-hint">Las claves se componen al leerlas: si lo cambias a <span class="mono fg-2">CW</span>, <span class="mono fg-2">AGN-12</span> pasa a leerse <span class="mono fg-2">CW-12</span>. El número no cambia nunca y no se reutiliza.</span></div>
<div class="form-row"><span class="t-label">Directorio</span><span class="mono t-sm fg-2">~/Escritorio/claude-wrapper</span></div>
</section>
{host_card()}
<section class="card col" style="padding: 18px; gap: 14px"><div class="col" style="gap: 4px"><h2 class="t-h2">Tablero</h2><span class="t-sm fg-2">Límite por columna. Pasarse se permite: la columna lo avisa con una palabra, sin bloquear el movimiento.</span></div>
<div style="display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px">{limits}</div>
</section>
<section class="card col" style="padding: 18px; gap: 12px"><h2 class="t-h2">Quitar el proyecto</h2>
<div class="row" style="gap: 14px; align-items: flex-start"><span class="t-sm fg-2 grow" style="line-height: 1.5">Deja de aparecer en Agentry. Sus ajustes y sus tareas se conservan: si vuelves a importar el directorio, vuelve todo. No toca el repositorio.</span><button type="button" class="btn">{ico('x')}Quitar de Agentry</button></div>
</section>
</div>
<div class="col" style="flex: 1.15 1 0; gap: 18px; min-width: 0">
<section class="card col" style="padding: 18px; gap: 12px"><div class="row"><h2 class="t-h2 grow">Módulos</h2><span class="mono t-xs fg-3">3 de 4 activados</span></div>
{module_card('board', True, '13 abiertas · 25 en total')}
{module_card('team', True, '5 miembros en .claude/agents/')}
{module_card('documents', False, ico('eyeoff') + 'oculto · 23 documentos conservados')}
{module_card('memory', True, 'CLAUDE.md · diario con 86 entradas')}
<div class="callout" style="margin-top: 4px">{ico('eyeoff', 'ico fg-3')}<span style="line-height: 1.5">Desactivar un módulo <b style="color: var(--fg); font-weight: 500">oculta su pestaña y conserva sus datos</b>. Al activarlo de nuevo vuelve todo, tal como estaba. Ningún interruptor borra nada.</span></div>
</section>
<div class="row" style="justify-content: flex-end; gap: 8px"><button type="button" class="btn btn-ghost">Descartar</button><button type="button" class="btn btn-primary">Guardar los cambios</button></div>
</div>
</div>
{project_providers_card()}
{override_card()}
</main>'''
  write('DesktopProyectoAjustes.html', tall(desktop('Ajustes del proyecto', 'projects', pcrumb('claude-wrapper', ('Ajustes', '')), main), 2700))


def project_settings_mobile():
  def cell_sw(k, on, note):
    _, icon, name, _ = next(m for m in MODS if m[0] == k)
    return f'<label class="cell" style="min-height: 64px"><span class="module-ico" style="{"background: var(--accent-soft); color: var(--accent)" if on else ""}">{ico(icon)}</span><span class="col grow" style="gap: 2px; min-width: 0"><span style="font-weight: 500{"" if on else "; color: var(--fg-2)"}">{name}</span><span class="mono t-xs fg-3" style="line-height: 1.45">{note}</span></span><button type="button" class="switch switch-lg{" on" if on else ""}" role="switch" aria-checked="{"true" if on else "false"}" aria-label="{name}"></button></label>'
  inner = f'''{mhead('Ajustes', 'claude-wrapper', 'MobileProyecto.html')}
<div class="m-body stack" style="gap: 16px">
<div class="col" style="gap: 8px"><span class="t-label" style="padding: 0 4px">General</span>
<div class="card" style="overflow: hidden">
<label class="cell" style="min-height: 56px"><span class="fg-3" style="width: 76px">Nombre</span><input class="grow" value="claude-wrapper" aria-label="Nombre" style="border: 0; outline: 0; background: transparent; font-size: 16px; min-width: 0"></label>
<label class="cell" style="min-height: 56px"><span class="fg-3" style="width: 76px">Prefijo</span><input class="grow mono" value="AGN" aria-label="Prefijo de clave" style="border: 0; outline: 0; background: transparent; font-size: 16px; min-width: 0"></label>
</div>
<span class="form-hint" style="padding: 0 4px">Cambiarlo cambia cómo se leen las claves: <span class="mono">AGN-12</span> pasaría a <span class="mono">CW-12</span>. El número no cambia.</span>
</div>
{mhost_section()}
<div class="col" style="gap: 8px"><span class="t-label" style="padding: 0 4px">Módulos</span>
<div class="card" style="overflow: hidden">
{cell_sw('board', True, '13 abiertas · 25 en total')}
{cell_sw('team', True, '5 miembros')}
{cell_sw('documents', False, 'oculto · 23 documentos conservados')}
{cell_sw('memory', True, 'diario con 86 entradas')}
</div>
<div class="callout" style="padding: 12px">{ico('eyeoff', 'ico fg-3')}<span>Desactivar un módulo oculta su pestaña y conserva sus datos. Al activarlo vuelve todo.</span></div>
</div>
<div class="card" style="overflow: hidden"><a href="#" class="cell" style="min-height: 52px"><span class="grow" style="font-weight: 500">Límites del tablero</span><span class="mono t-xs fg-3">en curso 3 · revisión 3</span>{ico('right', 'ico fg-3')}</a>
<a href="MobileProyectoAjustesProveedores.html" class="cell" style="min-height: 52px"><span class="grow" style="font-weight: 500">Proveedores</span><span class="mono t-xs fg-3">orden propio · 2 de 5</span>{ico('right', 'ico fg-3')}</a>
<a href="MobileProyectoAjustesDecisiones.html" class="cell" style="min-height: 52px"><span class="grow" style="font-weight: 500">Decisiones</span><span class="mono t-xs fg-3">heredado · 3 distintos</span>{ico('right', 'ico fg-3')}</a></div>
</div>
<div class="m-foot"><button type="button" class="btn btn-primary btn-lg">Guardar los cambios</button></div>'''
  write('MobileProyectoAjustes.html', mobile('Ajustes del proyecto', inner))


def project_decisions_mobile():
  # The override is its own screen on a phone: a card per point, the mode under its name at 44 px.
  # Flow and Orchestrations are open; the rest fold, as on the desktop.
  groups = ''
  for area, icon, pts in POINTS:
    if icon not in ('flow', 'orch'):
      n = len(pts)
      groups += f'<div class="card" style="overflow: hidden"><button type="button" class="decision-group" style="width: 100%; border: 0; border-top: 0; text-align: left; color: var(--fg); font-family: var(--sans)" aria-expanded="false">{ico("right", "ico ico-sm")}{area}<span class="grow"></span><span class="n"><b>{n}</b> {"punto" if n == 1 else "puntos"}</span></button></div>'
      continue
    cards = ''.join(mpoint_card(p, cli=False) for p in pts[:4])
    groups += (f'<div class="card" style="overflow: hidden"><button type="button" class="decision-group" style="width: 100%; border: 0; border-top: 0; text-align: left; color: var(--fg); font-family: var(--sans)" aria-expanded="true">{ico("down", "ico ico-sm")}{area}<span class="grow"></span><span class="n"><b>{len(pts)}</b> puntos</span></button>{cards}</div>')
  inner = f'''{mhead('Decisiones', 'claude-wrapper', 'MobileProyectoAjustes.html')}
<div class="m-body stack" style="gap: 14px; overflow-y: auto">
<div class="col" style="gap: 8px"><span class="t-label" style="padding: 0 4px">Proveedor</span>
<div class="seg" role="radiogroup" aria-label="Proveedor de las decisiones del proyecto" style="display: flex"><button type="button" role="radio" aria-checked="true" class="on" style="flex: 1 1 0; justify-content: center">Heredar</button><button type="button" role="radio" aria-checked="false" style="flex: 1 1 0; justify-content: center">CLI</button><button type="button" role="radio" aria-checked="false" style="flex: 1 1 0; justify-content: center">Jev</button></div>
<span class="form-hint" style="padding: 0 4px">Hereda Jev. Cada punto usa el ajuste global hasta que lo cambias aquí; el consentimiento sigue siendo global.</span></div>
{groups}
</div>
<div class="m-foot"><button type="button" class="btn btn-primary btn-lg">Guardar los cambios</button></div>'''
  write('MobileProyectoAjustesDecisiones.html', mobile('Decisiones del proyecto', inner))


def dist_rows():
  total = 15
  out = []
  for s, n in COLS:
    c = len(counted(by_col(s))) + (DONE_MORE if s == 'done' else 0)
    lim = LIMITS.get(s)
    over = lim is not None and c > lim
    pct = min(100, c / 12 * 100)
    barcls = 'bar bar-thin' + (' ok' if s == 'done' else (' warn' if over else ''))
    word = '<span class="badge b-warn" style="height: 18px">sobre el límite</span>' if over else ''
    out.append(f'<div class="row" style="gap: 10px; min-height: 30px">{sico(s)}<span class="t-sm" style="width: 92px">{n}</span><span class="{barcls} grow"><i style="width: {pct:.0f}%"></i></span><span class="mono t-xs{" c-warn" if over else " fg-2"}" style="width: 30px; text-align: right">{c}{"/" + str(lim) if lim else ""}</span>{word}</div>')
  return ''.join(out)


def live_rows(compact=False):
  return f'''<a href="DesktopChatTarea.html" class="link-row rail-live"><span class="spin-ring"></span><span class="col grow" style="gap: 2px; min-width: 0"><span class="row" style="gap: 8px"><span class="wi-key">AGN-28</span><span class="t-sm ellipsis" style="font-weight: 500">Tablero con columnas fijas y límites</span></span><span class="row t-xs" style="gap: 6px"><span class="spin-braille"></span><span class="c-live">Ejecutando</span><span class="mono fg-3">pnpm test · chat b67aa3</span></span></span><span class="mono t-xs fg-3">4:12</span></a>
<a href="DesktopOrquestacion.html" class="link-row rail-live"><span class="spin-ring"></span><span class="col grow" style="gap: 4px; min-width: 0"><span class="row" style="gap: 8px"><span class="wi-key">AGN-30</span><span class="t-sm ellipsis" style="font-weight: 500">API de tareas y del tablero</span></span><span class="row t-xs" style="gap: 8px"><span class="mono c-live">ecosystem-foundation · nodo 3 de 9</span><span class="segbar grow" style="height: 4px; max-width: 160px"><i class="ok"></i><i class="ok"></i><i class="live" style="--p: 55%"></i><i></i><i></i><i></i><i></i><i></i><i></i></span></span></span><span class="mono t-xs fg-3">11:40</span></a>'''


def project_page_desktop():
  hist = [
    ('move', '<b>AGN-26</b> pasó de En curso a En revisión', 'automático · el turno del chat terminó bien', '12 min'),
    ('play', '<b>AGN-28</b> pasó a En curso', 'automático · empezó el chat b67aa3', '4 min'),
    ('check', 'Criterio 4 de 5 marcado en <b>AGN-26</b>', 'yeyo', '40 min'),
    ('plus', '<b>AGN-45</b> creada en Backlog', 'yeyo · desde el chat 9f02c1', '1 h'),
    ('flag', 'Hito <b class="mono">v0.19</b> cerrado', 'yeyo', '2 d'),
  ]
  hrows = ''.join(f'<div class="hist"><span class="hist-ico"><span>{ico(i)}</span></span><span class="col grow" style="gap: 1px; min-width: 0"><span class="ellipsis">{t}</span><span class="cause">{c}</span></span><time>{w}</time></div>' for i, t, c, w in hist)
  main = f'''<main class="page" style="gap: 18px">
{proj_head()}
{proj_tabs('overview')}
<div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px">
<div class="card kpi"><span class="t-label">Abiertas</span><span class="v">13</span><span class="t-xs fg-3">25 en total · 12 hechas</span></div>
<div class="card kpi"><span class="t-label">En curso</span><span class="v c-warn">5<span class="fg-3">/3</span></span><span class="row t-xs c-warn" style="gap: 5px">{ico('warn', 'ico ico-sm')}sobre el límite</span></div>
<div class="card kpi"><span class="t-label">Agentes trabajando</span><span class="v c-live">2</span><span class="row t-xs fg-3" style="gap: 6px"><span class="spin-braille"></span>1 chat · 1 orquestación</span></div>
<a href="DesktopHitos.html" class="card kpi grad-border"><span class="t-label">Hito actual · <span style="text-transform: none">v0.20</span></span><span class="v grad-text">47 %</span><span class="ms-bar" style="margin-top: 2px"><i class="done" style="width: 47%"></i><i class="doing" style="width: 27%"></i></span></a>
</div>
<div style="display: grid; grid-template-columns: 1.55fr 1fr; gap: 12px; align-items: start">
<section class="card"><div class="card-head"><span class="t-h2 grow">En marcha ahora</span><span class="count-pill live">2</span></div><div class="col" style="padding: 12px; gap: 8px">{live_rows()}</div>
<div class="card-head" style="border-top: 1px solid var(--line)"><span class="t-h2 grow">Esperan tu revisión</span><span class="count-pill">2</span></div>
<div class="col" style="padding: 6px 4px 6px">
<a href="DesktopTarea.html" class="wi-row" style="border: 0">{sico('in_review')}<span class="wi-key">AGN-26</span><span class="wi-row-title">Plantillas de proyecto</span>{epic('eco')}<span class="mono t-xs fg-3">4/5</span><span class="badge b-idle">espera</span></a>
<a href="#" class="wi-row" style="border: 0">{sico('in_review')}<span class="wi-key">AGN-29</span><span class="wi-row-title">Historial automático de cambios</span>{epic('eco')}<span class="mono t-xs fg-3">2/2</span><span class="badge b-idle">espera</span></a>
</div>
<div class="card-head" style="border-top: 1px solid var(--line)"><span class="t-h2 grow">Chats recientes</span><a href="DesktopChats.html" class="t-sm c-accent">Ver todos</a></div>
<div class="col" style="padding: 6px 4px">
<a href="DesktopChatTarea.html" class="wi-row" style="border: 0"><span class="spin-braille"></span><span class="wi-row-title">Trabaja en AGN-28: tablero con columnas fijas y límites</span><span class="wi-key boxed">AGN-28</span><span class="mono t-xs c-live">ahora</span></a>
<a href="DesktopChat.html" class="wi-row" style="border: 0"><span class="dot dot-idle"></span><span class="wi-row-title">Revisa la PWA y la app desktop para mejorarlas</span><span class="mono t-xs fg-3">2,55 US$</span><span class="mono t-xs fg-3">4 h</span></a>
<a href="DesktopChat.html" class="wi-row" style="border: 0"><span class="dot dot-idle"></span><span class="wi-row-title">Trabaja en AGN-26: plantillas de proyecto</span><span class="wi-key boxed">AGN-26</span><span class="mono t-xs fg-3">5 h</span></a>
</div></section>
<div class="col" style="gap: 12px">
<section class="card"><div class="card-head"><span class="t-h2 grow">Tablero</span><a href="DesktopTablero.html" class="t-sm c-accent">Abrir</a></div><div class="col" style="padding: 10px 18px 12px; gap: 2px">{dist_rows()}</div></section>
<section class="card"><div class="card-head"><span class="t-h2 grow">Actividad</span><a href="#" class="t-sm c-accent">Ver todo</a></div><div class="activity" style="padding: 14px 18px">{hrows}</div></section>
</div>
</div>
</main>'''
  write('DesktopProyecto.html', desktop('Proyecto', 'projects', pcrumb('claude-wrapper', ('Resumen', '')), main))


def project_page_mobile():
  def cell(icon, name, note, href='#'):
    return f'<a href="{href}" class="cell"><span class="proj" style="background: var(--bg-3); color: var(--fg-2)">{ico(icon)}</span><span class="grow" style="font-weight: 500">{name}</span>{note if note.startswith('<') else f'<span class="mono t-xs fg-3">{note}</span>'}{ico("right", "ico fg-3")}</a>'
  inner = f'''<header class="row" style="flex-shrink: 0; padding: 8px 4px; gap: 4px">
<a href="MobileProyectos.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver">{ico('left', 'ico ico-lg', 'stroke-width: 2')}</a>
<span class="proj monogram" style="--hue: 20; width: 36px; height: 36px; border-radius: var(--r)">CW</span>
<span class="col grow" style="gap: 1px; min-width: 0; padding-left: 6px"><h1 class="t-h1">claude-wrapper</h1><span class="mono t-xs fg-3">AGN · ~/Escritorio/claude-wrapper</span></span>
<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Más acciones">{ico('more', 'ico ico-lg', 'stroke-width: 3')}</button>
</header>
<div class="m-body stack" style="gap: 14px">
<a href="MobileHitos.html" class="card grad-border col" style="padding: 16px; gap: 10px">
<span class="row"><span class="t-label grow">Hito actual · <span style="text-transform: none">v0.20</span></span>{ico('right', 'ico fg-3')}</span>
<span class="row" style="align-items: baseline; gap: 10px"><span class="t-num grad-text" style="font-size: 34px; font-weight: 600; letter-spacing: -0.035em">47 %</span><span class="t-sm fg-2">7 de 15 hechas</span></span>
<span class="ms-bar"><i class="done" style="width: 47%"></i><i class="doing" style="width: 27%"></i></span>
<span class="row mono t-xs fg-3" style="gap: 12px"><span>13 abiertas</span><span class="row c-warn" style="gap: 5px">{ico('warn', 'ico', 'width: 12px; height: 12px')}en curso 4/3, sobre el límite</span></span>
</a>
<div class="col" style="gap: 8px"><div class="row" style="padding: 0 4px"><span class="t-label grow">En marcha ahora</span><span class="count-pill live">2</span></div>
<a href="MobileChatTarea.html" class="card row rail-live" style="padding: 12px 14px 12px 16px; gap: 10px; min-height: 56px"><span class="spin-ring"></span><span class="col grow" style="gap: 2px; min-width: 0"><span class="row" style="gap: 7px"><span class="wi-key">AGN-28</span><span class="t-sm" style="font-weight: 500">Tablero con columnas fijas y límites</span></span><span class="row t-xs" style="gap: 6px"><span class="c-live">Ejecutando</span><span class="mono fg-3">pnpm test</span></span></span><span class="mono t-xs fg-3">4:12</span></a>
<a href="MobileOrquestacion.html" class="card row rail-live" style="padding: 12px 14px 12px 16px; gap: 10px; min-height: 56px"><span class="spin-ring"></span><span class="col grow" style="gap: 4px; min-width: 0"><span class="row" style="gap: 7px"><span class="wi-key">AGN-30</span><span class="t-sm" style="font-weight: 500">API de tareas y del tablero</span></span><span class="segbar" style="height: 4px"><i class="ok"></i><i class="ok"></i><i class="live" style="--p: 55%"></i><i></i><i></i><i></i><i></i><i></i><i></i></span></span><span class="mono t-xs fg-3">3/9</span></a>
</div>
<a href="MobileAsistentePropuestas.html" class="card row" style="padding: 12px 14px; gap: 12px; min-height: 56px"><span class="proj" style="background: var(--accent-soft); color: var(--accent)">{ico('sparkle')}</span><span class="col grow" style="gap: 2px; min-width: 0"><span style="font-weight: 500">Asistente del proyecto</span><span class="t-xs fg-3">3 propuestas por revisar</span></span>{ico('right', 'ico fg-3')}</a>
<nav aria-label="Secciones del proyecto" class="card" style="overflow: hidden">
{cell('board', 'Tablero', '13 abiertas', 'MobileTablero.html')}
{cell('team', 'Equipo', '5', 'MobileEquipo.html')}
{cell('docs', 'Documentos', '23', 'MobileDocumentos.html')}
{cell('memory', 'Memoria', '<span class="badge b-idle">3 esperan</span>', 'MobileMemoria.html')}
{cell('resources', 'Recursos', '12', 'MobileRecursos.html')}
{cell('branch', 'Worktrees', '15', '#')}
{cell('settings', 'Ajustes', '', 'MobileProyectoAjustes.html')}
</nav>
</div>
{tabbar('more')}'''
  write('MobileProyecto.html', mobile('Proyecto', inner))


if __name__ == '__main__':
  new_project_desktop(); new_project_mobile()
  project_settings_desktop(); project_settings_mobile(); project_decisions_mobile()
  project_page_desktop(); project_page_mobile()
