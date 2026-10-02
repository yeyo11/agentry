# Issue trackers (plans/code-hosts.md, phase 5, P0). One function group per task, each under its own banner:
# t-p1 is Settings → Integrations → Trackers, t-p2 the project's tracker (this file's first banner) and t-p3
# the import and the item's issue chips. Runs on its own: it imports common.py, data.py, board.py, decisions.py,
# projects.py and hosts.py (the project's settings page it extends and the host line above the tracker).
#   python3 trackers.py
from data import *
from board import mhead
from common import P, ico, desktop, mobile, write, tabbar, pcrumb
from decisions import scrim
from decision_parts import tall
from projects import proj_head, proj_tabs, host_card, mhost_section, HOST_LINES

P.setdefault('ext', 'M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5')

# ---------------------------------------------------------------- shared
# id -> label, monogram letters, hue (never red, green or cyan), the CLI. The two with a host reuse its CLI and
# readiness; Jira and YouTrack have no recording yet (phase 5 in two steps), so the registry knows them and the
# screens show them as trackers whose readiness is unknown, reason `not-recorded`.
TRK = {
  'github-issues': ('GitHub Issues', 'GH', 262, 'gh'),
  'gitlab-issues': ('GitLab Issues', 'GL', 45, 'glab'),
  'jira': ('Jira', 'JI', 300, 'acli'),
  'youtrack': ('YouTrack', 'YT', 75, 'youtrack-app'),
}
# readiness -> word, badge class, dot class; the words are the host's (hosts.py), `unknown` included
TRK_STATE = {
  'ready': ('Listo', 'b-ok', 'dot-ok'),
  'signed-out': ('Sin sesión', 'b-warn', 'dot-warn'),
  'unavailable': ('No disponible', 'b-warn', 'dot-warn'),
  'unknown': ('Sin comprobar', 'b-idle', 'dot-idle'),
}
NOT_RECORDED = 'Agentry todavía no ha probado {cli}, así que no puede ofrecerlo.'

# Each scenario is a project: its host line, which tracker it has saved and what the four options say.
# `opts` is (tracker id, state, the one line under the name); `noun`/`ref` are the host's change request.
SCENES = {
  'gh': dict(host='gh-ready', saved='github-issues', noun='PR', ref='#12', cli='gh', scope='yeyochico/claude-wrapper',
             query='is:open', where='github.com',
             opts=[('github-issues', 'ready', 'gh tiene sesión en github.com y responde.'),
                   ('gitlab-issues', 'unavailable', 'El host de este proyecto es github.com, no GitLab.'),
                   ('jira', 'unknown', NOT_RECORDED.format(cli='acli')),
                   ('youtrack', 'unknown', NOT_RECORDED.format(cli='youtrack-app'))]),
  'gl': dict(host='gl-ready', saved='gitlab-issues', noun='MR', ref='!12', cli='glab', scope='equipo/pagos-api',
             query='', where='gitlab.inmoseo.net',
             opts=[('github-issues', 'unavailable', 'El host de este proyecto es gitlab.inmoseo.net, no GitHub.'),
                   ('gitlab-issues', 'ready', 'glab tiene sesión en gitlab.inmoseo.net y responde.'),
                   ('jira', 'unknown', NOT_RECORDED.format(cli='acli')),
                   ('youtrack', 'unknown', NOT_RECORDED.format(cli='youtrack-app'))]),
  'none': dict(host='gh-ready', saved=None, noun='PR', ref='#12', cli='gh', scope='yeyochico/claude-wrapper',
               query='is:open', where='github.com',
               opts=[('github-issues', 'ready', 'gh tiene sesión en github.com y responde.'),
                     ('gitlab-issues', 'unavailable', 'El host de este proyecto es github.com, no GitLab.'),
                     ('jira', 'unknown', NOT_RECORDED.format(cli='acli')),
                     ('youtrack', 'unknown', NOT_RECORDED.format(cli='youtrack-app'))]),
  'out': dict(host='signed-out', saved='github-issues', noun='PR', ref='#12', cli='gh', scope='yeyochico/claude-wrapper',
              query='is:open', where='github.com',
              opts=[('github-issues', 'signed-out', 'gh no tiene sesión en github.com.'),
                    ('gitlab-issues', 'unavailable', 'El host de este proyecto es github.com, no GitLab.'),
                    ('jira', 'unknown', NOT_RECORDED.format(cli='acli')),
                    ('youtrack', 'unknown', NOT_RECORDED.format(cli='youtrack-app'))]),
  'jira': dict(host='gh-ready', saved='jira', noun='PR', ref='#12', cli='gh', scope='PROJ', query='',
               where='github.com',
               opts=[('github-issues', 'ready', 'gh tiene sesión en github.com y responde.'),
                     ('gitlab-issues', 'unavailable', 'El host de este proyecto es github.com, no GitLab.'),
                     ('jira', 'unknown', NOT_RECORDED.format(cli='acli')),
                     ('youtrack', 'unknown', NOT_RECORDED.format(cli='youtrack-app'))]),
}


def trk_mono(tid, small=False):
  label, letters, hue, _ = TRK[tid]
  return f'<span class="proj monogram" style="--hue: {hue}" role="img" aria-label="{label}" title="{label}">{letters}</span>'


def trk_badge(state):
  word, cls, dot = TRK_STATE[state]
  return f'<span class="badge {cls}"><span class="dot {dot}" style="width: 6px; height: 6px"></span>{word}</span>'


def trk_opt(tid, state, why, on):
  """One tracker as a radio row. Only a ready tracker can be chosen; the others say why in words and stay
  in the list, so the person sees what exists and what is missing. The saved choice stays marked even when
  it is not ready, so the page does not hide what the project has."""
  label = TRK[tid][0]
  disabled = state != 'ready' and not on
  attrs = f' aria-disabled="true"' if disabled else ''
  radio = f'<span class="radio{" on" if on else ""}" aria-hidden="true"></span>'
  return (f'<button type="button" role="radio" aria-checked="{"true" if on else "false"}" class="trk-opt{" on" if on else ""}"{attrs}>'
          f'{trk_mono(tid)}<span class="trk-opt-id"><span class="trk-opt-name">{label}{trk_badge(state)}</span>'
          f'<span class="trk-opt-why">{why}</span></span>{radio}</button>')


def trk_none(on):
  radio = f'<span class="radio{" on" if on else ""}" aria-hidden="true"></span>'
  return (f'<button type="button" role="radio" aria-checked="{"true" if on else "false"}" class="trk-opt{" on" if on else ""}">'
          f'<span class="proj" style="background: var(--bg-3); color: var(--fg-2)" aria-hidden="true">{ico("block")}</span>'
          f'<span class="trk-opt-id"><span class="trk-opt-name">Ninguno</span>'
          f'<span class="trk-opt-why">Las tareas de este proyecto no se enlazan con incidencias.</span></span>{radio}</button>')


def trk_choice(sc):
  s = SCENES[sc]
  rows = ''.join(trk_opt(t, st, why, t == s['saved']) for t, st, why in s['opts']) + trk_none(s['saved'] is None)
  return f'<div role="radiogroup" aria-label="Tracker" class="trk-opts">{rows}</div>'


def sel(label, options, value, disabled=False, big=False):
  """A select of components/controls: the field's own look, a chevron, never the browser's. On a phone it is
  a 44 px control at 16 px, as the decision settings draw theirs."""
  opts = ''.join(f'<option{" selected" if o == value else ""}>{o}</option>' for o in options)
  size = ' style="width: 100%; font-size: 16px; height: 44px"' if big else ''
  dis = ' disabled' if disabled else ''
  return f'<span class="trk-sel"><select class="select" aria-label="{label}"{dis}{size}>{opts}</select>{ico("down", "ico ico-sm")}</span>'


def mapping(sc, big=False):
  """The status mapping, one select per column of the board. GitHub and GitLab have no statuses between open and
  closed, so the first two are fixed to "Sin cambios" with the reason beside them, and Done is the one choice:
  close the issue. Jira and YouTrack's statuses will fill the first two when their recordings exist."""
  s = SCENES[sc]
  tid = s['saved']
  label = TRK[tid][0] if tid else ''
  if tid in ('github-issues', 'gitlab-issues'):
    close = 'Cerrar como completada' if tid == 'github-issues' else 'Cerrar la incidencia'
    rows = [('in_progress', 'En curso', ['Sin cambios'], 'Sin cambios', True, f'{label} solo tiene abierta y cerrada.'),
            ('in_review', 'En revisión', ['Sin cambios'], 'Sin cambios', True, f'{label} solo tiene abierta y cerrada.'),
            ('done', 'Hecha', [close, 'Sin cambios'], close, False, '')]
    foot = (f'Al fusionarse la {s["noun"]} la incidencia se cierra sola con <span class="mono fg-2">Closes #12</span> en su descripción. '
            f'Si no pudo, porque la rama de destino no es la principal, Agentry la cierra después y comprueba que ha quedado cerrada.')
  else:
    rows = [('in_progress', 'En curso', ['Sin cambios'], 'Sin cambios', True, 'Disponible cuando Agentry pruebe acli.'),
            ('in_review', 'En revisión', ['Sin cambios'], 'Sin cambios', True, 'Disponible cuando Agentry pruebe acli.'),
            ('done', 'Hecha', ['Sin cambios'], 'Sin cambios', True, 'Disponible cuando Agentry pruebe acli.')]
    foot = 'Los estados de Jira se leen de su propio proyecto; hasta entonces el tablero no cambia nada en Jira.'
  out = ''
  for k, name, options, value, dis, note in rows:
    note_html = f'<span class="trk-map-note">{note}</span>' if note else ''
    out += (f'<div class="trk-map-row"><span class="trk-map-col">{sico(k)}{name}</span>{ico("move", "ico ico-sm fg-3")}'
            f'{sel("Estado de " + name, options, value, dis, big)}{note_html}</div>')
  return f'<div class="trk-map" role="group" aria-label="Estados">{out}</div><span class="form-hint">{foot}</span>'


def fields(sc, big=False):
  s = SCENES[sc]
  tid = s['saved']
  if tid is None:
    return ''
  if tid == 'jira':
    scope_label, scope_hint = 'Clave del proyecto', 'La clave del proyecto de Jira, la que encabeza sus incidencias.'
    q_hint = 'Hasta que Agentry pruebe acli, la consulta no se puede escribir.'
    disabled = ' disabled'
    q_ph = 'Disponible cuando Agentry pruebe acli'
  elif tid == 'gitlab-issues':
    scope_label = 'Alcance'
    scope_hint = 'Las incidencias de este repositorio. Por defecto es el del remoto <span class="mono fg-2">origin</span>.'
    q_hint = 'GitLab busca el texto en el título y la descripción. Sin texto, salen todas las abiertas.'
    disabled, q_ph = '', 'Texto que buscar (opcional)'
  else:
    scope_label = 'Alcance'
    scope_hint = 'Las incidencias de este repositorio. Por defecto es el del remoto <span class="mono fg-2">origin</span>.'
    q_hint = 'La búsqueda de GitHub tal cual, la que escribirías en su pestaña de incidencias. Al importar sale ya escrita.'
    disabled, q_ph = '', 'is:open label:bug'
  size = ' field-lg' if big else ''
  fs = ' style="font-size: 16px"' if big else ''
  return (f'<div class="form-row"><span class="t-label">{scope_label}</span><label class="field field-mono mono{size}"><input value="{s["scope"]}" aria-label="{scope_label}"{fs}></label>'
          f'<span class="form-hint">{scope_hint}</span></div>'
          f'<div class="form-row"><span class="t-label">Consulta</span><label class="field field-mono mono{size}"><input value="{s["query"]}" placeholder="{q_ph}" aria-label="Consulta"{disabled}{fs}></label>'
          f'<span class="form-hint">{q_hint}</span></div>')


def saved_note(sc):
  """What the saved tracker needs when it is not ready, in words and with one way out."""
  s = SCENES[sc]
  state = next((st for t, st, _ in s['opts'] if t == s['saved']), None)
  if state == 'signed-out':
    return (f'<div class="callout callout-warn" role="note">{ico("warn", "ico fg-3")}<span style="line-height: 1.5">Hasta que {s["cli"]} tenga sesión en {s["where"]}, Agentry no lee ni cierra incidencias de este proyecto. '
            f'Lo guardado se conserva.</span><a href="DesktopIntegraciones.html" class="btn btn-sm">Ir a Integraciones</a></div>')
  if state == 'unknown':
    return (f'<div class="callout" role="note">{ico("info", "ico fg-3")}<span style="line-height: 1.5">Este proyecto guarda Jira, pero Agentry todavía no ha probado acli: no lee ni escribe incidencias. '
            f'Puedes elegir otro tracker o dejarlo guardado.</span></div>')
  return ''


# ---------------------------------------------------------------- t-p2: the project's tracker
def tracker_card(sc, big=False):
  s = SCENES[sc]
  head = ('<div class="row"><h2 class="t-h2 grow" id="sec-tracker">Incidencias</h2><span class="mono t-xs fg-3">opcional</span></div>'
          '<span class="t-sm fg-2" style="margin-top: -8px; line-height: 1.5">Enlaza las tareas del proyecto con las incidencias de un tracker: se importan, y la '
          f'{s["noun"]} las cita y las cierra.</span>')
  body = ''
  if s['saved']:
    body = f'{saved_note(sc)}{fields(sc, big)}<div class="form-row"><span class="t-label">Al mover una tarea</span>{mapping(sc, big)}</div>'
  else:
    body = '<span class="form-hint">Sin tracker no hay nada que importar ni que cerrar; el resto del proyecto sigue igual.</span>'
  return (f'<section class="card col" style="padding: 18px; gap: 16px" aria-labelledby="sec-tracker">{head}'
          f'<div class="form-row"><span class="t-label">Tracker</span>{trk_choice(sc)}'
          f'<span class="form-hint">Solo se pueden elegir los que están listos. El de {"GitHub" if s["cli"] == "gh" else "GitLab"} usa la misma sesión que el alojamiento del código.</span></div>'
          f'{body}</section>')


def tracker_desktop(name, sc, title, extra_note=''):
  actions = ('<div class="row" style="justify-content: flex-end; gap: 8px"><button type="button" class="btn btn-ghost">Descartar</button>'
             '<button type="button" class="btn btn-primary">Guardar los cambios</button></div>')
  main = f'''<main class="page" style="gap: 18px">
{proj_head(False)}
{proj_tabs('settings')}
<div class="col" style="gap: 18px; max-width: 880px">
{host_card(s_host(sc))}
{tracker_card(sc)}
{actions}
</div>
</main>'''
  write(name, tall(desktop(title, 'projects', pcrumb('claude-wrapper', ('Ajustes', '')), main), 1450))


def s_host(sc):
  return SCENES[sc]['host']


def tracker_mobile(name, sc, title, sheet='', height=1000):
  s = SCENES[sc]
  cur = next((t for t in TRK if t == s['saved']), None)
  chosen = (f'{trk_mono(cur)}<span class="col grow" style="gap: 2px; min-width: 0"><span style="font-weight: 500">{TRK[cur][0]}</span>'
            f'<span class="mono t-xs fg-3">{TRK[cur][3]}</span></span>{trk_badge(next(st for t, st, _ in s["opts"] if t == cur))}'
            if cur else
            f'<span class="proj" style="background: var(--bg-3); color: var(--fg-2)" aria-hidden="true">{ico("block")}</span><span class="grow" style="font-weight: 500">Ninguno</span>')
  tracker_cell = (f'<div class="col" style="gap: 8px"><span class="t-label" style="padding: 0 4px">Tracker</span>'
                  f'<section class="card" style="overflow: hidden"><a href="MobileProyectoTrackerElegir.html" class="cell" style="min-height: 64px">{chosen}{ico("right", "ico fg-3")}</a></section>'
                  f'<span class="form-hint" style="padding: 0 4px">Solo se pueden elegir los que están listos.</span></div>')
  rest = ''
  if s['saved']:
    note = saved_note(sc).replace('btn btn-sm', 'btn btn-lg" style="justify-content: center')
    rest = (f'{note}<div class="col" style="gap: 14px">{fields(sc, True)}</div>'
            f'<div class="col" style="gap: 8px"><span class="t-label" style="padding: 0 4px">Al mover una tarea</span>{mapping(sc, True)}</div>')
  inner = f'''{mhead('Incidencias', 'claude-wrapper', 'MobileProyectoAjustes.html')}
<div class="m-body stack" style="gap: 16px">
{tracker_cell}
{rest}
</div>
<div class="m-foot"><button type="button" class="btn btn-primary btn-lg">Guardar los cambios</button></div>
{sheet}'''
  write(name, mobile(title, inner, style=f'height: {height}px'))


def choose_sheet(sc):
  s = SCENES[sc]
  rows = ''.join(trk_opt(t, st, why, t == s['saved']) for t, st, why in s['opts']) + trk_none(s['saved'] is None)
  return f'''{scrim()}
<div class="sheet" role="dialog" aria-label="Tracker" style="z-index: 11; padding-bottom: 28px; display: flex; flex-direction: column; gap: 12px; max-height: 92%">
<div class="grab" style="margin-bottom: 0"></div>
<h2 class="t-h2">Tracker de incidencias</h2>
<div role="radiogroup" aria-label="Tracker" class="trk-opts" style="overflow-y: auto">{rows}</div>
<div class="row" style="gap: 8px"><button type="button" class="btn btn-lg btn-ghost" style="flex: 1 1 0; justify-content: center">Cancelar</button><button type="button" class="btn btn-lg btn-primary" style="flex: 1 1 0; justify-content: center">Elegir</button></div>
</div>'''


STATES = [
  ('gl', 'GitLab, listo', 'En un host de GitLab el tracker es GitLab Issues y el cambio es una MR, !12. Solo cierra la incidencia: GitLab no pide un motivo.'),
  ('none', 'Sin tracker', 'Es lo que tiene un proyecto al principio. Se elige "Ninguno" y no hay alcance, consulta ni estados que rellenar.'),
  ('out', 'El tracker guardado no está listo', 'La sesión de gh se perdió. Lo guardado se conserva, se dice en palabras y el único camino es Integraciones.'),
  ('jira', 'Jira guardado, sin comprobar', 'La clave existe en los ajustes para cuando Agentry pruebe acli. Mientras tanto no hay consulta ni estados, y nada se escribe en Jira.'),
]


def states_desktop():
  cells = ''
  for sc, title, note in STATES:
    cells += (f'<div class="col" style="gap: 8px"><span class="t-label" style="padding: 0 4px">{title}</span>'
              f'<p class="t-sm fg-2" style="margin: 0 4px; line-height: 1.5; max-width: 760px">{note}</p>{tracker_card(sc)}</div>')
  main = f'''<main class="page" style="gap: 18px">
{proj_head(False)}
{proj_tabs('settings')}
<div class="col" style="gap: 26px; max-width: 880px">{cells}</div>
</main>'''
  write('DesktopProyectoTrackerEstados.html', tall(desktop('Ajustes del proyecto, tracker en otros estados', 'projects', pcrumb('claude-wrapper', ('Ajustes', '')), main), 4150))


def states_mobile(name, title, scs, height=844):
  groups = ''
  for sc, t, note in [x for x in STATES if x[0] in scs]:
    s = SCENES[sc]
    cur = s['saved']
    chosen = (f'{trk_mono(cur)}<span class="col grow" style="gap: 2px; min-width: 0"><span style="font-weight: 500">{TRK[cur][0]}</span>'
              f'<span class="mono t-xs fg-3">{TRK[cur][3]}</span></span>{trk_badge(next(st for tt, st, _ in s["opts"] if tt == cur))}' if cur else
              f'<span class="proj" style="background: var(--bg-3); color: var(--fg-2)" aria-hidden="true">{ico("block")}</span><span class="grow" style="font-weight: 500">Ninguno</span>')
    note_html = saved_note(sc).replace('btn btn-sm', 'btn btn-lg" style="justify-content: center') if cur else ''
    groups += (f'<div class="col" style="gap: 8px"><span class="t-label" style="padding: 0 4px">{t}</span>'
               f'<section class="card" style="overflow: hidden" aria-label="{t}"><a href="MobileProyectoTrackerElegir.html" class="cell" style="min-height: 64px">{chosen}{ico("right", "ico fg-3")}</a></section>'
               f'{note_html}</div>')
  inner = f'{mhead("Incidencias", "claude-wrapper", "MobileProyectoAjustes.html")}<div class="m-body stack" style="gap: 16px">{groups}</div>'
  write(name, mobile(title, inner, style=f'height: {height}px'))


def t_p2():
  tracker_desktop('DesktopProyectoTracker.html', 'gh', 'Ajustes del proyecto, tracker')
  states_desktop()
  tracker_mobile('MobileProyectoTracker.html', 'gh', 'Ajustes del proyecto, tracker')
  tracker_mobile('MobileProyectoTrackerElegir.html', 'gh', 'Ajustes del proyecto, elegir tracker', sheet=choose_sheet('gh'), height=844)
  states_mobile('MobileProyectoTrackerEstados.html', 'Ajustes del proyecto, tracker en otros estados', ('gl', 'none'))
  states_mobile('MobileProyectoTrackerEstados2.html', 'Ajustes del proyecto, tracker guardado que no está listo', ('out', 'jira'))


# ---------------------------------------------------------------- run
if __name__ == '__main__':
  t_p2()
