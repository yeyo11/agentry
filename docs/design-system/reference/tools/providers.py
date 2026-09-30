# Providers (plans/multi-provider.md, P0 task p1): the first-run Providers step and Settings →
# Providers, on a desktop and on a phone. Runs on its own, after nothing: it imports common.py and
# the settings nav of decisions.py.
#   python3 providers.py
from common import P, ico, desktop, mobile, write, page, tabbar, BRAND
from decisions import SETTINGS_NAV, scrim

P.update({
  'grip': 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  'ext': 'M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  'up': 'm6 15 6-6 6 6',
  'down': 'm6 9 6 6 6-6',
})

# ---------------------------------------------------------------- data
# id -> label, monogram letters, hue (never a status hue: red, green or cyan)
PROV = {
  'claude-code': ('Claude Code', 'CC', 24),
  'copilot': ('GitHub Copilot', 'GH', 262),
  'codex': ('Codex', 'CX', 215),
  'gemini': ('Gemini CLI', 'GM', 288),
  'opencode': ('OpenCode', 'OC', 45),
}

# state -> word, badge class, dot class. Every state is a status colour with its word; a provider that
# is not installed has no status to colour, so it is the plain badge.
STATE = {
  'ready': ('Listo', 'b-ok', 'dot-ok'),
  'degraded': ('Con avisos', 'b-warn', 'dot-warn'),
  'signed-out': ('Sin sesión', 'b-warn', 'dot-warn'),
  'incompatible': ('Incompatible', 'b-bad', 'dot-bad'),
  'used-before': ('Usado antes', 'b-idle', 'dot-idle'),
  'not-installed': ('No instalado', '', ''),
  'unknown': ('Sin comprobar', 'b-idle', 'dot-idle'),
  'disabled': ('Desactivado', '', ''),
}

# The machine of the plan: Claude Code ready, Copilot signed out, Codex and Gemini used before, one not installed
MACHINE_A = [
  dict(id='claude-code', state='ready', version='2.1.282', path='~/.local/bin/claude', account='yeyo@inmoseo.net', reason='Instalado, con sesión iniciada y respondiendo.', default=True),
  dict(id='copilot', state='signed-out', version='1.0.4', path='/usr/local/bin/copilot', account='Sin cuenta', reason='Instalado, pero sin sesión iniciada.'),
  dict(id='codex', state='used-before', version='', path='~/.codex', account='Sin cuenta', reason='Hay configuración en ~/.codex, pero no se encuentra el programa.'),
  dict(id='gemini', state='used-before', version='', path='~/.gemini', account='Sin cuenta', reason='Hay configuración en ~/.gemini, pero no se encuentra el programa.'),
  dict(id='opencode', state='not-installed', version='', path='', account='Sin cuenta', reason='No hay rastro de OpenCode en este equipo.'),
]

# Another machine, for the states the first one does not have. OpenCode is being dragged above Gemini.
MACHINE_B = [
  dict(id='claude-code', state='degraded', version='2.0.8', range='≥ 2.1 < 3', path='~/.local/bin/claude', account='yeyo@inmoseo.net', reason='Funciona, pero la 2.0.8 es anterior a las versiones con las que Agentry se ha probado (2.1 a 2.x).', default=True),
  dict(id='copilot', state='incompatible', version='2.0.0', range='≥ 1.0 < 2', path='/usr/local/bin/copilot', account='yeyo-dev', reason='La 2.0.0 es más nueva de lo que Agentry sabe usar (1.x). Instala una anterior y elígela aquí.'),
  dict(id='codex', state='unknown', version='', path='~/.codex', account='Sin cuenta', reason='No se ha podido comprobar: no ha respondido en 10 s.'),
  dict(id='opencode', state='ready', version='1.4.2', path='~/.local/bin/opencode', account='yeyo@inmoseo.net', reason='Instalado, con sesión iniciada y respondiendo.', lifted=True),
  dict(id='gemini', state='disabled', version='0.9.1', path='~/.nvm/…/bin/gemini', account='yeyo@inmoseo.net', reason='No se busca ni se comprueba mientras esté desactivado.', off=True),
]


# ---------------------------------------------------------------- pieces
def badge(state):
  word, cls, dot = STATE[state]
  d = f'<span class="dot {dot}" style="width: 6px; height: 6px"></span>' if dot else ''
  return f'<span class="badge {cls}">{d}{word}</span>'.replace('badge "', 'badge"').replace('badge  ', 'badge ')


def mono_ico(pid):
  label, letters, hue = PROV[pid]
  return f'<span class="proj monogram" style="--hue: {hue}" role="img" aria-label="{label}" title="{label}">{letters}</span>'


def actions(p, open_=False):
  """The one action of a state first, then what else the state offers. Every button is neutral: the
  gradient is the page's, not a row's."""
  s, label = p['state'], PROV[p['id']][0]
  ext = ico('ext', 'ico ico-sm')
  out = []
  if s == 'signed-out':
    out.append(f'<button type="button" class="btn">Iniciar sesión{ext}</button>')
  elif s == 'used-before':
    pressed = ' aria-pressed="true"' if open_ else ''
    out.append(f'<button type="button" class="btn"{pressed}>Elegir binario</button>')
    out.append(f'<button type="button" class="btn btn-ghost">Instalar{ext}</button>')
  elif s == 'not-installed':
    out.append(f'<button type="button" class="btn">Instalar{ext}</button>')
  elif s == 'degraded':
    out.append(f'<button type="button" class="btn">Actualizar{ext}</button>')
    out.append('<button type="button" class="btn btn-ghost">Seguir así</button>')
  elif s == 'incompatible':
    out.append('<button type="button" class="btn">Elegir binario</button>')
    out.append(f'<button type="button" class="btn btn-ghost">Ver instalación{ext}</button>')
  elif s == 'unknown':
    out.append(f'<button type="button" class="btn">{ico("retry", "ico ico-sm")}Reintentar</button>')
  return out


def switch(p):
  on = not p.get('off')
  return (f'<span class="switch{" on" if on else ""}" role="switch" aria-checked="{"true" if on else "false"}" tabindex="0" '
          f'aria-label="{"Desactivar" if on else "Activar"} {PROV[p["id"]][0]}"></span>')


def identity(p):
  label = PROV[p['id']][0]
  dflt = '<span class="badge b-accent">Predeterminado</span>' if p.get('default') else ''
  meta = ' · '.join(x for x in [('v' + p['version']) if p['version'] else '', p.get('range', ''), p['path']] if x)
  return (f'<div class="prov-id"><span class="prov-name">{label}{dflt}</span>'
          f'<span class="t-sm fg-2">{p["account"]}</span>'
          f'<span class="prov-meta ellipsis">{meta}</span></div>')


def state_col(p):
  return f'<div class="prov-state">{badge(p["state"])}<p class="prov-reason">{p["reason"]}</p></div>'


def row(p, compact=False, open_=False):
  cls = 'prov-row' + (' compact' if compact else '') + (' open' if open_ else '') + (' lifted' if p.get('lifted') else '')
  grip = f'<span class="prov-grip" aria-hidden="true">{ico("grip", "ico ico-lg")}</span>' if not compact else ''
  sw = '' if compact else switch(p)
  acts = ''.join(actions(p, open_))
  return (f'<div class="{cls}" data-provider="{p["id"]}">{grip}{mono_ico(p["id"])}{identity(p)}{state_col(p)}'
          f'<div class="prov-actions">{acts}</div>{sw}</div>')


def bin_panel():
  return f'''<div class="prov-bin" role="group" aria-label="Binario de Codex">
<span class="t-label">Binario de Codex</span>
<div class="prov-bin-row"><label class="field field-mono grow">{ico("folder", "ico fg-3")}<input class="mono" value="/opt/codex/bin/codex" aria-label="Ruta del binario de Codex"></label><button type="button" class="btn">Buscar…</button></div>
<span class="form-hint">Agentry usa este programa en lugar de buscar en el PATH. Antes de guardarlo lee su versión y comprueba que está dentro del rango probado (<span class="mono">≥ 0.40</span>).</span>
<div class="row" style="gap: 8px"><button type="button" class="btn">Comprobar y guardar</button><button type="button" class="btn btn-ghost">Cancelar</button><span class="grow"></span><button type="button" class="btn btn-ghost btn-sm">Usar el del PATH</button></div>
</div>'''


def card_head(title, hint, id_):
  return f'<div class="card-head" id="{id_}">{ico("resources", "ico fg-3")}<h2 class="t-h2">{title}</h2><span class="mono t-xs fg-3 grow" style="text-align: right">{hint}</span></div>'


def settings_nav():
  out = []
  for g, items in SETTINGS_NAV:
    if g == 'Agentry':
      items = ['Apariencia', 'Notificaciones', 'Editor', 'Cuenta', 'Proveedores', 'Decisiones']
    links = ''.join(f'<a href="#" class="nav-item{" on" if i == "Proveedores" else ""}" style="height: 30px; font-size: 13px">{i}</a>' for i in items)
    out.append(f'<div class="col" style="gap: 1px"><span class="t-label" style="padding: 0 10px 4px">{g}</span>{links}</div>')
  return ('<nav aria-label="Secciones de ajustes" class="col" style="width: 236px; flex-shrink: 0; padding: 26px 12px 20px 24px; gap: 16px; overflow: hidden; border-right: 1px solid var(--line)">'
          '<h1 class="t-h1" style="padding-left: 10px; font-size: 20px">Ajustes</h1>' + ''.join(out) + '</nav>')


def counts(machine):
  ready = sum(1 for p in machine if p['state'] == 'ready')
  return f'{len(machine)} proveedores · {ready} listo' + ('s' if ready != 1 else '')


# ---------------------------------------------------------------- Settings → Providers, desktop
def default_strip(machine):
  first = machine[0]
  ctl = (f'<select class="select" aria-label="Proveedor predeterminado" style="width: 230px"><option>{PROV[first["id"]][0]}</option>'
         f'<option>Automático (el primero listo)</option></select>')
  return (f'<div class="row" style="padding: 16px 18px; gap: 24px; border-bottom: 1px solid var(--line); align-items: center">'
          f'<div class="col grow" style="gap: 4px"><span style="font-weight: 500">Proveedor predeterminado</span>'
          f'<span class="t-sm fg-2">Lo usan los chats nuevos. Con «Automático» es el primero que esté listo, en el orden de esta lista: arrastra por el asa para cambiarlo.</span></div>{ctl}</div>')


def desktop_settings(name, title, machine, open_id=None, drop_after=None):
  rows = []
  for p in machine:
    rows.append(row(p, open_=(p['id'] == open_id)))
    if p['id'] == open_id:
      rows.append(bin_panel())
    if p['id'] == drop_after:
      rows.append('<div class="prov-drop" aria-hidden="true"></div>')
  head = (f'<div class="row" style="gap: 20px; align-items: flex-end"><div class="col grow" style="gap: 4px"><h2 class="t-h1" style="font-size: 20px">Proveedores</h2>'
          f'<p class="fg-2 t-sm" style="margin: 0; max-width: 640px">Los agentes de programación que Agentry encuentra en este equipo. Si instalas uno o inicias sesión en una terminal, esta lista se actualiza sola.</p></div>'
          f'<span class="mono t-xs fg-3" style="white-space: nowrap; padding-bottom: 6px">Comprobado hace 2 min</span>'
          f'<button type="button" class="btn">{ico("retry", "ico")}Volver a comprobar</button></div>')
  card = (f'<section class="card grad-border col" style="flex-shrink: 0; gap: 0; overflow: hidden" aria-labelledby="sec-providers">'
          f'{card_head("Proveedores", counts(machine), "sec-providers")}{default_strip(machine)}{"".join(rows)}</section>')
  main = f'<main class="col grow" style="padding: 26px 32px; gap: 18px; min-width: 0">{head}{card}</main>'
  inner = f'<div class="row" style="flex: 1 1 auto; min-height: 0; align-items: stretch; gap: 0; overflow: hidden">{settings_nav()}{main}</div>'
  write(name, desktop(title, 'settings', '<span style="font-weight: 500">Ajustes</span>', inner, project='Todos los proyectos', agents=3, running=3))


# ---------------------------------------------------------------- Settings → Providers, phone
def mhead(title, back='MobileAjustes.html'):
  return (f'<header class="m-head" style="padding-left: 4px"><a href="{back}" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver">{ico("left", "ico ico-lg", "stroke-width: 2")}</a>'
          f'<h1 class="t-h1 grow">{title}</h1></header>')


def pcell(p, compact=False):
  label = PROV[p['id']][0]
  dflt = '<span class="badge b-accent">Predeterminado</span>' if p.get('default') else ''
  meta = ' · '.join(x for x in [('v' + p['version']) if p['version'] else '', p['account']] if x)
  chev = '' if compact else ico('right', 'ico fg-3')
  acts = ''.join(actions(p))
  acts_html = f'<div class="row" style="gap: 8px; flex-wrap: wrap">{acts}</div>' if acts else ''
  head = (f'<div class="prov-cell-head">{mono_ico(p["id"])}<div class="grow"><span class="row" style="gap: 8px; flex-wrap: wrap"><span style="font-weight: 500">{label}</span>{dflt}</span>'
          f'<span class="prov-meta">{meta}</span></div>{badge(p["state"])}{chev}</div>')
  tag = 'div' if compact else 'div'
  return f'<{tag} class="prov-cell" data-provider="{p["id"]}">{head}<p class="prov-reason">{p["reason"]}</p>{acts_html}</{tag}>'


def mbody(machine):
  first = PROV[machine[0]['id']][0]
  order_cell = (f'<a href="#" class="cell card" style="min-height: 56px" aria-label="Predeterminado y orden">{ico("list", "ico fg-3")}'
                f'<span class="grow col" style="gap: 1px"><span style="font-weight: 500">Predeterminado y orden</span><span class="mono t-xs fg-3">{first} · 1.º de {len(machine)}</span></span>{ico("right", "ico fg-3")}</a>')
  return f'''{mhead('Proveedores')}
<div class="m-body" style="gap: 12px">
<p class="t-sm fg-2" style="margin: 0 4px; line-height: 1.5">Los agentes de programación que Agentry encuentra en este equipo. Si instalas uno o inicias sesión en una terminal, la lista se actualiza sola.</p>
<div class="row" style="gap: 10px"><button type="button" class="btn grow" style="justify-content: center">{ico("retry", "ico")}Volver a comprobar</button><span class="mono t-xs fg-3" style="white-space: nowrap">hace 2 min</span></div>
{order_cell}
<section class="card grad-border" style="overflow: hidden" aria-label="Proveedores">{"".join(pcell(p) for p in machine)}</section>
</div>'''


def mobile_settings(name, title, machine, sheet=''):
  inner = mbody(machine)
  if sheet:
    write(name, mobile(title, f'{inner}\n{sheet}'))
  else:
    write(name, mobile(title, inner + '\n' + tabbar('more')))


def order_sheet(machine):
  auto = (f'<div class="prov-order-row"><button type="button" class="btn btn-ghost btn-icon btn-lg" role="radio" aria-checked="false" aria-label="Automático, el primero listo"><span class="prov-radio"></span></button>'
          f'<span class="grow col" style="gap: 1px"><span>Automático</span><span class="t-xs fg-3">El primero listo, en este orden</span></span></div>')
  rows = []
  for i, p in enumerate(machine):
    label = PROV[p['id']][0]
    on = ' on' if p.get('default') else ''
    up = f'<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Subir {label}"{" disabled" if i == 0 else ""}>{ico("up", "ico ico-lg")}</button>'
    dn = f'<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Bajar {label}"{" disabled" if i == len(machine) - 1 else ""}>{ico("down", "ico ico-lg")}</button>'
    rows.append(f'<div class="prov-order-row"><button type="button" class="btn btn-ghost btn-icon btn-lg" role="radio" aria-checked="{"true" if on else "false"}" aria-label="{label} predeterminado"><span class="prov-radio{on}"></span></button>'
                f'<span class="grow col" style="gap: 1px"><span>{label}</span><span class="mono t-xs fg-3">{i + 1}.º · {STATE[p["state"]][0]}</span></span>{up}{dn}</div>')
  return f'''{scrim()}
<div class="sheet" role="dialog" aria-label="Predeterminado y orden" style="z-index: 11; padding-bottom: 28px; display: flex; flex-direction: column; gap: 12px; max-height: 92%">
<div class="grab" style="margin-bottom: 0"></div>
<div class="col" style="gap: 2px"><h2 class="t-h2">Predeterminado y orden</h2><span class="t-sm fg-2">El predeterminado lo usan los chats nuevos. Sube o baja para cambiar el orden.</span></div>
<div class="col" style="gap: 0" role="radiogroup" aria-label="Proveedor predeterminado">{auto}{"".join(rows)}</div>
<div class="row" style="gap: 8px"><button type="button" class="btn btn-lg">Cancelar</button><button type="button" class="btn btn-lg btn-primary grow">Guardar</button></div>
</div>'''


def binary_sheet(p):
  label = PROV[p['id']][0]
  return f'''{scrim()}
<div class="sheet" role="dialog" aria-label="{label}" style="z-index: 11; padding-bottom: 28px; display: flex; flex-direction: column; gap: 12px; max-height: 92%">
<div class="grab" style="margin-bottom: 0"></div>
<div class="prov-cell-head">{mono_ico(p["id"])}<div class="grow"><h2 class="t-h2">{label}</h2><span class="mono t-xs fg-3">{p["path"]}</span></div>{badge(p["state"])}</div>
<p class="prov-reason" style="font-size: 14px">{p["reason"]}</p>
<label class="row" style="gap: 12px; min-height: 48px"><span class="grow" style="font-weight: 500">Activado</span>{switch(p).replace('<span class="switch', '<span class="switch switch-lg')}</label>
<div class="col" style="gap: 8px"><span class="t-label">Binario</span>
<label class="field field-lg field-mono">{ico("folder", "ico fg-3")}<input class="mono" value="/opt/codex/bin/codex" aria-label="Ruta del binario de Codex" style="font-size: 16px"></label>
<span class="form-hint">Agentry lo usa en lugar de buscar en el PATH. Antes de guardarlo lee su versión y comprueba que está dentro del rango probado (<span class="mono">≥ 0.40</span>).</span></div>
<div class="col" style="gap: 8px"><button type="button" class="btn btn-lg btn-primary">Comprobar y guardar</button>
<div class="row" style="gap: 8px"><button type="button" class="btn btn-lg btn-ghost grow" style="justify-content: center">Usar el del PATH</button><button type="button" class="btn btn-lg btn-ghost">Instalar{ico("ext", "ico ico-sm")}</button></div></div>
</div>'''


# ---------------------------------------------------------------- first run
def _il(size, body):
  g, d, fg, fm = 'il-grad', 'il-dots', 'il-fade-g', 'il-fade'
  return f'''<svg class="il {size}" viewBox="0 0 240 160" aria-hidden="true"><defs><linearGradient id="{g}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="stop-a"></stop><stop offset="1" class="stop-b"></stop></linearGradient><pattern id="{d}" width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" class="dot-fill"></circle></pattern><radialGradient id="{fg}" cx="0.5" cy="0.5" r="0.5"><stop offset="0" class="stop-in"></stop><stop offset="1" class="stop-out"></stop></radialGradient><mask id="{fm}"><rect x="0" y="0" width="240" height="160" fill="url(#{fg})"></rect></mask></defs>{body}</svg>'''


# The set's `install` illustration, as it is in illustrations/install.svg
INSTALL_BODY = '''<rect x="0" y="0" width="240" height="160" class="f-dots" mask="url(#il-fade)"></rect>
<g class="a-float"><path d="M50 36 V70 M38 58 l12 12 l12 -12 M34 84 h32" class="ln-grad w3"></path></g>
<rect x="86" y="12" width="68" height="136" rx="15" class="c1"></rect>
<rect x="108" y="18" width="24" height="5" rx="2.5" class="s3"></rect><rect x="108" y="139" width="24" height="3" rx="1.5" class="s3"></rect>
<circle cx="120" cy="70" r="26" class="halo"></circle>
<rect x="104" y="54" width="32" height="32" rx="9" class="f-grad"></rect>
<circle cx="112" cy="63" r="3" class="f-white"></circle><circle cx="128" cy="63" r="3" class="f-white"></circle><circle cx="120" cy="77" r="3" class="f-white"></circle>
<path d="M113.5 65.5 L118.5 74.5 M126.5 65.5 L121.5 74.5" class="ln-white" style="stroke-width: 1.5"></path>
<rect x="108" y="92" width="24" height="4" rx="2" class="s3"></rect>
<g class="a-float-2"><rect x="144" y="32" width="86" height="36" rx="10" class="c2"></rect><rect x="152" y="41" width="18" height="18" rx="5" class="f-grad"></rect><rect x="176" y="43" width="44" height="5" rx="2.5" class="s3"></rect><rect x="176" y="53" width="30" height="5" rx="2.5" class="s3"></rect><circle cx="228" cy="34" r="4.5" class="f-accent"></circle></g>'''

GROUPS = [('ready', 'Listos'), ('signed-out', 'Sin sesión'), ('used-before', 'Usados antes'), ('not-installed', 'Sin instalar')]
SKIP = '<button type="button" class="btn btn-ghost">Omitir por ahora</button>'


def brand_row(right=''):
  return (f'<div class="row" style="gap: 10px; height: 32px">{BRAND}<span style="font-weight: 600; font-size: 15px; letter-spacing: -0.02em">Agentry</span>'
          f'<span class="grow"></span>{right}</div>')


def first_head(kind):
  if kind == 'found':
    return ('<div class="col" style="gap: 10px"><h1 class="t-display" style="margin: 0">Estos son los agentes de tu equipo</h1>'
            '<p class="fg-2" style="margin: 0; max-width: 620px; line-height: 1.55">Agentry los ha buscado en el PATH de tu terminal y en las carpetas de instalación habituales. Empiezas con el primero que esté listo; el orden y el resto los cambias luego en Ajustes.</p></div>')
  return ('<div class="col" style="gap: 10px"><h1 class="t-display" style="margin: 0">Buscando agentes en tu equipo</h1>'
          '<p class="fg-2" style="margin: 0; max-width: 620px; line-height: 1.55">Lee el PATH de tu terminal, las carpetas de instalación y la configuración de cada agente. Cada uno se comprueba por separado, así que no hace falta esperar a todos.</p></div>')


def desktop_first(name, title, kind):
  if kind == 'found':
    groups = []
    for st, lab in GROUPS:
      ps = [p for p in MACHINE_A if p['state'] == st]
      if ps:
        groups.append(f'<div class="prov-group"><div class="prov-group-head"><span class="t-label">{lab}</span><span class="mono t-xs fg-3">{len(ps)}</span></div>'
                      f'<section class="card" style="overflow: hidden">{"".join(row(p, compact=True) for p in ps)}</section></div>')
    body = ''.join(groups)
    foot = (f'<div class="row" style="gap: 10px"><span class="prov-step-note grow">{ico("activity", "ico ico-sm")}Agentry vigila tus carpetas: lo que instales o inicies en una terminal aparece aquí solo.</span>'
            f'<button type="button" class="btn btn-ghost">{ico("retry", "ico")}Volver a comprobar</button>{SKIP}<button type="button" class="btn btn-primary">Continuar con Claude Code</button></div>')
  elif kind == 'checking':
    rows = [row(MACHINE_A[0], compact=True)] + [checking_row(pid, i) for i, pid in enumerate(['copilot', 'codex', 'gemini', 'opencode'])]
    body = f'<section class="card" style="overflow: hidden" aria-busy="true">{"".join(rows)}</section>'
    foot = (f'<div class="row" style="gap: 10px"><span class="prov-step-note grow"><span class="spin-braille"></span>Comprobando · 1 de 5</span>'
            f'{SKIP}<button type="button" class="btn btn-primary" disabled>Continuar</button></div>')
  else:
    chips = ''.join(f'<a href="#" class="chip">{PROV[i][0]}{ico("ext", "ico ico-sm")}</a>' for i in ['codex', 'gemini', 'copilot', 'opencode'])
    body = f'''<div class="empty-state" style="padding: 8px 24px 0">{_il('il-lg', INSTALL_BODY)}
<h2 class="t-h2">No se ha encontrado ningún agente</h2>
<p>Agentry ha buscado en el PATH de tu terminal y en las carpetas de instalación habituales, y no hay ninguno. Instala uno y aparecerá aquí solo, sin volver a comprobar.</p>
<div class="row" style="gap: 8px"><a href="#" class="btn btn-primary">Ver cómo instalar Claude Code{ico("ext", "ico ico-sm")}</a><button type="button" class="btn">{ico("retry", "ico")}Volver a comprobar</button></div>
<div class="col" style="gap: 8px; align-items: center"><span class="t-label">O elige otro</span><div class="row" style="gap: 6px; flex-wrap: wrap; justify-content: center">{chips}</div></div></div>'''
    foot = f'<div class="row" style="justify-content: center; gap: 10px">{SKIP}</div>'
  head = first_head('found' if kind == 'found' else 'checking') if kind != 'empty' else ''
  inner = f'<div class="prov-first" style="padding: 32px 0 40px">{brand_row(f"<span class=t-label>Primer arranque</span>")}{head}{body}{foot}</div>'
  html = page(title + ' (desktop)', f'<div class="app glow-top" data-theme="dark" style="width: 1440px; height: 1024px; overflow: hidden">{inner}</div>')
  write(name, html)


def checking_row(pid, i):
  label = PROV[pid][0]
  # The check that is running says so; the rest wait behind skeleton bars
  if i == 0:
    state = f'<span class="badge"><span class="spin-braille"></span>Comprobando</span><p class="prov-reason">Leyendo la versión y la sesión…</p>'
  else:
    state = '<span class="skeleton" style="width: 92px; height: 20px" aria-hidden="true"></span><span class="skeleton" style="width: 60%; height: 10px" aria-hidden="true"></span>'
  ident = (f'<div class="prov-id"><span class="prov-name">{label}</span><span class="skeleton" style="width: 110px; height: 10px; margin-top: 4px" aria-hidden="true"></span></div>')
  return f'<div class="prov-row compact" data-provider="{pid}">{mono_ico(pid)}{ident}<div class="prov-state">{state}</div><div class="prov-actions"></div></div>'


def mfirst(name, title, kind):
  if kind == 'found':
    ps = [p for st, _ in GROUPS for p in MACHINE_A if p['state'] == st]
    body = (f'<div class="col" style="gap: 8px"><h1 class="t-h1" style="font-size: 24px">Estos son los agentes de tu equipo</h1>'
            f'<p class="t-sm fg-2" style="margin: 0; line-height: 1.5">Empiezas con el primero que esté listo. El orden y el resto los cambias luego en Ajustes.</p></div>'
            f'<section class="card" style="overflow: hidden">{"".join(pcell(p, compact=True) for p in ps)}</section>')
    foot = ('<div class="m-foot" style="flex-direction: column"><button type="button" class="btn btn-lg btn-primary">Continuar con Claude Code</button>'
            '<div class="row" style="gap: 8px"><button type="button" class="btn btn-lg btn-ghost grow" style="justify-content: center">Omitir por ahora</button>'
            f'<button type="button" class="btn btn-lg btn-ghost grow" style="justify-content: center">{ico("retry", "ico")}Volver a comprobar</button></div></div>')
  elif kind == 'checking':
    cells = [pcell(MACHINE_A[0], compact=True)] + [mchecking_cell(pid, i) for i, pid in enumerate(['copilot', 'codex', 'gemini', 'opencode'])]
    body = (f'<div class="col" style="gap: 8px"><h1 class="t-h1" style="font-size: 24px">Buscando agentes en tu equipo</h1>'
            f'<p class="t-sm fg-2" style="margin: 0; line-height: 1.5">Cada uno se comprueba por separado, así que no hace falta esperar a todos.</p></div>'
            f'<span class="prov-step-note"><span class="spin-braille"></span>Comprobando · 1 de 5</span>'
            f'<section class="card" style="overflow: hidden" aria-busy="true">{"".join(cells)}</section>')
    foot = ('<div class="m-foot" style="flex-direction: column"><button type="button" class="btn btn-lg btn-primary" disabled>Continuar</button>'
            '<button type="button" class="btn btn-lg btn-ghost" style="justify-content: center">Omitir por ahora</button></div>')
  else:
    chips = ''.join(f'<a href="#" class="chip">{PROV[i][0]}{ico("ext", "ico ico-sm")}</a>' for i in ['codex', 'gemini', 'copilot', 'opencode'])
    body = f'''<div class="empty-state" style="padding: 12px 8px 0">{_il('il-sm', INSTALL_BODY)}
<h2 class="t-h2">No se ha encontrado ningún agente</h2>
<p>Agentry ha buscado en el PATH de tu terminal y en las carpetas de instalación habituales, y no hay ninguno. Instala uno y aparecerá aquí solo.</p>
<div class="col" style="gap: 8px; align-self: stretch"><a href="#" class="btn btn-lg btn-primary" style="justify-content: center">Ver cómo instalar Claude Code{ico("ext", "ico ico-sm")}</a><button type="button" class="btn btn-lg" style="justify-content: center">{ico("retry", "ico")}Volver a comprobar</button></div>
<div class="col" style="gap: 8px; align-items: center"><span class="t-label">O elige otro</span><div class="row" style="gap: 6px; flex-wrap: wrap; justify-content: center">{chips}</div></div></div>'''
    foot = '<div class="m-foot" style="flex-direction: column"><button type="button" class="btn btn-lg btn-ghost" style="justify-content: center">Omitir por ahora</button></div>'
  inner = (f'<div class="m-body glow-top" style="padding-top: 20px; gap: 16px">{brand_row("<span class=t-label>Primer arranque</span>")}{body}</div>\n{foot}')
  write(name, mobile(title, inner))


def mchecking_cell(pid, i):
  label = PROV[pid][0]
  head = (f'<div class="prov-cell-head">{mono_ico(pid)}<div class="grow"><span style="font-weight: 500">{label}</span>'
          f'<span class="skeleton" style="width: 110px; height: 10px; margin-top: 4px" aria-hidden="true"></span></div>'
          f'<span class="skeleton" style="width: 84px; height: 20px" aria-hidden="true"></span></div>')
  if i == 0:
    head = head.replace('<span class="skeleton" style="width: 84px; height: 20px" aria-hidden="true"></span>', '<span class="badge"><span class="spin-braille"></span>Comprobando</span>')
  return f'<div class="prov-cell" data-provider="{pid}">{head}</div>'


# ---------------------------------------------------------------- run
if __name__ == '__main__':
  desktop_settings('DesktopProveedores.html', 'Ajustes, proveedores', MACHINE_A, open_id='codex')
  desktop_settings('DesktopProveedoresEstados.html', 'Ajustes, proveedores con otros estados', MACHINE_B, drop_after='claude-code')
  mobile_settings('MobileProveedores.html', 'Ajustes, proveedores', MACHINE_A)
  mobile_settings('MobileProveedoresEstados.html', 'Ajustes, proveedores con otros estados', MACHINE_B)
  mobile_settings('MobileProveedoresOrden.html', 'Ajustes, predeterminado y orden', MACHINE_A, sheet=order_sheet(MACHINE_A))
  mobile_settings('MobileProveedoresBinario.html', 'Ajustes, binario de un proveedor', MACHINE_A, sheet=binary_sheet(MACHINE_A[2]))
  desktop_first('DesktopPrimerArranque.html', 'Primer arranque, proveedores', 'found')
  desktop_first('DesktopPrimerArranqueBuscando.html', 'Primer arranque, buscando', 'checking')
  desktop_first('DesktopPrimerArranqueVacio.html', 'Primer arranque, nada encontrado', 'empty')
  mfirst('MobilePrimerArranque.html', 'Primer arranque, proveedores', 'found')
  mfirst('MobilePrimerArranqueBuscando.html', 'Primer arranque, buscando', 'checking')
  mfirst('MobilePrimerArranqueVacio.html', 'Primer arranque, nada encontrado', 'empty')
