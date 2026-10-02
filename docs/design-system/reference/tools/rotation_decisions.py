# Rotation between providers, P0 `p3` (third part): the Decisions tab with its Providers area
# (`DesktopAjustesDecisionesProveedores`, `MobileAjustesDecisionesProveedores`: the base screens are left as
# they are, the way the checks' variants do it) and the spec page `DSRotacion`. Imported and run by
# rotation_work.py; it can also run on its own.
#   python3 rotation_decisions.py
from contextlib import contextmanager

from data import role
from common import ico, write, page
import decisions as dec
from rotation_work import chain, lim, statusbar, wait_line, RESET, TIP_NEAR, TIP_OUT, sb_section
from rotation_flow import notice

GROUP_NAME = 'Proveedores'
ON_LIMIT = ('provider.on-limit', 'Decidir qué hace el trabajo automático al llegar a un límite', 'A', 'P')
PICK = ('provider.pick', 'Elegir el proveedor de un trabajo automático al empezar', 'A', 'P')
MODEL_MAP = ('provider.model-map', 'Sugerir el modelo equivalente en otro proveedor', 'S', 'G')
POINTS = [ON_LIMIT, PICK, MODEL_MAP]
# count, acted, mean confidence, agreement (%, n), useful, not useful, unavailable, cost, runs saved
METRICS_ON_LIMIT = ('6', '50 %', '0,89', ('83 %', '6'), '2', '0', '0', '0,001 US$', '4')
METRICS_MAP = ('11', '0 %', '0,81', ('73 %', '11'), '3', '1', '0', '0,002 US$', '0')

NOTES = {
  'provider.on-limit': [
    ('info', 'Elige entre las acciones que has permitido en «Cuando un proveedor llega a su límite»: continuar con un traspaso, empezar de nuevo o esperar. '
             'Solo ve trabajo automático: un chat tuyo te pregunta siempre.'),
    ('lock', 'Nunca sale de lo permitido ni gasta en otro proveedor sin que lo hayas permitido. Con una sola acción posible, no pregunta.'),
  ],
  'provider.pick': [
    ('info', 'Elige entre los proveedores que pueden ejecutar el trabajo con sus reglas y con el modelo que le corresponde. No pregunta si solo uno puede.'),
  ],
  'provider.model-map': [
    ('lock', 'Propone el modelo equivalente de un proveedor en otro. Una sugerencia no vale hasta que la aceptas en Ajustes → Proveedores.'),
  ],
}


def notes_html(pid):
  return ''.join(f'<div class="dp-note" style="align-items: flex-start">{ico(i, "ico ico-sm", "flex-shrink: 0; margin-top: 2px")}<span>{t}</span></div>' for i, t in NOTES[pid])


@contextmanager
def with_points():
  """The Decisions tab with the three provider points: a group of its own after Paleta, 25 points in 10 groups."""
  saved = (dec.POINTS, dec.GROUPS, dec.point_row)
  gi = len(dec.GROUPS)
  dec.GROUPS = dec.GROUPS + [GROUP_NAME]
  dec.POINTS = dec.POINTS + [p + (gi,) for p in POINTS]
  dec.METRICS['k'] = METRICS_ON_LIMIT
  dec.METRICS['l'] = METRICS_MAP
  dec.STATE.update({
    'provider.on-limit': ('active', 0.85, ('ok', 1), 'k'),
    'provider.pick': ('off', 0.85, None, None),
    'provider.model-map': ('shadow', None, ('ok', 1), 'l'),
  })

  def row(p, cli, _row=saved[2]):
    r = _row(p, cli)
    if p[0] not in NOTES:
      return r
    notes = notes_html(p[0])
    if '<div class="dp-metrics"' in r:
      return r.replace('<div class="dp-metrics"', notes + '<div class="dp-metrics"', 1)
    return r[:r.rindex('</div>')] + notes + '</div>'

  dec.point_row = row
  try:
    yield
  finally:
    dec.POINTS, dec.GROUPS, dec.point_row = saved
    for k in ('k', 'l'):
      dec.METRICS.pop(k, None)
    for p in POINTS:
      dec.STATE.pop(p[0], None)


def captured(fn, *a, **kw):
  got, real = [], dec.write
  dec.write = lambda name, html: got.append(html)
  try:
    fn(*a, **kw)
  finally:
    dec.write = real
  return got[0]


def point_sheet():
  pid, label = ON_LIMIT[0], ON_LIMIT[1]
  mode, thr, consent, mk = dec.state_of(pid, False)
  return f'''{dec.scrim()}
<div class="sheet" role="dialog" aria-label="{label}" style="z-index: 11; padding-bottom: 28px; display: flex; flex-direction: column; gap: 14px; max-height: 96%; overflow: hidden">
<div class="grab" style="margin-bottom: 0"></div>
<div class="col" style="gap: 2px"><h2 class="t-h2">{label}</h2><span class="mono t-xs fg-3">{pid} · por proyecto · Actúa</span></div>
<div class="col" style="gap: 8px"><span class="t-label">Modo</span>{dec.seg("Modo de " + pid, dec.MODES, mode, phone=True)}</div>
<div class="col" style="gap: 2px"><span class="row"><span class="t-label grow">Umbral</span><span class="mono t-sm">{dec.num(thr)}</span></span>{dec.slider(thr, label="Umbral de " + pid)}<span class="form-hint">Actúa solo si la confianza lo supera; si no, decide tu ajuste.</span></div>
<div class="callout" style="align-items: flex-start">{ico("lock", "ico", "flex-shrink: 0; color: var(--fg-3); margin-top: 1px")}<span>Elige entre las acciones que has permitido: traspaso, empezar de nuevo o esperar. Nunca gasta en otro proveedor sin permiso.</span></div>
<div class="row" style="gap: 10px"><span class="t-label grow">Consentimiento</span>{dec.consent_cell(consent, mode)}</div>
<div class="col" style="gap: 8px"><span class="t-label">Últimos 7 días</span>{dec.metrics_grid(mk, False)}</div>
<button type="button" class="btn btn-lg">Ver en el historial</button>
</div>'''


# Where the group sits behind the viewport, measured in Chrome (see the report of p3)
DESKTOP_OFFSET = 3737
MOBILE_OFFSET = 3680


def decisions_screens():
  with with_points():
    h = captured(dec.desktop_page, 'x', 'Ajustes, decisiones del área de proveedores', offset=DESKTOP_OFFSET, tall=1024)
  write('DesktopAjustesDecisionesProveedores.html', h.replace('22 puntos · 9 grupos', '25 puntos · 10 grupos'))
  with with_points():
    h = captured(dec.mobile_page, 'x', 'Ajustes, el área de proveedores y un punto', sheet=point_sheet(), offset=MOBILE_OFFSET)
  write('MobileAjustesDecisionesProveedores.html', h)


# ---------------------------------------------------------------- the spec page
def frame(inner, w=None):
  st = f' style="max-width: {w}px"' if w else ''
  return f'<div class="card col" style="padding: 16px; gap: 12px"{st}>{inner}</div>'


def chain_section():
  rows = [
    ('Una sola: espera a su proveedor, o corre donde empezó', chain(['claude-code']), ''),
    ('Movida con un traspaso: continúa en el chat siguiente', chain(['claude-code', 'codex']), '<span class="chain-how">movida · traspaso · 13:48 · gpt-6.1-sol</span>'),
    ('Movida empezando de nuevo, con el prompt de origen', chain(['claude-code', 'codex']), '<span class="chain-how">movida · de nuevo · 13:48</span>'),
    ('Dos movimientos, el tope: la siguiente vez espera', chain(['claude-code', 'codex', 'gemini']), '<span class="chain-how">2 de 2 movimientos</span>'),
  ]
  cells = ''.join(f'<div class="col" style="gap: 8px"><span class="t-sm fg-2">{c}</span><div class="chain-row">{ch}{how}</div></div>' for c, ch, how in rows)
  intro = ('<p class="t-sm fg-2" style="margin: 0; max-width: 820px; line-height: 1.5">Cada eslabón es un chat, y el último es el que corre ahora, en <span class="mono">--fg</span> con el borde más marcado; los anteriores son historia. '
           'En un escritorio cada chip abre su chat; en un móvil se leen, y el botón de la tarjeta abre el más nuevo. Un chip solo sale cuando la tarea se ha movido, espera, o corre donde no empezó la orquestación.</p>')
  return (f'<section class="col" style="gap: 14px"><span class="t-label">La cadena de proveedores de una tarea</span>{intro}'
          f'<div class="card" style="padding: 20px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px 40px">{cells}</div></section>')


def wait_cards():
  clock = ico('wait', 'ico ico-sm')
  def w(title, why, actions):
    return (f'<div class="card col" style="padding: 16px; gap: 12px"><div class="row">{clock.replace("ico ico-sm", "ico ico-sm c-warn")}<span class="grow" style="font-weight: 600">Spanish copy: chats and home</span><span class="badge b-warn">esperando</span></div>'
            f'<div class="wait-line" role="status">{clock}<span>{title}<span class="why">{why}</span></span></div>'
            f'<div class="row t-xs" style="gap: 8px"><span class="grow"></span>{actions}</div></div>')
  known = '<button type="button" class="btn btn-sm btn-ghost">Dejar de esperar</button><button type="button" class="btn btn-sm">Mover ahora</button>'
  stop = '<button type="button" class="btn btn-sm btn-ghost">Dejar de esperar</button>'
  return [
    ('Con la hora de vuelta', w(f'<b>Esperando a Claude Code</b> · vuelve a las <span class="mono">{RESET}</span> (en 2 h 10 min)', 'Llegó a su límite de 5 h. La tarea conserva su sitio y retomará el turno sola.', known)),
    ('Sin hora: espera hasta un tope', w('<b>Esperando a Claude Code</b> · sin hora de vuelta', 'El límite no dice cuándo se reinicia. Agentry espera hasta <span class="mono">19:50</span> (6 h) y, si no vuelve, la ejecución falla.', known)),
    ('Sin modelo equivalente', w(f'<b>Esperando a Claude Code</b> · vuelve a las <span class="mono">{RESET}</span> (en 2 h 10 min)', 'Opus 5.5 no tiene equivalente en Codex, y el trabajo no puede pasar allí sin uno. <a href="DesktopProveedoresRotacion.html" class="c-accent">Elegir el equivalente</a>', stop)),
    ('Con el otro proveedor también agotado', w(f'<b>Esperando a Claude Code</b> · vuelve a las <span class="mono">{RESET}</span> (en 2 h 10 min)', 'Codex también llegó a su límite y vuelve a las <span class="mono">15:40</span>: no hay adonde mover el trabajo ahora.', stop)),
    ('Con el tope de movimientos alcanzado', w(f'<b>Esperando a Claude Code</b> · vuelve a las <span class="mono">{RESET}</span> (en 2 h 10 min)', 'Esta tarea ya se ha movido 2 veces, el máximo que permites. Ahora espera.', stop)),
  ]


def wait_section():
  cards = ''.join(f'<div class="col" style="gap: 8px"><span class="t-sm" style="font-weight: 600">{t}</span>{c}</div>' for t, c in wait_cards())
  intro = ('<p class="t-sm fg-2" style="margin: 0; max-width: 820px; line-height: 1.5">Esperar no es trabajo en marcha: aviso y el reloj, sin giro ni borde de energía, y el estado dice «esperando» con su palabra. '
           'La tarea sigue ocupando su sitio entre las paralelas. «Mover ahora» abre la hoja del traspaso y se desactiva, con su razón, cuando ningún proveedor puede recibirla.</p>')
  return (f'<section class="col" style="gap: 14px"><span class="t-label">Una tarea que espera, y por qué</span>{intro}'
          f'<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 24px">{cards}</div></section>')


def status_section():
  claude_ok = lim('claude-code', 'ok', 45, '2.1.282', tip='Ventana de 5 h · vuelve a las 14:05 · lectura de hace 2 min')
  codex_ok = lim('codex', 'ok', 31, '0.159.3', tip='Ventana de 5 h · vuelve a las 15:40 · lectura de hace 1 min')
  copilot = lim('copilot', 'ok', None, '1.0.90', tip='Copilot no informa de su límite')
  rows = [
    sb_section('Con lectura: barra neutra por debajo del 60 %', statusbar([claude_ok, codex_ok, copilot])),
    sb_section('Cerca: aviso desde el 60 %, con «límite» y el porcentaje', statusbar([lim('claude-code', 'near', 72, tip='Ventana de 5 h · 72 % · vuelve a las 14:05'), codex_ok, copilot]), TIP_NEAR),
    sb_section('Agotado: la palabra y cuándo vuelve', statusbar([claude_ok, lim('codex', 'out', tip='Ventana de 5 h · vuelve a las 14:05'), copilot]), TIP_OUT),
  ]
  intro = ('<p class="t-sm fg-2" style="margin: 0; max-width: 820px; line-height: 1.5">Un punto por proveedor, como en la fase 1, con su límite. Sin lectura (Copilot, Gemini y OpenCode no informan) no hay barra y nunca se dibuja «bien»: '
           'una lectura desconocida no es una lectura buena. La barra es neutra por debajo del 60 %, de aviso desde el 60 % y de error desde el 75 % o al agotarse; el título dice la ventana, la hora de vuelta y la edad de la lectura. La cuenta de claude-swap ya no está.</p>')
  return (f'<section class="col" style="gap: 14px"><span class="t-label">El límite en la barra de estado</span>{intro}<div class="app col" data-theme="dark" style="gap: 0; width: 1184px; background: var(--bg)">{"".join(rows)}</div></section>')


def banner(title, body, reason, acts):
  return (f'<div class="run-fail" role="status">{ico("x")}<div class="col" style="gap: 4px; min-width: 0"><span><b>{title}</b> {body}</span>'
          f'<span class="mono t-xs fg-3">{reason}</span><div class="acts">{acts}</div></div></div>')


def causes_section():
  a = banner('Esta ejecución no empezó: ningún proveedor podía ejecutarla.',
             'Ninguno de los que permites estaba listo y podía ejecutar esta etapa con sus reglas, entre ellas no subir nada con git push. La tarea sigue donde estaba, sin cambios.',
             'no provider can run this stage · hoy 13:52',
             '<button type="button" class="btn btn-sm">Reintentar</button><a href="DesktopProveedores.html" class="btn btn-sm btn-ghost">Ver proveedores</a>')
  b = banner('Esta ejecución esperó demasiado al reinicio de Claude Code.',
             'El límite no decía cuándo se reinicia y pasaron las 6 h que Agentry espera como máximo. La tarea sigue en Por hacer, sin cambios.',
             'the wait for the provider\'s reset ran out (6 h) · hoy 19:50',
             '<button type="button" class="btn btn-sm">Reintentar</button><a href="DesktopProveedores.html" class="btn btn-sm btn-ghost">Cambiar el tiempo máximo</a>')
  act = (f'<div class="card" style="overflow: hidden">'
         f'<div class="row" style="padding: 12px 16px; gap: 10px; border-bottom: 1px solid var(--line)">{role("DEV", "xs")}<span class="grow t-sm">Desarrollador pasó de Claude Code a Codex <span class="badge">traspaso</span></span><span class="mono t-xs fg-3">13:48</span></div>'
         f'<div class="row" style="padding: 12px 16px; gap: 10px">{role("DEV", "xs")}<span class="grow t-sm">Desarrollador espera a Claude Code · vuelve a las {RESET}</span><span class="badge b-warn">esperando</span><span class="mono t-xs fg-3">13:49</span></div></div>')
  intro = ('<p class="t-sm fg-2" style="margin: 0; max-width: 820px; line-height: 1.5">Las causas nuevas de una ejecución fallida se dicen con las palabras de la persona: qué faltó y qué pasa con la tarea. La frase en inglés de debajo es la razón que guarda Agentry, en mono y apagada. '
           '«Ninguna cuenta tenía cupo», de las ejecuciones antiguas, se sigue leyendo igual. La actividad de la tarea cuenta cada movimiento y cada espera con su palabra.</p>')
  return (f'<section class="col" style="gap: 14px"><span class="t-label">Las causas nuevas y la actividad de la tarea</span>{intro}'
          f'<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 24px"><div class="col" style="gap: 8px"><span class="t-sm" style="font-weight: 600">Ningún proveedor podía</span>{a}</div>'
          f'<div class="col" style="gap: 8px"><span class="t-sm" style="font-weight: 600">La espera se agotó</span>{b}</div></div>'
          f'<div class="col" style="gap: 8px; max-width: 760px"><span class="t-sm" style="font-weight: 600">En la actividad de la tarea</span>{act}</div></section>')


def notice_section():
  intro = ('<p class="t-sm fg-2" style="margin: 0; max-width: 820px; line-height: 1.5">El aviso de la retirada de claude-swap sale una sola vez, en las filas de preparación de Inicio y arriba de Ajustes → Proveedores, hasta que se descarta. '
           'Es neutro y no lleva el degradado: espera un «Entendido». Dice qué cuenta rige, qué política se perdió y qué no se tocó. Su única acción destructiva solo se ofrece si Agentry instaló su propia copia, y borra esa carpeta y nada más.</p>')
  return f'<section class="col" style="gap: 14px"><span class="t-label">El aviso de la retirada de claude-swap</span>{intro}<div style="max-width: 860px">{notice()}</div></section>'


RULES = [
  ('01', 'Esperar no se mueve', 'Una tarea que espera al reinicio no es trabajo en marcha: aviso y reloj, sin giro, sin riel y sin borde de energía. Lo vivo sigue siendo lo que corre, en el proveedor al que pasó.'),
  ('02', 'Cada color, una cosa', 'Aviso: cerca del límite o esperando. Rojo: agotado, o ejecución fallida. Idle: te espera a ti, como el aviso de la retirada. Siempre con su palabra, nunca solo color.'),
  ('03', 'La cadena se lee', 'Un chip por chat, con la marca del proveedor, el actual en primer plano y cómo se movió («traspaso», «de nuevo»). Lo que Agentry decidió lleva la marca «decidido», que abre la respuesta.'),
  ('04', 'Nombres de persona', 'Modos, causas y tipos se dicen como los dice la persona: «traspaso», «empezar de nuevo», «esperar al reinicio». Nunca un identificador de la API.'),
]


def rules_section():
  cards = ''.join(f'<div class="card col" style="padding: 18px; gap: 8px"><span class="mono t-xs fg-3">{n}</span><h2 class="t-h2">{t}</h2>'
                  f'<p class="t-sm fg-2" style="margin: 0; line-height: 1.5">{x}</p></div>' for n, t, x in RULES)
  return f'<section style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px">{cards}</section>'


DS_HEIGHT = 5600


def ds_rotation():
  head = ('<header class="col" style="gap: 8px"><span class="t-label">Agentry design system · rotación entre proveedores · trabajo automático y barra de estado</span>'
          '<h1 class="t-display" style="margin: 0">Cuando un proveedor llega a su límite</h1>'
          '<p class="fg-2" style="margin: 0; max-width: 900px; line-height: 1.55">Cómo se ve el trabajo automático que cambia de proveedor, espera o falla por ello, y cómo lo dice la barra de estado. '
          'Una palabra junto a cada color, nada que se mueva sin estar trabajando y los nombres de la persona, no los de la API.</p></header>')
  sections = [rules_section(), chain_section(), wait_section(), status_section(), causes_section(), notice_section()]
  body = (f'<div class="app col" data-theme="dark" style="width: 1440px; height: {DS_HEIGHT}px; padding: 56px 64px; gap: 40px; overflow: hidden">'
          f'{head}{"".join(sections)}</div>')
  write('DSRotacion.html', page('Design system · Rotación', body))


def all_decisions():
  decisions_screens()
  ds_rotation()


if __name__ == '__main__':
  all_decisions()
