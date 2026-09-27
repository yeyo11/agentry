from data import *


def view_seg(on):
  items = [('board', 'DesktopTablero.html', 'Tablero', 'board'), ('list', 'DesktopTareasLista.html', 'Lista', 'list'), ('ms', 'DesktopHitos.html', 'Hitos', 'flag')]
  out = ''.join(f'<a href="{h}" role="tab" aria-selected="{"true" if k == on else "false"}" class="{"on" if k == on else ""}">{ico(i, "ico ico-sm")}{n}</a>' for k, h, n, i in items)
  return f'<div class="seg" role="tablist" aria-label="Vista">{out}</div>'


def filters(applied=None):
  applied = applied or {}
  names = [('type', 'Tipo'), ('prio', 'Prioridad'), ('label', 'Etiqueta'), ('who', 'Responsable'), ('epic', 'Épica'), ('ms', 'Hito')]
  out = []
  for k, n in names:
    if k in applied:
      out.append(f'<button type="button" class="chip on">{n}: {applied[k]}<span aria-label="Quitar filtro">{ico("x", "ico ico-sm")}</span></button>')
    else:
      out.append(f'<button type="button" class="chip">{n}{ico("down", "ico ico-sm")}</button>')
  return ''.join(out)


def head(sub, on='board', primary=True, select=False, title='Tareas'):
  # Selection mode is the same button, pressed; while it is on, Orquestar is the zone's primary action
  sel = ('<button type="button" class="btn" aria-pressed="true">' + ico('check') + 'Seleccionar</button>') if select else ('<button type="button" class="btn">' + ico('tasks') + 'Seleccionar</button>')
  new = f'<a href="DesktopNuevaTarea.html" class="btn{" btn-primary" if primary and not select else ""}">{ico("plus")}Nueva tarea</a>' 
  return f'''<div class="page-head" style="align-items: center">
<div class="row" style="gap: 16px"><div class="col" style="gap: 4px"><h1 class="t-h1">{title}</h1><p class="fg-2 t-sm" style="margin: 0">{sub}</p></div></div>
<div class="row" style="gap: 8px">{view_seg(on)}<span style="width: 8px"></span>{sel if on != 'ms' else ''}{new}</div>
</div>'''


def toolbar(applied=None, q=''):
  val = f' value="{q}"' if q else ''
  return f'''<div class="row" style="gap: 8px; flex-wrap: wrap">
<label class="field" style="width: 300px">{ico('search')}<input type="search" placeholder="Buscar en título y descripción" aria-label="Buscar tareas"{val}><span class="kbd">/</span></label>
{filters(applied)}
</div>'''


# The order a person gave the cards by dragging (their rank). In curso is taller than the page, and
# its last card shows cut at the column's edge, which is how a column that scrolls reads.
RANK = ['AGN-12', 'AGN-28', 'AGN-30', 'AGN-35', 'AGN-31']


def epics_first(keys):
  # An epic groups the column's work, so it leads it
  return sorted(keys, key=lambda k: (W[k]['t'] != 'epic', RANK.index(k) if k in RANK else 0))


def board_desktop():
  selected = ('AGN-36', 'AGN-33')
  cols = ''.join(col(s, epics_first(by_col(s)), sel_mode=True, selected=selected) for s, _ in COLS)
  main = f'''<main class="page selecting" style="gap: 16px; position: relative">
{head('claude-wrapper · 15 abiertas · clave <span class="mono">AGN</span>', select=True)}
{toolbar()}
<div class="wi-board">{cols}</div>
<div class="select-bar" role="toolbar" aria-label="Selección">
<span style="font-weight: 600"><span class="t-num">2</span> seleccionadas</span>
<span class="row t-xs fg-3 mono" style="gap: 6px">{ico('block', 'ico ico-sm')}AGN-36 bloquea AGN-33: irá antes en el grafo</span>
<span style="width: 1px; height: 22px; background: var(--line-2)"></span>
<button type="button" class="btn btn-ghost btn-sm">Cancelar</button>
<a href="DesktopOrquestacion.html" class="btn btn-primary btn-sm">{ico('orch', 'ico ico-sm')}Orquestar</a>
</div>
</main>'''
  write('DesktopTablero.html', desktop('Tablero', 'tasks', '<span style="font-weight: 500">Tareas</span>', main, css=CARD_CSS))


def mhead(title, sub=None, back=None, right=''):
  b = f'<a href="{back}" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver">{ico("left", "ico ico-lg", "stroke-width: 2")}</a>' if back else ''
  s = f'<span class="mono t-xs fg-3">{sub}</span>' if sub else ''
  return f'<header class="m-head" style="padding-left: {4 if back else 16}px">{b}<span class="col grow" style="gap: 1px"><h1 class="t-h1" style="font-size: 24px">{title}</h1>{s}</span>{right}</header>'


def mrow(k, show_status=False):
  w = W[k]
  live = w.get('live')
  cls = 'wi-mrow' + (' rail-live' if live else '')
  lead = '<span class="spin-ring" style="width: 14px; height: 14px" role="img" aria-label="Trabajando"></span>' if live else tico(w['t'])
  st = sico(w['s']) if show_status else ''
  meta = []
  if w.get('epic'): meta.append(epic(w['epic']))
  for l in w.get('labels', []): meta.append(label(l))
  if w.get('crit'): meta.append(f'<span class="row mono t-xs fg-3" style="gap: 4px">{ico("crit", "ico", "width: 12px; height: 12px")}{w["crit"][0]}/{w["crit"][1]}</span>')
  livel = ''
  if live == 'chat':
    livel = '<span class="row t-xs" style="gap: 6px"><span class="spin-braille"></span><span class="c-live">Ejecutando</span><span class="mono fg-3 grow ellipsis">pnpm test</span><span class="mono fg-3">4:12</span></span>'
  if live == 'orch':
    livel = '<span class="row t-xs" style="gap: 8px"><span class="spin-braille"></span><span class="mono c-live">nodo 3 de 9</span><span class="segbar grow" style="height: 4px"><i class="ok"></i><i class="ok"></i><i class="live" style="--p: 55%"></i><i></i><i></i><i></i></span></span>'
  who = av() if w.get('who') else ''
  return f'''<a href="MobileTarea.html" class="{cls}">
<span class="row" style="gap: 8px">{st}{lead}<span class="wi-key">{k}</span><span class="grow"></span>{prio(w['p'])}{who}</span>
<span style="font-weight: 500; font-size: 15px; line-height: 1.35">{w['title']}</span>
{f'<span class="row" style="gap: 5px; flex-wrap: wrap">{"".join(meta)}</span>' if meta else ''}
{livel}
</a>'''


def msection(s, keys, first=False):
  n = len(keys) + (DONE_MORE if s == 'done' else 0)
  lim = LIMITS.get(s)
  over = lim is not None and n > lim
  cnt = f'<span class="wi-col-count"><b>{n}</b>/{lim}</span>' if lim else f'<span class="wi-col-count"><b>{n}</b></span>'
  warn = f'<span class="badge b-warn">{ico("warn", "ico", "width: 11px; height: 11px")}sobre el límite</span>' if over else ''
  rows = ''.join(mrow(k) for k in keys)
  return f'''<section class="col" style="gap: 8px" aria-label="{COL_WORD[s]}">
<div class="row" style="gap: 8px; padding: 0 2px">{sico(s)}<span class="t-label" style="color: var(--fg-2)">{COL_WORD[s]}</span><span class="{'c-warn ' if over else ''}wi-col-count">{cnt}</span><span class="grow"></span>{warn}</div>
<div class="card{' ' if not over else ''}" style="overflow: hidden{'; border-color: color-mix(in srgb, var(--warn) 38%, transparent)' if over else ''}">{rows}</div>
</section>'''


def jump(on='in_progress'):
  out = []
  for s, n in COLS:
    k = by_col(s)
    c = len(k) + (DONE_MORE if s == 'done' else 0)
    lim = LIMITS.get(s)
    over = lim is not None and c > lim
    cls = ('on ' if s == on else '') + ('over' if over else '')
    label_txt = f'{n} <span class="count">{c}{"/" + str(lim) if lim else ""}</span>' if s == on else f'{c}'
    out.append(f'<button type="button" role="tab" aria-selected="{"true" if s == on else "false"}" aria-label="{n}: {c}" class="{cls.strip()}">{sico(s)}{label_txt}</button>')
  return f'<div class="seg wi-jump" role="tablist" aria-label="Ir a la columna">{"".join(out)}</div>'


def mtoolbar(filters_n=0):
  badge = f'<span class="count-pill" style="position: absolute; top: -4px; right: -4px; background: var(--fg); color: var(--bg)">{filters_n}</span>' if filters_n else ''
  return f'''<div class="row" style="gap: 8px">
<label class="field field-lg grow">{ico('search', 'ico ico-lg')}<input type="search" placeholder="Buscar tareas" aria-label="Buscar tareas" style="font-size: 16px"></label>
<button type="button" class="btn btn-lg btn-icon" aria-label="Filtros" style="position: relative">{ico('filter', 'ico ico-lg')}{badge}</button>
</div>'''


def mproject_chip():
  return f'<button type="button" class="chip project-selector" style="height: 36px; font-size: 14px; padding: 0 12px">claude-wrapper{ico("down", "ico ico-sm")}</button>'


def mview_seg(on):
  items = [('board', 'MobileTablero.html', 'Tablero'), ('list', 'MobileTareasLista.html', 'Lista'), ('ms', 'MobileHitos.html', 'Hitos')]
  out = ''.join(f'<a href="{h}" role="tab" aria-selected="{"true" if k == on else "false"}" class="{"on" if k == on else ""}" style="flex: 1 1 0; justify-content: center; height: 36px; font-size: 14px">{n}</a>' for k, h, n in items)
  return f'<div class="seg" role="tablist" aria-label="Vista" style="display: flex">{out}</div>'


def board_mobile():
  inner = f'''{mhead('Tareas', None, 'MobileMas.html', mproject_chip() + '<span style="width: 8px"></span>')}
<div class="m-body stack" style="gap: 12px">
{mview_seg('board')}
{mtoolbar()}
{jump('in_progress')}
{msection('in_progress', by_col('in_progress'))}
{msection('in_review', by_col('in_review'))}
</div>
<a href="MobileNuevaTarea.html" class="fab" aria-label="Nueva tarea" style="padding: 0; width: 56px">{ico('plus', 'ico ico-lg', 'stroke-width: 2.2')}</a>
{tabbar('more')}'''
  write('MobileTablero.html', mobile('Tablero', inner, 'has-fab'))


if __name__ == '__main__':
  board_desktop()
  board_mobile()
