# The decision engine's pieces (docs/plans/decision-engine.md, "UI"): the "decided" mark and its
# answer, the project override, and the Usage line. Imported by board.py and projects.py, which
# write the screens; the Memoria and Uso screens have no generator, so they carry the same markup
# by hand. Not run on its own.
from common import *

P['up'] = 'M7 10v11M7 10l4-7a2 2 0 0 1 2 2v4h5.5a2 2 0 0 1 2 2.3l-1 7a2 2 0 0 1-2 1.7H7'
P['down-thumb'] = 'M7 14V3M7 14l4 7a2 2 0 0 0 2-2v-4h5.5a2 2 0 0 0 2-2.3l-1-7A2 2 0 0 0 17.5 3H7'
P['coin'] = 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM14.5 9.2c-.5-.8-1.4-1.2-2.5-1.2-1.4 0-2.5.7-2.5 1.8 0 2.6 5.2 1.2 5.2 3.9 0 1.1-1.1 1.8-2.7 1.8-1.2 0-2.2-.4-2.8-1.3M12 6.5V8M12 16v1.5'
P['layers'] = 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5'


def mark(conf='0,93', expanded=False, what=''):
  """The mark on a row where a decision changed something a person sees. "decidido · 0,93", or
  "sugerido" when the provider gave no confidence (the CLI). Neutral: no status colour."""
  text = f'decidido · {conf}' if conf else 'sugerido'
  label = (f'Decidido por Agentry, confianza {conf}' if conf else 'Sugerido por Agentry') + (f': {what}' if what else '') + '. Ver la respuesta'
  return (f'<button type="button" class="decided" aria-haspopup="dialog" aria-expanded="{"true" if expanded else "false"}" '
          f'aria-label="{label}"><span class="decided-face">{text}</span></button>')


def rate(useful=None):
  on = lambda v: 'true' if useful == v else 'false'
  return (f'<div class="decided-foot"><span class="ask">¿Te ha servido?</span>'
          f'<button type="button" class="btn btn-sm" aria-pressed="{on(True)}">{ico("up", "ico ico-sm")}Útil</button>'
          f'<button type="button" class="btn btn-sm" aria-pressed="{on(False)}">{ico("down-thumb", "ico ico-sm")}No útil</button>'
          f'<a href="DesktopAjustes.html">Ver en el historial</a></div>')


def answer(title, point, question, answer_text, odds, meta, chosen=0):
  """The body of an answer: what was asked, what was answered, the probabilities (Jev only), and
  the provider, mode, cost and time. The popover and the phone's Sheet both hold it."""
  odd_rows = ''.join(
    f'<div class="decided-odd{" is-chosen" if i == chosen else ""}"><span>{n}</span><span class="bar"><i style="width: {round(float(v.replace(",", ".")) * 100)}%"></i></span><span class="t-num">{v}</span></div>'
    for i, (n, v) in enumerate(odds))
  odds_html = f'<div class="decided-block"><span class="t-label">Probabilidades</span><div class="decided-odds">{odd_rows}</div></div>' if odds else ''
  meta_html = ''.join(f'<dt>{k}</dt><dd>{v}</dd>' for k, v in meta)
  head = f'<div class="col"><h2 class="t-h2">{title}</h2><span class="mono t-xs fg-3">{point}</span></div>'
  body = (f'<div class="decided-block"><span class="t-label">Pregunta</span><p>{question}</p></div>'
          f'<div class="decided-block"><span class="t-label">Respuesta</span><p class="is-answer">{answer_text}</p></div>'
          f'{odds_html}<dl class="decided-meta">{meta_html}</dl>')
  return head, body


def popover(style, *args, useful=None, **kw):
  head, body = answer(*args, **kw)
  close = f'<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Cerrar">{ico("x", "ico ico-sm")}</button>'
  return (f'<div class="decided-pop" role="dialog" aria-label="Respuesta de Agentry" style="{style}">'
          f'<div class="decided-head">{head}{close}</div>{body}{rate(useful)}</div>')


def sheet(*args, useful=None, **kw):
  """On a phone the same answer is a bottom Sheet over a dimmed screen."""
  head, body = answer(*args, **kw)
  close = f'<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Cerrar">{ico("x", "ico ico-lg")}</button>'
  return ('<div style="position: absolute; inset: 0; z-index: 10; background: color-mix(in srgb, var(--bg) 60%, transparent)"></div>'
          f'<div class="sheet decided-sheet" role="dialog" aria-label="Respuesta de Agentry" style="z-index: 11; padding-bottom: 28px"><div class="grab" style="margin-bottom: -4px"></div>'
          f'<div class="decided-head">{head}{close}</div>{body}{rate(useful)}</div>')


# Jev's answer for a card the engine classified, and the CLI's for a memory proposal
TRIAGE = dict(
  title='Clasificó la tarea', point='board.triage',
  question='¿De qué tipo y con qué prioridad se crea «La barra de uso no se actualiza al cambiar de cuenta»?',
  answer_text='Bug · prioridad urgente',
  odds=[('Bug', '0,93'), ('Tarea', '0,05'), ('Historia', '0,02')],
  meta=[('Proveedor', 'Jev'), ('Modo', 'activo · umbral 0,85'), ('Coste', '0,004 US$ · 1,2 s'), ('Resultado', 'la mantuviste · hace 2 min')])
MEMORY = dict(
  title='Ordenó las propuestas', point='memory.triage',
  question='¿Qué propuesta de memoria conviene revisar primero, y cuál repite lo que ya hay?',
  answer_text='Esta primero: no repite ninguna entrada de memoria',
  odds=[],
  meta=[('Proveedor', 'Claude Code CLI'), ('Confianza', '— (el CLI no la da)'), ('Modo', 'activo'), ('Coste', '0,011 US$ · 6,4 s'), ('Resultado', 'sin resultado todavía')])


# ---- Project settings → Decisions -------------------------------------------------------------

MODES = ['Apagado', 'Sombra', 'Activo']
# area, [(label, id, kind, global mode, global threshold, override (mode, threshold) or None)]
POINTS = [
  ('Flujo del proyecto', 'flow', [
    ('Refinar al entrar en Backlog', 'flow.refine-needed', 'act', 1, '0,85', None),
    ('Devolver una tarjeta tras QA', 'flow.bounce', 'act', 1, '0,85', (2, '0,90')),
    ('Revisar criterios antes de QA', 'flow.criteria-precheck', 'act', 1, '0,85', None),
    ('Unir criterios parecidos', 'flow.criteria-merge', 'suggest', 0, None, None),
    ('Reanudar tras un reinicio', 'flow.restart', 'act', 0, '0,85', None),
    ('Proponer responsable', 'team.assign', 'suggest', 1, None, (2, None)),
    ('Señalar desvío de alcance', 'flow.scope-drift', 'suggest', 1, None, None),
  ]),
  ('Tablero', 'board', [
    ('Clasificar una tarea nueva', 'board.triage', 'suggest', 1, None, (2, None)),
  ]),
  ('Memoria', 'memory', [
    ('Ordenar las propuestas', 'memory.triage', 'suggest', 1, None, None),
    ('Elegir entradas del diario', 'journal.relevance', 'act', 0, '0,85', None),
  ]),
  ('Asistente', 'sparkle', [
    ('Ordenar las propuestas', 'assistant.rerank', 'suggest', 1, None, None),
    ('Elegir qué leer primero', 'assistant.sources', 'act', 0, '0,85', None),
  ]),
  ('Orquestaciones', 'orch', [
    ('Reintentar un error', 'orchestration.retry', 'act', 0, '0,85', None),
    ('Elegir el modelo de cada tarea', 'orchestration.model', 'suggest', 1, None, None),
    ('Seguir arreglando o parar', 'orchestration.fixer', 'act', 0, '0,85', None),
    ('Continuar una ejecución', 'run.continuation', 'act', 1, '0,85', (2, '0,90')),
  ]),
  ('Revisión', 'git', [
    ('Señalar cambios sin explicar', 'changes.unexplained-hunk', 'suggest', 1, None, None),
  ]),
]
KIND = {'act': 'Actúa', 'suggest': 'Sugiere'}


def seg(mode, inherited, label, cli_act=False, lg=False):
  opts = ''
  for i, m in enumerate(MODES):
    off = cli_act and i == 2
    opts += (f'<button type="button" role="radio" aria-checked="{"true" if i == mode else "false"}"{" class=\"on\"" if i == mode else ""}'
             f'{" disabled" if off else ""}>{m}</button>')
  return f'<div class="seg decision-mode{" is-inherited" if inherited else ""}" role="radiogroup" aria-label="{label}">{opts}</div>'


def threshold(value, inherited, label):
  if value is None:
    return '<span class="threshold-none" title="Solo los puntos que actúan tienen umbral">—</span>'
  pct = round((float(value.replace(',', '.')) - 0.5) / 0.5 * 100)
  return (f'<div class="threshold{" is-inherited" if inherited else ""}" role="slider" aria-label="{label}" aria-valuemin="0.5" aria-valuemax="1" aria-valuenow="{value.replace(",", ".")}" aria-valuetext="{value}" tabindex="0">'
          f'<span class="threshold-track"><span class="threshold-range" style="width: {pct}%"></span><span class="threshold-thumb" style="left: {pct}%"></span></span>'
          f'<span class="threshold-value">{value}</span></div>')


def point_row(p):
  name, pid, kind, gmode, gthr, ov = p
  inherited = ov is None
  mode, thr = (gmode, gthr) if inherited else ov
  if not inherited and kind == 'act' and thr is None:
    thr = gthr
  state = ('<span>Heredado</span>' if inherited else
           f'<span>global: {MODES[gmode].lower()}</span><button type="button" class="btn btn-ghost btn-sm">Usar la global</button>')
  return (f'<div class="decision-row" role="group" aria-label="{name}">'
          f'<span class="decision-point"><span class="name">{name}</span><span class="id">{pid}</span></span>'
          f'<span class="decision-kind">{KIND[kind]}</span>'
          f'{seg(mode, inherited, "Modo de " + name)}{threshold(thr, inherited, "Umbral de " + name)}'
          f'<span class="decision-state">{state}</span></div>')


def override_card(open_groups=('flow', 'orch')):
  head = ('<div class="decision-row decision-head" style="border-top: 0"><span class="t-label">Punto</span><span class="t-label">Tipo</span>'
          '<span class="t-label">Modo</span><span class="t-label">Umbral</span><span></span></div>')
  groups = ''
  for area, icon, pts in POINTS:
    changed = sum(1 for p in pts if p[5])
    is_open = icon in open_groups
    n = f'<span class="n"><b>{len(pts)}</b> {"punto" if len(pts) == 1 else "puntos"}' + (f' · <b>{changed}</b> distinto{"s" if changed != 1 else ""} del global' if changed else '') + '</span>'
    groups += (f'<div class="decision-group" role="heading" aria-level="3">{ico("down" if is_open else "right", "ico ico-sm")}{area}<span class="grow"></span>{n}</div>'
               + (''.join(point_row(p) for p in pts) if is_open else ''))
  prov_seg = ('<div class="seg" role="radiogroup" aria-label="Proveedor de las decisiones del proyecto">'
              '<button type="button" role="radio" aria-checked="true" class="on">Heredar · Jev</button>'
              '<button type="button" role="radio" aria-checked="false">Claude Code CLI</button>'
              '<button type="button" role="radio" aria-checked="false">Jev</button></div>')
  return f'''<section class="card col" style="gap: 0" aria-labelledby="decisions-h">
<div class="col" style="padding: 18px; gap: 14px"><div class="col" style="gap: 4px"><h2 class="t-h2" id="decisions-h">Decisiones</h2><span class="t-sm fg-2">Qué decide Agentry por ti en este proyecto. Cada punto hereda el ajuste global hasta que lo cambias aquí; el consentimiento sigue siendo global.</span></div>
<div class="decision-provider"><span class="t-label" style="color: var(--fg-2)">Proveedor</span>{prov_seg}<span class="t-xs fg-3">Jev está disponible: hay una clave global guardada.</span></div>
<div class="callout">{ico('info', 'ico fg-3')}<span style="line-height: 1.5"><b style="color: var(--fg); font-weight: 500">Sombra</b> decide en silencio y compara con lo que pasó: no cambia nada. <b style="color: var(--fg); font-weight: 500">Activo</b> cambia lo que ves, y lo marca con «decidido».</span></div></div>
{head}{groups}
</section>'''


def mseg(mode, inherited, label, cli_act=False):
  return seg(mode, inherited, label, cli_act)


def mpoint_card(p, cli=False):
  name, pid, kind, gmode, gthr, ov = p
  inherited = ov is None
  mode, thr = (gmode, gthr) if inherited else ov
  if not inherited and kind == 'act' and thr is None:
    thr = gthr
  disabled = cli and kind == 'act'
  if disabled and mode == 2:
    mode = 1
  thr_html = ''
  if kind == 'act':
    thr_html = f'<div class="row" style="gap: 10px"><span class="t-xs fg-3" style="width: 52px">Umbral</span><div class="grow">{threshold(thr, inherited or disabled, "Umbral de " + name)}</div></div>'
  why = f'<span class="decision-why">{ico("lock", "ico")}Con el CLI este punto solo sugiere: «Activo» pide Jev.</span>' if disabled else ''
  reset = '' if inherited else f'<span class="row t-xs fg-3 mono" style="gap: 8px">global: {MODES[gmode].lower()}<button type="button" class="btn btn-ghost" style="margin-left: auto">Usar la global</button></span>'
  tag = '<span class="mono t-xs fg-3">Heredado</span>' if inherited else ''
  return (f'<div class="decision-card" role="group" aria-label="{name}">'
          f'<div class="decision-card-top"><span class="decision-point"><span class="name" style="font-size: 14px">{name}</span><span class="id">{pid} · {KIND[kind].lower()}</span></span>{tag}</div>'
          f'{seg(mode, inherited, "Modo de " + name, disabled)}{thr_html}{why}{reset}</div>')


def tall(html, h):
  """A desktop screen taller than the 1440 x 1024 frame: the shell and its sidebar take the height."""
  return html.replace("height: 1024px", f"height: {h}px")


def usage_line():
  """One line on Usage, over the page's window, read from GET /decisions/stats. The page hides it
  when no decision was recorded in that window. "Jev 0,38 US$" is what the provider charged."""
  return (f'<div class="usage-decisions" role="note">{ico("flow", "ico ico-sm")}<span class="lead">Decisiones</span><span class="sep">·</span>'
          '<span>Jev <span class="mono t-num">0,38 US$</span></span><span class="sep">·</span>'
          '<span><span class="mono t-num">37</span> ejecuciones de Claude ahorradas</span>'
          '<a href="DesktopAjustes.html">Ver el historial</a></div>')
