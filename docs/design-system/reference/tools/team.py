# The screens the ecosystem review added (design pass on feat/project-ecosystem): the Team activity
# view behind "Ver todo" (gap 6), a failed flow run's own chat (gaps 2 and 8), the phone board while
# the team works it (it was hand-drawn with the old card and a wrong count) and the DSTablero spec
# page. One data set with the rest: 13 open items, En curso 4 of 3, two runs at a time.
from data import *
from projects import proj_head, proj_tabs
from board import mhead, mrow, msection, jump, mview_seg, mproject_chip, mtoolbar
from desktop import TEAM_LIVE


# ---------------------------------------------------------------- flow runs
# A run is named by its stage as a noun in its title and by its verb while it runs. The core has one
# refine stage for Backlog and Por hacer; in Por hacer the Product Owner only checks the item is ready,
# so there the run is named by what it does: comprobación.
STAGE = {'refine': ('refinado', 'Refinando'), 'check': ('comprobación', 'Comprobando'), 'work': ('implementación', 'Implementando'), 'verify': ('verificación', 'Verificando')}


def outcome(r):
  # One word per outcome, each with its icon. Only running, passed and failed carry a status colour;
  # sent back, queued and cancelled are neutral because none of them is a fault.
  st = r.get('state') or r['outcome']
  return {
    'running': '<span class="badge b-live">en marcha</span>',
    'queued': f'<span class="badge">{ico("wait", "ico ico-sm")}en cola</span>',
    'passed': f'<span class="badge b-ok">{ico("check", "ico ico-sm")}pasó</span>',
    'rejected': f'<span class="badge">{ico("bounce", "ico ico-sm")}devuelta</span>',
    'failed': f'<span class="badge b-bad">{ico("x", "ico ico-sm")}fallida</span>',
    'cancelled': '<span class="badge">cancelada</span>',
  }[st]


# Newest first. Durations: a running clock in m:ss, a finished run in words (decision 10). A failed
# run offers "Reintentar" until a later run of the same stage exists; then it links that run.
RUNS = [
  dict(day='now', who='QA', stage='verify', key='AGN-29', state='running', clock='1:05', now='criterio 2 de 2 · work-items.test.ts'),
  dict(day='now', who='DEV', stage='work', key='AGN-28', state='running', clock='4:12', now='pnpm test'),
  dict(day='now', who='DEV', stage='work', key='AGN-35', state='queued', note='Retomará su chat cuando quede sitio: QA la devolvió', t='25 min'),
  dict(day='now', who='PO', stage='refine', key='AGN-45', state='queued', note='Espera sitio: hay 2 de 2 ejecuciones en marcha', t='6 min'),
  dict(day='today', who='QA', stage='verify', key='AGN-26', outcome='passed', note='5 de 5 criterios cumplidos · te espera para pasar a Hecho', dur='3 min 40 s', cost='0,42 US$', t='12 min'),
  dict(day='today', who='PO', stage='check', key='AGN-36', outcome='failed', dur='1 min 12 s', cost='0,18 US$', t='20 min',
       why=('Ninguna cuenta tenía cupo.', 'Las tres cuentas llegaron a su límite de 5 h y no quedaba otra a la que pasar. La tarea sigue en Por hacer, sin cambios.', 'the account hit its rate limit')),
  dict(day='today', who='QA', stage='verify', key='AGN-35', outcome='rejected', note='«La clave cambia al renombrar; el criterio 2 pide que no.» · rebote 1 de 3', dur='2 min 5 s', cost='0,21 US$', t='25 min'),
  dict(day='today', who='DEV', stage='work', key='AGN-35', outcome='passed', note='Dio por hechos los 2 criterios · pasó a En revisión', dur='11 min', cost='0,96 US$', t='41 min'),
  dict(day='today', who='PO', stage='refine', key='AGN-43', title='Tarea eliminada', gone=True, outcome='cancelled', note='No llegó a empezar: eliminaste la tarea mientras esperaba', t='1 h'),
  dict(day='yesterday', who='QA', stage='verify', key='AGN-31', outcome='rejected', note='Rebote 3 de 3 · ahora te espera a ti', dur='1 min 50 s', cost='0,17 US$', t='18:20'),
  dict(day='yesterday', who='QA', stage='verify', key='AGN-26', outcome='failed', dur='2 min 30 s', cost='0,39 US$', t='17:44', retried='pasó hace 12 min',
       why=('Se cortó tres veces.', 'Agentry se reinició mientras QA verificaba. Siguió en su chat las dos veces que se permiten; a la tercera, la ejecución se dio por fallida.', 'cut off by a restart (restarts: 2 of 2)')),
  dict(day='yesterday', who='PO', stage='refine', key='AGN-33', outcome='passed', note='Escribió 5 criterios de aceptación · pasó a Por hacer', dur='2 min 48 s', cost='0,31 US$', t='16:05'),
]
DAYS = [('now', 'Ahora'), ('today', 'Hoy'), ('yesterday', 'Ayer · domingo 27')]


def run_row(r, mobile=False):
  running = r.get('state') == 'running'
  name = ROLES[r['who']][1]
  pre = 'Mobile' if mobile else 'Desktop'
  # On a phone the whole row is the target and opens the run's chat (the failed one's banner has the
  # retry), so the item inside is text, not a nested link. An item that is gone is text everywhere.
  gone = r.get('gone')
  item_tag, item_href = ('span', '') if mobile or gone else ('a', f' href="{pre}Tarea.html"')
  item_title = r.get('title') or W[r['key']]['title']
  title = (f'<span class="run-title"><span class="who">{name}</span><span class="stage">· {STAGE[r["stage"]][0]}</span>{outcome(r)}</span>'
           f'<{item_tag}{item_href} class="row" style="gap: 8px; align-items: baseline; min-width: 0"><span class="wi-key">{r["key"]}</span><span class="t-sm{"" if mobile else " ellipsis"}{" fg-3" if gone else ""}" style="font-weight: 500">{item_title}</span></{item_tag}>')
  if running:
    line = f'<span class="run-now"><span class="spin-braille" aria-hidden="true"></span><span class="c-live" style="font-weight: 500">{STAGE[r["stage"]][1]}</span><span class="mono">{r["now"]}</span></span>'
  else:
    line = f'<span class="t-sm fg-2" style="line-height: 1.45">{r["note"]}</span>' if r.get('note') else ''
  why = ''
  if r.get('why') and mobile:
    head, text, raw = r['why']
    why = f'<div class="run-why">{ico("x")}<span><b>{head}</b> {text}</span></div>'
  elif r.get('why'):
    head, text, raw = r['why']
    chat = f'{pre}ChatFlujo.html'
    act = (f'<span class="row t-sm" style="gap: 6px; color: var(--fg-2)">{ico("retry", "ico ico-sm")}Reintentada: {r["retried"]}</span>' if r.get('retried')
           else f'<button type="button" class="btn btn-sm btn-ghost" style="margin: -4px 0">{ico("retry", "ico ico-sm")}Reintentar</button>')
    why = (f'<div class="run-why">{ico("x")}<span class="col" style="gap: 4px; min-width: 0"><span><b>{head}</b> {text}</span>'
           f'<span class="row" style="gap: 12px; flex-wrap: wrap"><span class="mono">{raw}</span><a href="{chat}" class="t-sm c-accent">Ver el chat</a>{act}</span></span></div>')
  if running:
    link = '' if mobile else f'<a href="{pre}ChatTarea.html" class="t-xs c-accent">Ver el chat</a>'
    side = f'<span class="run-side"><time class="t-num" style="color: var(--fg-2)">{r["clock"]}</time>{link}</span>'
  elif r.get('state') == 'queued':
    side = f'<span class="run-side"><time>{r["t"]}</time></span>'
  else:
    facts = ' · '.join(x for x in (r.get('dur'), r.get('cost')) if x)
    side = f'<span class="run-side"><time>{r["t"]}</time>{f"<span class=\"mono t-xs fg-3\" style=\"white-space: nowrap\">{facts}</span>" if facts and not mobile else ""}</span>'
  if mobile and r.get('dur'):
    line += f'<span class="mono t-xs fg-3">{r["dur"]} · {r["cost"]}</span>'
  label = f'{name}, {STAGE[r["stage"]][0]} de {r["key"]}'
  cls = f'run-row{" rail-live" if running else ""}'
  inner = f'{role(r["who"], "")}<div class="run-main">{title}{line}</div>{side}{why}'
  if mobile:
    href = 'MobileChatFlujo.html' if r.get('why') else 'MobileChatTarea.html' if r.get('state') != 'queued' else 'MobileTarea.html'
    return f'<a href="{href}" class="{cls}" aria-label="{label}">{inner}</a>'
  return f'<article class="{cls}" aria-label="{label}">\n{inner}\n</article>'


def runs_list(mobile=False, days=None, only=None):
  out = ''
  for d, word in DAYS:
    if days and d not in days:
      continue
    rows = [r for r in RUNS if r['day'] == d and (only is None or r.get('outcome') == only)]
    if not rows:
      continue
    extra = '<span class="mono t-xs fg-3">2 en marcha · 2 en cola</span>' if d == 'now' else f'<span class="mono t-xs fg-3">{len(rows)}</span>'
    out += f'<div class="run-day"><span class="t-label grow">{word}</span>{extra}</div>' + ''.join(run_row(r, mobile) for r in rows)
  return out


def team_seg(on, mobile=False):
  pre = 'Mobile' if mobile else 'Desktop'
  items = [('members', f'{pre}Equipo.html', 'Miembros' + ('' if mobile else ' <span class="count">5</span>')), ('flow', f'{pre}Flujo.html', 'Flujo'), ('activity', f'{pre}EquipoActividad.html', 'Actividad')]
  st = ' style="flex: 1 1 0; justify-content: center; height: 36px; font-size: 14px"' if mobile else ''
  out = ''.join(f'<a href="{h}" role="tab" aria-selected="{"true" if k == on else "false"}" class="{"on" if k == on else ""}"{st}>{n}</a>' for k, h, n in items)
  return f'<div class="seg" role="tablist" aria-label="Equipo"{" style=\"display: flex\"" if mobile else ""}>{out}</div>'


def member_chip(ab, n, on=False):
  return f'<button type="button" class="chip{" on" if on else ""}" aria-pressed="{"true" if on else "false"}">{role(ab, "xs")}{ROLES[ab][1]}<span class="n">{n}</span></button>'


def state_seg(mobile=False, on=0):
  items = [('Todas', ''), ('En marcha', '2'), ('Fallidas', '2'), ('Devueltas', '2')]
  st = ' style="flex: 1 1 0; justify-content: center"' if mobile else ''
  out = ''.join(f'<button type="button" role="tab" aria-selected="{"true" if i == on else "false"}" class="{"on" if i == on else ""}"{st}>{n}{f" <span class=\"count\">{c}</span>" if c else ""}</button>' for i, (n, c) in enumerate(items))
  return f'<div class="seg" role="tablist" aria-label="Estado"{" style=\"display: flex\"" if mobile else ""}>{out}</div>'


SUM = '<div class="run-sum"><span>Hoy <b>9</b> ejecuciones</span><span><b>2</b> en marcha</span><span><b>2</b> en cola</span><span><b>1</b> fallida</span><span><b>1,77 US$</b> en las terminadas</span></div>'


def per_member():
  rows = [('PO', '3', '0,18 US$', '1 fallida'), ('DEV', '3', '0,96 US$', ''), ('QA', '3', '0,63 US$', '')]
  out = ''
  for ab, n, cost, fail in rows:
    f = f'<span class="row t-xs c-bad" style="gap: 4px">{ico("x", "ico ico-sm")}{fail}</span>' if fail else ''
    out += f'<div class="row" style="gap: 10px; min-height: 44px; padding: 6px 0; border-top: 1px solid var(--line)">{role(ab, "sm")}<span class="col grow" style="gap: 2px"><span class="t-sm">{ROLES[ab][1]}</span>{f}</span><span class="mono t-xs fg-2">{n} ejec.</span><span class="mono t-xs fg-3" style="width: 64px; text-align: right">{cost}</span></div>'
  return out


def team_activity_desktop():
  filt = f'''<div class="row" style="gap: 8px; flex-wrap: wrap; min-height: 34px">
<span class="t-label" style="margin-right: 4px">Miembro</span><button type="button" class="chip on" aria-pressed="true">Todos</button>{member_chip('PO', 3)}{member_chip('DEV', 3)}{member_chip('QA', 3)}
</div>'''
  aside = f'''<div class="col" style="gap: 12px">
<section class="card card-pad col" style="gap: 6px"><div class="row" style="padding-bottom: 6px"><span class="t-h2 grow">Por miembro</span><span class="mono t-xs fg-3">hoy</span></div>{per_member()}
<span class="form-hint" style="padding-top: 6px">El Arquitecto y el Redactor técnico no responden de ninguna columna: el flujo no los ejecuta; se les consulta desde un chat.</span></section>
<section class="card card-pad col" style="gap: 0"><div class="row" style="padding-bottom: 8px"><span class="t-h2 grow">Límites del flujo</span><a href="DesktopFlujo.html" class="t-sm c-accent">Editar</a></div>
<div class="prop-row" style="border-top: 0"><span class="k" style="width: 120px">A la vez</span><span class="v"><span class="t-num">2</span><span class="t-xs fg-3">las dos en uso · 2 en cola</span></span></div>
<div class="prop-row"><span class="k" style="width: 120px">Coste por ejecución</span><span class="v">Sin límite</span></div>
<div class="prop-row"><span class="k" style="width: 120px">Rebotes</span><span class="v"><span class="t-num">3</span><span class="t-xs fg-3">como máximo</span></span></div></section>
</div>'''
  main = f'''<main class="page" style="gap: 16px">
{proj_head(task_primary=False)}
{proj_tabs('team')}
<div class="row" style="gap: 10px">{team_seg('activity')}<span class="grow"></span>{state_seg()}</div>
<div style="display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; align-items: start; min-height: 0">
<div class="col" style="gap: 12px; min-width: 0">
{filt}
<section class="card" style="overflow: hidden" aria-label="Ejecuciones">
<div class="row" style="padding: 12px 16px; border-bottom: 1px solid var(--line)">{SUM}</div>
{runs_list(days=('now', 'today', 'yesterday'))}
<div class="list-more" style="border-top: 1px solid var(--line)"><button type="button" class="btn btn-sm">Mostrar 50 más{ico('down', 'ico ico-sm')}</button><span class="mono t-xs">quedan 112</span></div>
</section>
</div>
{aside}
</div>
</main>'''
  write('DesktopEquipoActividad.html', desktop('Actividad del equipo', 'projects', pcrumb('claude-wrapper', ('Equipo', 'DesktopEquipo.html'), ('Actividad', '')), main, live=TEAM_LIVE, agents=3, running=3))


def team_activity_mobile():
  inner = f'''<header class="row" style="flex-shrink: 0; padding: 8px 4px; gap: 4px">
<a href="MobileProyecto.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver">{ico('left', 'ico ico-lg', 'stroke-width: 2')}</a>
<span class="col grow" style="gap: 1px; min-width: 0"><h1 class="t-h1">Equipo</h1><span class="mono t-xs fg-3">claude-wrapper · 5 miembros</span></span>
<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Filtrar por miembro">{ico('filter', 'ico ico-lg')}</button>
</header>
<div class="m-body stack" style="gap: 12px">
{team_seg('activity', True)}
{state_seg(True, on=2)}
<div class="card" style="overflow: hidden">
{runs_list(True, only='failed')}
</div>
<p class="t-sm fg-3" style="margin: 0; padding: 0 4px; line-height: 1.5">Una ejecución fallida no mueve la tarea: deja un comentario en ella y su chat dice por qué. Tócala para reintentarla desde su chat.</p>
</div>
{tabbar('more')}'''
  write('MobileEquipoActividad.html', mobile('Actividad del equipo', inner))


# ---------------------------------------------------------------- a failed run's own chat
FAIL_BANNER = f'''<div class="run-fail" role="status">{ico('x')}<div class="col" style="gap: 4px; min-width: 0">
<span><b>Esta verificación falló y no movió la tarea.</b> Se cortó tres veces: Agentry se reinició mientras QA verificaba; siguió en este chat las dos veces que se permiten y, a la tercera, la ejecución se dio por fallida. QA lo comentó en AGN-26.</span>
<span class="mono t-xs fg-3">cut off by a restart (restarts: 2 of 2) · ayer 17:44</span>
<span class="row t-sm" style="gap: 6px; margin-top: 4px">{ico('check', 'ico ico-sm c-ok')}<span>Reintentada hoy: <b class="c-ok">pasó</b> hace 12 min, en el chat 7c2e01.</span></span>
<div class="acts"><a href="DesktopChat.html" class="btn btn-sm">Abrir el chat 7c2e01</a><a href="DesktopTarea.html" class="btn btn-sm btn-ghost">Abrir AGN-26</a></div>
</div></div>'''


def restart_line(n, short=False):
  if n > 2:
    txt = 'Reinicio · sin reanudaciones' if short else 'Agentry se reinició · no quedan reanudaciones'
  else:
    txt = f'Reinicio · sigue aquí ({n} de 2)' if short else f'Agentry se reinició · sigue en este chat ({n} de 2)'
  return f'<div class="row t-xs mono fg-3" style="gap: 8px; justify-content: center; white-space: nowrap"><span style="flex: 1 1 0; height: 1px; background: var(--line)"></span>{ico("retry", "ico ico-sm")}{txt}<span style="flex: 1 1 0; height: 1px; background: var(--line)"></span></div>'


FLOW_PROMPT = '''<span class="row t-xs" style="gap: 6px; color: var(--fg-3); font-family: var(--mono)">FLUJO_ICO flujo automático · En revisión → QA</span><span><b>Verifica AGN-26 · Plantillas de proyecto</b><br>Comprueba cada criterio de aceptación contra el worktree <span class="mono">task/agn-26</span> y da tu veredicto por criterio.</span>'''


def flow_part_of(mobile=False):
  if mobile:
    return f'''<a href="MobileTarea.html" class="part-of" style="margin: 0 16px">{role('QA', 'xs')}<span class="col grow" style="gap: 2px; min-width: 0"><span class="row t-xs" style="gap: 6px"><span>Verificación de</span><span class="wi-key">AGN-26</span><span class="grow"></span><span class="row" style="gap: 5px">{sico('in_review')}En revisión</span></span><span style="font-size: 14px; font-weight: 600; color: var(--fg)">Plantillas de proyecto</span></span></a>'''
  return f'''<div class="part-of" style="white-space: nowrap">{role('QA', 'xs')}<span>Verificación de</span><span class="wi-key boxed">AGN-26</span><a href="DesktopTarea.html" class="ellipsis">Plantillas de proyecto</a><span class="grow"></span><span class="row t-xs" style="gap: 6px">{sico('in_review')}En revisión</span><span class="mono t-xs fg-3">criterios 5/5</span></div>'''


def flow_chat_desktop():
  prompt = FLOW_PROMPT.replace('FLUJO_ICO', ico('flow', 'ico ico-sm'))
  main = f'''<div class="row" style="flex: 1 1 auto; min-height: 0; align-items: stretch; gap: 0">
<div class="col grow" style="gap: 0; min-width: 0">
<div class="row" style="height: 56px; padding: 0 20px 0 12px; border-bottom: 1px solid var(--line); gap: 10px; flex-shrink: 0">
<a href="DesktopEquipoActividad.html" class="btn btn-ghost btn-icon btn-sm" aria-label="Volver">{ico('left')}</a>
<span class="col grow" style="gap: 1px; min-width: 0"><span class="ellipsis" style="font-weight: 600">QA verifica AGN-26: plantillas de proyecto</span><span class="mono t-xs fg-3">claude-wrapper · 91ab22 · sonnet · Sonnet 5</span></span>
<span class="badge b-bad">{ico('x', 'ico ico-sm')}fallida</span><span class="mono t-xs fg-3">2 min 30 s</span>
<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Buscar en el chat">{ico('search')}</button>
<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Más acciones">{ico('more', 'ico', 'stroke-width: 3')}</button>
</div>
<div style="padding: 12px 32px 0; display: flex; justify-content: center; flex-shrink: 0"><div class="col" style="width: 100%; max-width: 740px; gap: 10px">{flow_part_of()}{FAIL_BANNER}</div></div>
<div style="flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; justify-content: center; padding: 20px 32px 0">
<div class="col" style="width: 100%; max-width: 740px; gap: 16px; font-size: 14px; line-height: 1.65">
<div class="col" style="align-self: flex-end; max-width: 82%; gap: 4px; background: var(--bg-2); border: 1px dashed var(--line-3); border-radius: var(--r-xl) var(--r-xl) var(--r-xs) var(--r-xl); padding: 11px 15px; font-size: 14px">{prompt}</div>
<div class="row t-xs" style="gap: 8px; font-family: var(--mono); color: var(--fg-3)">{ico('check', 'ico ico-sm c-ok', 'stroke-width: 2.4')}<span>4 herramientas · 1 min 5 s</span><span class="badge">Read ×3</span><span class="badge">Grep</span>{ico('down', 'ico ico-sm')}</div>
<p style="margin: 0">Criterios 1 a 3 cumplidos: las cinco plantillas están en <code>project-templates.ts</code>, la ruta las lista en el orden del asistente y crear un proyecto preselecciona sus módulos. Sigo con el 4.</p>
{restart_line(1)}
<p style="margin: 0">Retomo en el criterio 4. Personalizada no activa ningún módulo: lo compruebo con el test de plantillas.</p>
<div class="row t-xs" style="gap: 8px; font-family: var(--mono); color: var(--fg-3)">{ico('check', 'ico ico-sm c-ok', 'stroke-width: 2.4')}<span>1 herramienta · 38 s</span><span class="badge">Bash</span></div>
{restart_line(2)}
<p style="margin: 0">Retomo otra vez en el criterio 4.</p>
{restart_line(3)}
<div class="row t-sm" style="gap: 8px; color: var(--fg-2)">{ico('x', 'ico ico-sm c-bad')}<span><b class="c-bad" style="font-weight: 600">Falló</b> · se cortó por tercera vez antes de dar su veredicto</span></div>
</div>
</div>
<div style="display: flex; justify-content: center; padding: 12px 32px 18px; flex-shrink: 0">
<div class="col" style="width: 100%; max-width: 780px; gap: 8px">
<div class="card" style="border-radius: var(--r-xl); padding: 10px; display: flex; align-items: flex-end; gap: 8px">
<button type="button" class="btn btn-ghost btn-icon" aria-label="Adjuntar">{ico('clip')}</button>
<label class="grow" style="display: flex; min-height: 36px; align-items: center"><textarea rows="1" placeholder="Escribe para seguir tú: el flujo te cede este chat" aria-label="Mensaje" style="width: 100%; border: 0; outline: 0; resize: none; background: transparent; font-size: 14px; padding: 0"></textarea></label>
<button type="button" class="btn btn-primary btn-icon" aria-label="Enviar">{ico('send', 'ico', 'stroke-width: 2.2')}</button>
</div>
<div class="row" style="gap: 6px"><button type="button" class="chip">Sonnet 5</button><button type="button" class="chip">Acepta ediciones</button><button type="button" class="chip">{ico('branch', 'ico ico-sm')}task/agn-26</button><span class="grow"></span><span class="t-xs fg-3 mono">↵ enviar · ⇧↵ salto</span></div>
</div>
</div>
</div>
<aside aria-label="Detalles del chat" class="col" style="width: 320px; flex-shrink: 0; border-left: 1px solid var(--line); background: var(--bg-1); gap: 0">
<div class="tabs" role="tablist" style="padding: 8px 16px 0; height: 56px; align-items: flex-end"><button type="button" role="tab" aria-selected="true" class="tab on">Resumen</button><button type="button" role="tab" aria-selected="false" class="tab">Actividad</button><button type="button" role="tab" aria-selected="false" class="tab">Cambios</button><button type="button" role="tab" aria-selected="false" class="tab">Entorno</button></div>
<div class="col" style="padding: 18px; gap: 22px">
<section class="col" style="gap: 0">
<div class="row" style="padding-bottom: 8px"><span class="t-label grow">Ejecución del flujo</span><a href="DesktopEquipoActividad.html" class="t-xs c-accent">Todas</a></div>
<div class="prop-row"><span class="k" style="width: 104px">Miembro</span><span class="v">{role('QA', 'sm')}QA</span></div>
<div class="prop-row"><span class="k" style="width: 104px">Etapa</span><span class="v">Verificación · En revisión</span></div>
<div class="prop-row"><span class="k" style="width: 104px">Modelo</span><span class="v"><span class="model-tag sonnet">sonnet</span>Sonnet 5</span></div>
<div class="prop-row"><span class="k" style="width: 104px">Estado</span><span class="v"><span class="badge b-bad">{ico('x', 'ico ico-sm')}fallida</span></span></div>
<div class="prop-row"><span class="k" style="width: 104px">Reanudaciones</span><span class="v t-num">2 de 2</span></div>
<div class="prop-row"><span class="k" style="width: 104px">Duración</span><span class="v">2 min 30 s</span></div>
<div class="prop-row"><span class="k" style="width: 104px">Coste</span><span class="v t-num">0,39 US$</span></div>
</section>
<section class="col" style="gap: 0">
<div class="row" style="padding-bottom: 8px"><span class="t-label grow">Tarea</span><a href="DesktopTarea.html" class="t-xs c-accent">Abrir</a></div>
<div class="prop-row"><span class="k" style="width: 104px">Clave</span><span class="v"><span class="wi-key boxed">AGN-26</span></span></div>
<div class="prop-row"><span class="k" style="width: 104px">Estado</span><span class="v">{sico('in_review')}En revisión</span></div>
<div class="prop-row"><span class="k" style="width: 104px">Criterios</span><span class="v"><span class="mono t-xs">5/5</span><span class="wi-crit full"><span class="bar"><i style="width: 100%"></i></span></span></span></div>
<div class="prop-row"><span class="k" style="width: 104px">Ahora</span><span class="v"><span class="badge b-idle">te espera</span><span class="t-xs fg-2">para pasar a Hecho</span></span></div>
</section>
</div>
</aside>
</div>'''
  write('DesktopChatFlujo.html', desktop('Chat de una ejecución fallida', 'chats', '<a href="DesktopChats.html" class="fg-2">Chats</a><span class="fg-3">/</span><span class="mono" style="font-weight: 500">91ab22</span>', main, live=TEAM_LIVE, agents=3, running=3))


def flow_chat_mobile():
  inner = f'''<header class="row" style="flex-shrink: 0; padding: 8px 4px; gap: 2px">
<a href="MobileEquipoActividad.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver">{ico('left', 'ico ico-lg', 'stroke-width: 2')}</a>
<span class="col grow" style="gap: 3px; min-width: 0"><span style="font-weight: 600; font-size: 16px; line-height: 1.3">QA verifica AGN-26: plantillas de proyecto</span><span class="row" style="gap: 6px"><span class="badge b-bad">{ico('x', 'ico ico-sm')}fallida</span><span class="mono t-xs fg-3">2 min 30 s · sonnet</span></span></span>
<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Más acciones">{ico('more', 'ico ico-lg', 'stroke-width: 3')}</button>
</header>
{flow_part_of(True)}
<div class="col" style="flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 12px 16px 0; gap: 14px; font-size: 15px; line-height: 1.6">
<div class="run-fail" role="status">{ico('x')}<div class="col" style="gap: 4px; min-width: 0"><span><b>Esta verificación falló y no movió la tarea.</b> Agentry se reinició tres veces mientras QA verificaba; a la tercera ya no pudo seguir.</span><span class="mono t-xs fg-3">cut off by a restart (restarts: 2 of 2)</span>
<span class="row t-sm" style="gap: 6px; margin-top: 2px">{ico('check', 'ico ico-sm c-ok')}<span>Reintentada hoy: <b class="c-ok">pasó</b> hace 12 min.</span></span>
<div class="acts" style="flex-direction: column"><a href="MobileChat.html" class="btn btn-lg" style="width: 100%">Abrir el chat 7c2e01</a></div></div></div>
<div class="col" style="align-self: flex-end; max-width: 88%; gap: 4px; background: var(--bg-2); border: 1px dashed var(--line-3); border-radius: var(--r-xl) var(--r-xl) var(--r-xs) var(--r-xl); padding: 10px 14px; font-size: 14px; line-height: 1.5"><span class="row t-xs" style="gap: 6px; color: var(--fg-3); font-family: var(--mono)">{ico('flow', 'ico ico-sm')}flujo automático · En revisión → QA</span><span><b>Verifica AGN-26</b>: cada criterio contra <span class="mono">task/agn-26</span>.</span></div>
<div class="row t-xs" style="gap: 8px; font-family: var(--mono); color: var(--fg-3)">{ico('check', 'ico ico-sm c-ok', 'stroke-width: 2.4')}<span>4 herramientas · 1 min 5 s</span></div>
<p style="margin: 0">Criterios 1 a 3 cumplidos. Sigo con el 4.</p>
{restart_line(1, True)}
<p style="margin: 0" class="fg-2">Retomo en el criterio 4: lo compruebo con el test de plantillas.</p>
{restart_line(2, True)}
{restart_line(3, True)}
<div class="row t-sm" style="gap: 8px; color: var(--fg-2)">{ico('x', 'ico ico-sm c-bad')}<span><b class="c-bad" style="font-weight: 600">Falló</b> · se cortó por tercera vez</span></div>
</div>
<div class="m-foot" style="align-items: center"><label class="field field-lg grow"><input type="text" placeholder="Escribe para seguir tú" aria-label="Mensaje" style="font-size: 16px"></label><button type="button" class="btn btn-primary btn-icon btn-lg" aria-label="Enviar" style="flex: 0 0 auto">{ico('send', 'ico ico-lg', 'stroke-width: 2.2')}</button></div>'''
  write('MobileChatFlujo.html', mobile('Chat de una ejecución fallida', inner))


# ---------------------------------------------------------------- the phone board while the team works it
def team_board_mobile():
  # Jumped to En curso: the column over its limit, with the Developer at work, a card QA sent back,
  # one that waits for the person, and En revisión under it with QA verifying and an approval.
  rows_ip = ''.join([
    mrow('AGN-12'),
    mrow('AGN-28', who='DEV', strip=live_strip('DEV', 'Implementando', '4:12', 'pnpm test')),
    mrow('AGN-30'),
    mrow('AGN-35', who='DEV', strip=quote_strip('QA', 'La clave cambia al renombrar; el criterio 2 pide que no.'), lead=[bounce(1)]),
    mrow('AGN-31', who='Y', strip=wait_strip('QA la devolvió tres veces'), lead=[bounce(3)]),
  ])
  rows_ir = ''.join([
    mrow('AGN-29', who='QA', strip=live_strip('QA', 'Verificando', '1:05', 'criterio 2 de 2 · work-items.test.ts')),
    mrow('AGN-26', strip=wait_strip('QA la dio por buena', approve=True).replace('btn btn-sm', 'btn btn-lg')),
  ])
  sel = f'<a href="MobileTableroSeleccion.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Seleccionar para orquestar">{ico("tasks", "ico ico-lg")}</a>'
  inner = f'''{mhead('Tareas', None, 'MobileMas.html', mproject_chip() + sel)}
<div class="m-body stack" style="gap: 12px; margin-bottom: 76px">
{mview_seg('board').replace('MobileTablero.html', 'MobileTableroEquipo.html')}
{mtoolbar()}
<a href="MobileFlujo.html" class="row" style="gap: 8px; min-height: 44px; padding: 0 12px; border-radius: var(--r); background: var(--bg-2); border: 1px solid var(--line); font-size: 13px">{ico('flow', 'ico fg-3')}<span class="grow">Flujo automático <span class="fg-3">·</span> <span class="fg-2">2 a la vez, 2 en cola</span></span><span class="badge">activado</span></a>
{jump('in_progress')}
{msection('in_progress', by_col('in_progress'), rows_html=rows_ip, head_right=role('DEV'))}
{msection('in_review', by_col('in_review'), rows_html=rows_ir, head_right=role('QA'))}
</div>
<a href="MobileNuevaTarea.html" class="fab" aria-label="Nueva tarea" style="padding: 0; width: 56px">{ico('plus', 'ico ico-lg', 'stroke-width: 2.2')}</a>
{tabbar('more')}'''
  write('MobileTableroEquipo.html', mobile('Tablero con equipo', inner, 'has-fab'))


# ---------------------------------------------------------------- DSTablero: the board's spec page
SKELETONS = ('<div class="wi-card skeleton-card" aria-hidden="true"><span class="skeleton" style="width: 40%"></span><span class="skeleton" style="width: 85%"></span></div>'
             '<div class="wi-card skeleton-card" aria-hidden="true"><span class="skeleton" style="width: 35%"></span><span class="skeleton" style="width: 70%"></span></div>')
YOU_HEAD = '<span class="proj monogram wi-assignee" style="--hue: 24" role="img" aria-label="Tú apruebas el paso a Hecho" title="Tú apruebas el paso a Hecho">Y</span>'


def ds_board():
  def principle(n, title, text):
    return f'<div class="card col" style="padding: 18px; gap: 8px"><span class="mono t-xs fg-3">{n}</span><h2 class="t-h2">{title}</h2><p class="t-sm fg-2" style="margin: 0; line-height: 1.5">{text}</p></div>'

  def cell(title, note, body):
    return f'<div class="col" style="gap: 8px"><span class="t-sm" style="font-weight: 600">{title}</span><span class="t-xs fg-3" style="line-height: 1.45; min-height: 32px">{note}</span>{body}</div>'

  anat = card('AGN-35', who='DEV', strip=quote_strip('QA', 'La clave cambia al renombrar; el criterio 2 pide que no.'), lead_facts=[bounce(1)], comments=1)
  rows = [('1', 'Qué es', 'Tipo, clave y prioridad. La prioridad es una marca neutra; solo Urgente lleva color.'),
          ('2', 'Título', 'Hasta tres líneas, sin cortar a mitad de palabra.'),
          ('3', 'Dónde va', 'La épica, sin caja, y las etiquetas con #. En Todos los proyectos, el proyecto delante.'),
          ('4', 'Hechos', 'Rebotes, criterios, bloqueos y comentarios, y al final quién la lleva, salvo que la franja ya lo diga.'),
          ('5', 'La franja', 'Qué pasa ahora, empezando por quién. Una sola por tarjeta, y ninguna si no pasa nada.')]
  legend = ''.join(f'<div class="row" style="gap: 12px; align-items: flex-start; padding: 10px 0; border-top: 1px solid var(--line)"><span class="count-pill" style="margin-top: 1px">{n}</span><span class="col" style="gap: 2px"><span class="t-sm" style="font-weight: 600">{t}</span><span class="t-sm fg-2" style="line-height: 1.45">{d}</span></span></div>' for n, t, d in rows)
  strips = [
    ('Un rol trabaja', 'El squircle del rol y el verbo de su etapa: Refinando, Implementando o Verificando.', card('AGN-28', who='DEV', strip=live_strip('DEV', 'Implementando', '4:12', 'pnpm test'))),
    ('Tu chat trabaja', 'Tu monograma redondo y lo que hace el chat que abrió «Trabajar en ella».', card('AGN-28')),
    ('Una orquestación', 'Su glifo, el nodo y el progreso del grafo.', card('AGN-30')),
    ('En cola', 'Neutra: espera sitio bajo el límite de ejecuciones a la vez.', card('AGN-45', who='PO', strip=queue_strip('PO', 'En cola: la refinará cuando quede sitio'))),
    ('Te espera', 'Le toca a la persona: QA la dio por buena y solo tú la pasas a Hecho.', card('AGN-26', strip=wait_strip('QA la dio por buena', approve=True))),
    ('Devuelta', 'Neutra: la cita de QA y el rebote en los hechos. No es un fallo. Si además espera sitio, manda la cita; la cola está en Actividad.', card('AGN-35', who='DEV', strip=quote_strip('QA', 'La clave cambia al renombrar; el criterio 2 pide que no.'), lead_facts=[bounce(1)])),
    ('Falló', 'La etapa y el motivo en palabras, con el color de fallo. La tarea no se movió.', card('AGN-36', who='PO', strip=fail_strip('PO', 'al comprobarla', 'ninguna cuenta tenía cupo'))),
    ('Hecha', 'Solo tipo, clave y título: lo hecho no pide atención.', card('AGN-24')),
  ]
  strip_grid = ''.join(cell(t, n, c) for t, n, c in strips)
  cols = [
    ('Normal', 'La cuenta deja fuera la épica: agrupa y no cuenta.', col('todo', by_col('todo'), cards=card('AGN-39') + card('AGN-47'), role_head=role('PO'))),
    ('Sobre el límite', 'Avisa y nunca bloquea: un filo y la frase en el color de aviso. Se puede soltar igual.', col('in_progress', by_col('in_progress'), cards=card('AGN-12') + card('AGN-31', who='Y', strip=wait_strip('QA la devolvió tres veces'), lead_facts=[bounce(3)]), role_head=role('DEV'))),
    ('Hecho, paginada', '«Mostrar N más» carga la página siguiente en su sitio.', col('done', by_col('done'), cards=card('AGN-24') + card('AGN-22'), role_head=YOU_HEAD)),
    ('Mientras llega', 'Dos esqueletos ocupan el sitio de la página que llega.', col('done', by_col('done'), cards=card('AGN-24') + card('AGN-22') + SKELETONS, more=0, role_head=YOU_HEAD)),
  ]
  col_grid = ''.join(cell(t, n, c) for t, n, c in cols)
  pr = ''.join(f'<span class="row" style="gap: 8px">{prio(p)}<span class="t-sm fg-2">{w}</span></span>' for p, w in [('low', 'Baja'), ('medium', 'Media'), ('high', 'Alta'), ('urgent', 'Urgente')])
  colors = [('live', 'b-live', 'en marcha', 'Algo trabaja ahora: franja, raíl y giro. Es lo único que se mueve.'),
            ('ok', 'b-ok', 'pasó', 'Una ejecución o un criterio que terminó bien.'),
            ('warn', 'b-warn', 'sobre el límite', 'Una columna pasada de su límite.'),
            ('bad', 'b-bad', 'fallida', 'Una ejecución que falló. Nunca una tarea devuelta.'),
            ('idle', 'b-idle', 'te espera', 'Le toca a la persona.')]
  ctab = ''.join(f'<div class="row" style="gap: 12px; min-height: 40px; border-top: 1px solid var(--line)"><span class="mono t-xs fg-3" style="width: 44px">{k}</span><span class="badge {b}" style="min-width: 118px; justify-content: center">{w}</span><span class="t-sm fg-2">{d}</span></div>' for k, b, w, d in colors)
  phone_rows = mrow('AGN-28', who='DEV', strip=live_strip('DEV', 'Implementando', '4:12', 'pnpm test')) + mrow('AGN-31', who='Y', strip=wait_strip('QA la devolvió tres veces'), lead=[bounce(3)])
  phone = (f'<div class="app m-screen" data-theme="dark" style="width: 390px; height: auto; border-radius: var(--r-xl); border: 1px solid var(--line-2); overflow: hidden; padding: 14px 0 16px">'
           f'<div class="m-body stack" style="gap: 12px; overflow: visible">{jump("in_progress")}{msection("in_progress", by_col("in_progress"), rows_html=phone_rows, head_right=role("DEV"))}</div></div>')
  head = ('<header class="col" style="gap: 8px"><span class="t-label">Agentry design system · ecosistema · tablero</span><h1 class="t-display" style="margin: 0">Tablero y tareas</h1>'
          '<p class="fg-2" style="margin: 0; max-width: 900px; line-height: 1.55">Cinco columnas fijas, una tarjeta que se lee de arriba abajo y una franja al pie que dice qué pasa ahora y quién lo hace. '
          'Sin fechas, estimaciones ni sprints: el tablero cuenta el trabajo, no el calendario.</p></header>')
  principles = ''.join([
    principle('01', 'Cinco columnas fijas', 'Backlog, Por hacer, En curso, En revisión y Hecho. Un solo nivel: la épica agrupa tareas y no cuenta como abierta ni en los límites.'),
    principle('02', 'Pasarse del límite avisa', 'Una columna sobre su límite lleva un filo y la frase «Sobre el límite: 4 de 3» en el color de aviso. Nunca impide soltar una tarjeta.'),
    principle('03', 'Una franja, un actor', 'Lo que pasa ahora va al pie, empezando por quién: el squircle de un rol, tu monograma redondo o el glifo de una orquestación.'),
    principle('04', 'Hecho es tuyo', 'Ningún agente mueve una tarea a Hecho. Cuando QA la da por buena, la franja dice «te espera» y ofrece aprobarla.'),
  ])
  body = f'''<div class="app col" data-theme="dark" style="width: 1440px; height: 2300px; padding: 56px 64px; gap: 40px; overflow: hidden">
{head}
<section style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px">{principles}</section>
<section style="display: grid; grid-template-columns: 272px minmax(0, 1fr) 390px; gap: 40px; align-items: start">
<div class="col" style="gap: 12px"><span class="t-label">Anatomía</span>{anat}</div>
<div class="col" style="gap: 0; padding-top: 26px">{legend}</div>
<div class="col" style="gap: 12px"><span class="t-label">Móvil: secciones y selector de salto</span>{phone}</div>
</section>
<section class="col" style="gap: 14px"><span class="t-label">La franja</span>
<div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 24px 20px; align-items: start">{strip_grid}</div></section>
<section class="col" style="gap: 14px"><span class="t-label">Columnas</span>
<div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 20px; align-items: start">{col_grid}</div></section>
<section style="display: grid; grid-template-columns: 1fr 1.6fr; gap: 20px; align-items: start">
<div class="card col" style="padding: 18px; gap: 12px"><span class="t-label">La prioridad no es un estado</span><div class="row" style="gap: 20px; flex-wrap: wrap">{pr}</div><p class="t-sm fg-2" style="margin: 0; line-height: 1.5">Tres alturas de barra en tinta neutra. Solo Urgente lleva color, el del acento, con un «!». La prioridad nunca usa verde, ámbar ni rojo.</p></div>
<div class="card col" style="padding: 18px; gap: 4px"><span class="t-label" style="padding-bottom: 8px">Un color, un significado, siempre con palabra</span>{ctab}</div>
</section>
</div>'''
  write('DSTablero.html', page('Design system · Tablero y tareas', body))


if __name__ == '__main__':
  team_activity_desktop(); team_activity_mobile()
  flow_chat_desktop(); flow_chat_mobile()
  team_board_mobile()
  ds_board()
