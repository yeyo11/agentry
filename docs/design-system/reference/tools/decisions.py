# The Decisions tab of Settings (plans/decision-engine.md, UI): the four sections, the consent dialog
# with the state preview, History and the provider warning, on a desktop and on a phone.
# Run from this folder after nothing else: it imports common.py only.
#   python3 decisions.py
import html
from common import P, ico, desktop, mobile, write, tabbar

P.update({
  'thumbup': 'M7 10v11H3V10zM7 10l4-8a2.5 2.5 0 0 1 2.5 2.5V8H19a2 2 0 0 1 2 2.3l-1.3 8A2 2 0 0 1 17.7 20H7',
  'thumbdown': 'M7 14V3H3v11zM7 14l4 8a2.5 2.5 0 0 0 2.5-2.5V16H19a2 2 0 0 0 2-2.3l-1.3-8A2 2 0 0 0 17.7 4H7',
  'key': 'M14 10a5 5 0 1 1-2.6-4.4M12 10 3 19v2h3v-2h2v-2h2l2-2M17.5 9h.01',
  'shield': 'M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z',
  'chev': 'm6 9 6 6 6-6',
  'chevup': 'm6 15 6-6 6 6',
})

# ---------------------------------------------------------------- data
# id, label (es), kind (S suggest / A act), scope (G global / P per project), group
GROUPS = ['Flujo del proyecto', 'Tablero', 'Memoria', 'Asistente', 'Orquestaciones', 'Salud y supervisor', 'Revisión', 'Avisos', 'Paleta']
POINTS = [
  ('flow.refine-needed', 'Decidir si una tarjeta necesita refinarse', 'A', 'P', 0),
  ('flow.bounce', 'Devolver la tarjeta al desarrollador tras el rechazo de QA', 'A', 'P', 0),
  ('flow.scope-drift', 'Detectar trabajo fuera del alcance en un commit', 'S', 'P', 0),
  ('flow.criteria-precheck', 'Comprobar los criterios antes de lanzar QA', 'A', 'P', 0),
  ('flow.criteria-merge', 'Fusionar criterios casi idénticos', 'S', 'P', 0),
  ('flow.restart', 'Reencolar una ejecución cortada por un reinicio', 'A', 'P', 0),
  ('board.triage', 'Proponer tipo, prioridad y épica al crear una tarea', 'S', 'P', 1),
  ('team.assign', 'Proponer el miembro del equipo para una tarea', 'S', 'P', 1),
  ('memory.triage', 'Ordenar y deduplicar las propuestas de memoria', 'S', 'P', 2),
  ('journal.relevance', 'Elegir qué entradas del diario pasan al relevo', 'A', 'P', 2),
  ('assistant.rerank', 'Reordenar las propuestas del asistente', 'S', 'P', 3),
  ('assistant.sources', 'Elegir qué lee primero el asistente', 'A', 'P', 3),
  ('orchestration.retry', 'Reintentar o no una tarea que ha fallado', 'A', 'P', 4),
  ('orchestration.model', 'Sugerir el modelo de cada tarea del plan', 'S', 'P', 4),
  ('orchestration.fixer', 'Decidir si lanzar el arreglo tras un fallo de checks', 'A', 'P', 4),
  ('run.continuation', 'Decidir si el trabajo sigue abierto tras un resultado', 'A', 'P', 4),
  ('supervisor.intervene', 'Decidir si el supervisor interviene en un worker atascado', 'A', 'G', 5),
  ('health.semantic-loop', 'Detectar bucles que no repiten literalmente', 'S', 'G', 5),
  ('health.test-weakening', 'Avisar de tests debilitados', 'S', 'G', 5),
  ('changes.unexplained-hunk', 'Marcar cambios sin explicar en la revisión', 'S', 'P', 6),
  ('notification.urgency', 'Elegir la urgencia de cada aviso', 'A', 'G', 7),
  ('palette.intent', 'Interpretar lo que escribes en la paleta', 'S', 'G', 8),
]

# id -> (mode, threshold, consent, metrics key)
STATE = {
  'flow.refine-needed': ('active', 0.88, ('ok', 2), 'a'),
  'flow.bounce': ('shadow', 0.85, ('ok', 1), 'b'),
  'flow.scope-drift': ('shadow', None, ('ok', 1), 'c'),
  'board.triage': ('active', None, ('ok', 1), 'd'),
  'memory.triage': ('shadow', None, ('stale', 3), 'e'),
  'assistant.rerank': ('shadow', None, ('ok', 1), 'f'),
  'orchestration.retry': ('active', 0.9, ('ok', 1), 'g'),
  'run.continuation': ('shadow', 0.8, ('ok', 1), 'h'),
  'palette.intent': ('shadow', None, ('ok', 1), 'i'),
}
# count, acted, mean confidence, agreement (%, n), useful, not useful, unavailable, cost, runs saved
METRICS = {
  'a': ('41', '63 %', '0,91', ('88 %', '24'), '5', '1', '2', '0,004 US$', '12'),
  'b': ('18', '0 %', '0,87', ('78 %', '14'), '2', '1', '0', '0,002 US$', '0'),
  'c': ('9', '0 %', '0,79', ('67 %', '6'), '1', '2', '1', '0,001 US$', '0'),
  'd': ('96', '71 %', '0,82', ('—', '0'), '14', '3', '0', '0,008 US$', '0'),
  'e': ('23', '0 %', '0,84', ('74 %', '19'), '3', '1', '0', '0,002 US$', '0'),
  'f': ('31', '0 %', '0,80', ('81 %', '21'), '4', '0', '3', '0,003 US$', '0'),
  'g': ('12', '58 %', '0,93', ('92 %', '12'), '3', '0', '0', '0,001 US$', '7'),
  'h': ('27', '0 %', '0,86', ('85 %', '20'), '2', '1', '1', '0,003 US$', '0'),
  'i': ('54', '0 %', '0,77', ('70 %', '30'), '6', '4', '0', '0,005 US$', '0'),
}
METRIC_LABELS = ['Decisiones', 'Actuó', 'Confianza', 'Acuerdo', 'Útil', 'No útil', 'No disponible', 'Coste', 'Runs ahorrados']
METRIC_LABELS_PHONE = METRIC_LABELS

STATE_JSON = '''{
  "item": {
    "key": "AGN-52",
    "type": "task",
    "priority": "medium",
    "title": "Board columns keep their order after a reload",
    "description": "When the page reloads the Done column jumps to the left.",
    "criteria": [
      "Columns keep the order backlog, todo, in_progress, in_review, done",
      "A reload does not change the order"
    ]
  },
  "epic": { "key": "AGN-12", "title": "Project ecosystem" },
  "history": [ { "at": "2026-09-30T09:12:04Z", "kind": "moved", "to": "todo" } ],
  "refinedAlready": false,
  "flowEnabled": true
}'''


def esc(s):
  return html.escape(s, quote=False)


def seg(label, options, on, disabled=(), phone=False):
  bs = []
  for key, text in options:
    cls = ' class="on"' if key == on else ''
    dis = ' disabled aria-disabled="true" title="Con Claude Code CLI no hay confianza calibrada: un punto que actúa solo puede usar Jev"' if key in disabled else ''
    st = ' style="flex: 1; justify-content: center"' if phone else ''
    if key in disabled:
      st = st[:-1] + '; opacity: 0.45; cursor: not-allowed"' if st else ' style="opacity: 0.45; cursor: not-allowed"'
    bs.append(f'<button type="button" role="radio" aria-checked="{"true" if key == on else "false"}"{cls}{dis}{st}>{text}</button>')
  return f'<div class="seg" role="radiogroup" aria-label="{label}"{" style=&quot;display: flex&quot;" if phone else ""}>{"".join(bs)}</div>'.replace('&quot;', '"')


MODES = [('off', 'Apagado'), ('shadow', 'Sombra'), ('active', 'Activo')]
MODE_WORD = dict(MODES)


def slider(v, off=False, label='Umbral'):
  pos = (v - 0.5) / 0.49 * 100
  cls = ' off' if off else ''
  return (f'<div class="slider{cls}" role="slider" tabindex="0" aria-label="{label}" aria-valuemin="0.5" aria-valuemax="0.99" aria-valuenow="{v}"'
          f'{" aria-disabled=&quot;true&quot;" if off else ""}><span class="slider-track"><span class="slider-range" style="width: {pos:.0f}%"></span></span>'
          f'<span class="slider-thumb" style="left: calc({pos:.0f}% - 8px)"></span></div>').replace('&quot;', '"')


def num(v):
  return f'{v:.2f}'.replace('.', ',')


def state_of(pid, cli):
  mode, thr, consent, mk = STATE.get(pid, ('off', 0.85, None, None))
  kind = next(p[2] for p in POINTS if p[0] == pid)
  if cli and kind == 'A' and mode == 'active':
    mode = 'shadow'
  return mode, thr, consent, mk


def consent_cell(consent, mode):
  if consent is None:
    return '<span class="dp-consent fg-3">Sin consentir</span>'
  kind, v = consent
  if kind == 'ok':
    return f'<span class="dp-consent"><span class="dot dot-ok" style="width: 6px; height: 6px"></span>Consentido<span class="mono fg-3" style="font-size: 11.5px">v{v}</span></span>'
  return f'<span class="dp-consent" style="color: var(--warn)"><span class="dot dot-warn" style="width: 6px; height: 6px"></span>Pide de nuevo<span class="mono" style="font-size: 11.5px">v{v}</span></span>'


def metrics_html(mk, cli):
  m = list(METRICS[mk])
  if cli:
    m[2] = '—'
  ag = m[3]
  vals = [m[0], m[1], m[2], f'{ag[0]}<span class="fg-3"> n {ag[1]}</span>' if ag[0] != '—' else '—', m[4], m[5], m[6], m[7], m[8]]
  cells = ''.join(f'<div class="dp-metric"><span>{l}</span><span>{v}</span></div>' for l, v in zip(METRIC_LABELS, vals))
  return f'<div class="dp-metrics" aria-label="Métricas de la última semana">{cells}</div>'


def point_row(p, cli):
  pid, label, kind, scope, _ = p
  mode, thr, consent, mk = state_of(pid, cli)
  kw = 'Sugiere' if kind == 'S' else 'Actúa'
  disabled = ('active',) if (cli and kind == 'A') else ()
  if kind == 'A':
    sl = f'<div class="dp-thr">{slider(thr, off=(mode == "off" or cli), label="Umbral de " + pid)}<output>{"—" if cli else num(thr)}</output></div>'
  else:
    sl = '<span class="fg-3 t-sm">Sin umbral</span>'
  scope_w = 'global' if scope == 'G' else 'por proyecto'
  stale = consent is not None and consent[0] == 'stale'
  note = ''
  if stale:
    note = ('<div class="dp-note warn"><svg class="ico ico-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="' + P['warn'] + '"></path></svg>'
            '<span>En pausa: la forma del estado ha cambiado (v2 → v3). Revisa lo que se envía y vuelve a consentir.</span>'
            '<span class="grow"></span><button type="button" class="btn btn-sm">Revisar el estado</button></div>')
  elif disabled and mode != 'off':
    pass
  elif disabled and mode == 'off':
    note = '<div class="dp-note"><svg class="ico ico-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="' + P['lock'] + '"></path></svg>Activo requiere Jev: el CLI no da confianza, así que no puede superar un umbral.</div>'
  met = metrics_html(mk, cli) if mk and not stale else (metrics_html(mk, cli) if mk else '')
  return f'''<div class="dp-row" data-point="{pid}">
<div class="dp-name"><span>{label}</span><span class="dp-id">{pid}</span></div>
<span class="dp-kind">{kw}<br><span class="fg-3 t-xs">{scope_w}</span></span>
{seg("Modo de " + pid, MODES, mode, disabled)}
{sl}
{consent_cell(consent, mode)}
{note}{met}
</div>'''


def points_section(cli):
  out = []
  for gi, g in enumerate(GROUPS):
    rows = ''.join(point_row(p, cli) for p in POINTS if p[4] == gi)
    n = sum(1 for p in POINTS if p[4] == gi)
    out.append(f'<div class="dp-group"><div class="dp-group-head"><span class="t-label grow">{g}</span><span class="mono t-xs fg-3">{n}</span></div>{rows}</div>')
  return ''.join(out)


def card_head(icon, title, hint, id_):
  return (f'<div class="card-head" id="{id_}">{ico(icon, "ico fg-3")}<h2 class="t-h2">{title}</h2><span class="mono t-xs fg-3 grow" style="text-align: right">{hint}</span></div>')


def setting(label, hint, control, last=False, top=False):
  bd = '' if last else ' border-bottom: 1px solid var(--line);'
  al = 'flex-start' if top else 'center'
  return (f'<div class="row" style="padding: 18px 20px; gap: 24px; align-items: {al};{bd}">'
          f'<div class="col" style="width: 240px; gap: 4px; flex-shrink: 0"><span style="font-weight: 500">{label}</span><span class="t-sm fg-2">{hint}</span></div>'
          f'<div class="col grow" style="gap: 10px; min-width: 0; align-items: flex-start">{control}</div></div>')


def unavailable_warning(phone=False):
  btns = '<button type="button" class="btn btn-sm">Probar la conexión</button><button type="button" class="btn btn-sm btn-ghost">Ver en el historial</button>'
  return (f'<div class="callout callout-warn" role="status" style="align-items: flex-start; border-radius: var(--r-lg)">{ico("warn", "ico", "color: var(--warn); flex-shrink: 0; margin-top: 1px")}'
          f'<div class="col grow" style="gap: 8px; min-width: 0"><span style="font-weight: 500; color: var(--fg)">Jev no disponible</span>'
          f'<span>4 de las últimas 10 peticiones no han llegado: 3 por tiempo agotado y 1 por límite de tasa. La última fue hace 11 min. '
          f'Agentry sigue con su comportamiento de siempre y no espera a Jev.</span>'
          f'<div class="row" style="gap: 8px; flex-wrap: wrap">{btns}</div></div></div>')


def engine_section(cli, phone=False):
  provider = 'cli' if cli else 'jev'
  jev_state = f'''<div class="row" style="gap: 8px; flex-wrap: wrap"><div class="field grow" style="min-width: 0; max-width: 340px">{ico("key")}<input class="mono" value="••••••••••••••••a91f" aria-label="Clave de API de Jev" readonly></div>
<button type="button" class="btn">Cambiar</button><button type="button" class="btn btn-ghost">Quitar</button></div>
<div class="row" style="gap: 10px; flex-wrap: wrap"><button type="button" class="btn">{ico("activity", "ico ico-sm")}Probar la conexión</button>
<span class="row t-sm" style="gap: 8px"><span class="badge b-ok"><span class="dot dot-ok" style="width: 6px; height: 6px"></span>Conectado</span><span class="mono t-xs fg-3">0,2 s · hace 2 min</span></span></div>'''
  model_pin = f'''<div class="row" style="gap: 10px; flex-wrap: wrap"><span class="mono" style="font-size: 13px">jev-1.13.0</span><span class="badge">Fijado</span></div>
<div class="callout" style="align-items: flex-start">{ico("info", "ico", "flex-shrink: 0; color: var(--fg-3)")}<div class="col" style="gap: 8px"><span>Ha salido <span class="mono">jev-1.14.0</span>. Tus puntos siguen con la versión fijada. Antes de cambiar, deja los que actúan en sombra unos días y compara el acuerdo.</span><div class="row"><button type="button" class="btn btn-sm">Cambiar a jev-1.14.0</button></div></div></div>'''
  cli_ctl = f'''<div class="row" style="gap: 10px; flex-wrap: wrap; align-items: center">
<select class="select" aria-label="Modelo del CLI" style="width: 180px"><option>haiku</option><option>sonnet</option></select>
{seg("Esfuerzo", [("low", "Bajo"), ("med", "Medio"), ("high", "Alto")], "low")}
<div class="field" style="width: 130px"><input class="mono" value="0,02" aria-label="Límite de coste por petición" style="text-align: right"><span class="mono t-xs fg-3">US$</span></div></div>'''
  privacy = (f'<div class="callout" style="align-items: flex-start">{ico("shield", "ico", "flex-shrink: 0; color: var(--fg-3)")}<div class="col" style="gap: 6px">'
             f'<span style="font-weight: 500; color: var(--fg)">Qué sale de tu equipo con Jev</span>'
             f'<span>Solo el estado que declara cada punto, sin más, redactado y recortado a su límite, hacia <span class="mono">api.typesafe.ai</span>. '
             f'Lo ves entero antes de consentir cada punto. Jev no guarda nada solo en el plan enterprise. Con Claude Code CLI no sale nada.</span></div></div>')
  rows = [
    setting('Proveedor', 'Quién responde las preguntas. El CLI es el predeterminado; Jev es un servicio externo con tu clave.',
            seg('Proveedor', [('cli', 'Claude Code CLI'), ('jev', 'Jev')], provider) +
            ('<span class="form-hint">Cada proyecto puede elegir el suyo en sus ajustes.</span>')),
    setting('Claude Code CLI', 'Un chat interno por petición, con tu cuenta. Cuenta en tu cuota.', cli_ctl),
    setting('Clave de Jev', 'Se guarda en este equipo y la API nunca la devuelve.', jev_state, top=True),
    setting('Modelo de Jev', 'Fijado para que las respuestas no cambien sin avisarte.', model_pin, top=True),
    setting('Privacidad', 'Lo que sabe Jev de lo que haces.', privacy, top=True),
    setting('Conservar el historial', 'Las decisiones más antiguas se borran solas.',
            '<div class="row" style="gap: 8px; align-items: center"><div class="field" style="width: 110px"><input class="mono" value="30" aria-label="Días de historial" style="text-align: right"></div><span class="t-sm fg-2">días</span></div>', last=True),
  ]
  warn = '' if cli else f'<div style="padding: 18px 20px 0">{unavailable_warning()}</div>'
  return f'<section class="card col" style="flex-shrink: 0; gap: 0" aria-labelledby="sec-engine">{card_head("settings", "Motor", "Proveedor, modelo y privacidad", "sec-engine")}{warn}{"".join(rows)}</section>'


def points_card(cli):
  intro = ('<div class="row" style="padding: 14px 18px; gap: 14px; border-bottom: 1px solid var(--line)"><p class="t-sm fg-2 grow" style="margin: 0">'
           'Todos los puntos empiezan apagados. En sombra, el motor responde y lo compara con lo que pasó, pero no cambia nada. '
           'Un punto que actúa solo lo hace si la confianza supera su umbral.</p><span class="mono t-xs fg-3" style="white-space: nowrap">Métricas de los últimos 7 días</span></div>')
  return f'<section class="card col" style="flex-shrink: 0; gap: 0; overflow: hidden" aria-labelledby="sec-points">{card_head("flow", "Puntos de decisión", "22 puntos · 9 grupos", "sec-points")}{intro}{points_section(cli)}</section>'


def supervisor_card():
  return f'''<section class="card col" style="flex-shrink: 0; gap: 0" aria-labelledby="sec-sup">{card_head("activity", "Supervisor", "supervisor.json", "sec-sup")}
<div class="col" style="padding: 18px 20px; gap: 18px">
<p class="t-sm fg-2" style="margin: 0; line-height: 1.55">Cuando la salud de un worker empeora, un modelo pequeño lee sus últimos pasos y propone una pista de una o dos líneas. La propuesta aparece en la salud del worker, donde la envías, la editas antes o la descartas. Pregunta una vez por señal y por chat, y cada respuesta es un chat interno del CLI, que cuenta en el coste de la orquestación del worker.</p>
<label class="row" style="gap: 12px"><span class="switch on" role="switch" aria-checked="true" tabindex="0"></span><span>Proponer pistas para los workers que parecen atascados</span></label>
<div class="row" style="gap: 24px; align-items: flex-start; flex-wrap: wrap">
<div class="form-row" style="width: 300px"><span class="t-label">Modelo</span><select class="select" aria-label="Modelo del supervisor"><option>haiku</option></select><span class="form-hint">Basta con uno pequeño: lee unas pocas líneas y escribe dos.</span></div>
<div class="form-row" style="width: 300px"><span class="t-label">Límite de coste por propuesta (USD)</span><div class="field"><input class="mono" value="0,05" aria-label="Límite de coste por propuesta"></div><span class="form-hint">Se pasa al CLI como <span class="mono">--max-budget-usd</span> en cada pregunta.</span></div>
</div>
<div class="col" style="gap: 6px"><label class="row" style="gap: 12px"><span class="switch" role="switch" aria-checked="false" tabindex="0"></span><span>Enviar cada propuesta al worker por sí sola</span></label>
<span class="form-hint" style="padding-left: 46px">Desactivado, la propuesta te espera. Activado, llega al worker en cuanto se escribe y queda en la tarjeta de salud como enviada.</span></div>
<div class="row"><button type="button" class="btn btn-primary" disabled>Guardar</button></div>
</div></section>'''


HIST = [
  # time, point, project, provider, mode, answer, conf, outcome (word, tone), feedback, open
  ('hace 4 min', 'flow.refine-needed', 'claude-wrapper', 'jev-1.13.0', 'Activo', 'No hace falta refinar', '0,96', ('Coincide', 'ok'), 'up', False),
  ('hace 11 min', 'orchestration.retry', 'ecosystem-foundation', 'jev-1.13.0', 'Activo', 'Sin respuesta · tiempo agotado', '—', ('Como siempre', 'plain'), None, False),
  ('hace 14 min', 'flow.bounce', 'claude-wrapper', 'jev-1.13.0', 'Sombra', 'Devolver al desarrollador', '0,91', ('Coincide', 'ok'), None, True),
  ('hace 38 min', 'board.triage', 'claude-wrapper', 'jev-1.13.0', 'Activo', 'Tipo bug · prioridad alta', '0,82', ('Sin resultado', 'plain'), None, False),
  ('hace 1 h', 'palette.intent', '—', 'jev-1.13.0', 'Sombra', 'Abrir Uso', '0,71', ('Difiere', 'plain'), 'down', False),
  ('hace 2 h', 'assistant.rerank', 'claude-wrapper', 'jev-1.13.0', 'Sombra', 'Subir la propuesta 3', '0,80', ('Coincide', 'ok'), 'up', False),
]


def fb_icon(f):
  if f == 'up':
    return f'<span class="fg-2" title="Útil" role="img" aria-label="Útil">{ico("thumbup", "ico ico-sm")}</span>'
  if f == 'down':
    return f'<span class="fg-2" title="No útil" role="img" aria-label="No útil">{ico("thumbdown", "ico ico-sm")}</span>'
  return '<span class="fg-3">—</span>'


def outcome(o):
  w, tone = o
  if tone == 'ok':
    return f'<span class="row" style="gap: 6px"><span class="dot dot-ok" style="width: 6px; height: 6px"></span>{w}</span>'
  return f'<span class="fg-2">{w}</span>'


def hist_answer():
  probs = [('devolver', 91, '0,91'), ('aceptar', 7, '0,07'), ('preguntar', 2, '0,02')]
  bars = ''.join(f'<div class="dp-prob"><span>{n}</span><span class="bar bar-thin"><i style="width: {w}%"></i></span><span class="t-num" style="text-align: right">{v}</span></div>' for n, w, v in probs)
  return f'''<div class="dp-answer">
<div class="col" style="gap: 6px"><span class="t-label">Pregunta</span><span class="mono" style="font-size: 12.5px; line-height: 1.55">Should the card go back to the developer, be accepted as it is, or wait for the person? QA rejected it once and the failing criterion is still open.</span></div>
<div class="col" style="gap: 8px"><span class="t-label">Probabilidades</span>{bars}</div>
<div class="dp-facts"><div class="dp-fact"><span>Proveedor</span><span>jev · jev-1.13.0</span></div><div class="dp-fact"><span>Modo</span><span>sombra</span></div><div class="dp-fact"><span>Umbral</span><span>0,85</span></div><div class="dp-fact"><span>Latencia</span><span>0,21 s</span></div><div class="dp-fact"><span>Coste</span><span>0,00005 US$</span></div><div class="dp-fact"><span>Resultado</span><span>QA rechazó otra vez: coincide</span></div></div>
<div class="row" style="gap: 8px"><button type="button" class="btn btn-sm">{ico("thumbup", "ico ico-sm")}Útil</button><button type="button" class="btn btn-sm">{ico("thumbdown", "ico ico-sm")}No útil</button><span class="grow"></span><button type="button" class="btn btn-sm btn-ghost">{ico("trash", "ico ico-sm")}Eliminar</button></div>
</div>'''


def history_card(cli):
  filt = ''.join(f'<select class="select" aria-label="{a}" style="width: {w}px"><option>{b}</option></select>' for a, b, w in [
    ('Punto', 'Todos los puntos', 150), ('Proyecto', 'Todos los proyectos', 168), ('Proveedor', 'Proveedor: todos', 148), ('Modo', 'Modo: todos', 116), ('Estado', 'Estado: todos', 124)])
  bar = (f'<div class="row" style="padding: 14px 18px; gap: 8px; border-bottom: 1px solid var(--line); flex-wrap: wrap">{filt}<span class="grow"></span>'
         f'<button type="button" class="btn btn-danger btn-sm">{ico("trash", "ico ico-sm")}Vaciar…</button></div>')
  confirm = (f'<div class="dp-confirm" role="alertdialog" aria-label="Vaciar el historial">{ico("warn", "ico")}<span class="grow">Se eliminarán <b class="mono" style="font-weight: 500">148</b> decisiones que coinciden con los filtros. No se puede deshacer.</span>'
             f'<button type="button" class="btn btn-sm">Cancelar</button><button type="button" class="btn btn-sm btn-danger" style="border-color: var(--bad)">Eliminar 148</button></div>')
  head = ('<div class="dp-hist-head t-label"><span>Cuándo</span><span>Punto</span><span>Proveedor</span><span>Respuesta</span><span>Conf.</span><span>Resultado</span><span>Valoración</span></div>')
  rows = []
  for t, pid, proj, prov, mode, ans, conf, out, fb, op in HIST:
    unav = 'tiempo agotado' in ans
    ans_html = f'<span class="badge b-warn">No disponible</span> <span class="fg-2 t-xs">tiempo agotado</span>' if unav else f'<span class="ellipsis">{ans}</span>'
    rows.append(f'''<div class="dp-hist-row{" open" if op else ""}">
<span class="mono fg-3">{t}</span>
<span class="col" style="gap: 2px; min-width: 0"><span class="mono ellipsis">{pid}</span><span class="t-xs fg-3 ellipsis">{proj}</span></span>
<span class="col" style="gap: 2px; min-width: 0"><span class="mono ellipsis">{prov}</span><span class="t-xs fg-3">{mode}</span></span>
<span class="col" style="min-width: 0">{ans_html}</span>
<span class="mono t-num">{conf}</span>
{outcome(out)}
<span class="row" style="gap: 6px">{fb_icon(fb)}<span class="grow"></span>{ico("chevup" if op else "chev", "ico ico-sm fg-3")}</span>
</div>{hist_answer() if op else ""}''')
  foot = '<div class="row" style="padding: 12px 18px; gap: 12px"><span class="mono t-xs fg-3">6 de 148 decisiones · últimos 30 días</span><span class="grow"></span><button type="button" class="btn btn-sm">Cargar más</button></div>'
  return f'<section class="card col" style="flex-shrink: 0; gap: 0; overflow: hidden" aria-labelledby="sec-history">{card_head("wait", "Historial", "30 días · editable arriba", "sec-history")}{bar}{confirm}{head}{"".join(rows)}{foot}</section>'


SETTINGS_NAV = [
  ('Agentry', ['Apariencia', 'Notificaciones', 'Editor', 'Cuenta', 'Decisiones']),
  ('Claude Code', ['Instrucciones', 'Ajustes', 'Memoria', 'Reglas', 'Output styles']),
  ('Extensiones', ['Servidores MCP', 'Plugins', 'Skills', 'Agentes', 'Comandos', 'Workflows', 'Presets de herramientas']),
  ('Sistema', ['Archivos', 'Instalar', 'Seguridad']),
]


def settings_nav():
  out = []
  for g, items in SETTINGS_NAV:
    links = ''.join(f'<a href="#" class="nav-item{" on" if i == "Decisiones" else ""}" style="height: 30px; font-size: 13px">{i}</a>' for i in items)
    out.append(f'<div class="col" style="gap: 1px"><span class="t-label" style="padding: 0 10px 4px">{g}</span>{links}</div>')
  return ('<nav aria-label="Secciones de ajustes" class="col" style="width: 236px; flex-shrink: 0; padding: 26px 12px 20px 24px; gap: 16px; overflow: hidden; border-right: 1px solid var(--line)">'
          '<h1 class="t-h1" style="padding-left: 10px; font-size: 20px">Ajustes</h1>' + ''.join(out) + '</nav>')


def jump():
  items = [('Motor', '#sec-engine'), ('Puntos de decisión', '#sec-points'), ('Supervisor', '#sec-sup'), ('Historial', '#sec-history')]
  return '<nav class="row" aria-label="Secciones de Decisiones" style="gap: 8px">' + ''.join(f'<a href="{h}" class="chip">{n}</a>' for n, h in items) + '</nav>'


def desktop_main(cli):
  head = ('<div class="col" style="gap: 4px"><h2 class="t-h1" style="font-size: 20px">Decisiones</h2>'
          '<p class="fg-2 t-sm" style="margin: 0">Preguntas cortas con respuesta tipada que Agentry resuelve por ti, con el CLI o con Jev. Cada punto empieza apagado y tú decides cuándo pasa a sombra o a activo.</p></div>')
  return (f'<main class="col grow" style="padding: 26px 32px; gap: 18px; min-width: 0">{head}{jump()}{engine_section(cli)}{points_card(cli)}{supervisor_card()}{history_card(cli)}</main>')


def desktop_page(name, title, cli=False, overlay='', offset=0, tall=3600):
  body = desktop_main(cli)
  inner = f'<div class="row" style="flex: 1 1 auto; min-height: 0; align-items: stretch; gap: 0; overflow: hidden">{settings_nav()}{body}</div>'
  if offset:
    inner = f'<div class="row" style="flex: 1 1 auto; min-height: 0; align-items: flex-start; gap: 0; overflow: hidden"><div style="margin-top: -{offset}px; display: flex; width: 100%">{settings_nav()}{body}</div></div>'
  h = desktop(title, 'settings', '<span style="font-weight: 500">Ajustes</span>', inner, overlay=overlay, project='Todos los proyectos', agents=3, running=3)
  if not overlay:
    h = h.replace('height: 1024px', f'height: {tall}px')
  write(name, h)


# ---------------------------------------------------------------- the consent dialog
def preview_json():
  return esc(STATE_JSON)


def consent_dialog(cli):
  where = ('<span class="dp-fact"><span>Va a</span><span>este equipo (chat interno del CLI)</span></span>' if cli else
           '<span class="dp-fact"><span>Va a</span><span>Jev · api.typesafe.ai</span></span>')
  facts = (f'<div class="dp-facts">{where}<span class="dp-fact"><span>Tamaño</span><span>1,8 KB · ≈ 460 tokens</span></span>'
           f'<span class="dp-fact"><span>Versión del estado</span><span>v2</span></span></div>')
  if cli:
    notice = (f'<div class="callout" style="align-items: flex-start">{ico("lock", "ico", "flex-shrink: 0; color: var(--ok)")}<div class="col" style="gap: 4px">'
              '<span style="font-weight: 500; color: var(--fg)">Nada sale de tu equipo</span>'
              '<span>Con Claude Code CLI la pregunta se hace en un chat interno con tu cuenta, igual que el resto de tus chats. Lo que ves abajo es lo que lee ese chat.</span></div></div>')
    foot_btn = 'Consentir y pasar a sombra'
  else:
    notice = (f'<div class="callout callout-warn" style="align-items: flex-start">{ico("shield", "ico", "flex-shrink: 0; color: var(--warn)")}<div class="col" style="gap: 4px">'
              '<span style="font-weight: 500; color: var(--fg)">Este contenido sale de tu equipo</span>'
              '<span>Se envía a un servicio externo de TypeSafe con tu clave. Jev no guarda nada solo en el plan enterprise. Si la forma del estado cambia, Agentry te lo volverá a preguntar.</span></div></div>')
    foot_btn = 'Consentir y pasar a sombra'
  return f'''<div style="position: absolute; inset: 0; z-index: 30"><div class="scrim">
<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dec-consent" style="width: 640px; max-height: calc(100% - 48px)">
<div class="dialog-head">{ico("shield", "ico fg-3")}<div class="col grow" style="gap: 2px"><h2 id="dec-consent" class="t-h2">Antes de pasar a sombra</h2><span class="mono t-xs fg-3">flow.refine-needed · Decidir si una tarjeta necesita refinarse</span></div><button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Cerrar">{ico("x")}</button></div>
<div class="dialog-body" style="gap: 14px">
{notice}
<div class="col" style="gap: 8px"><span class="t-label">Estado exacto de la última petición</span><pre class="dp-preview" aria-label="Estado que se envía">{preview_json()}</pre></div>
{facts}
</div>
<div class="dialog-foot"><span class="t-sm fg-2" style="white-space: nowrap">Puedes retirarlo cuando quieras apagando el punto.</span><span class="grow"></span><button type="button" class="btn">Cancelar</button><button type="button" class="btn btn-primary">{foot_btn}</button></div>
</div></div></div>'''


# ---------------------------------------------------------------- phone
def mhead(title, back='MobileAjustes.html'):
  return (f'<header class="m-head" style="padding-left: 4px"><a href="{back}" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver">{ico("left", "ico ico-lg", "stroke-width: 2")}</a>'
          f'<h1 class="t-h1 grow">{title}</h1></header>')


def mjump():
  items = [('Motor', '#m-engine'), ('Puntos', '#m-points'), ('Supervisor', '#m-sup'), ('Historial', '#m-history')]
  return '<nav class="row" aria-label="Secciones de Decisiones" style="gap: 6px">' + ''.join(f'<a href="{h}" class="chip" style="flex: 1; justify-content: center">{n}</a>' for n, h in items) + '</nav>'


def mfield(label, hint, control):
  return f'<div class="col" style="padding: 14px; gap: 8px; border-bottom: 1px solid var(--line)"><span style="font-weight: 500">{label}</span>{control}{f"<span class=form-hint>{hint}</span>" if hint else ""}</div>'


def mengine(cli):
  provider = 'cli' if cli else 'jev'
  warn = '' if cli else f'<div style="padding: 14px 14px 0">{unavailable_warning(True)}</div>'
  rows = [
    mfield('Proveedor', 'El CLI es el predeterminado; Jev es un servicio externo con tu clave. Cada proyecto puede elegir el suyo.', seg('Proveedor', [('cli', 'Claude Code CLI'), ('jev', 'Jev')], provider, phone=True)),
    mfield('Modelo del CLI', 'Un chat interno por petición, con tu cuenta.', '<select class="select" aria-label="Modelo del CLI" style="width: 100%; font-size: 16px"><option>haiku</option></select>'),
    mfield('Esfuerzo', '', seg('Esfuerzo', [('low', 'Bajo'), ('med', 'Medio'), ('high', 'Alto')], 'low', phone=True)),
    mfield('Límite de coste por petición', '', '<div class="field field-lg"><input class="mono" value="0,02" aria-label="Límite de coste por petición" style="font-size: 16px"><span class="mono t-xs fg-3">US$</span></div>'),
    mfield('Clave de Jev', 'Se guarda en este equipo y la API nunca la devuelve.',
           f'<div class="field field-lg">{ico("key")}<input class="mono" value="••••••••••••a91f" aria-label="Clave de API de Jev" readonly style="font-size: 16px"></div>'
           f'<div class="row" style="gap: 8px"><button type="button" class="btn btn-lg grow">Cambiar</button><button type="button" class="btn btn-lg btn-ghost">Quitar</button></div>'
           f'<button type="button" class="btn btn-lg">{ico("activity", "ico")}Probar la conexión</button>'
           f'<span class="row t-sm" style="gap: 8px"><span class="badge b-ok"><span class="dot dot-ok" style="width: 6px; height: 6px"></span>Conectado</span><span class="mono t-xs fg-3">0,2 s · hace 2 min</span></span>'),
    mfield('Modelo de Jev', '', '<div class="row" style="gap: 10px"><span class="mono">jev-1.13.0</span><span class="badge">Fijado</span></div>'
           f'<div class="callout" style="align-items: flex-start">{ico("info", "ico", "flex-shrink: 0; color: var(--fg-3)")}<div class="col" style="gap: 10px"><span>Ha salido <span class="mono">jev-1.14.0</span>. Antes de cambiar, deja los puntos que actúan en sombra unos días y compara el acuerdo.</span><button type="button" class="btn">Cambiar a jev-1.14.0</button></div></div>'),
    mfield('Privacidad', '', f'<div class="callout" style="align-items: flex-start">{ico("shield", "ico", "flex-shrink: 0; color: var(--fg-3)")}<span>Con Jev sale de tu equipo solo el estado que declara cada punto, redactado y recortado, hacia <span class="mono">api.typesafe.ai</span>. Lo ves entero antes de consentir. Jev no guarda nada solo en el plan enterprise. Con Claude Code CLI no sale nada.</span></div>'),
    mfield('Conservar el historial', '', '<div class="row" style="gap: 10px; align-items: center"><div class="field field-lg" style="width: 120px"><input class="mono" value="30" aria-label="Días de historial" style="font-size: 16px; text-align: right"></div><span class="t-sm fg-2">días</span></div>'),
  ]
  rows[-1] = rows[-1].replace(' border-bottom: 1px solid var(--line)', '')
  return f'<section class="col" style="gap: 6px" id="m-engine" aria-label="Motor"><span class="t-label" style="padding: 0 4px">Motor</span><div class="card" style="overflow: hidden">{warn}{"".join(rows)}</div></section>'


def mpoints(cli):
  out = []
  for gi, g in enumerate(GROUPS):
    cells = []
    for p in [p for p in POINTS if p[4] == gi]:
      pid, label, kind, scope, _ = p
      mode, thr, consent, mk = state_of(pid, cli)
      badge = {'off': '<span class="fg-3">Apagado</span>', 'shadow': '<span class="badge">Sombra</span>', 'active': '<span class="badge b-accent">Activo</span>'}[mode]
      kw = 'Sugiere' if kind == 'S' else 'Actúa'
      stale = consent is not None and consent[0] == 'stale'
      extra = f'<span class="row t-xs" style="gap: 6px; color: var(--warn)">{ico("warn", "ico ico-sm")}En pausa: vuelve a consentir</span>' if stale else ''
      cells.append(f'<a href="#" class="cell stacked" style="min-height: 64px"><span class="row" style="gap: 10px"><span class="grow" style="font-weight: 500; font-size: 14px; line-height: 1.35">{label}</span>{ico("right", "ico fg-3")}</span>'
                   f'<span class="row t-xs" style="gap: 10px"><span class="mono fg-3 ellipsis grow">{pid}</span><span class="fg-2">{kw}</span>{badge}</span>{extra}</a>')
    out.append(f'<div class="col" style="gap: 6px"><span class="t-label" style="padding: 0 4px">{g}</span><div class="card" style="overflow: hidden">{"".join(cells)}</div></div>')
  intro = '<p class="t-sm fg-2" style="margin: 0 4px; line-height: 1.5">Todos los puntos empiezan apagados. En sombra, el motor responde y lo compara con lo que pasó, pero no cambia nada. Toca uno para ajustarlo.</p>'
  return f'<section class="col" style="gap: 14px" id="m-points" aria-label="Puntos de decisión"><span class="t-label" style="padding: 0 4px">Puntos de decisión</span>{intro}{"".join(out)}</section>'


def msupervisor():
  return f'''<section class="col" style="gap: 6px" id="m-sup" aria-label="Supervisor"><span class="t-label" style="padding: 0 4px">Supervisor</span>
<div class="card col" style="padding: 14px; gap: 16px">
<p class="t-sm fg-2" style="margin: 0; line-height: 1.55">Cuando la salud de un worker empeora, un modelo pequeño lee sus últimos pasos y propone una pista de una o dos líneas. Cada respuesta es un chat interno del CLI, que cuenta en el coste de la orquestación del worker.</p>
<label class="row" style="gap: 12px; min-height: 44px"><span class="switch switch-lg on" role="switch" aria-checked="true" tabindex="0"></span><span class="grow">Proponer pistas para los workers que parecen atascados</span></label>
<div class="form-row"><span class="t-label">Modelo</span><select class="select" aria-label="Modelo del supervisor" style="font-size: 16px; height: 44px"><option>haiku</option></select><span class="form-hint">Basta con uno pequeño: lee unas pocas líneas y escribe dos.</span></div>
<div class="form-row"><span class="t-label">Límite de coste por propuesta (USD)</span><div class="field field-lg"><input class="mono" value="0,05" aria-label="Límite de coste por propuesta" style="font-size: 16px"></div><span class="form-hint">Se pasa al CLI como <span class="mono">--max-budget-usd</span> en cada pregunta.</span></div>
<label class="row" style="gap: 12px; min-height: 44px"><span class="switch switch-lg" role="switch" aria-checked="false" tabindex="0"></span><span class="grow">Enviar cada propuesta al worker por sí sola</span></label>
<span class="form-hint" style="margin-top: -8px">Desactivado, la propuesta te espera. Activado, llega al worker en cuanto se escribe y queda en la tarjeta de salud como enviada.</span>
<button type="button" class="btn btn-lg" disabled>Guardar</button>
</div></section>'''


def mhistory():
  chips = ('<div class="row" style="gap: 8px; flex-wrap: wrap"><button type="button" class="chip">Todos los puntos<span class="n">▾</span></button>'
           '<button type="button" class="chip on">Jev</button><button type="button" class="chip">Filtros<span class="n">2</span></button>'
           '<span class="grow"></span><button type="button" class="btn btn-danger">Vaciar…</button></div>')
  confirm = (f'<div class="dp-confirm" role="alertdialog" aria-label="Vaciar el historial" style="border-radius: var(--r-lg)">{ico("warn", "ico")}<span class="grow" style="flex-basis: 60%">Se eliminarán <b class="mono" style="font-weight: 500">148</b> decisiones que coinciden con los filtros. No se puede deshacer.</span>'
             f'<div class="row" style="gap: 8px; width: 100%"><button type="button" class="btn grow">Cancelar</button><button type="button" class="btn btn-danger grow" style="border-color: var(--bad)">Eliminar 148</button></div></div>')
  cells = []
  for t, pid, proj, prov, mode, ans, conf, out, fb, op in HIST:
    unav = 'tiempo agotado' in ans
    a = '<span class="badge b-warn">No disponible</span><span class="t-xs fg-2">tiempo agotado</span>' if unav else f'<span class="t-sm">{ans}</span>'
    detail = ''
    if op:
      probs = [('devolver', 91, '0,91'), ('aceptar', 7, '0,07'), ('preguntar', 2, '0,02')]
      bars = ''.join(f'<div class="dp-prob" style="grid-template-columns: 76px minmax(0, 1fr) 36px"><span>{n}</span><span class="bar bar-thin"><i style="width: {w}%"></i></span><span class="t-num" style="text-align: right">{v}</span></div>' for n, w, v in probs)
      detail = (f'<div class="col" style="gap: 12px; padding-top: 6px">'
                f'<div class="col" style="gap: 4px"><span class="t-label">Pregunta</span><span class="mono" style="font-size: 12px; line-height: 1.55">Should the card go back to the developer, be accepted as it is, or wait for the person? QA rejected it once and the failing criterion is still open.</span></div>'
                f'<div class="col" style="gap: 8px"><span class="t-label">Probabilidades</span>{bars}</div>'
                f'<div class="dp-metrics grid-2"><div class="dp-metric"><span>Proveedor</span><span>jev-1.13.0</span></div><div class="dp-metric"><span>Umbral</span><span>0,85</span></div><div class="dp-metric"><span>Latencia</span><span>0,21 s</span></div><div class="dp-metric"><span>Coste</span><span>0,00005 US$</span></div></div>'
                f'<span class="t-sm fg-2">Resultado: QA rechazó otra vez, coincide.</span>'
                f'<div class="row" style="gap: 8px"><button type="button" class="btn grow">{ico("thumbup", "ico ico-sm")}Útil</button><button type="button" class="btn grow">{ico("thumbdown", "ico ico-sm")}No útil</button><button type="button" class="btn btn-icon" aria-label="Eliminar">{ico("trash", "ico ico-sm")}</button></div></div>')
    cells.append(f'<div class="cell stacked" style="gap: 6px; padding-top: 12px; padding-bottom: 12px{"; background: var(--bg-1)" if op else ""}">'
                 f'<span class="row" style="gap: 8px"><span class="mono" style="font-size: 12.5px">{pid}</span><span class="grow"></span><span class="mono t-xs fg-3">{t}</span></span>'
                 f'<span class="row" style="gap: 8px; flex-wrap: wrap">{a}</span>'
                 f'<span class="row t-xs" style="gap: 10px"><span class="mono fg-3 ellipsis">{prov} · {mode.lower()}</span><span class="mono t-num">{conf}</span><span class="grow"></span>{outcome(out)}{fb_icon(fb) if fb else ""}{ico("chevup" if op else "chev", "ico ico-sm fg-3")}</span>{detail}</div>')
  foot = '<div class="row" style="padding: 12px 14px; gap: 12px"><span class="mono t-xs fg-3 grow">6 de 148 · últimos 30 días</span><button type="button" class="btn">Cargar más</button></div>'
  return f'<section class="col" style="gap: 8px" id="m-history" aria-label="Historial"><span class="t-label" style="padding: 0 4px">Historial</span>{chips}{confirm}<div class="card" style="overflow: hidden">{"".join(cells)}{foot}</div></section>'


def mobile_page(name, title, cli=False, sheet='', offset=0):
  body = f'''{mhead('Decisiones')}
<div class="m-body" style="gap: 16px">
<p class="t-sm fg-2" style="margin: 0 4px; line-height: 1.5">Preguntas cortas con respuesta tipada que Agentry resuelve por ti, con el CLI o con Jev. Tú decides cuándo cada punto pasa a sombra o a activo.</p>
{mjump()}
{mengine(cli)}
{mpoints(cli)}
{msupervisor()}
{mhistory()}
</div>'''
  if sheet:
    inner = f'<div style="flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; flex-direction: column"><div style="margin-top: -{offset}px">{body}</div></div>' + sheet
    write(name, mobile(title, inner))
  else:
    inner = body + '\n' + tabbar('more').replace('class="app tabbar"', 'class="app tabbar" ')
    h = mobile(title, inner, style='height: auto; min-height: 844px')
    write(name, h)


def scrim():
  return '<div style="position: absolute; inset: 0; z-index: 10; background: color-mix(in srgb, var(--bg) 60%, transparent)"></div>'


def mconsent_sheet(cli):
  if cli:
    notice = (f'<div class="callout" style="align-items: flex-start">{ico("lock", "ico", "flex-shrink: 0; color: var(--ok)")}<div class="col" style="gap: 4px"><span style="font-weight: 500; color: var(--fg)">Nada sale de tu equipo</span><span>La pregunta se hace en un chat interno del CLI, con tu cuenta.</span></div></div>')
    where = 'este equipo (CLI)'
  else:
    notice = (f'<div class="callout callout-warn" style="align-items: flex-start">{ico("shield", "ico", "flex-shrink: 0; color: var(--warn)")}<div class="col" style="gap: 4px"><span style="font-weight: 500; color: var(--fg)">Este contenido sale de tu equipo</span><span>Se envía a Jev con tu clave. Si la forma del estado cambia, te lo volveremos a preguntar.</span></div></div>')
    where = 'Jev · api.typesafe.ai'
  return f'''{scrim()}
<div class="sheet" role="dialog" aria-label="Antes de pasar a sombra" style="z-index: 11; padding-bottom: 28px; display: flex; flex-direction: column; gap: 12px; max-height: 88%">
<div class="grab" style="margin-bottom: 0"></div>
<div class="col" style="gap: 2px"><h2 class="t-h2">Antes de pasar a sombra</h2><span class="mono t-xs fg-3">flow.refine-needed</span></div>
{notice}
<div class="col" style="gap: 6px; min-height: 0"><span class="t-label">Estado exacto de la última petición</span><pre class="dp-preview" aria-label="Estado que se envía" style="max-height: 200px; font-size: 11.5px">{preview_json()}</pre></div>
<div class="dp-metrics grid-2"><div class="dp-metric"><span>Va a</span><span style="white-space: normal">{where}</span></div><div class="dp-metric"><span>Tamaño</span><span>1,8 KB · ≈ 460 tokens</span></div></div>
<div class="row" style="gap: 8px"><button type="button" class="btn btn-lg">Cancelar</button><button type="button" class="btn btn-lg btn-primary grow">Consentir y pasar a sombra</button></div>
</div>'''


def mpoint_sheet(cli):
  pid, label = 'flow.refine-needed', 'Decidir si una tarjeta necesita refinarse'
  mode, thr, consent, mk = state_of(pid, cli)
  disabled = ('active',) if cli else ()
  reason = (f'<span class="row t-xs fg-3" style="gap: 8px">{ico("lock", "ico ico-sm")}Activo requiere Jev: el CLI no da confianza, así que no puede superar un umbral.</span>' if cli else '')
  return f'''{scrim()}
<div class="sheet" role="dialog" aria-label="{label}" style="z-index: 11; padding-bottom: 28px; display: flex; flex-direction: column; gap: 14px; max-height: 92%">
<div class="grab" style="margin-bottom: 0"></div>
<div class="col" style="gap: 2px"><h2 class="t-h2">{label}</h2><span class="mono t-xs fg-3">{pid} · por proyecto · Actúa</span></div>
<div class="col" style="gap: 8px"><span class="t-label">Modo</span>{seg("Modo de " + pid, MODES, mode, disabled, phone=True)}{reason}</div>
<div class="col" style="gap: 2px"><span class="row"><span class="t-label grow">Umbral</span><span class="mono t-sm">{"—" if cli else num(thr)}</span></span>{slider(thr, off=cli, label="Umbral de " + pid)}<span class="form-hint">Actúa solo si la confianza lo supera; si no, sigue como hasta ahora.</span></div>
<div class="row" style="gap: 10px"><span class="t-label grow">Consentimiento</span>{consent_cell(consent, mode)}</div>
<div class="col" style="gap: 8px"><span class="t-label">Últimos 7 días</span>{metrics_grid(mk, cli)}</div>
<button type="button" class="btn btn-lg">Ver en el historial</button>
</div>'''


def metrics_grid(mk, cli):
  m = list(METRICS[mk])
  if cli:
    m[2] = '—'
  ag = m[3]
  vals = [m[0], m[1], m[2], f'{ag[0]}<span class="fg-3"> n {ag[1]}</span>' if ag[0] != '—' else '—', m[4], m[5], m[6], m[7], m[8]]
  cells = ''.join(f'<div class="dp-metric"><span>{l}</span><span>{v}</span></div>' for l, v in zip(METRIC_LABELS, vals))
  return f'<div class="dp-metrics grid-2" style="grid-template-columns: repeat(3, minmax(0, 1fr))">{cells}</div>'


if __name__ == '__main__':
  desktop_page('DesktopAjustesDecisiones.html', 'Ajustes, decisiones', tall=5450)
  desktop_page('DesktopAjustesDecisionesCli.html', 'Ajustes, decisiones con el CLI', cli=True, tall=5450)
  desktop_page('DesktopAjustesDecisionesConsentimiento.html', 'Ajustes, consentir un punto', overlay=consent_dialog(False), offset=1020)
  desktop_page('DesktopAjustesDecisionesConsentimientoCli.html', 'Ajustes, consentir un punto con el CLI', cli=True, overlay=consent_dialog(True), offset=1020)
  mobile_page('MobileAjustesDecisiones.html', 'Ajustes, decisiones')
  mobile_page('MobileAjustesDecisionesPunto.html', 'Ajustes, un punto de decisión', cli=True, sheet=mpoint_sheet(True), offset=1960)
  mobile_page('MobileAjustesDecisionesConsentimiento.html', 'Ajustes, consentir un punto', sheet=mconsent_sheet(False), offset=1960)
