# Issue trackers (plans/code-hosts.md, phase 5, P0): the screens of the trackers. t-p1 is Settings →
# Integrations, the trackers' section, on a desktop and on a phone. t-p2 and t-p3 add their own functions
# below, each under its own banner. Runs on its own: it imports hosts.py for the pieces the two sections
# share (the states, the badge, the binary panel's look, the hosts card above the trackers).
#   python3 trackers.py
#
# Scope of this step: GitHub Issues and GitLab Issues. Jira (acli) and YouTrack (youtrack-app) have no
# recordings yet (plan: "Phase 5 in two steps"), so they are rows with readiness `unknown`, reason
# `not-recorded`, no action and no detail about their CLIs: nothing here is built on a fact nobody has seen.
from common import ico, write, tabbar, mobile
from decisions import scrim
from providers import card_head, mhead
from hosts import STATE, badge, head as hosts_head, hosts_card, desktop_page, scenario_label, mrecheck

# id -> label, monogram letters, hue (never a status hue: red, green or cyan), the CLI it goes through, the
# oldest version that works, an example key, the host it needs (None: not built in this step)
TRK = {
  'github-issues': ('GitHub Issues', 'GH', 262, 'gh', '2.92.0', '#12', 'GitHub'),
  'gitlab-issues': ('GitLab Issues', 'GL', 45, 'glab', '1.120.0', '#12', 'GitLab'),
  'jira': ('Jira', 'JR', 215, 'acli', '', 'CW-22', None),
  'youtrack': ('YouTrack', 'YT', 330, 'youtrack-app', '', 'PROJ-12', None),
}

# The words of the one state that is not in hosts.py: a tracker whose CLI nobody has recorded. It has no
# status to colour, so it is the plain badge, like a CLI that is not installed.
NOT_RECORDED = 'Aún no disponible'

# The two hosts the first machine has, as the hosts card above the trackers shows them. The hosts each CLI
# knows are on the hosts' own screens; here the card is the line a tracker's readiness comes from.
HOSTS = [
  dict(id='github', state='ready', version='2.92.0', path='/usr/bin/gh',
       hosts=[],
       reason='Instalado, con sesión iniciada y respondiendo.'),
  dict(id='gitlab', state='ready', version='1.120.0', path='~/.local/bin/glab',
       hosts=[],
       reason='Instalado, con sesión iniciada y respondiendo.'),
]

NOT_BUILT = {
  'jira': ('Jira todavía no está disponible: Agentry aún no ha visto cómo responde <span class="mono">acli</span> '
           'y no construye nada sobre algo que no ha visto.'),
  'youtrack': ('YouTrack todavía no está disponible: Agentry aún no ha visto cómo responde <span class="mono">youtrack-app</span> '
               'y no construye nada sobre algo que no ha visto.'),
}

MAIN = [
  dict(id='github-issues', state='ready', version='2.92.0', path='/usr/bin/gh',
       reason='Lee y escribe incidencias con gh, con la sesión que ya tiene. Sirve en los proyectos cuyo código está en GitHub.',
       short='Usa gh y su sesión, en proyectos con el código en GitHub.'),
  dict(id='gitlab-issues', state='ready', version='1.120.0', path='~/.local/bin/glab',
       reason='Lee y escribe incidencias con glab, con la sesión que ya tiene. Sirve en los proyectos cuyo código está en GitLab.',
       short='Usa glab y su sesión, en proyectos con el código en GitLab.'),
  dict(id='jira', state='not-recorded', version='', path='', reason=NOT_BUILT['jira'],
       short='Agentry aún no ha visto cómo responde <span class="mono">acli</span>, y no construye nada sobre eso.'),
  dict(id='youtrack', state='not-recorded', version='', path='', reason=NOT_BUILT['youtrack'],
       short='Agentry aún no ha visto cómo responde <span class="mono">youtrack-app</span>, y no construye nada sobre eso.'),
]

# Scenarios for the states the first machine lacks. A tracker's readiness is its host's (it reuses the CLI),
# so these are the host's states said in the tracker's words.
SCENARIOS = [
  ('Un gh antiguo y un glab sin sesión', [
    dict(id='github-issues', state='incompatible', version='2.45.0', path='/usr/bin/gh',
         reason='La 2.45.0 es anterior a la 2.92.0, la más antigua con la que funciona Agentry.'),
    dict(id='gitlab-issues', state='signed-out', version='1.120.0', path='~/.local/bin/glab',
         reason='glab está instalado, pero no tiene la sesión iniciada en ningún host.'),
  ]),
  ('Sin gh y un glab que no responde', [
    dict(id='github-issues', state='not-installed', version='', path='', reason='gh no está instalado, o Agentry no lo encuentra.'),
    dict(id='gitlab-issues', state='unknown', version='', path='~/.local/bin/glab', reason='glab no ha respondido en 10 s, así que Agentry lo ha detenido.'),
  ]),
  ('Justo después de abrir Agentry', [
    dict(id='github-issues', state='checking', version='', path='', reason='Leyendo la versión y los hosts…'),
    dict(id='gitlab-issues', state='checking', version='', path='', reason=''),
  ]),
]


# ---------------------------------------------------------------- pieces
def tbadge(t):
  if t['state'] == 'not-recorded':
    return f'<span class="badge">{NOT_RECORDED}</span>'
  return badge(t['state'])


def mono_ico(tid):
  label, letters, hue = TRK[tid][:3]
  return f'<span class="proj monogram" style="--hue: {hue}" role="img" aria-label="{label}" title="{label}">{letters}</span>'


def actions(t, open_=False):
  """One action each, every button neutral. A ready tracker offers the binary override (it is always
  allowed); the other states follow hosts.py's table; Jira and YouTrack offer nothing."""
  s = t['state']
  ext = ico('ext', 'ico ico-sm')
  pressed = ' aria-pressed="true"' if open_ else ''
  if s == 'not-recorded':
    return []
  if s == 'ready':
    return [f'<button type="button" class="btn btn-ghost"{pressed}>Elegir binario</button>']
  if s == 'signed-out':
    return [f'<a href="#" class="btn">Cómo iniciar sesión{ext}</a>']
  if s == 'incompatible':
    return [f'<a href="#" class="btn">Actualizar{ext}</a>', f'<button type="button" class="btn btn-ghost"{pressed}>Elegir binario</button>']
  if s == 'not-installed':
    return [f'<a href="#" class="btn">Ver instalación{ext}</a>', f'<button type="button" class="btn btn-ghost"{pressed}>Elegir binario</button>']
  if s == 'unknown':
    return [f'<button type="button" class="btn">{ico("retry", "ico ico-sm")}Reintentar</button>']
  return []


def meta(t):
  """`gh 2.92.0 · path`, or for a tracker nobody has recorded, the CLI it will use and nothing else."""
  cli, key = TRK[t['id']][3], TRK[t['id']][5]
  if t['state'] == 'not-recorded':
    return cli, key
  return ' · '.join(x for x in [f'{cli} {t["version"]}' if t['version'] else cli, t['path']] if x), key


def detail(t):
  """The registry's reason code, in mono, for the two trackers that are in it with no adapter."""
  if t['state'] != 'not-recorded':
    return ''
  return '<span class="mono t-xs fg-3">unknown · not-recorded</span>'


def identity(t):
  label = TRK[t['id']][0]
  m, key = meta(t)
  return (f'<div class="prov-id"><span class="prov-name">{label}<span class="mono t-xs fg-3">{key}</span></span>'
          f'<span class="prov-meta ellipsis">{m}</span></div>')


def checking_row(t, first):
  label = TRK[t['id']][0]
  ident = f'<div class="prov-id"><span class="prov-name">{label}</span><span class="skeleton" style="width: 110px; height: 10px; margin-top: 4px" aria-hidden="true"></span></div>'
  if first:
    state = f'{badge("checking")}<p class="prov-reason">{t["reason"]}</p>'
  else:
    state = '<span class="skeleton" style="width: 92px; height: 20px" aria-hidden="true"></span><span class="skeleton" style="width: 60%; height: 10px" aria-hidden="true"></span>'
  return f'<div class="prov-row compact" data-tracker="{t["id"]}">{mono_ico(t["id"])}{ident}<div class="prov-state">{state}</div><div class="prov-actions"></div></div>'


def row(t, open_=False, first=False):
  if t['state'] == 'checking':
    return checking_row(t, first)
  cls = 'prov-row compact' + (' open' if open_ else '')
  acts = ''.join(actions(t, open_))
  return (f'<div class="{cls}" data-tracker="{t["id"]}">{mono_ico(t["id"])}{identity(t)}'
          f'<div class="prov-state">{tbadge(t)}<p class="prov-reason">{t["reason"]}</p>{detail(t)}</div>'
          f'<div class="prov-actions">{acts}</div></div>')


def bin_panel(t):
  label, cli, minimum, host = TRK[t['id']][0], TRK[t['id']][3], TRK[t['id']][4], TRK[t['id']][6]
  return f'''<div class="prov-bin" role="group" aria-label="Binario de {cli} para {label}" style="padding-left: 68px">
<span class="t-label">Binario de {cli} para {label}</span>
<div class="prov-bin-row"><label class="field field-mono grow">{ico("folder", "ico fg-3")}<input class="mono" placeholder="El mismo que usa {host}" aria-label="Ruta del binario de {cli} para {label}"></label><button type="button" class="btn">Buscar…</button></div>
<span class="form-hint">Vacío, {label} usa el mismo programa que {host}. Si eliges otro, Agentry lee su versión antes de guardarlo y comprueba que no es anterior a la <span class="mono">{minimum}</span>.</span>
<div class="row" style="gap: 8px"><button type="button" class="btn">Comprobar y guardar</button><button type="button" class="btn btn-ghost">Cancelar</button><span class="grow"></span><button type="button" class="btn btn-ghost btn-sm">Usar el del host</button></div>
</div>'''


def summary(machine):
  ready = sum(1 for t in machine if t['state'] == 'ready')
  return f'{len(machine)} gestores · {ready} listo' + ('s' if ready != 1 else '')


INTRO = ('Agentry importa incidencias de GitHub Issues (<span class="mono">#12</span>) y GitLab Issues (<span class="mono">#12</span>) con los mismos programas '
         'que ya usa para las PR y las MR: no pide otra sesión ni guarda otra clave. Jira y YouTrack llegarán cuando se haya comprobado cómo responden sus programas.')


def trackers_card(machine, open_id=None, id_='sec-trackers', grad=True, heading=True):
  rows = []
  for i, t in enumerate(machine):
    rows.append(row(t, open_=(t['id'] == open_id), first=(i == 0)))
    if t['id'] == open_id:
      rows.append(bin_panel(t))
  cls = 'card grad-border col' if grad else 'card col'
  label = f'aria-labelledby="{id_}"' if heading else 'aria-label="Gestores de incidencias"'
  return (f'<section class="{cls}" style="flex-shrink: 0; gap: 0; overflow: hidden" {label}>'
          f'{card_head("Gestores de incidencias", summary(machine), id_) if heading else ""}{"".join(rows)}</section>')


# ---------------------------------------------------------------- t-p1 · Settings → Integrations, desktop
def trackers_intro():
  return f'<p class="fg-2 t-sm" style="margin: 0; max-width: 700px; line-height: 1.5">{INTRO}</p>'


def desktop_trackers():
  body = (hosts_head(intro=False) + hosts_card(HOSTS, grad=False)
          + f'<div class="col" style="gap: 8px">{trackers_intro()}</div>' + trackers_card(MAIN))
  desktop_page('DesktopIntegracionesTrackers.html', 'Ajustes, integraciones con gestores de incidencias', body)


def desktop_trackers_states():
  cards = ''.join(f'<div class="col" style="gap: 6px">{scenario_label(t)}'
                  f'{trackers_card(m, open_id="github-issues" if i == 0 else None, id_=f"sec-trackers-{i}", grad=False, heading=False)}</div>'
                  for i, (t, m) in enumerate(SCENARIOS))
  desktop_page('DesktopIntegracionesTrackersEstados.html', 'Ajustes, gestores de incidencias con otros estados',
               hosts_head(intro=False) + f'<div class="col" style="gap: 14px">{cards}</div>')


# ---------------------------------------------------------------- t-p1 · Settings → Integrations, phone
def pcell(t, first=False):
  label = TRK[t['id']][0]
  m, key = meta(t)
  if t['state'] == 'checking':
    right = badge('checking') if first else '<span class="skeleton" style="width: 84px; height: 20px" aria-hidden="true"></span>'
    sub = '<span class="skeleton" style="width: 110px; height: 10px; margin-top: 4px" aria-hidden="true"></span>'
    reason = f'<p class="prov-reason">{t["reason"]}</p>' if first and t['reason'] else ''
    hd = f'<div class="prov-cell-head">{mono_ico(t["id"])}<div class="grow"><span style="font-weight: 500">{label}</span>{sub}</div>{right}</div>'
    return f'<div class="prov-cell" data-tracker="{t["id"]}">{hd}{reason}</div>'
  acts = ''.join(actions(t))
  acts_html = f'<div class="row" style="gap: 8px; flex-wrap: wrap">{acts}</div>' if acts else ''
  hd = (f'<div class="prov-cell-head">{mono_ico(t["id"])}<div class="grow"><span class="row" style="gap: 8px; flex-wrap: wrap"><span style="font-weight: 500">{label}</span>'
        f'<span class="mono t-xs fg-3">{key}</span></span><span class="prov-meta">{m}</span></div>{tbadge(t)}</div>')
  return f'<div class="prov-cell" data-tracker="{t["id"]}">{hd}<p class="prov-reason">{t.get("short", t["reason"])}</p>{acts_html}</div>'


def mobile_trackers(name, title, sheet='', machine=MAIN):
  # The hosts' section and the intro are above on the page and scroll off; the rows say what they need, so the
  # phone's first screen is the four trackers.
  body = (f'{mhead("Integraciones")}<div class="m-body" style="gap: 12px">{mrecheck()}'
          f'<section class="card grad-border" style="overflow: hidden" aria-label="Gestores de incidencias">{"".join(pcell(t, i == 0) for i, t in enumerate(machine))}</section></div>')
  write(name, mobile(title, f'{body}\n{sheet}' if sheet else body + '\n' + tabbar('more')))


def mobile_trackers_states(name, title, scenarios):
  groups = ''.join(f'<div class="col" style="gap: 6px">{scenario_label(t)}<section class="card" style="overflow: hidden" aria-label="{t}">{"".join(pcell(x, i == 0) for i, x in enumerate(m))}</section></div>'
                   for t, m in scenarios)
  body = f'{mhead("Integraciones")}<div class="m-body" style="gap: 12px">{groups}</div>'
  write(name, mobile(title, body + '\n' + tabbar('more')))


def binary_sheet(t):
  label, cli, minimum, host = TRK[t['id']][0], TRK[t['id']][3], TRK[t['id']][4], TRK[t['id']][6]
  return f'''{scrim()}
<div class="sheet" role="dialog" aria-label="{label}" style="z-index: 11; padding-bottom: 28px; display: flex; flex-direction: column; gap: 12px; max-height: 92%">
<div class="grab" style="margin-bottom: 0"></div>
<div class="prov-cell-head">{mono_ico(t["id"])}<div class="grow"><h2 class="t-h2">{label}</h2><span class="prov-meta">{cli} {t["version"]} · {t["path"]}</span></div>{tbadge(t)}</div>
<p class="prov-reason" style="font-size: 14px">{t["reason"]}</p>
<div class="col" style="gap: 8px"><span class="t-label">Binario de {cli} para {label}</span>
<label class="field field-lg field-mono">{ico("folder", "ico fg-3")}<input class="mono" placeholder="El mismo que usa {host}" aria-label="Ruta del binario de {cli} para {label}" style="font-size: 16px"></label>
<span class="form-hint">Vacío, {label} usa el mismo programa que {host}. Si eliges otro, Agentry lee su versión antes de guardarlo y comprueba que no es anterior a la <span class="mono">{minimum}</span>.</span></div>
<div class="col" style="gap: 8px"><button type="button" class="btn btn-lg btn-primary">Comprobar y guardar</button>
<div class="row" style="gap: 8px"><button type="button" class="btn btn-lg btn-ghost grow" style="justify-content: center">Usar el del host</button><button type="button" class="btn btn-lg btn-ghost">Cancelar</button></div></div>
</div>'''


# ---------------------------------------------------------------- run
if __name__ == '__main__':
  desktop_trackers()
  desktop_trackers_states()
  mobile_trackers('MobileIntegracionesTrackers.html', 'Ajustes, integraciones con gestores de incidencias')
  mobile_trackers_states('MobileIntegracionesTrackersEstados.html', 'Ajustes, gestores de incidencias con otros estados', SCENARIOS[:1])
  mobile_trackers_states('MobileIntegracionesTrackersSinInstalar.html', 'Ajustes, gestores de incidencias sin instalar y comprobando', SCENARIOS[1:])
  mobile_trackers('MobileIntegracionesTrackersBinario.html', 'Ajustes, binario de un gestor de incidencias', sheet=binary_sheet(SCENARIOS[0][1][0]), machine=SCENARIOS[0][1])
