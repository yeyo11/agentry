# Code hosts (plans/code-hosts.md, phase 1, P0): the prototypes of Settings → Integrations, the
# project's host line, readiness notes and MR wording. Runs on its own, like providers.py, and each
# task keeps its screens in functions of its own so the merge does not touch another task's lines.
#   python3 hosts.py
# p2 (this part): DSIntegraciones, the states sheet of the project's host line. The line itself is
# drawn by projects.py (host_line / host_card / mhost_section), because the project settings are.
from common import page, write
from projects import HOST_LINES, host_line, host_hint


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


# ---------------------------------------------------------------- DSIntegraciones
def ds_integrations():
  head = ('<header class="col" style="gap: 8px"><span class="t-label">Agentry design system · alojamientos de código · integraciones</span>'
          '<h1 class="t-display" style="margin: 0">Integraciones</h1>'
          '<p class="fg-2" style="margin: 0; max-width: 900px; line-height: 1.55">Cómo dice Agentry dónde vive el código de un proyecto y si puede hablar con ese host. '
          'Siempre una palabra de estado junto al color, una razón en lenguaje llano y una sola acción.</p></header>')
  sections = [p2_section()]
  body = (f'<div class="app col" data-theme="dark" style="width: 1440px; height: 1460px; padding: 56px 64px; gap: 40px; overflow: hidden">'
          f'{head}{"".join(sections)}</div>')
  write('DSIntegraciones.html', page('Design system · Integraciones', body))


if __name__ == '__main__':
  ds_integrations()
