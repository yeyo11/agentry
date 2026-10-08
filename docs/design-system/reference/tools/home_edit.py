# The editable Home of CW-34: edit mode, the add-widget picker, the Documents and Flow widgets filled, and the phone's edit mode.
# Writes DesktopInicioEditar, DesktopInicioAnadirWidget, DesktopInicioWidgetsNuevos and MobileInicioEditar.
# Runs on its own; imports common.py.
from common import *

P['grip'] = 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01'
P['up'] = 'm6 15 6-6 6 6'

PROJECT = 'claude-wrapper'
SIZE_WORD = {'s': 'S', 'm': 'M', 'l': 'L', 'full': 'Todo'}
SIZE_NAME = {'s': 'pequeño', 'm': 'mediano', 'l': 'grande', 'full': 'a todo el ancho'}


def wsizes(name, sizes, on):
  btns = ''.join(f'<button type="button" class="{"on" if s == on else ""}" aria-pressed="{"true" if s == on else "false"}" aria-label="Tamaño {SIZE_NAME[s]}, {name}">{SIZE_WORD[s]}</button>' for s in sizes)
  return f'<div class="seg widget-sizes" role="group" aria-label="Tamaño de {name}">{btns}</div>'


def editbar(name, sizes, on):
  return (f'<div class="widget-editbar">'
          f'<button type="button" class="btn btn-ghost btn-icon btn-sm widget-handle" aria-label="Mover {name}. Espacio para levantarlo, flechas para moverlo">{ico("grip")}</button>'
          f'<span class="widget-name">{name}</span>{wsizes(name, sizes, on)}'
          f'<button type="button" class="btn btn-ghost btn-icon btn-sm widget-remove" aria-label="Quitar {name}">{ico("x")}</button></div>')


def head(name, icon=None, aside='', link=None):
  lk = f'<a href="{link[1]}" class="btn btn-ghost btn-sm">{link[0]}{ico("right", "ico ico-sm")}</a>' if link else ''
  ic = ico(icon, 'ico fg-3') if icon else ''
  return f'<div class="card-head">{ic}<h2 class="t-h2 grow">{name}</h2>{aside}{lk}</div>'


def widget(size, name, body, edit=False, sizes=('s', 'm', 'l'), icon=None, aside='', link=None, cls=''):
  top = editbar(name, sizes, size) if edit else head(name, icon, aside, link)
  return f'<section class="card widget w-{size}{" widget-edit" if edit else ""} {cls}" aria-label="{name}">{top}{body}</section>'


# ---- the widgets' content ----
def w_kpis(edit):
  tiles = f'''<div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; padding: 14px 18px">
<div class="col" style="gap: 4px"><span class="row t-sm fg-2" style="gap: 8px"><span class="spin-braille"></span>Agentes en marcha</span><span class="t-num" style="font-size: 28px; font-weight: 600">3</span></div>
<div class="col" style="gap: 4px"><span class="row t-sm fg-2" style="gap: 8px"><span class="dot dot-ok"></span>Esperan tu respuesta</span><span class="t-num" style="font-size: 28px; font-weight: 600">0</span></div>
<div class="col" style="gap: 4px"><span class="t-sm fg-2">Gasto de hoy</span><span class="t-num" style="font-size: 28px; font-weight: 600">3,41 US$</span></div>
</div>'''
  return widget('l', 'Cifras', tiles, edit, ('l',))


def w_limits(edit):
  body = '''<div class="row" style="padding: 14px 18px; gap: 14px"><span class="ring" style="--p: 45; width: 52px; height: 52px; font-size: 12px">45%</span><span class="col" style="gap: 3px"><span class="t-sm fg-2">Límite de 5 h</span><span class="t-xs fg-3 mono">vuelve en 4 h 49 min</span><span class="t-xs fg-3 mono">semanal 5%</span></span></div>'''
  return widget('s', 'Límites', body, edit, ('s',))


def w_now(edit, size='l'):
  rows = '''<div class="widget-body">
<a href="DesktopChatTarea.html" class="list-row rail-live" style="padding: 9px 12px 9px 16px; gap: 10px"><span class="spin-ring"></span><span class="col grow" style="gap: 1px; min-width: 0"><span class="t-sm ellipsis" style="font-weight: 500">Desarrollador implementa AGN-28: tablero con columnas fijas</span><span class="t-xs fg-3 mono">Ejecutando · pnpm test</span></span><span class="mono t-xs fg-3">4:12</span></a>
<a href="DesktopOrquestacion.html" class="list-row rail-live" style="padding: 9px 12px 9px 16px; gap: 10px"><span class="spin-ring"></span><span class="col grow" style="gap: 6px; min-width: 0"><span class="t-sm ellipsis" style="font-weight: 500">ecosystem-foundation</span><span class="segbar" style="height: 4px"><i class="ok"></i><i class="ok"></i><i class="live" style="--p: 55%"></i><i></i><i></i><i></i></span></span><span class="mono t-xs fg-3">2/9</span></a>
</div>'''
  aside = '' if edit else '<span class="badge b-live"><span class="dot dot-live dot-ping" style="width: 6px; height: 6px"></span>en vivo</span>'
  return widget(size, 'En marcha', rows, edit, ('l', 'full'), aside=aside, link=('Ver todo', 'DesktopOrquestaciones.html'), cls='' if edit else 'energy')


def w_memory(edit):
  body = f'''<div class="widget-body" style="padding: 12px 18px 14px; gap: 8px"><span class="t-sm fg-2">El CLAUDE.md del proyecto</span><span class="row t-xs fg-3 mono" style="gap: 8px">{ico("memory", "ico ico-sm")}3 archivos de memoria</span><span class="t-xs fg-3 mono">editado ayer</span></div>'''
  return widget('s', 'Memoria', body, edit, ('s', 'm', 'l'), icon='memory', link=('Abrir', 'DesktopMemoria.html'))


DOCS = [
  ('agn-28-tablero.md', 'docs/specs', 'SPEC', 'Arquitecto', 'ayer'),
  ('ADR-007-enlaces.md', 'docs/adr', 'ADR', 'Arquitecto', 'hace 2 d'),
  ('agn-47-asistente.md', 'docs/specs', 'SPEC', 'Product Owner', 'hace 3 d'),
  ('status.md', 'docs', 'DOC', 'Tú', 'hace 5 d'),
]


def w_docs(edit, size='m'):
  rows = ''.join(f'''<a href="DesktopDocumentos.html" class="doc-row">{ico("docs", "ico fg-3")}<span class="col grow" style="gap: 1px; min-width: 0"><span class="doc-name ellipsis">{n}</span><span class="t-xs fg-3 mono ellipsis">{p} · {who}</span></span><span class="badge">{k}</span><span class="t-xs fg-3" style="width: 56px; text-align: right">{t}</span></a>''' for n, p, k, who, t in DOCS)
  body = f'<div class="widget-body">{rows}</div><div class="widget-foot"><span>23 documentos</span><span class="grow"></span><span>6 ligados a tareas</span></div>'
  return widget(size, 'Documentos', body, edit, ('m', 'l', 'full'), icon='docs', aside='<span class="count-pill">23</span>', link=('Ver todos', 'DesktopDocumentos.html'))


def w_flow(edit, size='m'):
  rows = '''<a href="DesktopFlujo.html" class="flow-row rail-live" style="padding-left: 14px"><span class="spin-ring"></span><span class="flow-what"><span class="t-sm ellipsis" style="font-weight: 500">AGN-28 · Tablero con columnas fijas</span><span class="t-xs fg-3 mono">Desarrollador · Ejecutando</span></span><span class="mono t-xs fg-3">4:12</span></a>
<a href="DesktopFlujo.html" class="flow-row rail-live" style="padding-left: 14px"><span class="spin-ring"></span><span class="flow-what"><span class="t-sm ellipsis" style="font-weight: 500">AGN-29 · Historial automático</span><span class="t-xs fg-3 mono">QA · Leyendo</span></span><span class="mono t-xs fg-3">1:05</span></a>
<a href="DesktopFlujo.html" class="flow-row"><span class="dot dot-idle"></span><span class="flow-what"><span class="t-sm ellipsis" style="font-weight: 500">AGN-31 · Enlaces entre tareas</span><span class="t-xs fg-3 mono">Hecho · espera tu aprobación</span></span><span class="badge b-idle">te espera</span></a>
<a href="DesktopFlujo.html" class="flow-row"><span class="dot dot-warn"></span><span class="flow-what"><span class="t-sm ellipsis" style="font-weight: 500">AGN-27 · Notificaciones de la PWA</span><span class="t-xs fg-3 mono">QA la devolvió · rebote 1 de 3</span></span><span class="badge b-warn">devuelta</span></a>'''
  body = f'<div class="widget-body">{rows}</div><div class="widget-foot"><span>2 ejecuciones a la vez</span><span class="grow"></span><span>0 en cola</span></div>'
  aside = '' if edit else '<span class="badge b-ok">activado</span>'
  return widget(size, 'Flujo', body, edit, ('m', 'l', 'full'), icon='flow', aside=aside, link=('Ver el flujo', 'DesktopFlujo.html'))


def w_pickup(edit, size='m'):
  body = '''<div class="widget-body">
<a href="DesktopChat.html" class="list-row" style="padding: 9px 12px; gap: 10px"><span class="dot dot-idle"></span><span class="col grow" style="gap: 1px; min-width: 0"><span class="ellipsis t-sm" style="font-weight: 500">Cuál es el estado actual del proyecto</span><span class="mono t-xs fg-3">6% · 0,86 US$</span></span><span class="t-xs fg-3">4 h</span></a>
<a href="DesktopChat.html" class="list-row" style="padding: 9px 12px; gap: 10px"><span class="dot dot-bad"></span><span class="col grow" style="gap: 1px; min-width: 0"><span class="ellipsis t-sm" style="font-weight: 500">Investiga las notificaciones de la PWA</span><span class="mono t-xs fg-3">11% · 3,65 US$</span></span><span class="badge b-bad">interrumpido</span></a></div>'''
  return widget(size, 'Retomar', body, edit, ('m', 'l', 'full'), link=('Ver chats', 'DesktopChats.html'))


def w_today(edit, size='m'):
  body = '''<div class="widget-body" style="padding: 10px 18px 14px; gap: 8px">
<div class="row t-sm" style="gap: 8px"><span class="dot" style="background: var(--accent)"></span><span class="grow">Opus 5.5</span><span class="mono t-xs">76,8 k</span></div>
<div class="row t-sm" style="gap: 8px"><span class="dot" style="background: var(--idle)"></span><span class="grow">Sonnet 5</span><span class="mono t-xs">5,2 k</span></div></div>'''
  return widget(size, 'Uso de hoy', body, edit, ('m', 'l'), link=('Detalle', 'DesktopUso.html'))


def pagehead_normal():
  return f'''<div class="page-head">
<div class="col" style="gap: 6px">
<span class="t-label">Jueves · 8 oct</span>
<h1 class="t-display" style="margin: 0">Todo en marcha, nada te espera</h1>
<p class="fg-2" style="margin: 0">3 agentes trabajando en 2 orquestaciones y 1 chat. Ningún permiso ni pregunta pendiente.</p>
</div>
<div class="row"><button type="button" class="btn">{ico("edit")}Editar inicio</button><a href="DesktopNuevoChat.html" class="btn">Nueva orquestación</a></div>
</div>'''


def pagehead_edit():
  return f'''<div class="page-head">
<div class="col" style="gap: 6px">
<span class="t-label">Editando el inicio de {PROJECT}</span>
<h1 class="t-display" style="margin: 0">Ordena tu inicio</h1>
<p class="fg-2" style="margin: 0">Mueve, cambia de tamaño o quita los widgets. Cada cambio se guarda al momento, solo para este proyecto.</p>
</div>
<div class="row"><button type="button" class="btn">{ico("plus")}Añadir widget</button><button type="button" class="btn btn-ghost">{ico("retry")}Restablecer</button><button type="button" class="btn edit-done">{ico("check", "ico", "stroke-width: 2.2")}Listo</button></div>
</div>'''


def crumb():
  return '<span style="font-weight: 500">Inicio</span>'


def desktop_edit(picker=False):
  grid = f'''<div class="home-grid">
{w_kpis(True)}{w_limits(True)}
{w_now(True)}{w_memory(True)}
{w_docs(True)}{w_flow(True)}
</div>
<button type="button" class="widget-add">{ico("plus", "ico ico-sm")}Añadir widget</button>'''
  main = f'<main class="page glow-top">\n{pagehead_edit()}\n{grid}\n</main>'
  overlay = picker_dialog() if picker else ''
  name = 'DesktopInicioAnadirWidget' if picker else 'DesktopInicioEditar'
  write(name + '.html', desktop('Inicio, ' + ('añadir un widget' if picker else 'editando'), 'home', crumb(), main, overlay=overlay))


def picker_rows(mobile=False):
  avail = [
    ('docs', 'Documentos', True, 'Los documentos más recientes del proyecto, quién los escribió y cuántos están ligados a tareas.', 'M · L · Todo'),
    ('flow', 'Flujo', True, 'Las ejecuciones del flujo en marcha y las tarjetas que esperan al equipo o a ti.', 'M · L · Todo'),
    ('orch', 'Orquestaciones', False, 'Las orquestaciones del proyecto y sus etapas.', 'M · L · Todo'),
    ('send', 'Inicio rápido', False, 'Un chat nuevo en el proyecto, con su prompt y sus opciones.', 'M · L · Todo'),
  ]
  size = ' btn-lg' if mobile else ' btn-sm'
  rows = ''
  for icon, name, new, desc, sz in avail:
    nb = '<span class="badge" style="background: var(--accent-soft); color: var(--accent); border-color: transparent">nuevo</span>' if new else ''
    rows += f'''<div class="pick-row"><span class="pick-ico">{ico(icon)}</span><span class="pick-text"><span class="pick-name">{name}{nb}</span>{"" if mobile else f'<span class="pick-desc">{desc}</span><span class="pick-sizes">{sz}</span>'}</span><button type="button" class="btn{size}" aria-label="Añadir {name}">{ico("plus", "ico ico-sm")}Añadir</button></div>'''
  return f'<div class="pick-list">{rows}</div>'


HAVE = ['Cifras', 'Límites', 'En marcha', 'Retomar', 'Uso de hoy', 'Programaciones', 'Memoria', 'Worktrees', 'Recursos', 'Exportar']


def have_chips():
  return '<div class="pick-have">' + ''.join(f'<span class="chip">{ico("check", "ico ico-sm c-ok", "stroke-width: 2.4")}{h}</span>' for h in HAVE) + '</div>'


def picker_dialog():
  return f'''<div class="scrim"><div class="dialog" role="dialog" aria-label="Añadir widget" style="width: 640px">
<div class="dialog-head"><h2 class="t-h2 grow">Añadir widget</h2><button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Cerrar">{ico("x")}</button></div>
<div class="dialog-body" style="gap: 14px">
<p class="t-sm fg-2" style="margin: 0">Se añade al final del inicio de <span class="mono">{PROJECT}</span>. Luego lo mueves donde quieras.</p>
{picker_rows()}
<div class="col" style="gap: 8px"><span class="t-label">Ya están en tu inicio</span>{have_chips()}</div>
</div>
<div class="dialog-foot"><span class="grow t-xs fg-3 mono">Cada widget aparece una vez</span><button type="button" class="btn btn-ghost">Cancelar</button></div>
</div></div>'''


def desktop_new():
  grid = f'''<div class="home-grid">
{w_kpis(False)}{w_limits(False)}
{w_now(False, 'full')}
{w_docs(False)}{w_flow(False)}
{w_pickup(False)}{w_today(False)}
</div>'''
  main = f'<main class="page glow-top">\n{pagehead_normal()}\n{grid}\n</main>'
  write('DesktopInicioWidgetsNuevos.html', desktop('Inicio con Documentos y Flujo', 'home', crumb(), main))


MOVE = [('Cifras', 'overview'), ('Límites', 'usage'), ('En marcha', 'activity'), ('Documentos', 'docs'), ('Flujo', 'flow'), ('Memoria', 'memory'), ('Programaciones', 'sched')]


def mobile_edit():
  rows = ''
  for i, (name, icon) in enumerate(MOVE):
    up = ' disabled' if i == 0 else ''
    dn = ' disabled' if i == len(MOVE) - 1 else ''
    rows += (f'<div class="move-row"><span class="pick-ico">{ico(icon)}</span><span class="grow ellipsis" style="font-weight: 600; font-size: 15px">{name}</span>'
             f'<button type="button" class="btn btn-ghost btn-icon" aria-label="Subir {name}"{up}>{ico("up", "ico ico-lg")}</button>'
             f'<button type="button" class="btn btn-ghost btn-icon" aria-label="Bajar {name}"{dn}>{ico("down", "ico ico-lg")}</button>'
             f'<button type="button" class="btn btn-ghost btn-icon widget-remove" aria-label="Quitar {name}">{ico("x", "ico ico-lg")}</button></div>')
  inner = f'''<header class="m-head"><span class="col grow" style="gap: 1px"><span class="t-label">{PROJECT}</span><h1 class="t-h1">Editar inicio</h1></span><button type="button" class="btn edit-done btn-lg">{ico("check", "ico", "stroke-width: 2.2")}Listo</button></header>
<div class="m-body" style="gap: 10px; overflow: hidden">
<p class="t-sm fg-2" style="margin: 0 2px">Cambia el orden con las flechas. Cada cambio se guarda al momento, solo para este proyecto. El tamaño se elige en pantallas anchas.</p>
{rows}
<div class="row" style="gap: 8px"><button type="button" class="btn btn-lg grow" style="justify-content: center">{ico("plus")}Añadir widget</button><button type="button" class="btn btn-lg btn-ghost">{ico("retry")}Restablecer</button></div>
</div>
<div style="position: absolute; inset: 0; z-index: 10; background: color-mix(in srgb, var(--bg) 60%, transparent)"></div>
<div class="sheet" role="dialog" aria-label="Añadir widget" style="z-index: 11; padding-bottom: 28px; display: flex; flex-direction: column; gap: 12px; max-height: 92%">
<div class="grab" style="margin-bottom: 0"></div>
<div class="row"><h2 class="t-h2 grow">Añadir widget</h2><button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Cerrar">{ico("x", "ico ico-lg")}</button></div>
{picker_rows(True)}
</div>
{tabbar('home')}'''
  write('MobileInicioEditar.html', mobile('Inicio, editando', inner))


if __name__ == '__main__':
  desktop_edit(); desktop_edit(True); desktop_new(); mobile_edit()
