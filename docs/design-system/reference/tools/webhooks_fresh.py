# Code hosts (plans/code-hosts.md, phase 6, P0): w-p2, how fresh a change request is. The item page's freshness line
# (`.fresh`, inside the panel of the PR or MR) in every state, both sizes, and DSWebhooks, the sheet that explains it.
# It lives in its own file so it does not collide with webhooks.py (w-p1, Integrations → Webhooks). Runs on its own:
# it imports common.py, data.py, tasks.py, reviews.py and merge.py (the item page and the panel it extends).
#   python3 webhooks_fresh.py
from data import *
from common import P, ico, write, page
from tasks import _captured, _swap, detail_desktop, detail_mobile
from reviews import mr_panel, pr_row
from merge import phone_frame

P.setdefault('ext', EXT_PATH)

HOSTS = {'github': ('GitHub', 'PR', '#12'), 'gitlab': ('GitLab', 'MR', '!12')}


def t(x):
  """A number of time, in mono and tabular: the line is read by its numbers."""
  return f'<span class="fresh-t">{x.replace(" ", chr(160))}</span>'


# A status colour always has its word; the plain cases (a read some seconds ago and the next one soon) have no
# badge, since nothing is wrong or special. Only a read in flight is live: its braille spinner stands next to the
# verb, as everywhere else.
def line(state, host='github', mobile=False):
  name = HOSTS[host][0]
  noun, num = HOSTS[host][1], HOSTS[host][2]
  badge, text, why, busy = '', '', '', False
  if state == 'webhook':
    badge = f'<span class="badge b-ok">{ico("check", "ico ico-sm")}Al instante</span>'
    text = f'Por webhook · último aviso hace {t("12 s")}'
    why = f'Por si falla, {name} se lee cada {t("15 min")}: la próxima, en {t("14 min")}.'
  elif state == 'poll':
    text = f'Comprobada hace {t("40 s")} · la próxima, en {t("2 min")}'
  elif state == 'open':
    text = f'Comprobada hace {t("8 s")} · la próxima, en {t("20 s")}'
    why = 'Tienes esta página abierta.'
  elif state == 'checks':
    text = f'Comprobada hace {t("12 s")} · la próxima, en {t("30 s")}'
    why = 'Corre la pipeline.' if host == 'gitlab' else 'Corren las comprobaciones.'
  elif state == 'quiet':
    text = f'Comprobada hace {t("3 min")} · la próxima, en {t("10 min")}'
    why = f'Sin cambios desde hace {t("1 h")}.'
  elif state == 'reading':
    badge = '<span class="spin-braille" aria-hidden="true"></span>'
    text = f'Leyendo {name}…'
    why = f'La anterior fue hace {t("41 s")}.'
    busy = True
  elif state == 'silent':
    badge = '<span class="badge b-warn">Webhook sin avisos</span>'
    text = f'Sin avisos desde hace {t("40 min")} · comprobada hace {t("40 s")} · la próxima, en {t("2 min")}'
    why = f'Mientras tanto se lee {name} a ritmo normal. <a href="DesktopIntegracionesWebhooks.html" class="c-accent">Ver los webhooks</a>'
  elif state == 'failing':
    badge = '<span class="badge b-warn">Sin respuesta</span>'
    text = f'{name} no responde · datos de hace {t("9 min")} · reintento en {t("4 min")}'
    why = f'La {noun} {num} puede haber cambiado desde entonces.'
  elif state == 'paused':
    badge = '<span class="badge b-warn">En pausa</span>'
    text = f'{name} limita las lecturas · se reanuda a las {t("11:20")} · datos de hace {t("6 min")}'
    why = 'Actualizar sigue funcionando: es una acción tuya.'
  else:
    raise ValueError(state)
  dis = ' disabled aria-busy="true"' if busy else ''
  if mobile:
    btn = f'<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Actualizar ahora"{dis}>{ico("retry", "ico ico-lg")}</button>'
  else:
    btn = f'<button type="button" class="btn btn-ghost btn-sm"{dis}>{ico("retry", "ico ico-sm")}Actualizar</button>'
  w = f'<span class="fresh-state">{badge}</span>' if badge else ''
  y = f'<span class="fresh-why">{why}</span>' if why else ''
  return f'<div class="fresh" data-fresh="{state}">{w}<span class="fresh-text"><span>{text}</span>{y}</span>{btn}</div>'


def to_host(h, host):
  """reviews.py draws the GitHub case; the same wording follows the host."""
  if host == 'gitlab':
    h = h.replace('PR #12', 'MR !12').replace('La PR', 'La MR').replace('en GitHub', 'en GitLab').replace('Pull request', 'Merge request')
  return h


def panel(host, state, mobile=False):
  """The panel of the PR or MR with the freshness line as its last row."""
  end = '<span>Cuando se fusione, la tarea pasará sola a Hecho.</span></div>'
  return to_host(_swap(mr_panel(host, mobile), end, f'<span>Cuando se fusione, la tarea pasará sola a Hecho.</span>{line(state, host, mobile)}</div>'), host)


# ---------------------------------------------------------------- the item page
def item_desktop(host, state, name, title):
  h = _captured(detail_desktop)
  h = _swap(h, '<span class="badge b-idle">te espera</span>', '<span class="badge b-idle">espera tu fusión</span>')
  crit = '<section class="col" style="gap: 8px"><div class="row" style="gap: 10px"><h2 class="t-h2">Criterios'
  h = _swap(h, crit, panel(host, state) + crit)
  diff = '<div class="row" style="gap: 8px"><a href="#" class="btn btn-sm grow">'
  h = _swap(h, diff, to_host(pr_row(host), host) + diff)
  write(name, h.replace('<title>Agentry · Tarea (desktop)', f'<title>Agentry · {title} (desktop)'))


def item_mobile(host, state, name, title):
  h = _captured(detail_mobile)
  h = _swap(h, '<span class="badge b-idle">te espera</span>', '<span class="badge b-idle">espera tu fusión</span>')
  desc = '<p class="t-sm fg-2" style="margin: 0; line-height: 1.55">'
  h = _swap(h, desc, panel(host, state, True) + desc)
  done = f'<button type="button" class="btn btn-lg" style="flex: 0 0 auto">{ico("check", "ico ico-lg")}Mover a Hecho</button>'
  noun, num = HOSTS[host][1], HOSTS[host][2]
  h = _swap(h, done, f'<a href="#" class="btn btn-lg" style="flex: 0 0 auto" target="_blank" rel="noreferrer">{ext_ico("ico ico-lg")}Abrir {noun} {num}</a>')
  write(name, h.replace('<title>Agentry · Tarea (móvil)', f'<title>Agentry · {title} (móvil)'))


# ---------------------------------------------------------------- DSWebhooks
RULES = [
  ('01', 'En palabras, nunca un reloj', 'La línea dice cuándo se leyó por última vez y cuándo será la próxima, con números en mono y tabulares: «comprobada hace 40 s · la próxima, en 2 min». Nada cuenta atrás con una animación: el texto se renueva y ya.'),
  ('02', 'Al instante, solo con un webhook sano', 'La palabra «Al instante» (ok) sale únicamente si el repositorio tiene un webhook que ha entregado o respondido a una prueba en los últimos 30 min. Sin él, la línea es la lectura periódica, sin adornos. Y no es cian: no hay un agente trabajando.'),
  ('03', 'Cada color, una cosa', 'Ok: el webhook funciona. Aviso: el webhook calla, el host no responde o limita las lecturas. Sin color: una lectura normal. Cian y spinner: solo mientras se lee, junto al verbo. Siempre con su palabra.'),
  ('04', 'Actualizar es tuyo', 'Pone la próxima lectura en ahora, también durante una pausa por límite: es una acción de la persona, no una lectura de fondo. Se apaga mientras se lee.'),
]


def rules_section():
  cards = ''.join(f'<div class="card col" style="padding: 18px; gap: 8px"><span class="mono t-xs fg-3">{n}</span><h2 class="t-h2">{ti}</h2>'
                  f'<p class="t-sm fg-2" style="margin: 0; line-height: 1.5">{x}</p></div>' for n, ti, x in RULES)
  return f'<section style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px">{cards}</section>'


# when, the next read, what the line says
TIERS = [
  ('Pipeline en marcha, o fusión esperando a una', '30 s', 'Comprobada hace 12 s · la próxima, en 30 s'),
  ('Su página abierta en un navegador', '20 s', 'Comprobada hace 8 s · la próxima, en 20 s'),
  ('Abierta, esperando revisión o fusión', '2 min', 'Comprobada hace 40 s · la próxima, en 2 min'),
  ('Sin cambios desde hace una hora', '10 min', 'Comprobada hace 3 min · la próxima, en 10 min'),
  ('Un webhook sano en su repositorio', '15 min', 'Al instante · por webhook · último aviso hace 12 s'),
  ('Un fallo', '1, 2, 4, 8 y 15 min', 'GitHub no responde · datos de hace 9 min · reintento en 4 min'),
  ('El host limita las lecturas', 'al reanudarse', 'GitHub limita las lecturas · se reanuda a las 11:20'),
]
TGRID = 'display: grid; grid-template-columns: minmax(0, 1.2fr) 170px minmax(0, 1.6fr); gap: 20px; align-items: center'


def tier_section():
  cols = (f'<div style="{TGRID}; padding-bottom: 8px"><span class="t-label">Cuándo</span><span class="t-label">Próxima lectura</span>'
          f'<span class="t-label">Lo que dice la línea</span></div>')
  rows = ''.join(f'<div style="{TGRID}; padding: 12px 0; border-top: 1px solid var(--line)"><span class="t-sm">{w}</span>'
                 f'<span class="mono t-sm" style="font-variant-numeric: tabular-nums">{n}</span><span class="mono t-xs fg-2">{x}</span></div>'
                 for w, n, x in TIERS)
  return (f'<section class="col" style="gap: 0"><span class="t-label" style="padding-bottom: 6px">De dónde sale el número · el ritmo de Agentry</span>'
          f'<p class="t-sm fg-2" style="margin: 0 0 14px; max-width: 900px; line-height: 1.5">Agentry elige el ritmo de cada PR o MR abierta; la línea solo cuenta lo que ya decidió. '
          f'Una entrega de webhook o un Actualizar mandan la próxima lectura a ahora.</p>{cols}{rows}</section>')


def cell(label, note, body):
  return (f'<div class="col" style="gap: 8px; min-width: 0"><span class="t-label" style="padding: 0 2px">{label}</span>'
          f'<span class="t-xs fg-3" style="padding: 0 2px; line-height: 1.45; min-height: 34px">{note}</span>{body}</div>')


def states_section():
  cells = [
    ('GitHub · al instante', 'Un webhook sano: lo último que dijo GitHub y el respaldo de 15 min.', 'github', 'webhook'),
    ('GitHub · lectura normal', 'Sin webhook, o una PR que espera revisión: 2 min.', 'github', 'poll'),
    ('GitHub · página abierta', 'Quien mira la página acelera la lectura a 20 s.', 'github', 'open'),
    ('GitHub · leyendo', 'La lectura en vuelo: el spinner junto al verbo es lo único vivo.', 'github', 'reading'),
    ('GitHub · el webhook calla', 'Registrado, pero sin entregas en 30 min: se vuelve al ritmo normal y se dice, con un enlace a los webhooks.', 'github', 'silent'),
    ('GitHub · sin respuesta', 'La lectura falló: se reintenta con 1, 2, 4, 8 y 15 min, y se dice de cuándo son los datos.', 'github', 'failing'),
    ('GitLab · pipeline en marcha', 'En GitLab la línea es siempre lectura periódica: su webhook aún no está disponible.', 'gitlab', 'checks'),
    ('GitLab · sin cambios', 'Una MR parada desde hace una hora se lee cada 10 min.', 'gitlab', 'quiet'),
    ('GitLab · en pausa', 'El host limita las lecturas: se detienen las de fondo hasta la hora que dice.', 'gitlab', 'paused'),
  ]
  grid = ''.join(cell(la, n, f'<div class="card" style="padding: 12px 14px">{line(s, h)}</div>') for la, n, h, s in cells)
  return (f'<section class="col" style="gap: 12px"><span class="t-label">La línea en cada estado · escritorio</span>'
          f'<div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 22px 24px; align-items: start">{grid}</div></section>')


def phone_section():
  frames = [('GitHub · al instante', 'github', 'webhook'), ('GitHub · sin respuesta', 'github', 'failing'),
            ('GitLab · lectura normal', 'gitlab', 'poll'), ('GitLab · en pausa', 'gitlab', 'paused')]
  out = ''.join(f'<div class="col" style="gap: 8px"><span class="t-sm" style="font-weight: 600">{la}</span>{phone_frame(panel(h, s, True))}</div>'
                for la, h, s in frames)
  return (f'<section class="col" style="gap: 12px"><span class="t-label">En el móvil · el botón mide 44 px y el texto envuelve</span>'
          f'<div style="display: grid; grid-template-columns: repeat(3, 390px); gap: 24px; align-items: start">{out}</div></section>')


def gitlab_section():
  return (f'<section class="callout" style="align-items: flex-start; max-width: 1100px">{ico("info", "ico", "flex-shrink: 0; color: var(--fg-3); margin-top: 1px")}'
          '<span class="col" style="gap: 4px"><b style="color: var(--fg); font-weight: 500">GitLab: aún sin webhook</b>'
          '<span>Agentry ya sabe recibir un webhook de GitLab, pero todavía no lo registra, lo prueba ni lo quita: eso falta por probarlo con glab. '
          'Hasta entonces una MR muestra solo la lectura periódica, y Integraciones dice «aún no disponible» en vez de ofrecer una acción que no existe.</span></span></section>')


DS_HEIGHT = 2440


def ds_webhooks():
  head = ('<header class="col" style="gap: 8px"><span class="t-label">Agentry design system · alojamientos de código · webhooks</span>'
          '<h1 class="t-display" style="margin: 0">Lo fresca que está una PR o una MR</h1>'
          '<p class="fg-2" style="margin: 0; max-width: 900px; line-height: 1.55">Una línea en el panel de la PR o la MR de la tarea: si se actualiza al instante '
          'por un webhook, o cuándo se leyó y cuándo se volverá a leer, dicho con palabras. Una palabra junto a cada color y un solo botón, Actualizar.</p></header>')
  sections = [rules_section(), tier_section(), states_section(), phone_section(), gitlab_section()]
  body = (f'<div class="app col" data-theme="dark" style="width: 1440px; height: {DS_HEIGHT}px; padding: 56px 64px; gap: 40px; overflow: hidden">'
          f'{head}{"".join(sections)}</div>')
  write('DSWebhooks.html', page('Design system · Webhooks', body))


def w_p2():
  item_desktop('github', 'webhook', 'DesktopTareaFrescura.html', 'Tarea, frescura de la PR')
  item_mobile('github', 'webhook', 'MobileTareaFrescura.html', 'Tarea, frescura de la PR')
  ds_webhooks()


if __name__ == '__main__':
  w_p2()
