# Shared shell and components for the project ecosystem prototypes.
import os

# The screens are written next to this folder; NS_OUT writes them elsewhere, to compare before and after.
OUT = os.environ.get('NS_OUT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

P = {
  'home': 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  'chats': 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  'orch': 'M8.5 6a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM20.5 6a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM14.5 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM7.5 8 11 15.5M16.5 8 13 15.5',
  'sched': 'M5.5 5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3.5 10h17M8 3v4M16 3v4',
  'folder': 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  'accounts': 'M12.5 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5',
  'conn': 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
  'usage': 'M4 20V11M10 20V4M16 20v-6M3 20.5h18',
  'settings': 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M17 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM11 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM19 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
  'book': 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 21V5',
  'search': 'M17.5 11a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0zM20 20l-4.2-4.2',
  'plus': 'M12 5v14M5 12h14',
  'down': 'm6 9 6 6 6-6',
  'right': 'm9 6 6 6-6 6',
  'left': 'm15 6-6 6 6 6',
  'x': 'M6 6l12 12M18 6 6 18',
  'bell': 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
  'sidebar': 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 4v16',
  'more': 'M5 12h.01M12 12h.01M19 12h.01',
  'menu': 'M4 6h16M4 12h16M4 18h16',
  'filter': 'M4 6h16M7 12h10M10 18h4',
  'board': 'M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z',
  'list': 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  'flag': 'M5 21V4M5 4h12l-2.5 4L17 12H5',
  'tasks': 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8.5 12l2.5 2.5 4.5-5',
  'overview': 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  'team': 'M12.5 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5',
  'docs': 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
  'memory': 'M6 3h11a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6zM6 3v18M9.5 8h5M9.5 12h5',
  'resources': 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12 4 7.5',
  'branch': 'M6 4v12M18 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM8 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM16 8c0 5-10 3-10 8',
  'check': 'm5 12 5 5 9-10',
  'eyeoff': 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c5 0 8.5 4 9.5 7a13 13 0 0 1-2.4 3.6M6.6 6.6A13 13 0 0 0 2.5 12c1 3 4.5 7 9.5 7a9.6 9.6 0 0 0 4.4-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2',
  'warn': 'M12 4 2.5 20h19zM12 10v4M12 17h.01',
  'play': 'M8 5.5v13l10.5-6.5z',
  'edit': 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  'comment': 'M4 5h16v11H9l-5 4z',
  'crit': 'M9 6h11M9 12h11M9 18h11M3.5 6l1.2 1.2L7 5M3.5 12l1.2 1.2L7 11M3.5 18l1.2 1.2L7 17',
  'block': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.6 5.6l12.8 12.8',
  'link': 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  'move': 'M5 12h14M13 6l6 6-6 6',
  'user': 'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM4 21a8 8 0 0 1 16 0',
  'tag': 'M3 12V4h8l10 10-8 8zM7.5 8h.01',
  'copy': 'M9 9h10v10H9zM5 15V5h10',
  'fork': 'M6 3v6a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4v4M18 3v6M6 21v-4',
  'git': 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM3 12h5M16 12h5',
  'sparkle': 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  'lock': 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  'trash': 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  'package': 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12 4 7.5M8 5.3l8 4.5',
  'code': 'm8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  'flask': 'M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3M7.5 14h9',
  'blank': 'M5 4h14v16H5z',
  'send': 'M12 19V5M6 11l6-6 6 6',
  'clip': 'M20 11.5 12.5 19a5 5 0 0 1-7-7l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4L15 7.5',
  'md': 'M4 6h16v12H4zM7 15V9l2.5 3L12 9v6M16 9v6M14 13l2 2 2-2',
  'dots-v': 'M12 5h.01M12 12h.01M12 19h.01',
}

TYPE = {
  'epic': 'M12 3l9 9-9 9-9-9zM12 8.5l3.5 3.5-3.5 3.5L8.5 12z',
  'story': 'M7 3.5h10v17l-5-3.8-5 3.8z',
  'task': 'M5 5h14v14H5zM9 12l2 2 4-4.5',
  'bug': 'M9 7a3 3 0 0 1 6 0M8 9h8v5a4 4 0 0 1-8 0zM12 9v9M4 13h4M16 13h4M5 7.5l3 2M19 7.5l-3 2M5.5 19l2.8-2.4M18.5 19l-2.8-2.4',
}
TYPE_WORD = {'epic': 'Épica', 'story': 'Historia', 'task': 'Tarea', 'bug': 'Bug'}
PRIO_WORD = {'low': 'Baja', 'medium': 'Media', 'high': 'Alta', 'urgent': 'Urgente'}
COLS = [('backlog', 'Backlog'), ('todo', 'Por hacer'), ('in_progress', 'En curso'), ('in_review', 'En revisión'), ('done', 'Hecho')]
COL_WORD = dict(COLS)


def ico(name, cls='ico', style=''):
  st = f' style="{style}"' if style else ''
  return f'<svg class="{cls}" viewBox="0 0 24 24" aria-hidden="true"{st}><path d="{P[name]}"></path></svg>'


def tico(t, lg=False):
  return f'<svg class="wi-type{" lg" if lg else ""}" viewBox="0 0 24 24" role="img" aria-label="{TYPE_WORD[t]}"><title>{TYPE_WORD[t]}</title><path d="{TYPE[t]}"></path></svg>'


def sico(s):
  w = COL_WORD[s]
  inner = {
    'backlog': '<circle cx="8" cy="8" r="6" stroke-dasharray="2.4 2.2"></circle>',
    'todo': '<circle cx="8" cy="8" r="6"></circle>',
    'in_progress': '<circle cx="8" cy="8" r="6"></circle><path class="fill" d="M8 4a4 4 0 0 1 0 8z"></path>',
    'in_review': '<circle cx="8" cy="8" r="6"></circle><path class="fill" d="M8 4a4 4 0 1 1-4 4h4z"></path>',
    'done': '<circle class="fill" cx="8" cy="8" r="7"></circle><path class="tick" d="M5.2 8.3l1.9 1.9 3.7-4"></path>',
  }[s]
  cls = 'wi-status s-done' if s == 'done' else 'wi-status'
  return f'<svg class="{cls}" viewBox="0 0 16 16" role="img" aria-label="{w}"><title>{w}</title>{inner}</svg>'


def prio(p):
  return f'<span class="wi-prio p-{p}" role="img" aria-label="Prioridad {PRIO_WORD[p].lower()}" title="Prioridad {PRIO_WORD[p].lower()}"><i></i><i></i><i></i></span>'


def av(letter='Y', hue=24, cls='wi-assignee'):
  return f'<span class="proj monogram {cls}" style="--hue: {hue}" title="yeyo">{letter}</span>'


def unassigned():
  return '<span class="proj wi-assignee none" role="img" aria-label="Sin responsable" title="Sin responsable"></span>'


EPICS = {'eco': ('Ecosistema de proyectos', 18), 'mob': ('Móvil', 215), 'perf': ('Coste y uso', 330)}


def epic(k):
  n, h = EPICS[k]
  return f'<span class="wi-epic" style="--hue: {h}">{n}</span>'


def label(t):
  return f'<span class="wi-label">{t}</span>'


BRAND = ('<span style="width: 26px; height: 26px; border-radius: var(--r); background: var(--grad); display: grid; place-items: center; color: #fff; '
         'box-shadow: 0 4px 14px -4px color-mix(in srgb, var(--accent-2) 70%, transparent)">'
         '<svg class="ico ico-sm" viewBox="0 0 24 24" style="stroke-width: 2.2"><path d="' + P['orch'] + '"></path></svg></span>')


def page(title, body, mobile=False):
  return f'''<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Agentry · {title}</title><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="assets/fonts.css"><link rel="stylesheet" href="../agentry-ds.css"><style>body{{margin:0;background:var(--bg)}}</style><script>function t(){{var m=location.hash==="#light"?"light":"dark";document.querySelectorAll("[data-theme]").forEach(function(e){{e.setAttribute("data-theme",m)}})}}addEventListener("hashchange",t);addEventListener("DOMContentLoaded",t);</script></head><body data-theme="dark">
{body}
<script>t()</script>
</body></html>
'''


LIVE_DEFAULT = '''<div class="col" style="gap: 4px">
<div class="row" style="padding: 0 10px 4px"><span class="t-label grow">En directo</span><span class="count-pill live">2</span></div>
<a href="DesktopChatTarea.html" class="list-row rail-live" style="padding: 8px 10px 8px 14px; flex-direction: column; align-items: stretch; gap: 3px">
<span class="row" style="gap: 7px"><span class="spin-braille"></span><span class="t-sm ellipsis" style="font-weight: 500">Trabaja en AGN-28: tablero con columnas fijas</span></span>
<span class="row t-xs" style="gap: 6px; padding-left: 15px"><span class="c-live">Ejecutando</span><span class="mono fg-3 ellipsis grow">pnpm test</span><span class="mono fg-3">4:12</span></span>
</a>
<a href="DesktopOrquestacion.html" class="list-row rail-live" style="padding: 8px 10px 8px 14px; flex-direction: column; align-items: stretch; gap: 6px">
<span class="row" style="gap: 7px"><span class="spin-braille"></span><span class="t-sm ellipsis grow" style="font-weight: 500">ecosystem-foundation</span><span class="mono t-xs fg-3">2/9</span></span>
<span class="segbar" style="height: 4px; margin-left: 15px"><i class="ok"></i><i class="ok"></i><i class="live" style="--p: 55%"></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
</a>
</div>'''


def sidebar(active, live=None):
  def item(key, href, icon, name, extra=''):
    on = ' on' if key == active else ''
    return f'<a href="{href}" class="nav-item{on}">{ico(icon)}<span class="grow">{name}</span>{extra}</a>'
  return f'''<div class="side">
<nav class="app" data-theme="dark" aria-label="Principal" style="width: 256px; height: 1024px; background: var(--bg-1); border-right: 1px solid var(--line); display: flex; flex-direction: column; padding: 14px 12px; gap: 18px">
<div class="row" style="padding: 0 4px; height: 32px; gap: 10px">
<a href="Main.html" class="row" style="gap: 10px; flex: 1 1 auto">{BRAND}<span style="font-weight: 600; font-size: 15px; letter-spacing: -0.02em">Agentry</span></a>
<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Plegar barra lateral">{ico('sidebar')}</button>
</div>
<button type="button" class="field" style="width: 100%; cursor: pointer; justify-content: flex-start; background: var(--bg-2)">{ico('search')}<span class="grow t-sm" style="text-align: left">Buscar o ejecutar…</span><span class="kbd">⌘K</span></button>
<div class="col" style="gap: 1px">
{item('home', 'Main.html', 'home', 'Inicio')}
{item('chats', 'DesktopChats.html', 'chats', 'Chats', '<span class="count">197</span>')}
{item('tasks', 'DesktopTablero.html', 'tasks', 'Tareas', '<span class="count">15</span>')}
{item('orch', 'DesktopOrquestaciones.html', 'orch', 'Orquestaciones', '<span class="count-pill live">1</span>')}
{item('sched', 'DesktopProgramaciones.html', 'sched', 'Programaciones')}
</div>
<div class="col" style="gap: 1px">
<span class="t-label" style="padding: 0 10px 6px">Espacio</span>
{item('projects', 'DesktopProyectos.html', 'folder', 'Proyectos')}
{item('accounts', 'DesktopCuentas.html', 'accounts', 'Cuentas')}
{item('conn', 'DesktopConectores.html', 'conn', 'Conectores')}
{item('usage', 'DesktopUso.html', 'usage', 'Uso')}
{item('settings', 'DesktopAjustes.html', 'settings', 'Ajustes')}
</div>
{live if live is not None else LIVE_DEFAULT}
<div class="grow"></div>
<a href="#" class="nav-item">{ico('book')}Referencia de la API</a>
</nav>
</div>'''


def topbar(crumb, project='claude-wrapper', agents=2):
  return f'''<header class="app" data-theme="dark" style="width: 1184px; height: 52px; flex-shrink: 0; display: flex; align-items: center; gap: 10px; padding: 0 20px 0 24px; border-bottom: 1px solid var(--line); background: var(--bg)">
<nav aria-label="Ruta" class="row t-sm" style="gap: 6px">
<button type="button" class="btn btn-ghost btn-sm project-selector" style="gap: 6px; padding: 0 8px; color: var(--fg-2)">{ico('folder', 'ico ico-sm')}{project}{ico('down', 'ico ico-sm')}</button>
<span class="fg-3">/</span>
{crumb}
</nav>
<div class="grow"></div>
<a href="DesktopOrquestaciones.html" class="chip" style="gap: 8px; border-color: transparent; background: var(--live-soft); color: var(--live); font-family: var(--mono); font-size: 11.5px"><span class="dot dot-live dot-ping" style="width: 6px; height: 6px"></span>{agents} agentes trabajando</a>
<button type="button" class="btn btn-ghost btn-icon" aria-label="Notificaciones" style="position: relative">{ico('bell')}<span class="dot" style="position: absolute; top: 8px; right: 9px; width: 6px; height: 6px; background: var(--accent)"></span></button>
<div class="row" style="gap: 0">
<a href="DesktopNuevoChat.html" class="btn btn-primary" style="border-radius: var(--r) 0 0 var(--r)">{ico('plus')}Nuevo chat</a>
<button type="button" class="btn btn-primary btn-icon" aria-label="Más formas de empezar" style="border-radius: 0 var(--r) var(--r) 0; width: 30px; margin-left: 1px">{ico('down', 'ico ico-sm')}</button>
</div>
</header>'''


STATUSBAR = '''<footer class="app statusbar" data-theme="dark" style="width: 1184px">
<a href="DesktopCuentas.html" class="row" style="gap: 7px"><span class="dot dot-ok" style="width: 6px; height: 6px"></span>yeyo@inmoseo.net</a>
<span class="row" style="gap: 6px">5h<span class="bar bar-thin grad"><i style="width: 45%"></i></span>45%</span>
<span class="row" style="gap: 6px">7d<span class="bar bar-thin grad"><i style="width: 5%"></i></span>5%</span>
<span class="grow"></span>
<span class="row" style="gap: 6px"><span class="spin-braille"></span>2 en marcha</span>
<span>hoy 3,41 US$</span>
<span>Claude Code 2.1.282</span>
</footer>'''


def desktop(title, active, crumb, main, overlay='', project='claude-wrapper', live=None, agents=2, running=2):
  body = f'''<div class="app shell" data-theme="dark" style="width: 1440px; height: 1024px; position: relative">
{sidebar(active, live)}
<div class="main-col" style="position: relative">
{topbar(crumb, project, agents)}
{main}
{STATUSBAR.replace('2 en marcha', f'{running} en marcha')}
</div>
{overlay}
</div>'''
  return page(title + ' (desktop)', body)


def tabbar(active='more'):
  def tab(key, href, icon, name, extra=''):
    on = ' on' if key == active else ''
    return f'<a href="{href}" class="tab-m{on}"><span class="pill">{ico(icon, "ico ico-lg")}</span>{name}{extra}</a>'
  return f'''<nav class="app tabbar" data-theme="dark" aria-label="Principal" style="width: 390px">
{tab('home', 'MobileInicio.html', 'home', 'Inicio')}
{tab('chats', 'MobileChats.html', 'chats', 'Chats')}
{tab('orch', 'MobileOrquestaciones.html', 'orch', 'Orquestaciones', '<span class="count-pill live">1</span>')}
{tab('more', 'MobileMas.html', 'menu', 'Más')}
</nav>'''


def mobile(title, inner, cls='', style=''):
  st = f' style="{style}"' if style else ''
  body = f'<div class="app m-screen {cls}" data-theme="dark"{st}>\n{inner}\n</div>'
  return page(title + ' (móvil)', body, mobile=True)


def write(name, html):
  with open(os.path.join(OUT, name), 'w') as f:
    f.write(html)
  print('wrote', name)


def empty_board_svg(size='il-lg'):
  ids = 'il'
  # The empty board: three empty columns with dashed slots, and the first card, gradient-bordered,
  # floating in with its key and the + that creates it.
  g, d, fg, fm = f'{ids}-grad', f'{ids}-dots', f'{ids}-fade-g', f'{ids}-fade'
  return f'''<svg class="il {size}" viewBox="0 0 240 160" aria-hidden="true"><defs><linearGradient id="{g}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="stop-a"></stop><stop offset="1" class="stop-b"></stop></linearGradient><pattern id="{d}" width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" class="dot-fill"></circle></pattern><radialGradient id="{fg}" cx="0.5" cy="0.5" r="0.5"><stop offset="0" class="stop-in"></stop><stop offset="1" class="stop-out"></stop></radialGradient><mask id="{fm}"><rect x="0" y="0" width="240" height="160" fill="url(#{fg})"></rect></mask></defs>{BOARD_BODY}</svg>'''


BOARD_BODY = '''<rect x="0" y="0" width="240" height="160" class="f-dots" mask="url(#il-fade)"></rect>
<rect x="34" y="32" width="52" height="102" rx="10" class="c0"></rect>
<rect x="94" y="32" width="52" height="102" rx="10" class="c0"></rect>
<rect x="154" y="32" width="52" height="102" rx="10" class="c0"></rect>
<rect x="42" y="42" width="20" height="4" rx="2" class="s3"></rect><circle cx="77" cy="44" r="2.5" class="f-ink"></circle>
<rect x="102" y="42" width="24" height="4" rx="2" class="s3"></rect><circle cx="137" cy="44" r="2.5" class="f-ink"></circle>
<rect x="162" y="42" width="16" height="4" rx="2" class="s3"></rect><path d="M193.5 44 l1.8 1.8 l3.2 -3.4" class="ln-ok"></path>
<rect x="41" y="56" width="38" height="24" rx="5" class="ln-soft dash-lg"></rect>
<rect x="101" y="56" width="38" height="24" rx="5" class="ln-soft dash-lg"></rect>
<rect x="101" y="86" width="38" height="24" rx="5" class="ln-soft dash-lg"></rect>
<rect x="161" y="56" width="38" height="24" rx="5" class="ln-soft dash-lg"></rect>
<g class="a-float"><g transform="rotate(-8 64 58)"><rect x="34" y="42" width="64" height="34" rx="7" class="cg"></rect><text x="42" y="56" class="txt">AGN-1</text><rect x="42" y="63" width="36" height="5" rx="2.5" class="s3"></rect><circle cx="88" cy="53" r="2.5" class="f-grad"></circle></g></g>
<circle cx="212" cy="126" r="17" class="halo"></circle>
<circle cx="212" cy="126" r="13" class="f-grad a-pulse"></circle><path d="M212 120 v12 M206 126 h12" class="ln-white"></path>'''
