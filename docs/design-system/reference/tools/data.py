# The work items the prototypes show, one set for every screen so they agree.
from common import *

# key: dict(type, title, status, prio, epic, labels, who, crit, comments, live, blocked, child)
W = {
  'AGN-45': dict(t='story', title='Filtros guardados en la lista de tareas', s='backlog', p='medium', labels=['web']),
  'AGN-38': dict(t='bug', title='El FAB tapa la última fila en el iPhone SE', s='backlog', p='medium', epic='mob', labels=['móvil']),
  'AGN-44': dict(t='task', title='Documentar las plantillas de proyecto', s='backlog', p='low', epic='eco', labels=['docs']),
  'AGN-41': dict(t='story', title='Exportar el tablero a Markdown', s='backlog', p='low'),
  'AGN-47': dict(t='epic', title='Asistente de proyecto', s='todo', p='medium', child=(0, 6)),
  'AGN-39': dict(t='bug', title='La barra de uso no se actualiza al cambiar de cuenta', s='todo', p='urgent', epic='perf', labels=['web'], who='Y'),
  'AGN-36': dict(t='task', title='Tablas de tareas en SQLite', s='todo', p='high', epic='eco', labels=['core'], crit=(0, 4)),
  'AGN-33': dict(t='story', title='Enlazar tareas con chats y orquestaciones', s='todo', p='high', epic='eco', blocked='AGN-36', crit=(0, 5)),
  'AGN-28': dict(t='story', title='Tablero con columnas fijas y límites', s='in_progress', p='high', epic='eco', who='Y', crit=(2, 5), comments=2, live='chat'),
  'AGN-30': dict(t='task', title='API de tareas y del tablero', s='in_progress', p='medium', epic='eco', labels=['api'], crit=(1, 4), live='orch'),
  'AGN-31': dict(t='bug', title='El resumen de coste cuenta la caché dos veces', s='in_progress', p='high', epic='perf', labels=['core'], who='Y', crit=(1, 3)),
  'AGN-35': dict(t='task', title='Clave por proyecto al estilo YouTrack', s='in_progress', p='medium', epic='eco', crit=(0, 2)),
  'AGN-26': dict(t='story', title='Plantillas de proyecto', s='in_review', p='medium', epic='eco', who='Y', crit=(4, 5), comments=3, chat=True),
  'AGN-29': dict(t='task', title='Historial automático de cambios', s='in_review', p='low', epic='eco', crit=(2, 2), chat=True),
  'AGN-24': dict(t='task', title='Ajustes por proyecto en un JSON', s='done', p='medium', epic='eco', crit=(3, 3)),
  'AGN-22': dict(t='bug', title='Parpadeo del tema al cargar la app', s='done', p='high', labels=['web']),
  'AGN-19': dict(t='story', title='Night Shift en la web', s='done', p='medium', labels=['web'], crit=(6, 6)),
  'AGN-12': dict(t='epic', title='Ecosistema de proyectos', s='in_progress', p='high', child=(3, 11)),
}
LIMITS = {'in_progress': 3, 'in_review': 3}
DONE_MORE = 9


def by_col(s, keys=None):
  ks = keys or W.keys()
  return [k for k in ks if W[k]['s'] == s]


def card(k, sel=None):
  w = W[k]
  done = w['s'] == 'done'
  live = w.get('live')
  cls = 'wi-card'
  if done: cls += ' done'
  if live: cls += ' rail-live'
  if sel is True: cls += ' sel'
  chk = ''
  if sel:
    chk = '<span class="checkbox on" role="checkbox" aria-checked="true" aria-label="Seleccionada"></span>'
  lead = '<span class="spin-ring" style="width: 14px; height: 14px" role="img" aria-label="Trabajando"></span>' if live else tico(w['t'])
  top = f'<div class="wi-card-top">{chk}{lead}<span class="wi-key">{k}</span><span class="grow"></span>{prio(w["p"])}</div>'
  title = f'<p class="wi-card-title">{w["title"]}</p>'
  meta_bits = []
  if w.get('epic'): meta_bits.append(epic(w['epic']))
  for l in w.get('labels', []): meta_bits.append(label(l))
  meta = f'<div class="wi-card-meta">{"".join(meta_bits)}</div>' if meta_bits else ''
  body = ''
  if w['t'] == 'epic':
    d, n = w['child']
    body = f'<div class="wi-card-epic"><span class="ms-bar"><i class="done" style="width: {d / n * 100:.0f}%"></i></span><span>{d}/{n} tareas</span></div>'
  if live == 'chat':
    # Two lines, so the command the agent runs is never cut: the verb and the time, then the detail
    body += '<div class="wi-card-live two"><span class="spin-braille"></span><span class="c-live grow">Ejecutando</span><span class="mono t-xs fg-3">4:12</span><span class="mono fg-3 detail">pnpm test</span></div>'
  if live == 'orch':
    body += '<div class="wi-card-live"><span class="spin-braille"></span><span class="mono t-xs c-live ellipsis">nodo 3 de 9</span><span class="segbar"><i class="ok"></i><i class="ok"></i><i class="live" style="--p: 55%"></i><i></i><i></i><i></i></span></div>'
  foot = []
  if w.get('blocked'):
    foot.append(f'<span class="wi-fact" title="Bloqueada por {w["blocked"]}">{ico("block")}{w["blocked"]}</span>')
  if w.get('crit'):
    a, b = w['crit']
    foot.append(f'<span class="wi-fact" title="Criterios de aceptación">{ico("crit")}{a}/{b}</span>')
  if w.get('comments'):
    foot.append(f'<span class="wi-fact" title="Comentarios">{ico("comment")}{w["comments"]}</span>')
  who = av() if w.get('who') else ''
  # An assignee with no facts beside it joins the meta row instead of opening a row of its own
  if who and not foot and meta:
    meta = meta[:-len('</div>')] + f'<span class="grow"></span>{who}</div>'
    who = ''
  footer = f'<div class="wi-card-foot">{"".join(foot)}<span class="grow"></span>{who}</div>' if (foot or who) else ''
  return f'<article class="{cls}" aria-label="{k} · {w["title"]}">{top}{title}{meta}{body}{footer}</article>'


def col(s, keys, sel_mode=False, selected=(), extra=''):
  name = COL_WORD[s]
  n = len(keys) + (DONE_MORE if s == 'done' else 0)
  lim = LIMITS.get(s)
  over = lim is not None and n > lim
  cnt = f'<span class="wi-col-count"><b>{n}</b>/{lim}</span>' if lim else f'<span class="wi-col-count"><b>{n}</b></span>'
  head = f'<div class="wi-col-head">{sico(s)}<span class="t-label">{name}</span>{cnt}<span class="grow"></span><button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Nueva tarea en {name}">{ico("plus", "ico ico-sm")}</button></div>'
  warn = f'<div class="wi-col-limit" role="status">{ico("warn")}Sobre el límite: {n} de {lim}</div>' if over else ''
  cards = ''.join(card(k, (k in selected) if sel_mode and s != 'done' else None) for k in keys)
  more = f'<a href="DesktopTareasLista.html" class="wi-col-slot" style="border-style: solid; border-color: var(--line)">y {DONE_MORE} más</a>' if s == 'done' else ''
  return f'<section class="wi-col{" over" if over else ""}" aria-label="{name}">{head}{warn}<div class="wi-col-body">{cards}{more}{extra}</div></section>'
