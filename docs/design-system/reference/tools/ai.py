# The assistant, suggestion and resources-with-AI prototypes (proto-ai).
from data import *
from board import head as board_head, toolbar as board_toolbar, mhead
from projects import proj_head, proj_tabs

P.update({
  'agent': 'M4 17l6-5-6-5M12 19h8',
  'skill': 'M13 3 5 14h6l-1 7 8-11h-6z',
  'command': 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM14 8l-4 8',
  'file': 'M6 3h8l4 4v14H6zM14 3v4h4',
  'wait': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  'info': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  'undo': 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  'refresh': 'M20 11a8 8 0 0 0-14.7-4.3L4 8M4 4v4h4M4 13a8 8 0 0 0 14.7 4.3L20 16M20 20v-4h-4',
  'dash-circle': 'M12 3a9 9 0 0 1 0 18M12 21a9 9 0 0 1 0-18',
})

KIND = {'agent': ('agent', 'Agente', 'agentes'), 'skill': ('skill', 'Skill', 'skills'), 'command': ('command', 'Comando', 'comandos')}


def mark(sm=False):
  return f'<span class="ai-mark{" sm" if sm else ""}" aria-hidden="true">{ico("sparkle")}</span>'


def facts(*items):
  return f'<div class="ai-facts">{"".join(items)}</div>'


def f(txt, cls=''):
  return f'<span class="{cls}">{txt}</span>' if cls else f'<span>{txt}</span>'


def chat_link(cid):
  return f'<a href="DesktopChat.html">chat {cid}</a>'


def live_verb(verb, detail, t=None):
  tt = f'<span class="grow"></span><span class="mono t-xs fg-3">{t}</span>' if t else ''
  return f'<div class="ai-run-now"><span class="spin-braille"></span><span class="c-live">{verb}</span><span class="mono ellipsis">{detail}</span>{tt}</div>'


# ---------------------------------------------------------------- the project assistant

READ = [
  ('done', 'file', '<span class="path">README.md</span>', '142 líneas'),
  ('done', 'file', '<span class="path">package.json</span> y <span class="path">pnpm-workspace.yaml</span>', '2 archivos'),
  ('done', 'chats', 'Los chats de Claude Code en este directorio', '23 chats'),
  ('done', 'docs', '<span class="path">docs/</span>', '9 documentos'),
  ('done', 'file', '<span class="path">CLAUDE.md</span>', 'no existe'),
  ('now', None, '<span class="path">src/</span>', '31 de 48'),
  ('todo', 'git', 'El historial de git', 'después'),
]


def steps_html(items):
  out = []
  for st, icon, txt, n in items:
    lead = '<span class="spin-braille" role="img" aria-label="Leyendo"></span>' if st == 'now' else (ico('check') if st == 'done' else ico('dash-circle'))
    out.append(f'<div class="ai-step{"" if st == "done" else " " + st}">{lead}<span class="ellipsis">{txt}</span><span class="n">{n}</span></div>')
  return f'<div class="ai-steps">{"".join(out)}</div>'


FOUND = ['TypeScript', 'Fastify', 'Stripe', 'PostgreSQL', 'Drizzle', 'Vitest', 'pnpm', 'sin CI']


def found_html():
  return f'<div class="ai-found">{"".join(label(x) for x in FOUND)}</div>'


ASSIST_LIVE = '''<div class="col" style="gap: 4px">
<div class="row" style="padding: 0 10px 4px"><span class="t-label grow">En directo</span><span class="count-pill live">3</span></div>
<a href="DesktopAsistente.html" class="list-row rail-live" style="padding: 8px 10px 8px 14px; flex-direction: column; align-items: stretch; gap: 3px">
<span class="row" style="gap: 7px"><span class="spin-braille"></span><span class="t-sm ellipsis" style="font-weight: 500">Asistente de pagos-api</span></span>
<span class="row t-xs" style="gap: 6px; padding-left: 15px"><span class="c-live">Leyendo</span><span class="mono fg-3 ellipsis grow">src/webhooks</span><span class="mono fg-3">0:41</span></span>
</a>
<a href="DesktopChatTarea.html" class="list-row rail-live" style="padding: 8px 10px 8px 14px; flex-direction: column; align-items: stretch; gap: 3px">
<span class="row" style="gap: 7px"><span class="spin-braille"></span><span class="t-sm ellipsis" style="font-weight: 500">Trabaja en AGN-28: tablero con columnas fijas</span></span>
<span class="row t-xs" style="gap: 6px; padding-left: 15px"><span class="c-live">Ejecutando</span><span class="mono fg-3 ellipsis grow">pnpm test</span><span class="mono fg-3">4:12</span></span>
</a>
<a href="DesktopOrquestacion.html" class="list-row rail-live" style="padding: 8px 10px 8px 14px; flex-direction: column; align-items: stretch; gap: 6px">
<span class="row" style="gap: 7px"><span class="spin-braille"></span><span class="t-sm ellipsis grow" style="font-weight: 500">ecosystem-foundation</span><span class="mono t-xs fg-3">2/9</span></span>
<span class="segbar" style="height: 4px; margin-left: 15px"><i class="ok"></i><i class="ok"></i><i class="live" style="--p: 55%"></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
</a>
</div>'''


def assist_head(sub, right):
  return f'''<div class="page-head" style="align-items: center">
<div class="row" style="gap: 14px"><a href="DesktopNuevoProyecto.html" class="btn btn-icon" aria-label="Volver">{ico('left')}</a>
<span class="proj monogram" style="--hue: 150; width: 40px; height: 40px; border-radius: var(--r-lg); font-size: 13px">PA</span>
<div class="col" style="gap: 4px"><h1 class="t-h1">Asistente de proyecto</h1><p class="fg-2 t-sm" style="margin: 0">{sub}</p></div></div>
<div class="row" style="gap: 8px">{right}</div>
</div>'''


def wait_card(icon, title, note):
  return f'''<section class="card" aria-label="{title}">
<div class="card-head">{ico(icon, 'ico fg-3')}<h2 class="t-h2 grow">{title}</h2><span class="mono t-xs fg-3">en espera</span></div>
<div class="sug-wait">{ico('wait')}{note}</div>
</section>'''


def assistant_live_desktop():
  run = f'''<section class="ai-run live energy" aria-label="Sugerencia en curso">
<div class="ai-run-head">{mark()}<div class="col grow" style="gap: 3px; min-width: 0"><h2 class="ai-run-title">Leyendo el repositorio</h2>{live_verb('Leyendo', 'src/webhooks/stripe.ts')}</div><span class="mono t-sm fg-2 t-num">0:41</span><button type="button" class="btn btn-sm">{ico('x', 'ico ico-sm')}Detener</button></div>
{facts(f('Sonnet 5'), f('0,03 US$ hasta ahora', 'cost'), chat_link('4e1f09'), f('--json-schema'))}
<hr class="divider">
<div class="col" style="gap: 6px"><span class="t-label">Lo que ha leído</span>{steps_html(READ)}</div>
<div class="col" style="gap: 8px"><span class="t-label">Lo que ha encontrado</span>{found_html()}</div>
</section>'''
  right = f'''<div class="col" style="gap: 12px">
{wait_card('team', 'Equipo', 'Propondrá los roles que necesita pagos-api')}
{wait_card('resources', 'Recursos', 'Agentes, skills y comandos para este repositorio')}
{wait_card('tasks', 'Primeras tareas', 'Lo que falta, con el porqué de cada una')}
<div class="callout">{ico('info', 'ico fg-3')}<span>Es un chat del CLI con <code>--json-schema</code>: su coste cuenta en Uso y en la barra de estado, como el de cualquier chat. Si no hubiera nada que leer, te ofrecería el equipo de la plantilla.</span></div>
</div>'''
  main = f'''<main class="page" style="gap: 20px">
{assist_head('pagos-api · lee el repositorio y te propone el equipo, los recursos y las primeras tareas. Nada se escribe hasta que lo aceptes.', '<a href="DesktopProyecto.html" class="btn btn-ghost">Omitir por ahora</a><button type="button" class="btn btn-primary" disabled>' + ico('right') + 'Ir al proyecto</button>')}
<div style="display: grid; grid-template-columns: 1.25fr 1fr; gap: 16px; align-items: start">
{run}
{right}
</div>
</main>'''
  crumb = pcrumb('pagos-api', ('Asistente', ''))
  html = desktop('Asistente de proyecto', 'projects', crumb, main, project='pagos-api', live=ASSIST_LIVE, agents=3, running=3)
  write('DesktopAsistente.html', html)


TASKS = [
  dict(st='accepted', t='story', title='Verificar la firma de los webhooks de Stripe', p='high', labels=['webhooks'], key='PAG-1',
       why='<span class="mono">src/webhooks/stripe.ts</span> lee el cuerpo sin comprobar la cabecera <span class="mono">Stripe-Signature</span>.'),
  dict(st='accepted', t='bug', title='Los reembolsos parciales se guardan como totales', p='urgent', labels=['pagos'], key='PAG-2',
       why='Tres de los 23 chats hablan de este fallo y ningún test lo cubre.'),
  dict(st='pending', t='story', title='Idempotencia en POST /payments', p='high', labels=['api'],
       why='Un reintento del cliente puede cobrar dos veces: la ruta no acepta <span class="mono">Idempotency-Key</span>.'),
  dict(st='discarded', t='epic', title='Panel de administración', p='medium'),
  dict(st='pending', t='task', title='CI con pnpm test y typecheck', p='medium', labels=['ci'],
       why='No hay ningún workflow en <span class="mono">.github/</span>, y los tests ya existen.'),
  dict(st='pending', t='task', title='Escribir CLAUDE.md con las convenciones', p='low', labels=['docs'],
       why='No existe, y los chats repiten las mismas instrucciones sobre Drizzle y los tests.'),
]


def prio_word(p):
  return f'<span class="row" style="gap: 5px">{prio(p)}{PRIO_WORD[p]}</span>'


def task_meta(x):
  bits = [f'<span class="row" style="gap: 5px">{tico(x["t"])}{TYPE_WORD[x["t"]]}</span>', prio_word(x['p'])]
  if x.get('epic'): bits.append(epic(x['epic']))
  for l in x.get('labels', []): bits.append(label(l))
  if x.get('like'): bits.append(f'<span class="sug-like">{ico("copy", "ico ico-sm")}Parecida a <span class="wi-key">{x["like"]}</span></span>')
  return f'<div class="sug-meta">{"".join(bits)}</div>'


def accept_btns(sm=True, what='la tarea'):
  s = ' btn-sm' if sm else ' btn-lg'
  return f'<button type="button" class="btn btn-ghost{s}" aria-label="Descartar {what}">{ico("x", "ico ico-sm")}Descartar</button><button type="button" class="btn{s}" aria-label="Aceptar {what}">{ico("check", "ico ico-sm")}Aceptar</button>'


def discarded_acts():
  return '<span class="t-xs fg-3">Descartada</span><button type="button" class="btn btn-ghost btn-sm">' + ico('undo', 'ico ico-sm') + 'Deshacer</button>'


def task_row(x):
  st = x['st']
  if st == 'accepted':
    acts = f'<span class="sug-done">{ico("check", "ico ico-sm")}creada · <a href="DesktopTarea.html" class="wi-key boxed">{x["key"]}</a></span>'
  elif st == 'discarded':
    acts = discarded_acts()
  else:
    acts = accept_btns()
  reason = f'<p class="sug-reason">{x["why"]}</p>' if x.get('why') else ''
  return f'''<div class="sug-row{" " + st if st != "pending" else ""}">
<div class="sug-main"><span class="sug-title">{x['title']}</span>{task_meta(x)}{reason}</div>
<div class="sug-acts">{acts}</div>
</div>'''


TEAM = [
  dict(st='accepted', ab='PO', hue=300, role='Product Owner', model='opus', writes='nada, solo tareas'),
  dict(st='accepted', ab='AR', hue=215, role='Arquitecto', model='opus', writes='docs/'),
  dict(st='accepted', ab='DEV', hue=90, role='Desarrollador', model='sonnet', writes='src/, tests/'),
  dict(st='pending', ab='QA', hue=330, role='QA', model='sonnet', writes='tests/'),
  dict(st='pending', ab='SEG', hue=160, role='Seguridad de pagos', model='sonnet', writes='nada', extra=True),
]


def team_row(x):
  if x['st'] == 'accepted':
    acts = f'<span class="sug-done">{ico("check", "ico ico-sm")}añadido</span>'
  else:
    acts = accept_btns(what=x['role'])
  tag = '<span class="badge">fuera de la plantilla</span>' if x.get('extra') else ''
  return f'''<div class="sug-row{" accepted" if x["st"] == "accepted" else ""}" style="align-items: center; padding: 10px 14px">
<span class="role-av" style="--hue: {x['hue']}" role="img" aria-label="{x['role']}" title="{x['role']}">{x['ab']}</span>
<div class="sug-main" style="gap: 2px"><span class="sug-title">{x['role']}{tag}</span><div class="sug-meta"><span class="model-tag{' opus' if x['model'] == 'opus' else ''}">{x['model']}</span><span>·</span><span>escribe: <span class="mono">{x['writes']}</span></span></div></div>
<div class="sug-acts">{acts}</div>
</div>'''


RES = [
  dict(st='accepted', k='skill', name='stripe-webhooks', saved='.claude/skills/stripe-webhooks/',
       desc='Cómo verificar, reintentar y probar un webhook de Stripe.'),
  dict(st='pending', k='agent', name='payments-reviewer', desc='Revisa cada cambio que toca dinero: redondeos, divisas y reembolsos.',
       why='Los importes se guardan en céntimos en unos sitios y en euros en otros.'),
  dict(st='pending', k='command', name='/migrate', desc='Genera y aplica una migración de Drizzle, y la revierte si falla.',
       why='Los chats lanzan las mismas tres órdenes de Drizzle a mano.'),
]


def kind_ico(k):
  icon, word, _ = KIND[k]
  return f'<span class="link-ico" role="img" aria-label="{word}">{ico(icon)}</span>'


def res_row(x, href='DesktopRecursoPropuesta.html', compact=False):
  icon, word, _ = KIND[x['k']]
  if x['st'] == 'accepted':
    acts = f'<span class="sug-done">{ico("check", "ico ico-sm")}guardada</span>'
  else:
    acts = f'<button type="button" class="btn btn-ghost btn-sm" aria-label="Descartar {x["name"]}">{ico("x", "ico ico-sm")}Descartar</button><a href="{href}" class="btn btn-sm">{ico("edit", "ico ico-sm")}Revisar</a>'
  where = x.get('saved') or ('.claude/' + ('agents/' + x['name'] + '.md' if x['k'] == 'agent' else ('commands/' + x['name'][1:] + '.md' if x['k'] == 'command' else 'skills/' + x['name'] + '/')))
  reason = f'<p class="sug-reason">{x["why"]}</p>' if x.get('why') else ''
  if compact:
    body = reason or f'<span class="t-sm fg-2" style="line-height: 1.45">{x["desc"]}</span>'
  else:
    body = f'<span class="t-sm fg-2" style="line-height: 1.45">{x["desc"]}</span><div class="sug-meta"><span>proyecto</span><span>·</span><span class="mono">{where}</span></div>{reason}'
  return f'''<div class="sug-row{" accepted" if x["st"] == "accepted" else ""}">
{kind_ico(x['k'])}
<div class="sug-main"><span class="sug-title"><span class="mono">{x['name']}</span><span class="badge">{word}</span></span>{body}</div>
<div class="sug-acts">{acts}</div>
</div>'''


def assistant_done_desktop():
  run = f'''<section class="ai-run done" aria-label="Sugerencia completada">{mark(True)}<span class="t-sm"><b style="font-weight: 600">14 propuestas</b> <span class="fg-2">después de leer 61 archivos, 23 chats y <span class="mono">docs/</span></span></span><span class="grow"></span>{facts(f('Sonnet 5'), f('1 min 12 s'), f('0,08 US$', 'cost'), chat_link('4e1f09'))}<button type="button" class="btn btn-ghost btn-sm">Ver lo que ha leído</button></section>'''
  tasks = f'''<section class="card grad-border" aria-label="Primeras tareas">
<div class="card-head">{ico('tasks', 'ico fg-3')}<h2 class="t-h2" style="white-space: nowrap">Primeras tareas</h2><span class="mono t-xs fg-3 grow">2 de 6 aceptadas · a Backlog</span></div>
{''.join(task_row(x) for x in TASKS)}
</section>'''
  team = f'''<section class="card" aria-label="Equipo">
<div class="card-head">{ico('team', 'ico fg-3')}<h2 class="t-h2">Equipo</h2><span class="mono t-xs fg-3 grow">3 de 5 aceptados</span><span class="t-xs fg-3">de Software profesional</span></div>
{''.join(team_row(x) for x in TEAM)}
</section>'''
  res = f'''<section class="card" aria-label="Recursos">
<div class="card-head">{ico('resources', 'ico fg-3')}<h2 class="t-h2">Recursos</h2><span class="mono t-xs fg-3 grow">1 de 3 guardados</span><span class="t-xs fg-3">se revisan en el editor</span></div>
{''.join(res_row(x, compact=True) for x in RES)}
</section>'''
  main = f'''<main class="page" style="gap: 16px">
{assist_head('pagos-api · acepta o descarta cada propuesta. Nada se escribe hasta que la aceptes.', '<button type="button" class="btn">' + ico('refresh') + 'Volver a sugerir</button><a href="DesktopProyecto.html" class="btn btn-primary">' + ico('right') + 'Ir al proyecto</a>')}
{run}
<div style="display: grid; grid-template-columns: 1.15fr 1fr; gap: 14px; align-items: start">
{tasks}
<div class="col" style="gap: 14px">{team}{res}</div>
</div>
</main>'''
  crumb = pcrumb('pagos-api', ('Asistente', ''))
  write('DesktopAsistentePropuestas.html', desktop('Propuestas del asistente', 'projects', crumb, main, project='pagos-api'))


def mhead_proj(title, back, right=''):
  return f'''<header class="row" style="flex-shrink: 0; padding: 8px 4px; gap: 4px; min-height: 60px">
<a href="{back}" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver">{ico('left', 'ico ico-lg', 'stroke-width: 2')}</a>
<span class="col grow" style="gap: 1px; min-width: 0; padding-left: 2px"><h1 class="t-h1" style="font-size: 24px">{title}</h1><span class="mono t-xs fg-3 ellipsis">pagos-api · PAG</span></span>
{right}
</header>'''


def assistant_live_mobile():
  items = [READ[0], READ[2], READ[3], READ[4], READ[5], READ[6]]
  inner = f'''{mhead_proj('Asistente de proyecto', 'MobileNuevoProyecto.html')}
<div class="m-body stack" style="gap: 14px">
<section class="ai-run live energy" aria-label="Sugerencia en curso" style="padding: 14px">
<div class="ai-run-head">{mark()}<div class="col grow" style="gap: 3px; min-width: 0"><h2 class="ai-run-title">Leyendo el repositorio</h2>{live_verb('Leyendo', 'src/webhooks/stripe.ts', '0:41')}</div></div>
{facts(f('Sonnet 5'), f('0,03 US$ hasta ahora', 'cost'), f('chat 4e1f09'))}
<hr class="divider">
{steps_html(items).replace('<span class="ellipsis">', '<span>')}
{found_html()}
</section>
<div class="row" style="padding: 0 4px"><span class="t-label grow">Después de leer</span></div>
<div class="card" style="overflow: hidden">
<div class="cell fg-3">{ico('team', 'ico ico-lg')}<span class="grow" style="color: var(--fg-2); font-weight: 500">Equipo</span><span class="row mono t-xs" style="gap: 5px">{ico('wait', 'ico ico-sm')}en espera</span></div>
<div class="cell fg-3">{ico('resources', 'ico ico-lg')}<span class="grow" style="color: var(--fg-2); font-weight: 500">Recursos</span><span class="row mono t-xs" style="gap: 5px">{ico('wait', 'ico ico-sm')}en espera</span></div>
<div class="cell fg-3">{ico('tasks', 'ico ico-lg')}<span class="grow" style="color: var(--fg-2); font-weight: 500">Primeras tareas</span><span class="row mono t-xs" style="gap: 5px">{ico('wait', 'ico ico-sm')}en espera</span></div>
</div>
<p class="t-xs fg-3" style="margin: 0; padding: 0 4px; line-height: 1.5">Nada se escribe hasta que lo aceptes. El coste cuenta en Uso, como el de cualquier chat.</p>
</div>
<div class="m-foot"><button type="button" class="btn btn-lg">{ico('x', 'ico ico-lg')}Detener</button><a href="MobileProyecto.html" class="btn btn-lg btn-ghost">Omitir por ahora</a></div>'''
  write('MobileAsistente.html', mobile('Asistente de proyecto', inner))


def msug_task(x):
  st = x['st']
  if st == 'accepted':
    acts = f'<div class="row"><span class="sug-done">{ico("check", "ico ico-sm")}creada · <span class="wi-key boxed">{x["key"]}</span></span></div>'
  elif st == 'discarded':
    acts = f'<div class="row" style="gap: 8px"><span class="t-xs fg-3 grow">Descartada</span><button type="button" class="btn btn-ghost btn-lg" style="height: 44px">{ico("undo", "ico ico-sm")}Deshacer</button></div>'
  else:
    acts = f'<div class="sug-acts">{accept_btns(False)}</div>'
  reason = f'<p class="sug-reason" style="font-size: 14px">{x["why"]}</p>' if x.get('why') and st != 'discarded' else ''
  meta = task_meta(x) if st != 'discarded' else ''
  title_style = 'font-size: 15px' + ('; color: var(--fg-3); text-decoration: line-through; text-decoration-color: var(--line-3)' if st == 'discarded' else '')
  return f'<div class="sug-card"><span class="sug-title" style="{title_style}">{x["title"]}</span>{meta}{reason}{acts}</div>'


def mprop_seg(on):
  # The three kinds of proposal, each a screen of its own on a phone
  items = [('tasks', 'MobileAsistentePropuestas.html', 'Tareas', 6), ('team', 'MobileAsistenteEquipo.html', 'Equipo', 5), ('res', 'MobileAsistenteRecursos.html', 'Recursos', 3)]
  out = ''.join(f'<a href="{h}" role="tab" aria-selected="{"true" if k == on else "false"}" class="{"on" if k == on else ""}" style="flex: 1 1 0; justify-content: center">{n} <span class="count">{c}</span></a>' for k, h, n, c in items)
  return f'<div class="seg" role="tablist" aria-label="Propuestas" style="display: flex">{out}</div>'


def assistant_done_mobile():
  seg = mprop_seg('tasks')
  order = [TASKS[2], TASKS[0], TASKS[3], TASKS[4]]
  inner = f'''{mhead_proj('Asistente de proyecto', 'MobileNuevoProyecto.html', '<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Más acciones">' + ico('more', 'ico ico-lg', 'stroke-width: 3') + '</button>')}
<div class="m-body stack" style="gap: 12px">
<section class="ai-run done" aria-label="Sugerencia completada" style="flex-direction: column; align-items: stretch; gap: 6px"><span class="row t-sm" style="gap: 10px">{mark(True)}<span><b style="font-weight: 600">14 propuestas</b> <span class="fg-2">de 61 archivos y 23 chats</span></span></span>{facts(f('Sonnet 5'), f('1 min 12 s'), f('0,08 US$', 'cost'), f('chat 4e1f09'))}</section>
{seg}
<div class="row" style="padding: 0 4px; gap: 8px"><span class="t-label grow">2 de 6 aceptadas · a Backlog</span></div>
<div class="card grad-border" style="overflow: hidden">{''.join(msug_task(x) for x in order)}</div>
</div>
<div class="m-foot"><a href="MobileProyecto.html" class="btn btn-primary btn-lg">{ico('right', 'ico ico-lg')}Ir al proyecto</a></div>'''
  write('MobileAsistentePropuestas.html', mobile('Propuestas del asistente', inner))


# ---------------------------------------------------------------- suggest tasks (from the board)

SUGG = [
  dict(on=True, t='story', title='Deshacer el último movimiento de una tarjeta', p='medium', epic='eco',
       why='El plan hace que la persona gane siempre a un movimiento automático, pero no hay forma de deshacer uno propio.'),
  dict(on=True, t='bug', title='El límite por columna no se valida al importar un proyecto', p='high', epic='eco', labels=['core'],
       why='<span class="mono">PUT /projects/:id/settings</span> valida el límite, <span class="mono">POST /projects/import</span> no.'),
  dict(on=True, t='task', title='Spec e2e del tablero en el móvil', p='medium', labels=['e2e'],
       why='<span class="mono">MobileTablero</span> no tiene spec; el del tablero solo cubre el escritorio.'),
  dict(on=False, t='story', title='Filtrar la lista por hito', p='low', like='AGN-45',
       why='Los hitos existen, pero la lista solo filtra por épica.'),
  dict(on=False, t='task', title='Documentar la clave por proyecto', p='low', labels=['docs'],
       why='<span class="mono">docs/work-items.md</span> no dice cómo se deriva el prefijo.'),
  dict(on=False, t='bug', title='El FAB tapa la barra de selección en el iPhone SE', p='medium', epic='mob', like='AGN-38',
       why='Los dos flotan a 16 px del borde inferior.'),
]


def sugg_row(x):
  chk = f'<span class="checkbox{" on" if x["on"] else ""}" role="checkbox" aria-checked="{"true" if x["on"] else "false"}" aria-label="Incluir {x["title"]}"></span>'
  return f'''<label class="sug-row" style="cursor: pointer">{chk}
<div class="sug-main"><span class="sug-title">{x['title']}</span>{task_meta(x)}<p class="sug-reason">{x['why']}</p></div>
</label>'''


def suggest_desktop():
  cols = ''.join(col(s, by_col(s)) for s, _ in COLS)
  hd = board_head('claude-wrapper · 15 abiertas · clave <span class="mono">AGN</span>', primary=False)
  hd = hd.replace('<a href="DesktopNuevaTarea.html"', '<button type="button" class="btn" aria-pressed="true">' + ico('sparkle') + 'Sugerir tareas</button><a href="DesktopNuevaTarea.html"')
  main = f'''<main class="page" style="gap: 16px; position: relative">
{hd}
{board_toolbar()}
<div class="wi-board">{cols}</div>
</main>'''
  dialog = f'''<div class="scrim">
<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="st-title" style="width: 780px; max-height: calc(100% - 48px)">
<div class="dialog-head">{mark(True)}<h2 id="st-title" class="t-h2 grow">Sugerir tareas</h2><span class="mono t-xs fg-3">claude-wrapper · se crean en Backlog</span><button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Cerrar">{ico('x')}</button></div>
<div class="dialog-body" style="gap: 14px">
<div class="row" style="gap: 8px"><label class="field grow">{ico('search')}<input value="lo que falta para cerrar v0.20" aria-label="Qué buscar (opcional)"></label><button type="button" class="btn">{ico('refresh')}Volver a sugerir</button></div>
<section class="ai-run done" aria-label="Sugerencia completada" style="background: var(--bg-1)">{ico('check', 'ico fg-3')}<span class="t-sm"><b style="font-weight: 600">6 propuestas</b> <span class="fg-2">del tablero, <span class="mono">docs/plans/</span> y los últimos 20 commits</span></span><span class="grow"></span>{facts(f('Sonnet 5'), f('48 s'), f('0,06 US$', 'cost'), chat_link('7c2e1a'))}</section>
<div class="card" style="overflow: hidden; box-shadow: none">{''.join(sugg_row(x) for x in SUGG)}</div>
<span class="form-hint" style="margin-top: -4px">Las parecidas a una tarea que ya existe empiezan sin marcar.</span>
</div>
<div class="dialog-foot"><span class="t-sm" style="white-space: nowrap"><b class="t-num">3</b> <span class="fg-2">de 6 seleccionadas</span></span><span class="grow"></span><button type="button" class="btn btn-ghost">Cancelar</button><button type="button" class="btn btn-primary">{ico('plus')}Crear las seleccionadas</button></div>
</div>
</div>'''
  write('DesktopSugerirTareas.html', desktop('Sugerir tareas', 'tasks', '<span style="font-weight: 500">Tareas</span>', main, overlay=f'<div style="position: absolute; inset: 0; z-index: 30">{dialog}</div>', css=CARD_CSS))


def msugg_card(x):
  pressed = 'true' if x['on'] else 'false'
  btn = f'<button type="button" class="btn btn-lg sug-pick" aria-pressed="{pressed}" style="height: 44px">{ico("check", "ico") if x["on"] else ico("plus", "ico")}{"Incluida" if x["on"] else "Incluir"}</button>'
  return f'<div class="sug-card"><span class="sug-title" style="font-size: 15px">{x["title"]}</span>{task_meta(x)}<p class="sug-reason" style="font-size: 14px">{x["why"]}</p><div class="sug-acts">{btn}</div></div>'


def suggest_mobile():
  inner = f'''<header class="row" style="flex-shrink: 0; padding: 8px 8px; gap: 4px; min-height: 60px">
<a href="MobileTablero.html" class="btn btn-ghost btn-lg" style="padding: 0 10px">Cancelar</a>
<span class="grow" style="text-align: center; font-weight: 600; font-size: 17px">Sugerir tareas</span>
<span style="width: 86px"></span>
</header>
<div class="m-body stack" style="gap: 12px">
<div class="row" style="gap: 8px"><label class="field field-lg grow">{ico('search', 'ico ico-lg')}<input value="lo que falta para v0.20" aria-label="Qué buscar (opcional)" style="font-size: 16px"></label><button type="button" class="btn btn-lg btn-icon" aria-label="Volver a sugerir">{ico('refresh', 'ico ico-lg')}</button></div>
<section class="ai-run done" aria-label="Sugerencia completada" style="flex-direction: column; align-items: stretch; gap: 6px"><span class="row t-sm" style="gap: 8px">{ico('check', 'ico fg-3')}<span><b style="font-weight: 600">6 propuestas</b> <span class="fg-2">· se crean en Backlog</span></span></span>{facts(f('Sonnet 5'), f('48 s'), f('0,06 US$', 'cost'), f('chat 7c2e1a'))}</section>
<div class="card" style="overflow: hidden">{''.join(msugg_card(x) for x in [SUGG[0], SUGG[1], SUGG[3], SUGG[2]])}</div>
</div>
<div class="m-foot"><button type="button" class="btn btn-primary btn-lg">{ico('plus', 'ico ico-lg')}Crear las seleccionadas (3)</button></div>'''
  write('MobileSugerirTareas.html', mobile('Sugerir tareas', inner))


# ---------------------------------------------------------------- resources with AI

RPROP = [
  dict(st='pending', k='agent', name='migration-reviewer', desc='Revisa cada migración nueva de packages/core/src/db.ts antes del commit.',
       why='<span class="mono">db.ts</span> tiene 14 migraciones y la regla de no editar una existente solo está en CONTRIBUTING.md.'),
  dict(st='pending', k='skill', name='design-tokens', desc='Busca colores, radios y duraciones fuera de tokens.css y propone el token.',
       why='La regla de los tokens se repite a mano en 9 de los últimos 30 chats.'),
  dict(st='pending', k='command', name='/openapi', desc='Regenera los esquemas OpenAPI y resume qué rutas cambiaron.',
       why='CI ha fallado 4 veces este mes por esquemas sin regenerar.'),
  dict(st='accepted', k='agent', name='i18n-parity', saved='.claude/agents/i18n-parity.md',
       desc='Compara las claves de en y es y lee cada frase contra GLOSSARY.md.'),
]

EXIST = {
  'agent': [('i18n-parity', 'Compara las claves de en y es y lee cada frase contra GLOSSARY.md', 'hace 2 min'), ('code-reviewer', 'Revisa el diff con las reglas de CONTRIBUTING.md', 'hace 3 d'), ('e2e-fixer', 'Arregla un spec de e2e que falla, sin tocar el producto', 'hace 6 d'),
            ('kb-writer', 'Escribe el documento de una decisión en docs/', 'hace 2 sem'), ('ds-checker', 'Compara una pantalla con su referencia', 'hace 3 sem')],
  'skill': [('night-shift', 'El sistema de diseño, sus tokens y sus reglas', 'hace 2 d'), ('cli-surfaces', 'Qué partes del CLI puede usar Agentry', 'hace 1 sem'),
            ('sqlite-migrations', 'Cómo añadir una migración', 'hace 2 sem'), ('pando', 'Buscar en la base de conocimiento', 'hace 1 mes')],
  'command': [('/checks', 'typecheck, test y build', 'hace 1 d'), ('/kb-sync', 'Reindexa docs/', 'hace 5 d'), ('/release', 'Prepara la release', 'hace 3 sem')],
}


def kinds_seg(big=False):
  st = ' style="flex: 1 1 0; justify-content: center; font-size: 13px; padding: 0 6px"' if big else ''
  items = [('Todos', 12, True), ('Agentes', 5, False), ('Skills', 4, False), ('Comandos', 3, False)]
  out = ''.join(f'<button type="button" role="tab" aria-selected="{"true" if on else "false"}" class="{"on" if on else ""}"{st}>{n} <span class="count">{c}</span></button>' for n, c, on in items)
  return f'<div class="seg" role="tablist" aria-label="Tipo de recurso"{" style=\"display: flex\"" if big else ""}>{out}</div>'


def exist_list(limit=None):
  out = []
  for k in ('agent', 'skill', 'command'):
    icon, word, plural = KIND[k]
    items = EXIST[k][:limit] if limit else EXIST[k]
    out.append(f'<div class="row" style="padding: 12px 12px 4px; gap: 6px">{ico(icon, "ico ico-sm fg-3")}<span class="t-label grow">{plural.capitalize()}</span><span class="mono t-xs fg-3">{len(EXIST[k])}</span></div>')
    for n, d, t in items:
      out.append(f'<a href="#" class="res-item"><span class="name">{n}<span class="grow"></span><span class="mono t-xs fg-3" style="font-weight: 400">{t}</span></span><span class="desc">{d}</span></a>')
    rest = len(EXIST[k]) - len(items)
    if rest:
      out.append(f'<a href="#" class="row t-xs c-accent" style="padding: 6px 12px; gap: 6px">{ico("down", "ico ico-sm")}{rest} más</a>')
    if k == 'agent':
      out.append(f'<a href="DesktopEquipo.html" class="row t-xs fg-3" style="padding: 2px 12px 6px; gap: 6px">{ico("team", "ico ico-sm")}Los 5 miembros del equipo también son agentes: están en Equipo</a>')
  return ''.join(out)


def res_actions():
  return f'<button type="button" class="btn">{ico("sparkle")}Sugerir</button><a href="DesktopRecursoCrearIA.html" class="btn">{ico("edit")}Crear con IA</a><button type="button" class="btn btn-ghost">{ico("plus")}Nuevo</button>'


def resources_main():
  props = f'''<section class="card grad-border" aria-label="Propuestas del asistente">
<div class="card-head">{mark(True)}<h2 class="t-h2">Propuestas del asistente</h2><span class="mono t-xs fg-3 grow">3 por revisar</span><button type="button" class="btn btn-ghost btn-sm">Descartar todas</button></div>
<div style="padding: 10px 14px; border-bottom: 1px solid var(--line); background: var(--bg-1)">{facts(f('Sugerir'), f('Sonnet 5'), f('1 min 3 s'), f('0,07 US$', 'cost'), chat_link('a91c30'), f('hace 2 min'))}</div>
{''.join(res_row(x) for x in RPROP)}
<div class="form-hint" style="padding: 10px 14px; border-top: 1px solid var(--line)">Cada propuesta se abre en el editor con su contenido. Nada se guarda hasta que pulses Crear, y va al proyecto salvo que elijas Usuario.</div>
</section>'''
  exist = f'''<section class="card" aria-label="En el proyecto">
<div class="card-head"><h2 class="t-h2 grow">En el proyecto</h2><span class="mono t-xs fg-3">.claude/ · 12</span></div>
<div class="col" style="gap: 0; padding: 0 6px 8px">{exist_list(2)}</div>
</section>'''
  return f'''<main class="page" style="gap: 18px">
{proj_head(False)}
{proj_tabs('resources')}
<div class="row" style="gap: 10px">{kinds_seg()}<span class="mono t-xs fg-3 grow">en .claude/ del proyecto</span>{res_actions()}</div>
<div style="display: grid; grid-template-columns: 1.3fr 1fr; gap: 14px; align-items: start">
{props}
{exist}
</div>
</main>'''


def resources_desktop():
  crumb = pcrumb('claude-wrapper', ('Recursos', ''))
  write('DesktopRecursos.html', desktop('Recursos', 'projects', crumb, resources_main()))


AGENT_MD = [
  ('<span class="tk-p">---</span>', ''),
  ('<span class="tk-k">name:</span> migration-reviewer', ''),
  ('<span class="tk-k">description:</span> Revisa cada migración nueva de packages/core/src/db.ts antes del commit. Úsalo cuando un cambio toque MIGRATIONS.', ''),
  ('<span class="tk-k">tools:</span> Read, Grep, Glob, Bash(git diff:*)', ''),
  ('<span class="tk-k">model:</span> sonnet', ''),
  ('<span class="tk-p">---</span>', ''),
  ('', ''),
  ('<span class="tk-h"># Revisor de migraciones</span>', ''),
  ('', ''),
  ('Lees el diff de <span class="tk-k">`packages/core/src/db.ts`</span> y compruebas:', ''),
  ('', ''),
  ('<span class="tk-p">1.</span> Que ninguna migración existente cambia: solo se añade una entrada al final de <span class="tk-k">`MIGRATIONS`</span>.', ''),
  ('<span class="tk-p">2.</span> Que se aplica sobre una base en la versión anterior sin perder filas.', ''),
  ('<span class="tk-p">3.</span> Que lo que se acumula son filas, no un JSON en una columna: dos procesos comparten el directorio de datos.', ''),
  ('<span class="tk-p">4.</span> Que cada tabla nueva tiene índice por proyecto.', ''),
  ('', ''),
  ('Responde con una lista: lo que está bien, lo que bloquea el commit y por qué, citando la línea del diff.', ''),
]


def code_ed(lines, caret=False, style='', size=None):
  rows = []
  for i, (l, _) in enumerate(lines, 1):
    tail = '<span class="caret" aria-hidden="true"></span>' if caret and i == len(lines) else ''
    rows.append(f'<span class="ln">{i}</span><span class="tx">{l or " "}{tail}</span>')
  fs = f' font-size: {size}px;' if size else ''
  return f'<div class="code-ed" role="textbox" aria-multiline="true" aria-label="Contenido" style="{style}{fs}">{"".join(rows)}</div>'


def proposal_desktop():
  master = []
  master.append(f'<div class="row" style="padding: 10px 12px 4px; gap: 6px">{ico("sparkle", "ico ico-sm fg-3")}<span class="t-label grow">Propuestas</span><span class="mono t-xs fg-3">3</span></div>')
  for i, x in enumerate(RPROP[:3]):
    icon, word, _ = KIND[x['k']]
    tag = f'<span class="row" style="margin-top: 3px"><span class="badge b-warn">{ico("warn", "ico", "width: 11px; height: 11px")}aún sin guardar</span></span>' if i == 0 else ''
    master.append(f'<a href="#" class="res-item{" sel" if i == 0 else ""}"{" aria-current=\"true\"" if i == 0 else ""}><span class="name">{ico(icon, "ico ico-sm fg-3")}<span class="ellipsis">{x["name"]}</span><span class="grow"></span><span class="mono t-xs fg-3" style="font-weight: 400">{word.lower()}</span></span><span class="desc">{x["desc"]}</span>{tag}</a>')
  master.append(exist_list(2))
  meta = f'''<div class="editor-meta"><span style="font-weight: 600; font-size: 15px" class="mono">migration-reviewer</span><span class="badge">Agente</span><span class="badge b-warn">{ico('warn', 'ico', 'width: 11px; height: 11px')}aún sin guardar</span><span class="path grow">se guardará en .claude/agents/migration-reviewer.md</span>
<div class="seg" role="radiogroup" aria-label="Dónde"><button type="button" role="radio" aria-checked="true" class="on">{ico('folder', 'ico ico-sm')}Proyecto</button><button type="button" role="radio" aria-checked="false">{ico('user', 'ico ico-sm')}Usuario</button></div></div>'''
  why = f'''<div class="callout" style="align-items: flex-start">{mark(True)}<div class="col" style="gap: 4px; min-width: 0"><span style="color: var(--fg); font-weight: 500">Propuesto por el asistente</span><span><span class="mono">db.ts</span> tiene 14 migraciones y la regla de no editar una existente solo está en CONTRIBUTING.md.</span>{facts(f('Sugerir'), f('Sonnet 5'), f('0,07 US$ por las 4 propuestas', 'cost'), chat_link('a91c30'))}</div></div>'''
  detail = f'''<div class="col" style="gap: 12px; padding: 16px 18px; min-width: 0; min-height: 0">
{meta}
{why}
{code_ed(AGENT_MD, style='flex: 1 1 auto')}
<div class="row" style="gap: 8px"><button type="button" class="btn btn-primary">{ico('check')}Crear agente</button><button type="button" class="btn">Descartar</button><span class="grow"></span><span class="t-xs fg-3">Nada se escribe hasta que lo crees. <span class="kbd">⌘S</span></span></div>
</div>'''
  main = f'''<main class="page" style="gap: 18px">
{proj_head(False)}
{proj_tabs('resources')}
<section class="card" style="flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 300px minmax(0, 1fr); overflow: hidden">
<nav class="col" aria-label="Recursos" style="gap: 1px; padding: 4px 6px; border-right: 1px solid var(--line); background: var(--bg-1); overflow: hidden">{''.join(master)}</nav>
{detail}
</section>
</main>'''
  crumb = pcrumb('claude-wrapper', ('Recursos', 'DesktopRecursos.html'), ('<span class="mono">migration-reviewer</span>', ''))
  write('DesktopRecursoPropuesta.html', desktop('Propuesta en el editor', 'projects', crumb, main))


GLOSS_MD = [
  ('<span class="tk-p">---</span>', ''),
  ('<span class="tk-k">name:</span> glossary-reviewer', ''),
  ('<span class="tk-k">description:</span> Lee cada frase nueva de locales/es contra GLOSSARY.md: español de España, botones en infinitivo y mayúscula solo al principio. Úsalo antes de un commit que toque las traducciones.', ''),
  ('<span class="tk-k">tools:</span> Read, Grep', ''),
  ('<span class="tk-k">model:</span> sonnet', ''),
  ('<span class="tk-p">---</span>', ''),
  ('', ''),
  ('<span class="tk-h"># Revisor del glosario</span>', ''),
]

CREATE_LIVE = ASSIST_LIVE.replace('href="DesktopAsistente.html"', 'href="DesktopRecursoCrearIA.html"').replace('Asistente de pagos-api', 'Crear con IA: glossary-reviewer').replace('<span class="c-live">Leyendo</span><span class="mono fg-3 ellipsis grow">src/webhooks</span><span class="mono fg-3">0:41</span>', '<span class="c-live">Escribiendo</span><span class="mono fg-3 ellipsis grow">glossary-reviewer.md</span><span class="mono fg-3">0:18</span>')


def create_ai_form(mobile=False):
  seg_st = ' style="flex: 1 1 0; justify-content: center"' if mobile else ''
  segd = ' style="display: flex"' if mobile else ''
  kinds = ''.join(f'<button type="button" role="radio" aria-checked="{"true" if k == "agent" else "false"}" class="{"on" if k == "agent" else ""}"{seg_st}>{ico(KIND[k][0], "ico ico-sm")}{KIND[k][1]}</button>' for k in ('agent', 'skill', 'command'))
  scope = f'<button type="button" role="radio" aria-checked="true" class="on"{seg_st}>{ico("folder", "ico ico-sm")}Proyecto</button><button type="button" role="radio" aria-checked="false"{seg_st}>{ico("user", "ico ico-sm")}Usuario</button>'
  fs = ' style="font-size: 16px"' if mobile else ''
  desc = 'Un agente que lea cada frase nueva en español contra GLOSSARY.md y diga qué no cumple: infinitivos, mayúsculas y términos que se quedan en inglés.'
  grid = 'display: flex; flex-direction: column; gap: 12px' if mobile else 'display: grid; grid-template-columns: 1.4fr 1fr; gap: 14px'
  return f'''<div style="{grid}">
<div class="form-row"><span class="t-label">Tipo</span><div class="seg" role="radiogroup" aria-label="Tipo"{segd}>{kinds}</div></div>
<div class="form-row"><span class="t-label">Dónde</span><div class="seg" role="radiogroup" aria-label="Dónde"{segd}>{scope}</div></div>
</div>
<div class="form-row"><span class="t-label">Qué debe hacer</span><label class="field field-area"><textarea rows="{5 if mobile else 3}" aria-label="Qué debe hacer"{fs}>{desc}</textarea></label></div>'''


def create_ai_run(mobile=False):
  size = 12 if mobile else None
  return f'''<section class="ai-run live energy" aria-label="Escribiendo el recurso" style="{"padding: 14px; " if mobile else ""}background: var(--bg-1); box-shadow: none; gap: 10px">
<div class="ai-run-head" style="gap: 10px">{live_verb('Escribiendo', 'glossary-reviewer.md', '0:18')}</div>
{facts(f('Sonnet 5'), f('0,01 US$ hasta ahora', 'cost'), chat_link('c03d77') if not mobile else f('chat c03d77'))}
{code_ed(GLOSS_MD, caret=True, size=size)}
</section>'''


def create_ai_desktop():
  dialog = f'''<div class="scrim">
<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="ca-title" style="width: 700px">
<div class="dialog-head">{mark(True)}<h2 id="ca-title" class="t-h2 grow">Crear con IA</h2><span class="mono t-xs fg-3">claude-wrapper</span><button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Cerrar">{ico('x')}</button></div>
<div class="dialog-body" style="gap: 14px">
{create_ai_form()}
{create_ai_run()}
</div>
<div class="dialog-foot"><span class="form-hint grow">Se abre en el editor para que lo revises antes de guardarlo.</span><button type="button" class="btn">{ico('x', 'ico ico-sm')}Detener</button><button type="button" class="btn btn-primary" disabled>Abrir en el editor</button></div>
</div>
</div>'''
  crumb = pcrumb('claude-wrapper', ('Recursos', ''))
  write('DesktopRecursoCrearIA.html', desktop('Crear con IA', 'projects', crumb, resources_main(), overlay=f'<div style="position: absolute; inset: 0; z-index: 30">{dialog}</div>', live=CREATE_LIVE, agents=3, running=3))


def resources_mobile():
  def pcell(x):
    icon, word, _ = KIND[x['k']]
    if x['st'] == 'accepted':
      right = f'<span class="sug-done">{ico("check", "ico ico-sm")}guardada</span>'
    else:
      right = ico('right', 'ico fg-3')
    reason = f'<span class="t-sm fg-2" style="line-height: 1.45">{x.get("why") or x["desc"]}</span>'
    return f'<a href="MobileRecursoPropuesta.html" class="cell" style="align-items: flex-start; padding: 12px 14px; gap: 12px">{kind_ico(x["k"])}<span class="col grow" style="gap: 3px; min-width: 0"><span class="row" style="gap: 7px"><span class="mono" style="font-weight: 500; font-size: 14px">{x["name"]}</span><span class="badge">{word}</span></span>{reason}</span><span style="margin-top: 4px">{right}</span></a>'

  def ecell(k, n, d):
    return f'<a href="#" class="cell">{ico(KIND[k][0], "ico fg-3")}<span class="col grow" style="gap: 1px; min-width: 0"><span class="mono" style="font-weight: 500; font-size: 14px">{n}</span><span class="t-xs fg-3">{d}</span></span>{ico("right", "ico fg-3")}</a>'
  inner = f'''<header class="row" style="flex-shrink: 0; padding: 8px 4px; gap: 4px; min-height: 60px">
<a href="MobileProyecto.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver">{ico('left', 'ico ico-lg', 'stroke-width: 2')}</a>
<span class="col grow" style="gap: 1px; min-width: 0; padding-left: 2px"><h1 class="t-h1" style="font-size: 24px">Recursos</h1><span class="mono t-xs fg-3 ellipsis">claude-wrapper · .claude/</span></span>
<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Nuevo recurso">{ico('plus', 'ico ico-lg')}</button>
</header>
<div class="m-body stack" style="gap: 12px">
{kinds_seg(True)}
<div class="row" style="gap: 8px"><button type="button" class="btn btn-lg" style="flex: 1 1 0">{ico('sparkle', 'ico ico-lg')}Sugerir</button><a href="MobileRecursoCrearIA.html" class="btn btn-lg" style="flex: 1 1 0">{ico('edit', 'ico ico-lg')}Crear con IA</a></div>
<section class="card grad-border" style="overflow: hidden" aria-label="Propuestas del asistente">
<div class="row" style="padding: 12px 14px 8px; gap: 10px">{mark(True)}<span class="col grow" style="gap: 2px"><span style="font-weight: 600; font-size: 15px">Propuestas del asistente</span>{facts(f('3 por revisar'), f('0,07 US$', 'cost'), f('hace 2 min'))}</span></div>
{''.join(pcell(x) for x in RPROP)}
</section>
<div class="row" style="padding: 0 4px"><span class="t-label grow">En el proyecto</span><span class="mono t-xs fg-3">12</span></div>
<div class="card" style="overflow: hidden">{ecell('agent', *EXIST['agent'][0][:2])}{ecell('agent', *EXIST['agent'][1][:2])}{ecell('skill', *EXIST['skill'][0][:2])}</div>
</div>
{tabbar('more')}'''
  write('MobileRecursos.html', mobile('Recursos', inner))


def proposal_mobile():
  inner = f'''<header class="row" style="flex-shrink: 0; padding: 8px 4px; gap: 4px; min-height: 60px">
<a href="MobileRecursos.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver">{ico('left', 'ico ico-lg', 'stroke-width: 2')}</a>
<span class="col grow" style="gap: 1px; min-width: 0; padding-left: 2px"><h1 class="t-h1 mono" style="font-size: 24px">migration-reviewer</h1><span class="t-xs fg-3">Agente · propuesta del asistente</span></span>
<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Más acciones">{ico('more', 'ico ico-lg', 'stroke-width: 3')}</button>
</header>
<div class="m-body stack" style="gap: 12px">
<div class="row" style="gap: 8px; flex-wrap: wrap"><span class="badge b-warn">{ico('warn', 'ico', 'width: 11px; height: 11px')}aún sin guardar</span><span class="mono t-xs fg-3">.claude/agents/migration-reviewer.md</span></div>
<div class="callout" style="align-items: flex-start; font-size: 13px">{mark(True)}<div class="col" style="gap: 4px; min-width: 0"><span><span class="mono">db.ts</span> tiene 14 migraciones y la regla de no editar una existente solo está en CONTRIBUTING.md.</span>{facts(f('Sonnet 5'), f('0,07 US$ por las 4', 'cost'), f('chat a91c30'))}</div></div>
<div class="seg" role="radiogroup" aria-label="Dónde" style="display: flex"><button type="button" role="radio" aria-checked="true" class="on" style="flex: 1 1 0; justify-content: center">{ico('folder', 'ico ico-sm')}Proyecto</button><button type="button" role="radio" aria-checked="false" style="flex: 1 1 0; justify-content: center">{ico('user', 'ico ico-sm')}Usuario</button></div>
<div class="row" style="padding: 0 4px; gap: 8px"><span class="t-label grow">Contenido</span><a href="#" class="btn btn-lg">{ico('edit', 'ico')}Editar</a></div>
{code_ed(AGENT_MD[:8], size=12)}
</div>
<div class="m-foot"><button type="button" class="btn btn-lg">Descartar</button><button type="button" class="btn btn-primary btn-lg">{ico('check', 'ico ico-lg')}Crear agente</button></div>'''
  write('MobileRecursoPropuesta.html', mobile('Propuesta en el editor', inner))


def create_ai_mobile():
  inner = f'''<header class="row" style="flex-shrink: 0; padding: 8px 8px; gap: 4px; min-height: 60px">
<a href="MobileRecursos.html" class="btn btn-ghost btn-lg" style="padding: 0 10px">Cancelar</a>
<span class="grow" style="text-align: center; font-weight: 600; font-size: 17px">Crear con IA</span>
<span style="width: 86px"></span>
</header>
<div class="m-body stack" style="gap: 14px">
{create_ai_form(True)}
{create_ai_run(True)}
</div>
<div class="m-foot"><button type="button" class="btn btn-lg">{ico('x', 'ico ico-lg')}Detener</button><button type="button" class="btn btn-primary btn-lg" disabled>Abrir en el editor</button></div>'''
  write('MobileRecursoCrearIA.html', mobile('Crear con IA', inner))


ALL = ['DesktopAsistente', 'MobileAsistente', 'DesktopAsistentePropuestas', 'MobileAsistentePropuestas', 'DesktopSugerirTareas', 'MobileSugerirTareas',
       'DesktopRecursos', 'MobileRecursos', 'DesktopRecursoPropuesta', 'MobileRecursoPropuesta', 'DesktopRecursoCrearIA', 'MobileRecursoCrearIA']

if __name__ == '__main__':
  assistant_live_desktop(); assistant_live_mobile()
  assistant_done_desktop(); assistant_done_mobile()
  suggest_desktop(); suggest_mobile()
  resources_desktop(); resources_mobile()
  proposal_desktop(); proposal_mobile()
  create_ai_desktop(); create_ai_mobile()
