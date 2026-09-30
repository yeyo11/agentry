# Code hosts (plans/code-hosts.md, phase 1, P0): the screens of the host integrations. p1 is Settings →
# Integrations, on a desktop and on a phone. p2 and p3 add their own functions below, each under its own
# banner. Runs on its own, after nothing: it imports common.py, the settings nav of decisions.py and a
# few pieces of providers.py (the two tabs are the same kind of list).
#   python3 hosts.py
from data import *
from board import mrow
from common import P, ico, desktop, mobile, write, tabbar, page
from decisions import SETTINGS_NAV, scrim
from providers import card_head, mhead, _il
from projects import HOST_LINES, host_line, host_hint

P.update({
  'ext': 'M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
})

# ---------------------------------------------------------------- data
# id -> label, monogram letters, hue (never a status hue: red, green or cyan), CLI, oldest version that works,
# the change request's noun and its first number
HOST = {
  'github': ('GitHub', 'GH', 262, 'gh', '2.92.0', 'PR', '#12'),
  'gitlab': ('GitLab', 'GL', 45, 'glab', '1.120.0', 'MR', '!12'),
}

# state -> word, badge class, dot class. A status colour with its word; a CLI that is not installed has no
# status to colour, so it is the plain badge, and one being checked is the plain badge with a spinner.
STATE = {
  'ready': ('Listo', 'b-ok', 'dot-ok'),
  'degraded': ('Con avisos', 'b-warn', 'dot-warn'),
  'signed-out': ('Sin sesión', 'b-warn', 'dot-warn'),
  'incompatible': ('Incompatible', 'b-bad', 'dot-bad'),
  'not-installed': ('No instalado', '', ''),
  'unknown': ('Sin comprobar', 'b-idle', 'dot-idle'),
  'checking': ('Comprobando', '', ''),
}

# id, state, version, path, the hosts its CLI knows as (hostname, account or None when signed out), reason
MAIN = [
  dict(id='github', state='ready', version='2.92.0', path='/usr/bin/gh',
       hosts=[('github.com', 'yeyo-dev'), ('github.acme.io', 'yeyo')],
       reason='Instalado, con sesión iniciada y respondiendo.'),
  dict(id='gitlab', state='degraded', version='1.134.0', path='~/.local/bin/glab',
       hosts=[('gitlab.com', 'yeyo')],
       reason='Funciona, pero la 1.134.0 es más nueva que la 1.120.0, la última con la que se ha probado Agentry.'),
]

# Scenarios for the states the first machine lacks: each is a pair of CLIs on an imagined machine
SCENARIOS = [
  ('Un gh antiguo y un glab sin sesión', [
    dict(id='github', state='incompatible', version='2.45.0', path='/usr/bin/gh',
         hosts=[('github.com', 'yeyo-dev')],
         reason='La 2.45.0 es anterior a la 2.92.0, la más antigua con la que funciona Agentry.'),
    dict(id='gitlab', state='signed-out', version='1.120.0', path='~/.local/bin/glab',
         hosts=[('git.inmoseo.net', None)],
         reason='glab está instalado, pero no tiene la sesión iniciada en ningún host.'),
  ]),
  ('Sin gh y un glab que no responde', [
    dict(id='github', state='not-installed', version='', path='',
         hosts=[], reason='gh no está instalado, o Agentry no lo encuentra.'),
    dict(id='gitlab', state='unknown', version='', path='~/.local/bin/glab',
         hosts=[], reason='glab no ha respondido en 10 s, así que Agentry lo ha detenido.'),
  ]),
  ('Justo después de abrir Agentry', [
    dict(id='github', state='checking', version='', path='', hosts=[], reason='Leyendo la versión y los hosts…'),
    dict(id='gitlab', state='checking', version='', path='', hosts=[], reason=''),
  ]),
]


# ---------------------------------------------------------------- pieces
def badge(state):
  word, cls, dot = STATE[state]
  if state == 'checking':
    return f'<span class="badge"><span class="spin-braille"></span>{word}</span>'
  d = f'<span class="dot {dot}" style="width: 6px; height: 6px"></span>' if dot else ''
  return f'<span class="badge {cls}">{d}{word}</span>'.replace('badge "', 'badge"')


def mono_ico(hid):
  label, letters, hue = HOST[hid][:3]
  return f'<span class="proj monogram" style="--hue: {hue}" role="img" aria-label="{label}" title="{label}">{letters}</span>'


def actions(h, open_=False):
  """The one action of a state first, then what else the state offers. Every button is neutral: the
  gradient is the page's, not a row's. Sign in, Install and Update open the vendor's page."""
  s = h['state']
  ext = ico('ext', 'ico ico-sm')
  if s == 'degraded':
    pressed = ' aria-pressed="true"' if open_ else ''
    return [f'<button type="button" class="btn"{pressed}>Elegir binario</button>']
  if s == 'signed-out':
    return [f'<a href="#" class="btn">Cómo iniciar sesión{ext}</a>']
  if s == 'incompatible':
    return [f'<a href="#" class="btn">Actualizar{ext}</a>', '<button type="button" class="btn btn-ghost">Elegir binario</button>']
  if s == 'not-installed':
    return [f'<a href="#" class="btn">Ver instalación{ext}</a>', '<button type="button" class="btn btn-ghost">Elegir binario</button>']
  if s == 'unknown':
    return [f'<button type="button" class="btn">{ico("retry", "ico ico-sm")}Reintentar</button>']
  return []


def known(h):
  """The hosts the CLI knows, each with its account or 'Sin sesión' in warn."""
  if not h['hosts']:
    return ''
  cli = HOST[h['id']][3]
  items = []
  for name, user in h['hosts']:
    who = (f'<span class="host-user">{user}</span>' if user
           else '<span class="badge b-warn"><span class="dot dot-warn" style="width: 6px; height: 6px"></span>Sin sesión</span>')
    items.append(f'<li><span class="host-name">{name}</span>{who}</li>')
  return (f'<div class="host-known" role="group" aria-label="Hosts que conoce {cli}"><span class="t-label">Hosts que conoce {cli}</span>'
          f'<ul>{"".join(items)}</ul></div>')


def meta(h):
  cli, noun, num = HOST[h['id']][3], HOST[h['id']][5], HOST[h['id']][6]
  return ' · '.join(x for x in [f'{cli} {h["version"]}' if h['version'] else cli, h['path']] if x), f'{noun} {num}'


def identity(h):
  label = HOST[h['id']][0]
  m, pr = meta(h)
  return (f'<div class="prov-id"><span class="prov-name">{label}<span class="mono t-xs fg-3">{pr}</span></span>'
          f'<span class="prov-meta ellipsis">{m}</span></div>')


def checking_row(h, first):
  # The check that is running says so; the one waiting sits behind skeleton bars
  label = HOST[h['id']][0]
  ident = (f'<div class="prov-id"><span class="prov-name">{label}</span><span class="skeleton" style="width: 110px; height: 10px; margin-top: 4px" aria-hidden="true"></span></div>')
  if first:
    state = f'{badge("checking")}<p class="prov-reason">{h["reason"]}</p>'
  else:
    state = '<span class="skeleton" style="width: 92px; height: 20px" aria-hidden="true"></span><span class="skeleton" style="width: 60%; height: 10px" aria-hidden="true"></span>'
  return f'<div class="prov-row compact" data-host="{h["id"]}">{mono_ico(h["id"])}{ident}<div class="prov-state">{state}</div><div class="prov-actions"></div></div>'


def row(h, open_=False, first=False):
  if h['state'] == 'checking':
    return checking_row(h, first)
  cls = 'prov-row compact' + (' open' if open_ else '')
  acts = ''.join(actions(h, open_))
  return (f'<div class="{cls}" data-host="{h["id"]}">{mono_ico(h["id"])}{identity(h)}'
          f'<div class="prov-state">{badge(h["state"])}<p class="prov-reason">{h["reason"]}</p>{known(h)}</div>'
          f'<div class="prov-actions">{acts}</div></div>')


def bin_panel(h):
  cli, minimum = HOST[h['id']][3], HOST[h['id']][4]
  return f'''<div class="prov-bin" role="group" aria-label="Binario de {cli}" style="padding-left: 68px">
<span class="t-label">Binario de {cli}</span>
<div class="prov-bin-row"><label class="field field-mono grow">{ico("folder", "ico fg-3")}<input class="mono" value="/opt/glab/bin/glab" aria-label="Ruta del binario de {cli}"></label><button type="button" class="btn">Buscar…</button></div>
<span class="form-hint">Agentry usa este programa en lugar de buscar en el PATH. Antes de guardarlo lee su versión y comprueba que no es anterior a la <span class="mono">{minimum}</span>.</span>
<div class="row" style="gap: 8px"><button type="button" class="btn">Comprobar y guardar</button><button type="button" class="btn btn-ghost">Cancelar</button><span class="grow"></span><button type="button" class="btn btn-ghost btn-sm">Usar el del PATH</button></div>
</div>'''


def settings_nav():
  out = []
  for g, items in SETTINGS_NAV:
    if g == 'Agentry':
      items = ['Apariencia', 'Notificaciones', 'Editor', 'Cuenta', 'Proveedores', 'Integraciones', 'Decisiones']
    links = ''.join(f'<a href="#" class="nav-item{" on" if i == "Integraciones" else ""}" style="height: 30px; font-size: 13px">{i}</a>' for i in items)
    out.append(f'<div class="col" style="gap: 1px"><span class="t-label" style="padding: 0 10px 4px">{g}</span>{links}</div>')
  return ('<nav aria-label="Secciones de ajustes" class="col" style="width: 236px; flex-shrink: 0; padding: 26px 12px 20px 24px; gap: 16px; overflow: hidden; border-right: 1px solid var(--line)">'
          '<h1 class="t-h1" style="padding-left: 10px; font-size: 20px">Ajustes</h1>' + ''.join(out) + '</nav>')


INTRO = ('Agentry abre y sigue las PR de GitHub (<span class="mono">#12</span>) y las MR de GitLab (<span class="mono">!12</span>) con los programas '
         '<span class="mono">gh</span> y <span class="mono">glab</span> de este equipo. No guarda ninguna clave: usa la sesión que ya tiene cada programa.')
OTHER_HOST = '¿Falta un host? Inicia sesión en él con el programa que corresponda y aparecerá aquí solo.'


def summary(machine):
  ready = sum(1 for h in machine if h['state'] == 'ready')
  return f'{len(machine)} programas · {ready} listo' + ('s' if ready != 1 else '')


# ---------------------------------------------------------------- p1 · Settings → Integrations, desktop
def head(checked='Comprobado hace 2 min', intro=True):
  text = f'<p class="fg-2 t-sm" style="margin: 0; max-width: 640px; line-height: 1.5">{INTRO}</p>' if intro else ''
  return (f'<div class="row" style="gap: 20px; align-items: flex-end"><div class="col grow" style="gap: 4px"><h2 class="t-h1" style="font-size: 20px">Integraciones</h2>'
          f'{text}</div>'
          f'<span class="mono t-xs fg-3" style="white-space: nowrap; padding-bottom: 6px">{checked}</span>'
          f'<button type="button" class="btn">{ico("retry", "ico")}Volver a comprobar</button></div>')


def other_host_note():
  return (f'<p class="row t-sm fg-2" style="margin: 0; gap: 10px; align-items: center">{OTHER_HOST}'
          f'<a href="#" class="c-accent row" style="gap: 4px; white-space: nowrap">Cómo iniciar sesión en otro host{ico("ext", "ico ico-sm")}</a></p>')


def hosts_card(machine, open_id=None, id_='sec-hosts', grad=True, heading=True):
  rows = []
  for i, h in enumerate(machine):
    rows.append(row(h, open_=(h['id'] == open_id), first=(i == 0)))
    if h['id'] == open_id:
      rows.append(bin_panel(h))
  cls = 'card grad-border col' if grad else 'card col'
  return (f'<section class="{cls}" style="flex-shrink: 0; gap: 0; overflow: hidden" {'aria-labelledby="' + id_ + '"' if heading else 'aria-label="Programas"'}>'
          f'{card_head("Programas", summary(machine), id_) if heading else ""}{"".join(rows)}</section>')


def scenario_label(text):
  return f'<span class="t-label" style="padding: 0 4px">{text}</span>'


def desktop_page(name, title, body):
  main = f'<main class="col grow" style="padding: 26px 32px; gap: 18px; min-width: 0">{body}</main>'
  inner = f'<div class="row" style="flex: 1 1 auto; min-height: 0; align-items: stretch; gap: 0; overflow: hidden">{settings_nav()}{main}</div>'
  write(name, desktop(title, 'settings', '<span style="font-weight: 500">Ajustes</span>', inner, project='Todos los proyectos', agents=3, running=3))


def desktop_integrations():
  desktop_page('DesktopIntegraciones.html', 'Ajustes, integraciones',
               head() + hosts_card(MAIN, open_id='gitlab') + other_host_note())


def desktop_states():
  cards = ''.join(f'<div class="col" style="gap: 6px">{scenario_label(t)}{hosts_card(m, id_=f"sec-hosts-{i}", grad=False, heading=False)}</div>'
                  for i, (t, m) in enumerate(SCENARIOS))
  desktop_page('DesktopIntegracionesEstados.html', 'Ajustes, integraciones con otros estados',
               head(intro=False) + f'<div class="col" style="gap: 14px">{cards}</div>')


def nothing_body(large):
  il = _il('il-lg' if large else 'il-sm', CLI_MISSING_BODY).replace('class="il ', 'class="il il-warn ')
  chips = (f'<a href="#" class="chip">Instalar glab para GitLab{ico("ext", "ico ico-sm")}</a>'
           f'<button type="button" class="chip">Elegir un binario</button>')
  if large:
    acts = (f'<div class="row" style="gap: 8px"><a href="#" class="btn btn-primary">Ver cómo instalar gh{ico("ext", "ico ico-sm")}</a>'
            f'<button type="button" class="btn">{ico("retry", "ico")}Volver a comprobar</button></div>')
  else:
    acts = (f'<div class="col" style="gap: 8px; align-self: stretch"><a href="#" class="btn btn-lg btn-primary" style="justify-content: center">Ver cómo instalar gh{ico("ext", "ico ico-sm")}</a>'
            f'<button type="button" class="btn btn-lg" style="justify-content: center">{ico("retry", "ico")}Volver a comprobar</button></div>')
  return f'''<div class="empty-state" style="padding: {"24px 24px 32px" if large else "16px 8px 20px"}">{il}
<h2 class="t-h2">Agentry no encuentra gh ni glab</h2>
<p>Sin uno de los dos no puede abrir PR ni MR. Instálalo y aparecerá aquí solo, sin volver a comprobar.</p>
{acts}
<div class="col" style="gap: 8px; align-items: center"><span class="t-label">O también</span><div class="row" style="gap: 6px; flex-wrap: wrap; justify-content: center">{chips}</div></div></div>'''


def desktop_nothing():
  card = (f'<section class="card col" style="flex-shrink: 0; gap: 0; overflow: hidden" aria-labelledby="sec-hosts">'
          f'{card_head("Programas", "0 programas · 0 listos", "sec-hosts")}{nothing_body(True)}</section>')
  desktop_page('DesktopIntegracionesVacio.html', 'Ajustes, integraciones sin nada instalado', head() + card + other_host_note())


# ---------------------------------------------------------------- p1 · Settings → Integrations, phone
def pcell(h, first=False):
  label = HOST[h['id']][0]
  m, pr = meta(h)
  if h['state'] == 'checking':
    right = badge('checking') if first else '<span class="skeleton" style="width: 84px; height: 20px" aria-hidden="true"></span>'
    sub = '<span class="skeleton" style="width: 110px; height: 10px; margin-top: 4px" aria-hidden="true"></span>'
    reason = f'<p class="prov-reason">{h["reason"]}</p>' if first and h['reason'] else ''
    hd = f'<div class="prov-cell-head">{mono_ico(h["id"])}<div class="grow"><span style="font-weight: 500">{label}</span>{sub}</div>{right}</div>'
    return f'<div class="prov-cell" data-host="{h["id"]}">{hd}{reason}</div>'
  acts = ''.join(actions(h))
  acts_html = f'<div class="row" style="gap: 8px; flex-wrap: wrap">{acts}</div>' if acts else ''
  hd = (f'<div class="prov-cell-head">{mono_ico(h["id"])}<div class="grow"><span class="row" style="gap: 8px; flex-wrap: wrap"><span style="font-weight: 500">{label}</span>'
        f'<span class="mono t-xs fg-3">{pr}</span></span><span class="prov-meta">{m}</span></div>{badge(h["state"])}</div>')
  return f'<div class="prov-cell" data-host="{h["id"]}">{hd}<p class="prov-reason">{h["reason"]}</p>{known(h)}{acts_html}</div>'


def mintro():
  return f'<p class="t-sm fg-2" style="margin: 0 4px; line-height: 1.5">{INTRO}</p>'


def mrecheck():
  return f'<div class="row" style="gap: 10px"><button type="button" class="btn grow" style="justify-content: center">{ico("retry", "ico")}Volver a comprobar</button><span class="mono t-xs fg-3" style="white-space: nowrap">hace 2 min</span></div>'


def mother_host():
  return (f'<p class="t-sm fg-2" style="margin: 0 4px; line-height: 1.5">{OTHER_HOST} '
          f'<a href="#" class="c-accent" style="display: inline-flex; align-items: center; gap: 4px; min-height: 44px">Cómo iniciar sesión en otro host{ico("ext", "ico ico-sm")}</a></p>')


def mobile_integrations(name, title, sheet=''):
  body = (f'{mhead("Integraciones")}<div class="m-body" style="gap: 12px">{mintro()}{mrecheck()}'
          f'<section class="card grad-border" style="overflow: hidden" aria-label="Programas">{"".join(pcell(h, i == 0) for i, h in enumerate(MAIN))}</section>{mother_host()}</div>')
  write(name, mobile(title, f'{body}\n{sheet}' if sheet else body + '\n' + tabbar('more')))


def mobile_states(name, title, scenarios):
  groups = ''.join(f'<div class="col" style="gap: 6px">{scenario_label(t)}<section class="card" style="overflow: hidden" aria-label="{t}">{"".join(pcell(h, i == 0) for i, h in enumerate(m))}</section></div>'
                   for t, m in scenarios)
  body = f'{mhead("Integraciones")}<div class="m-body" style="gap: 12px">{groups}</div>'
  write(name, mobile(title, body + '\n' + tabbar('more')))


def binary_sheet(h):
  label, cli, minimum = HOST[h['id']][0], HOST[h['id']][3], HOST[h['id']][4]
  return f'''{scrim()}
<div class="sheet" role="dialog" aria-label="{label}" style="z-index: 11; padding-bottom: 28px; display: flex; flex-direction: column; gap: 12px; max-height: 92%">
<div class="grab" style="margin-bottom: 0"></div>
<div class="prov-cell-head">{mono_ico(h["id"])}<div class="grow"><h2 class="t-h2">{label}</h2><span class="prov-meta">{cli} {h["version"]} · {h["path"]}</span></div>{badge(h["state"])}</div>
<p class="prov-reason" style="font-size: 14px">{h["reason"]}</p>
<div class="col" style="gap: 8px"><span class="t-label">Binario de {cli}</span>
<label class="field field-lg field-mono">{ico("folder", "ico fg-3")}<input class="mono" value="/opt/glab/bin/glab" aria-label="Ruta del binario de {cli}" style="font-size: 16px"></label>
<span class="form-hint">Agentry lo usa en lugar de buscar en el PATH. Antes de guardarlo lee su versión y comprueba que no es anterior a la <span class="mono">{minimum}</span>.</span></div>
<div class="col" style="gap: 8px"><button type="button" class="btn btn-lg btn-primary">Comprobar y guardar</button>
<div class="row" style="gap: 8px"><button type="button" class="btn btn-lg btn-ghost grow" style="justify-content: center">Usar el del PATH</button><button type="button" class="btn btn-lg btn-ghost">Cancelar</button></div></div>
</div>'''


def mobile_nothing():
  body = (f'{mhead("Integraciones")}<div class="m-body" style="gap: 12px">{mintro()}{mrecheck()}'
          f'<section class="card" style="overflow: hidden" aria-label="Programas">{nothing_body(False)}</section></div>')
  write('MobileIntegracionesVacio.html', mobile('Ajustes, integraciones sin nada instalado', body + '\n' + tabbar('more')))


# The set's `cli-missing` illustration, as it is in illustrations/cli-missing.svg
CLI_MISSING_BODY = '''<rect x="0" y="0" width="240" height="160" class="f-dots" mask="url(#il-fade)"></rect>
<rect x="34" y="26" width="170" height="110" rx="12" class="c0"></rect>
<path d="M34 46 H204" class="ln-soft"></path>
<circle cx="48" cy="36" r="3" class="s3"></circle><circle cx="58" cy="36" r="3" class="s3"></circle><circle cx="68" cy="36" r="3" class="s3"></circle>
<text x="48" y="66" class="txt">$ agent --version</text>
<text x="48" y="83" class="txt-tone">command not found</text>
<text x="48" y="104" class="txt">$</text><rect x="58" y="95" width="6" height="12" rx="1" class="f-grad a-blink"></rect>
<g class="a-float"><circle cx="206" cy="30" r="14" class="f-tone-soft"></circle><circle cx="206" cy="30" r="14" class="ln-tone"></circle><path d="M206 23 V31 M206 36.5 V37" class="ln-tone w3"></path></g>'''


# ---------------------------------------------------------------- p2: the host line, four states
P2_STATES = [
  ('gh-ready', 'GitHub, listo', 'gh tiene sesión en el host del remoto: la línea no pide nada y dice cómo se llaman las propuestas de cambio aquí, PR y #12.'),
  ('gl-ready', 'GitLab propio, listo', 'Un host que no es gitlab.com se nombra entero. Las propuestas son MR y se leen !12; el resto de la línea es igual.'),
  ('unsupported', 'Host sin soporte', 'Ni gh ni glab tienen sesión en este host. Un único camino, Integraciones, donde se ve qué host conoce cada CLI.'),
  ('signed-out', 'CLI sin sesión', 'El programa está, pero sin sesión en ese host. El remedio es un enlace a la documentación, nunca un comando que copiar.'),
]


def p2_cell(variant, title, note, phone):
  v = HOST_LINES[variant]
  if phone:
    body = (f'<div class="app m-screen" data-theme="dark" style="width: 390px; height: auto; border-radius: var(--r-xl); border: 1px solid var(--line-2); overflow: hidden; padding: 14px">'
            f'<div class="col" style="gap: 8px"><span class="t-label" style="padding: 0 4px">Repositorio</span>'
            f'<section class="card" style="padding: 14px" aria-label="Alojamiento del código">{host_line(variant, stacked=True)}</section>'
            f'<span class="form-hint" style="padding: 0 4px">Detectado del remoto origin; no se elige. {host_hint(v)}</span></div></div>')
    return body
  return (f'<div class="col" style="gap: 8px"><span class="t-sm" style="font-weight: 600">{title}</span>'
          f'<span class="t-xs fg-3" style="line-height: 1.45; min-height: 32px">{note}</span>'
          f'<section class="card col" style="padding: 18px; gap: 14px"><div class="row"><h2 class="t-h2 grow">Alojamiento del código</h2>'
          f'<span class="mono t-xs fg-3">detectado del remoto origin</span></div>{host_line(variant)}<span class="form-hint">{host_hint(v)}</span></section></div>')


def p2_section():
  rows = ''
  for variant, title, note in P2_STATES:
    rows += (f'<div style="display: grid; grid-template-columns: minmax(0, 1fr) 390px; gap: 40px; align-items: end">'
             f'{p2_cell(variant, title, note, False)}{p2_cell(variant, title, note, True)}</div>')
  return (f'<section class="col" style="gap: 14px"><span class="t-label">La línea del host en los ajustes del proyecto</span>'
          f'<p class="t-sm fg-2" style="margin: 0; max-width: 820px; line-height: 1.5">El host se detecta del remoto <span class="mono">origin</span> y nunca se elige: no hay selector. '
          f'La línea es el icono del host, <span class="mono">host/ruta</span> en mono, la CLI con su cuenta y una palabra de estado. '
          f'Cada estado tiene una sola acción, y ninguna es un comando.</p>{rows}</section>')


# ================================================================ p3 · readiness notes and MR wording
# The seven reasons a project offers no PR or MR (PullRequestNotReadyReason in plans/code-hosts.md, "Readiness"),
# each as the board's quiet note and the item page's note, with its remedy. A remedy is a link, or an
# Agentry action, never a command to copy: (label, True) opens the host's or the CLI's own page.
#   code, when, host (for the noun), board line, item sentence, the CLI's own line, remedies
REASONS = [
  ('not-git', 'la ruta no es un repositorio git', None,
   'Sin PR ni MR: el proyecto no es un repositorio git.',
   'Aprobarla no abre una PR ni una MR: el proyecto no es un repositorio git.',
   'fatal: not a git repository (or any of the parent directories): .git', []),
  ('no-remote', 'falta el remoto origin', None,
   'Sin PR ni MR: el proyecto no tiene remoto.',
   'Aprobarla no abre una PR ni una MR: el proyecto no tiene un remoto llamado origin.',
   "error: No such remote 'origin'", [('Cómo añadir un remoto', True)]),
  ('unsupported-host', 'ni gh ni glab conocen el host', None,
   'Sin PR ni MR: Agentry no llega a git.inmoseo.net.',
   'Aprobarla no abre una PR ni una MR: Agentry no llega a git.inmoseo.net, porque ni gh ni glab han iniciado sesión allí.',
   'git.inmoseo.net · pagos/api', [('Abrir Ajustes → Integraciones', False)]),
  ('no-default-branch', 'ni git ni la CLI la nombran', 'github',
   'Sin PR: no se encuentra la rama predeterminada.',
   'Aprobarla no abre una PR: Agentry no ha encontrado la rama predeterminada de este repositorio.',
   'gh: HTTP 404: Not Found (repos/yeyo/claude-wrapper)', [('Documentación de gh', True)]),
  ('cli-missing', 'glab no se encuentra o no responde', 'gitlab',
   'Sin MR: glab no está instalado.',
   'Aprobarla no abre una MR: glab no está instalado, o Agentry no lo encuentra.',
   'glab: command not found', [('Ver instalación', True), ('Elegir binario', False)]),
  ('cli-incompatible', 'versión por debajo del mínimo', 'gitlab',
   'Sin MR: glab 1.80.0 es demasiado antigua.',
   'Aprobarla no abre una MR: glab 1.80.0 es anterior a la 1.120.0, la más antigua con la que funciona Agentry.',
   'glab 1.80.0', [('Ver instalación', True)]),
  ('cli-signed-out', 'la CLI no tiene sesión en ese host', 'gitlab',
   'Sin MR: glab no ha iniciado sesión.',
   'Aprobarla no abre una MR: glab no ha iniciado sesión en git.inmoseo.net.',
   'glab auth status --hostname git.inmoseo.net · salida 1', [('Cómo iniciar sesión', True)]),
]


def board_note(r, mobile=False):
  """The quiet note on the card of an item that waits for the person: the warn line and its remedy
  above the approval, which stays "Aprobar y pasar a Hecho" because no PR or MR will open."""
  code, _, _, line, _, detail, remedy = r
  note = no_pr_line(line, remedy)
  strip = (f'<div class="wi-strip wait"><span class="badge b-idle">te espera</span><span class="verb">QA la dio por buena</span>{note}'
           f'<button type="button" class="btn btn-sm" title="{detail}">{ico("check", "ico ico-sm")}Aprobar y pasar a Hecho</button></div>')
  return strip


def item_note(r):
  """The item page's note: the reason in a sentence, the CLI's own line in mono, and the remedy."""
  code, _, _, _, sentence, detail, remedy = r
  links = ''.join(f'<a href="#" class="pr-remedy">{label}{ext_ico() if out else ""}</a>' for label, out in remedy)
  links = f'<span class="row" style="gap: 4px 16px; flex-wrap: wrap">{links}</span>' if links else ''
  return (f'<div class="pr-not-ready" role="note" data-reason="{code}">{ico("warn", "ico")}'
          f'<div class="col" style="gap: 4px; min-width: 0"><span>{sentence}</span><span class="detail">{detail}</span>{links}</div></div>')


def reason_row(r):
  code, when, host, *_ = r
  noun = 'MR' if host == 'gitlab' else 'PR' if host == 'github' else 'PR ni MR'
  head = (f'<div class="col" style="gap: 6px"><span class="mono t-sm" style="font-weight: 500">{code}</span>'
          f'<span class="t-xs fg-3" style="line-height: 1.45">{when}</span>'
          f'<span class="row t-xs fg-2" style="gap: 6px">{"GitLab" if host == "gitlab" else "GitHub" if host == "github" else "sin host"}<span class="fg-3">·</span>{noun}</span></div>')
  board = card('AGN-29', strip=board_note(r))
  item = f'<div class="card col" style="padding: 14px 16px; gap: 10px"><span class="row" style="gap: 8px">{tico("story", True)}<span class="wi-key boxed">AGN-29</span><span class="badge b-idle">te espera</span></span>{item_note(r)}<div class="row" style="gap: 8px"><button type="button" class="btn btn-sm">{ico("check", "ico ico-sm")}Aprobar y pasar a Hecho</button></div></div>'
  return f'<div style="display: grid; grid-template-columns: 210px 340px minmax(0, 1fr); gap: 28px; align-items: start; padding: 18px 0; border-top: 1px solid var(--line)">{head}{board}{item}</div>'


def ready_row():
  head = ('<div class="col" style="gap: 6px"><span class="mono t-sm" style="font-weight: 500">ready</span>'
          '<span class="t-xs fg-3" style="line-height: 1.45">Con la CLI lista, la aprobación abre la solicitud.</span>'
          '<span class="row t-xs fg-2" style="gap: 6px">GitLab<span class="fg-3">·</span>MR</span></div>')
  board = card('AGN-29', strip=approve_strip('QA la dio por buena', 'Aprobar y abrir MR'))
  item = (f'<div class="card col" style="padding: 14px 16px; gap: 10px"><span class="row" style="gap: 8px">{tico("story", True)}<span class="wi-key boxed">AGN-29</span><span class="badge b-idle">te espera</span></span>'
          f'<span class="t-sm fg-2" style="line-height: 1.5">Aprobarla abre su MR hacia <span class="mono">main</span>.</span>'
          f'<div class="row" style="gap: 8px"><button type="button" class="btn btn-sm">{ico("check", "ico ico-sm")}Aprobar y abrir MR</button></div></div>')
  return f'<div style="display: grid; grid-template-columns: 210px 340px minmax(0, 1fr); gap: 28px; align-items: start; padding: 18px 0">{head}{board}{item}</div>'


def p3_section():
  """DSIntegraciones, section "Avisos de preparación": the rules, the seven notices and the phone."""
  cols_head = ('<div style="display: grid; grid-template-columns: 210px 340px minmax(0, 1fr); gap: 28px; padding-bottom: 8px">'
               '<span class="t-label">Motivo</span><span class="t-label">En el tablero</span><span class="t-label">En la tarea</span></div>')
  rows = ready_row() + ''.join(reason_row(r) for r in REASONS)
  phone_r = REASONS[6]
  phone = (f'<div class="app m-screen" data-theme="dark" style="width: 390px; height: auto; border-radius: var(--r-xl); border: 1px solid var(--line-2); overflow: hidden; padding: 14px 0 16px">'
           f'<div class="m-body stack" style="gap: 12px; overflow: visible">'
           f'{mrow("AGN-29", strip=board_note(phone_r))}'
           f'<div class="card col" style="padding: 14px; gap: 8px"><span class="row" style="gap: 8px">{tico("story", True)}<span class="wi-key boxed">AGN-29</span><span class="badge b-idle">te espera</span></span>{item_note(phone_r)}</div>'
           f'</div></div>')
  rules = [
    ('01', 'Una línea, un motivo', 'El aviso dice por qué no se abre la PR o la MR, en el color de aviso y con su palabra. La línea de la CLI va debajo, en mono, o como título en la tarjeta.'),
    ('02', 'El remedio es un enlace', 'Una página de instalación, la documentación o Ajustes → Integraciones. Nunca un comando para copiar. not-git no tiene remedio: no hay nada que enlazar.'),
    ('03', 'La aprobación no cambia', 'Sin PR ni MR, aprobar sigue pasando la tarea a Hecho. Con la CLI lista, el botón dice «Aprobar y abrir MR» o «Aprobar y abrir PR».'),
    ('04', 'La palabra sigue al host', 'MR y !12 en GitLab, PR y #12 en GitHub. Sin host conocido, «PR ni MR».'),
  ]
  principles = ''.join(f'<div class="card col" style="padding: 18px; gap: 8px"><span class="mono t-xs fg-3">{n}</span><h2 class="t-h2">{t}</h2><p class="t-sm fg-2" style="margin: 0; line-height: 1.5">{x}</p></div>' for n, t, x in rules)
  return f'''<section style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px">{principles}</section>
<section class="col" id="avisos" style="gap: 0"><span class="t-label" style="padding-bottom: 14px">Los siete avisos</span>{cols_head}{rows}</section>
<section class="col" style="gap: 12px"><span class="t-label">Móvil: sin sesión en GitLab</span>{phone}</section>'''


# ---------------------------------------------------------------- the orchestration's merge request
ORCH_STEPS = ['Etapa 1', 'Etapa 2', 'Etapa 3', 'Integración', 'Verificación', 'Síntesis']


def orch_steps(last):
  """The seven steps of a finished run; the last, the merge request, is idle while it waits."""
  done = ''.join(f'<li class="col" style="gap: 8px"><div class="bar ok"><i style="width: 100%"></i></div><span class="row t-sm" style="gap: 6px; font-weight: 500">{ico("check", "ico ico-sm", "color: var(--ok)")}{s}</span><span class="mono t-xs fg-3">hecha</span></li>' for s in ORCH_STEPS)
  word = {'todo': ('pendiente', 'fg-3', 'fg-2'), 'wait': ('esperando fusión', 'fg-2', 'fg-2')}[last]
  tail = f'<li class="col" style="gap: 8px"><div class="bar"><i style="width: 0"></i></div><span class="t-sm {word[2]}">Merge request</span><span class="mono t-xs {word[1]}">{word[0]}</span></li>'
  return f'<ol aria-label="Pasos" style="margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px">{done}{tail}</ol>'


def orch_integration(opened):
  branch = f'<span class="row" style="gap: 8px">{ico("branch", "ico fg-3")}<span class="mono t-sm">orch/spanish-copy</span><span class="mono t-xs fg-3">desde main</span></span>'
  merged = '<span class="mono t-xs fg-2">6/6 ramas de tarea fusionadas</span>'
  if opened:
    mr = (f'<a href="#" class="pr-row" target="_blank" rel="noreferrer" aria-label="Abrir MR !14 en GitLab" style="min-height: 44px"><span class="pr-num">MR !14</span>'
          f'<span class="pr-branch">orch/spanish-copy → main</span><span class="badge b-idle">esperando fusión</span>{ci_badge("passing")}{ext_ico()}</a>')
    foot = (f'<div class="row" style="gap: 10px"><span class="t-xs fg-3 grow" style="line-height: 1.45">Agentry sigue la MR en git.inmoseo.net con glab 1.120.0. Cuando se fusione, te lo dirá aquí y quitará los worktrees.</span>'
            f'<a href="#" class="btn" target="_blank" rel="noreferrer">{ext_ico()}Abrir MR !14 en GitLab</a></div>')
    title = 'Su merge request'
  else:
    mr = ''
    foot = (f'<div class="row" style="gap: 10px"><span class="t-xs fg-3 grow" style="line-height: 1.45">Sube la rama a origin y abre una merge request hacia main en git.inmoseo.net con glab.</span>'
            f'<button type="button" class="btn btn-primary">{ico("branch", "ico")}Abrir merge request</button></div>')
    title = 'Integración'
  return (f'<section class="card card-pad col" style="gap: 14px"><div class="row" style="gap: 10px"><h2 class="t-h2 grow">{title}</h2>{merged}</div>'
          f'{branch}{mr}{foot}</section>')


def orch_main(opened):
  return f'''<main class="page" style="gap: 18px">
<div class="row" style="gap: 12px">
<a href="DesktopOrquestaciones.html" class="btn btn-icon btn-sm" aria-label="Volver a orquestaciones">{ico('left')}</a>
<h1 class="t-h1">spanish-copy</h1>
<span class="badge b-ok" style="height: 24px">{ico('check', 'ico ico-sm')}completada</span>
<span class="grow"></span>
<button type="button" class="btn">{ico('folder')}Ver worktree</button>
</div>
<div class="card card-pad col" style="gap: 10px">
<span class="t-label">Objetivo</span>
<p style="margin: 0; line-height: 1.55">Rewrite the Spanish UI copy so it reads as written in Spanish from Spain: a revised glossary, then every es locale file.</p>
<div class="row" style="gap: 6px; flex-wrap: wrap"><span class="badge">sonnet</span><span class="badge">un worktree por tarea</span><span class="badge">6 tareas</span><span class="badge">20:32</span></div>
</div>
{orch_steps('wait' if opened else 'todo')}
{orch_integration(opened)}
</main>'''


def orch_dialog():
  return f'''<div class="scrim" style="z-index: 30">
<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="push-title" style="width: 520px">
<div class="dialog-head"><h2 id="push-title" class="t-h2 grow">¿Subir <span class="mono">orch/spanish-copy</span>?</h2><button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Cerrar">{ico('x')}</button></div>
<div class="dialog-body">
<p class="t-sm fg-2" style="margin: 0; line-height: 1.55">La rama se sube a origin y se abre una merge request para ella con glab.</p>
<div class="callout" style="align-items: flex-start">{ico('git', 'ico fg-3', 'flex-shrink: 0; margin-top: 1px')}<span class="col" style="gap: 4px"><span class="mono" style="color: var(--fg)">orch/spanish-copy → main</span><span class="mono t-xs fg-3">git.inmoseo.net · pagos/api · glab 1.120.0 · yeyo</span></span></div>
</div>
<div class="dialog-foot"><span class="grow"></span><button type="button" class="btn btn-ghost">Cancelar</button><button type="button" class="btn btn-primary">Subir y abrir la MR</button></div>
</div>
</div>'''


def orch_mr_desktop(name, opened, dialog=False):
  crumb = '<a href="DesktopOrquestaciones.html" class="fg-2">Orquestaciones</a><span class="fg-3">/</span><span style="font-weight: 500">spanish-copy</span>'
  write(name, desktop('Orquestación con MR', 'orch', crumb, orch_main(opened), overlay=orch_dialog() if dialog else ''))


def orch_mr_mobile(name, opened, dialog=False):
  head = (f'<header class="row" style="flex-shrink: 0; padding: 8px 4px; gap: 2px"><a href="MobileOrquestaciones.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver">{ico("left", "ico ico-lg", "stroke-width: 2")}</a>'
          f'<span class="col grow" style="gap: 2px"><span style="font-weight: 600; font-size: 16px">spanish-copy</span><span class="row t-xs mono c-ok" style="gap: 6px">{ico("check", "ico ico-sm")}completada</span></span>'
          f'<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Más acciones">{ico("more", "ico ico-lg", "stroke-width: 3")}</button></header>')
  chips = ''.join(f'<span class="badge b-ok" style="height: 28px; flex-shrink: 0">✓ {s.lower()}</span>' for s in ['etapas', 'integración', 'verificación']) \
    + ('<span class="badge b-idle" style="height: 28px; flex-shrink: 0">MR !14</span>' if opened else '<span class="badge" style="height: 28px; flex-shrink: 0">merge request</span>')
  if opened:
    card_ = (f'<section class="card col" style="padding: 14px; gap: 12px"><span class="row" style="gap: 8px"><span class="t-label grow">Su merge request</span><span class="mono t-xs fg-3">6/6 ramas fusionadas</span></span>'
             f'<a href="#" class="pr-row" target="_blank" rel="noreferrer" aria-label="Abrir MR !14 en GitLab"><span class="pr-num">MR !14</span><span class="pr-branch">orch/spanish-copy → main</span>'
             f'<span class="badge b-idle">esperando fusión</span>{ci_badge("passing")}</a>'
             f'<span class="t-xs fg-3" style="line-height: 1.45">Agentry sigue la MR en git.inmoseo.net. Cuando se fusione, te lo dirá aquí y quitará los worktrees.</span></section>')
    foot = f'<div class="m-foot"><a href="#" class="btn btn-lg grow" style="justify-content: center" target="_blank" rel="noreferrer">{ext_ico("ico ico-lg")}Abrir MR !14 en GitLab</a></div>'
  else:
    card_ = (f'<section class="card col" style="padding: 14px; gap: 10px"><span class="row" style="gap: 8px"><span class="t-label grow">Integración</span><span class="mono t-xs fg-3">6/6 ramas fusionadas</span></span>'
             f'<span class="row" style="gap: 8px">{ico("branch", "ico fg-3")}<span class="mono t-sm">orch/spanish-copy</span><span class="mono t-xs fg-3">desde main</span></span>'
             f'<span class="t-xs fg-3" style="line-height: 1.45">Sube la rama a origin y abre una merge request hacia main en git.inmoseo.net con glab.</span></section>')
    foot = f'<div class="m-foot"><button type="button" class="btn btn-lg btn-primary grow" style="justify-content: center">{ico("branch", "ico ico-lg")}Abrir merge request</button></div>'
  sheet_ = ''
  if dialog:
    sheet_ = f'''{scrim()}
<div class="sheet" role="dialog" aria-label="Subir la rama" style="z-index: 11; padding-bottom: 28px; display: flex; flex-direction: column; gap: 12px">
<div class="grab" style="margin-bottom: 0"></div>
<div class="col" style="gap: 2px"><h2 class="t-h2">¿Subir <span class="mono">orch/spanish-copy</span>?</h2></div>
<p class="t-sm fg-2" style="margin: 0; line-height: 1.5">La rama se sube a origin y se abre una merge request para ella con glab.</p>
<div class="callout" style="align-items: flex-start">{ico('git', 'ico fg-3', 'flex-shrink: 0; margin-top: 1px')}<span class="col" style="gap: 4px; min-width: 0"><span class="mono" style="color: var(--fg)">orch/spanish-copy → main</span><span class="mono t-xs fg-3" style="overflow-wrap: anywhere">git.inmoseo.net · pagos/api · glab 1.120.0 · yeyo</span></span></div>
<div class="row" style="gap: 8px"><button type="button" class="btn btn-lg">Cancelar</button><button type="button" class="btn btn-lg btn-primary grow" style="justify-content: center">Subir y abrir la MR</button></div>
</div>'''
  inner = (f'{head}\n<div class="m-body" style="gap: 14px"><p class="t-sm fg-2" style="margin: 0; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden">Rewrite the Spanish UI copy so it reads as written in Spanish from Spain: a revised glossary, then every es locale file.</p>'
           f'<div class="row" style="gap: 6px; overflow: hidden">{chips}</div>{card_}</div>\n{foot}\n{sheet_}')
  write(name, mobile('Orquestación con MR', inner, 'glow-top', 'background-size: 100% 300px'))


# ---------------------------------------------------------------- DSIntegraciones
def ds_integrations():
  head = ('<header class="col" style="gap: 8px"><span class="t-label">Agentry design system · alojamientos de código · integraciones</span>'
          '<h1 class="t-display" style="margin: 0">Integraciones</h1>'
          '<p class="fg-2" style="margin: 0; max-width: 900px; line-height: 1.55">Cómo dice Agentry dónde vive el código de un proyecto y si puede hablar con ese host. '
          'Siempre una palabra de estado junto al color, una razón en lenguaje llano y una sola acción.</p></header>')
  sections = [p2_section(), p3_section()]
  body = (f'<div class="app col" data-theme="dark" style="width: 1440px; height: 4400px; padding: 56px 64px; gap: 40px; overflow: hidden">'
          f'{head}{"".join(sections)}</div>')
  write('DSIntegraciones.html', page('Design system · Integraciones', body))


# ---------------------------------------------------------------- run
if __name__ == '__main__':
  desktop_integrations()
  desktop_states()
  desktop_nothing()
  mobile_integrations('MobileIntegraciones.html', 'Ajustes, integraciones')
  mobile_states('MobileIntegracionesEstados.html', 'Ajustes, integraciones con otros estados', SCENARIOS[:1])
  mobile_states('MobileIntegracionesSinInstalar.html', 'Ajustes, integraciones sin instalar y comprobando', SCENARIOS[1:])
  mobile_nothing()
  mobile_integrations('MobileIntegracionesBinario.html', 'Ajustes, binario de una integración', sheet=binary_sheet(MAIN[1]))
  ds_integrations()
  orch_mr_desktop('DesktopOrquestacionMR.html', True)
  orch_mr_desktop('DesktopOrquestacionMRSubir.html', False, dialog=True)
  orch_mr_mobile('MobileOrquestacionMR.html', True)
  orch_mr_mobile('MobileOrquestacionMRSubir.html', False, dialog=True)
