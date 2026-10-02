# Webhooks (plans/code-hosts.md, phase 6, P0). One function group per task, each under its own banner:
# w-p1 is Settings → Integrations → Webhooks, per project (this file's first banner); w-p2 adds the freshness
# line of the item page under its own banner. Runs on its own: it imports common.py, hosts.py (the Integrations
# page it extends: its settings nav, head and the host monograms), decisions.py and providers.py.
#   python3 webhooks.py
from common import P, ico, desktop, mobile, write, tabbar
from decisions import scrim, card_head
from providers import mhead
from hosts import HOST, mono_ico, settings_nav, scenario_label

P.setdefault('ext', 'M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5')

# ---------------------------------------------------------------- w-p1 · data
# The tunnel's name changes on every start: the current one, and the one a hook still points to when it is stale.
ORIGIN = 'https://calm-otter-4f2a.lhr.life'
OLD_ORIGIN = 'https://quiet-fox-91c3.lhr.life'
RID = 'a3f9c2e1'

# state -> word, badge class, dot class. A status colour with its word. `off` waits for the person, but it is
# not a state to colour: the project simply has no hook, so it is the plain badge. A host Agentry has not
# recorded is the plain badge too, as the trackers' "Aún no disponible".
STATE = {
  'active': ('Activo', 'b-ok', 'dot-ok'),
  'failing': ('Con fallos', 'b-bad', 'dot-bad'),
  'stale': ('Dirección antigua', 'b-warn', 'dot-warn'),
  'off': ('Apagado', '', ''),
  'unavailable': ('Aún no disponible', '', ''),
}

# Events a GitHub hook asks for (action matrix G1), each with what it means in words.
EVENTS = [
  ('pull_request', 'Una PR se abre, cambia o se cierra'),
  ('pull_request_review', 'Alguien envía una revisión'),
  ('pull_request_review_comment', 'Un comentario en el diff'),
  ('pull_request_review_thread', 'Un hilo se resuelve o se reabre'),
  ('check_run', 'Una comprobación cambia'),
  ('check_suite', 'Un conjunto de comprobaciones termina'),
  ('workflow_run', 'Un workflow empieza o termina'),
  ('issue_comment', 'Un comentario en una PR o una incidencia'),
  ('issues', 'Una incidencia cambia'),
]

# One project each: its monogram is its host's, the name is the project's and the repository sits in mono.
PROJECTS = {
  'cw': dict(name='claude-wrapper', host='github', repo='yeyochico/claude-wrapper', where='github.com'),
  'gdm': dict(name='google-docs-mcp', host='github', repo='yeyochico/google-docs-mcp', where='github.com'),
  'pa': dict(name='pagos-api', host='gitlab', repo='equipo/pagos-api', where='gitlab.inmoseo.net'),
}

NOT_RECORDED = ('Agentry todavía no ha visto cómo registra <span class="mono">glab</span> un webhook, así que no puede registrarlo, '
                'probarlo ni quitarlo. Las MR se siguen leyendo cada 2 min; un aviso que llegue con el token '
                '<span class="mono">X-Gitlab-Token</span> se recibe igual.')

# The rows of each scenario: project, state, then what the state says. `facts` are mono lines (label, value);
# `pace` is the pacer's cadence for that project's change requests (design note of phase 6: a healthy hook is
# a 15 min safety net, otherwise an open request waiting for review is read every 2 min).
ROWS = {
  'active': dict(p='cw', state='active', reason='GitHub entrega los avisos y Agentry vuelve a leer la PR al momento.',
                 facts=[('último aviso', 'pull_request · hace 3 min'), ('última prueba', '204 · hace 2 h'), ('lectura de respaldo', 'cada 15 min')],
                 acts=['test', 'remove']),
  'off': dict(p='gdm', state='off', reason='Sin webhook, Agentry lee las PR cada 2 min. Con uno se entera al momento.',
              facts=[('lectura', 'cada 2 min')], acts=['register']),
  'unavailable': dict(p='pa', state='unavailable', reason=NOT_RECORDED, facts=[('lectura', 'cada 2 min'), ('motivo', 'unknown · not-recorded')], acts=[]),
  'failing': dict(p='cw', state='failing', reason='GitHub no consigue entregar los avisos: la dirección de Agentry respondió con un error.',
                  facts=[('última respuesta', 'HTTP 502 · hace 12 min'), ('último intento', 'pull_request'), ('lectura', 'cada 2 min')],
                  acts=['test', 'remove']),
  'stale': dict(p='cw', state='stale',
                reason='El webhook apunta a una dirección que ya no es la de Agentry. Agentry lo apunta solo a la nueva, pero esta vez no ha podido.',
                facts=[('apunta a', OLD_ORIGIN), ('ahora', ORIGIN), ('lectura', 'cada 2 min')], acts=['repoint', 'remove']),
  'repointed': dict(p='cw', state='active', reason='GitHub entrega los avisos y Agentry vuelve a leer la PR al momento.',
                    facts=[('apuntado de nuevo', 'por Agentry · hace 4 min'), ('último aviso', 'pull_request · hace 1 min'), ('lectura de respaldo', 'cada 15 min')],
                    acts=['test', 'remove']),
  'closed': dict(p='cw', state='stale', reason='El túnel está cerrado, así que GitHub ya no llega a Agentry. Cuando haya una dirección nueva, Agentry apuntará el webhook a ella.',
                 facts=[('apunta a', OLD_ORIGIN), ('lectura', 'cada 2 min')], acts=['remove']),
  'off-closed': dict(p='gdm', state='off', reason='Registrar un webhook necesita una dirección pública. Mientras tanto Agentry lee las PR cada 2 min.',
                     facts=[('lectura', 'cada 2 min')], acts=[]),
}


# ---------------------------------------------------------------- w-p1 · pieces
def hbadge(state):
  word, cls, dot = STATE[state]
  d = f'<span class="dot {dot}" style="width: 6px; height: 6px"></span>' if dot else ''
  return f'<span class="badge {cls}">{d}{word}</span>'.replace('badge "', 'badge"')


def hact(kind, big=False):
  """Every button is neutral: the page's gradient is the dialog's, not a row's. Probar, Apuntar and Quitar act on a hook
  Agentry registered; Quitar is a ghost, and asks before it deletes."""
  size = ' btn-lg' if big else ''
  return {
    'register': f'<button type="button" class="btn{size}">{ico("plus", "ico ico-sm")}Registrar…</button>',
    'test': f'<button type="button" class="btn{size}">{ico("activity", "ico ico-sm")}Probar</button>',
    'repoint': f'<button type="button" class="btn{size}">{ico("retry", "ico ico-sm")}Apuntar a la dirección actual</button>',
    'remove': f'<button type="button" class="btn btn-ghost{size}">Quitar</button>',
  }[kind]


def facts(r):
  lines = ''.join(f'<span><b>{k}</b> · {v}</span>' for k, v in r['facts'])
  return f'<div class="hook-facts">{lines}</div>'


def meta(p):
  """The repository, with its host only when it is not the public one: the row has the room for the path alone."""
  return p['repo'] if p['where'] in ('github.com', 'gitlab.com') else f'{p["where"]}/{p["repo"]}'


def identity(r):
  p = PROJECTS[r['p']]
  noun, num = HOST[p['host']][5], HOST[p['host']][6]
  return (f'<div class="prov-id"><span class="prov-name">{p["name"]}<span class="mono t-xs fg-3">{noun} {num}</span></span>'
          f'<span class="prov-meta ellipsis">{meta(p)}</span></div>')


def row(r):
  p = PROJECTS[r['p']]
  acts = ''.join(hact(k) for k in r['acts'])
  return (f'<div class="prov-row compact" data-project="{p["name"]}">{mono_ico(p["host"])}{identity(r)}'
          f'<div class="prov-state">{hbadge(r["state"])}<p class="prov-reason">{r["reason"]}</p>{facts(r)}</div>'
          f'<div class="prov-actions" style="flex-direction: column; align-items: stretch">{acts}</div></div>')


def cell(r):
  p = PROJECTS[r['p']]
  noun, num = HOST[p['host']][5], HOST[p['host']][6]
  acts = ''.join(hact(k, True) for k in r['acts'])
  acts_html = f'<div class="col" style="gap: 8px">{acts}</div>' if acts else ''
  hd = (f'<div class="prov-cell-head">{mono_ico(p["host"])}<div class="grow"><span class="row" style="gap: 8px; flex-wrap: wrap"><span style="font-weight: 500">{p["name"]}</span>'
        f'<span class="mono t-xs fg-3">{noun} {num}</span></span><span class="prov-meta">{p["repo"]}</span></div>{hbadge(r["state"])}</div>')
  return f'<div class="prov-cell" data-project="{p["name"]}">{hd}<p class="prov-reason">{r["reason"]}</p>{facts(r)}{acts_html}</div>'


def origin(url, big=False):
  """Where the hosts deliver: the tunnel's address now. With none, the strip says so and offers the one way out."""
  if url:
    return (f'<div class="hook-origin" role="group" aria-label="Dirección pública">{ico("link", "ico fg-3")}<span>Los avisos llegan a</span>'
            f'<span class="url grow">{url}</span><span class="badge b-ok"><span class="dot dot-ok" style="width: 6px; height: 6px"></span>Abierta</span></div>')
  link = f'<a href="#" class="btn{" btn-lg" if big else ""}" style="white-space: nowrap">Abrir Acceso remoto{ico("ext", "ico ico-sm")}</a>'
  return (f'<div class="hook-origin none" role="group" aria-label="Dirección pública">{ico("warn", "ico", "color: var(--warn)")}'
          f'<span class="grow" style="flex-basis: 260px"><b style="font-weight: 500; color: var(--fg)">Agentry no tiene una dirección pública.</b> '
          f'Los hosts no pueden llegar hasta aquí: abre el túnel en Ajustes → Acceso remoto, o configura una dirección pública.</span>{link}</div>')


INTRO = ('Un webhook hace que GitHub avise a Agentry en cuanto una PR cambia, en lugar de esperar a la siguiente lectura. Solo sirve de aviso: '
         'Agentry vuelve a leer la PR y no cambia nada por lo que diga el aviso. Sin webhook, o si un aviso se pierde, las sigue leyendo cada pocos minutos.')


def summary(rows):
  n = sum(1 for r in rows if r['state'] in ('active', 'failing', 'stale'))
  return f'{len(rows)} proyectos · {n} con webhook'


def webhooks_card(rows, url=ORIGIN, grad=True, id_='sec-webhooks', heading=True):
  cls = 'card grad-border col' if grad else 'card col'
  label = f'aria-labelledby="{id_}"' if heading else 'aria-label="Webhooks"'
  hd = card_head('link', 'Webhooks', summary(rows), id_) if heading else ''
  return (f'<section class="{cls}" style="flex-shrink: 0; gap: 0; overflow: hidden" {label}>{hd}{origin(url)}'
          f'{"".join(row(r) for r in rows)}</section>')


def intro():
  return f'<p class="fg-2 t-sm" style="margin: 0; max-width: 700px; line-height: 1.5">{INTRO}</p>'


# ---------------------------------------------------------------- w-p1 · the register dialog
def url_for(project):
  return f'{ORIGIN}/webhooks/{HOST[PROJECTS[project]["host"]][0].lower()}/{RID}'


def events_list():
  items = ''.join(f'<li><span class="mono">{n}</span><span>{d}</span></li>' for n, d in EVENTS)
  return f'<ul class="hook-events" aria-label="Eventos">{items}</ul>'


def events_short():
  return '<ul class="hook-events" aria-label="Eventos">' + ''.join(f'<li><span class="mono">{n}</span></li>' for n, _ in EVENTS) + '</ul>'


SECRET = ('Agentry genera un secreto de 32 bytes, lo guarda y se lo entrega a GitHub al registrar el webhook. No se vuelve a mostrar. '
          'Si el repositorio ya tiene un webhook con esta dirección, Agentry lo adopta en lugar de crear otro.')
BEFORE = 'Registrarlo necesita permiso de administración sobre el repositorio.'
BODY_HINT = 'GitHub firma cada aviso con el secreto; Agentry lo comprueba antes de leer nada.'


def register_dialog(project='gdm'):
  p = PROJECTS[project]
  url = url_for(project)
  body = (f'<div class="col" style="gap: 8px"><span class="t-label">Dirección</span>'
          f'<label class="field field-mono">{ico("link", "ico fg-3")}<input class="mono" value="{url}" readonly aria-label="Dirección del webhook">'
          f'<button type="button" class="btn btn-ghost btn-sm" style="margin-right: -8px; font-family: var(--sans)">{ico("copy", "ico ico-sm")}Copiar</button></label>'
          f'<span class="form-hint">Es la dirección pública de Agentry ahora mismo. {BODY_HINT}</span></div>'
          f'<div class="col" style="gap: 8px"><span class="t-label">Eventos</span>{events_list()}'
          f'<span class="form-hint">Los elige Agentry y son los que hacen falta para seguir una PR; no se pueden cambiar aquí.</span></div>'
          f'<div class="callout" style="align-items: flex-start">{ico("lock", "ico", "flex-shrink: 0; color: var(--fg-3); margin-top: 1px")}<span>{SECRET} {BEFORE}</span></div>')
  return (f'<div class="scrim" style="z-index: 30"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="hook-title" style="width: 660px">'
          f'<div class="dialog-head">{mono_ico(p["host"])}<div class="col grow" style="gap: 2px"><h2 id="hook-title" class="t-h2">Registrar un webhook en {p["name"]}</h2>'
          f'<span class="mono t-xs fg-3">{p["repo"]} · {p["where"]} · gh 2.92.0</span></div>'
          f'<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Cerrar">{ico("x")}</button></div>'
          f'<div class="dialog-body">{body}</div>'
          f'<div class="dialog-foot"><span class="t-xs fg-3">Se registra con gh, con tu sesión de yeyochico</span><span class="grow"></span>'
          f'<button type="button" class="btn btn-ghost">Cancelar</button><button type="button" class="btn btn-primary">Registrar webhook</button></div></div></div>')


def register_sheet(project='gdm'):
  p = PROJECTS[project]
  url = url_for(project)
  return f'''{scrim()}
<div class="sheet" role="dialog" aria-label="Registrar un webhook" style="z-index: 11; padding-bottom: 24px; display: flex; flex-direction: column; gap: 12px; max-height: 93%">
<div class="grab" style="margin-bottom: 0"></div>
<div class="row" style="gap: 10px">{mono_ico(p["host"])}<div class="col grow" style="gap: 2px"><h2 class="t-h2">Registrar un webhook en {p["name"]}</h2><span class="mono t-xs fg-3" style="overflow-wrap: anywhere">{p["repo"]} · gh 2.92.0</span></div></div>
<div class="col" style="gap: 8px"><span class="t-label">Dirección</span>
<div class="row" style="gap: 4px; align-items: center; padding: 4px 4px 4px 12px; border: 1px solid var(--line-2); border-radius: var(--r); background: var(--bg-1)" role="group" aria-label="Dirección del webhook"><span class="mono grow" style="font-size: 14px; line-height: 1.45; overflow-wrap: anywhere">{url}</span><button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Copiar la dirección">{ico("copy", "ico")}</button></div>
<span class="form-hint">La dirección pública de Agentry ahora mismo. {BODY_HINT}</span></div>
<div class="col" style="gap: 8px"><span class="t-label">Eventos</span>{events_short()}</div>
<span class="t-xs fg-3" style="line-height: 1.45">{SECRET} {BEFORE}</span>
<div class="col" style="gap: 8px"><button type="button" class="btn btn-lg btn-primary" style="justify-content: center">Registrar webhook</button>
<button type="button" class="btn btn-lg btn-ghost" style="justify-content: center">Cancelar</button></div>
</div>'''


# ---------------------------------------------------------------- w-p1 · desktop
MAIN_ROWS = [ROWS['active'], ROWS['off'], ROWS['unavailable']]


def head():
  return '<div class="row" style="gap: 20px; align-items: flex-end"><div class="col grow" style="gap: 4px"><h2 class="t-h1" style="font-size: 20px">Integraciones</h2></div></div>'


def desktop_webhooks(name, title, rows, url=ORIGIN, overlay='', grad=True, extra=''):
  body = head() + intro() + webhooks_card(rows, url, grad=grad) + extra
  main = f'<main class="col grow" style="padding: 26px 32px; gap: 18px; min-width: 0">{body}</main>'
  inner = f'<div class="row" style="flex: 1 1 auto; min-height: 0; align-items: stretch; gap: 0; overflow: hidden">{settings_nav()}{main}</div>'
  write(name, desktop(title, 'settings', '<span style="font-weight: 500">Ajustes</span>', inner, overlay=overlay, project='Todos los proyectos', agents=3, running=3))


def desktop_all():
  desktop_webhooks('DesktopIntegracionesWebhooks.html', 'Ajustes, integraciones con webhooks', MAIN_ROWS)
  desktop_webhooks('DesktopIntegracionesWebhooksRegistrar.html', 'Ajustes, registrar un webhook', MAIN_ROWS,
                   overlay=register_dialog('gdm'), grad=False)
  scenes = [('Los avisos no llegan: GitHub recibió un error', ROWS['failing']),
            ('La dirección cambió y Agentry no pudo apuntar el webhook', ROWS['stale']),
            ('Agentry apuntó el webhook a la dirección nueva', ROWS['repointed'])]
  cards = ''.join(f'<div class="col" style="gap: 6px">{scenario_label(t)}{webhooks_card([r], grad=False, id_=f"sec-webhooks-{i}", heading=False)}</div>'
                  for i, (t, r) in enumerate(scenes))
  main = f'<main class="col grow" style="padding: 26px 32px; gap: 14px; min-width: 0">{head()}{cards}</main>'
  inner = f'<div class="row" style="flex: 1 1 auto; min-height: 0; align-items: stretch; gap: 0; overflow: hidden">{settings_nav()}{main}</div>'
  write('DesktopIntegracionesWebhooksEstados.html', desktop('Ajustes, webhooks con otros estados', 'settings', '<span style="font-weight: 500">Ajustes</span>', inner,
                                                           project='Todos los proyectos', agents=3, running=3))
  desktop_webhooks('DesktopIntegracionesWebhooksSinDireccion.html', 'Ajustes, webhooks sin dirección pública',
                   [ROWS['closed'], ROWS['off-closed'], ROWS['unavailable']], url=None)


# ---------------------------------------------------------------- w-p1 · phone
def mobile_webhooks(name, title, rows, url=ORIGIN, sheet='', lead=''):
  body = (f'{mhead("Integraciones")}<div class="m-body" style="gap: 12px">{lead}'
          f'<section class="card grad-border" style="overflow: hidden" aria-label="Webhooks">{origin(url, True)}{"".join(cell(r) for r in rows)}</section></div>')
  write(name, mobile(title, f'{body}\n{sheet}' if sheet else body + '\n' + tabbar('more')))


def mobile_states(name, title, scenes):
  groups = ''.join(f'<div class="col" style="gap: 6px">{scenario_label(t)}<section class="card" style="overflow: hidden" aria-label="{t}">{cell(r)}</section></div>' for t, r in scenes)
  write(name, mobile(title, f'{mhead("Integraciones")}<div class="m-body" style="gap: 12px">{groups}</div>\n' + tabbar('more')))


def mobile_all():
  mobile_webhooks('MobileIntegracionesWebhooks.html', 'Ajustes, integraciones con webhooks', MAIN_ROWS)
  mobile_webhooks('MobileIntegracionesWebhooksRegistrar.html', 'Ajustes, registrar un webhook', MAIN_ROWS, sheet=register_sheet('gdm'))
  mobile_states('MobileIntegracionesWebhooksEstados.html', 'Ajustes, webhooks con fallos y con dirección antigua',
                [('Los avisos no llegan: GitHub recibió un error', ROWS['failing']),
                 ('La dirección cambió y Agentry no pudo apuntar el webhook', ROWS['stale'])])
  mobile_states('MobileIntegracionesWebhooksReapuntado.html', 'Ajustes, webhook apuntado de nuevo',
                [('Agentry apuntó el webhook a la dirección nueva', ROWS['repointed'])])
  mobile_webhooks('MobileIntegracionesWebhooksSinDireccion.html', 'Ajustes, webhooks sin dirección pública',
                  [ROWS['closed'], ROWS['off-closed'], ROWS['unavailable']], url=None)


# ---------------------------------------------------------------- run
if __name__ == '__main__':
  desktop_all()
  mobile_all()
