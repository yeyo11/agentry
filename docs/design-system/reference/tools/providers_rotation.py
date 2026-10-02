# Rotation between providers (plans/multi-provider.md, phase 4, P0 task p1): Settings → Providers →
# what happens at a limit and the model mapping, the project's override of both, and DSLimites, the
# sheet with every state of a provider's limit. Its own file so it does not collide with p2 and p3.
# Runs after providers.py and projects.py are importable; it imports providers.py, decisions.py and
# decision_parts.py, and projects.py imports `project_providers_card` back from here.
#   python3 providers_rotation.py
from common import P, ico, desktop, mobile, write, page, tabbar
from decisions import scrim
from decision_parts import tall
from providers import PROV, mono_ico, badge, settings_nav, mhead, limit_block, STATE

P.update({'minus': 'M5 12h14'})

# ---------------------------------------------------------------- the words
# action id -> label, what it does. The ids never reach the screen: the person reads the label.
ACTIONS = [
  ('handoff', 'Continuar con un resumen', 'Sigue en el siguiente proveedor listo, en el mismo worktree, con un resumen de lo pedido, lo hecho y lo que falta.'),
  ('restart', 'Empezar de nuevo', 'Empieza en el siguiente proveedor, en el mismo worktree, desde el prompt original.'),
  ('wait', 'Esperar al reinicio', 'Reanuda en el mismo proveedor cuando se renueve el límite. No gasta nada en otro.'),
]
LABEL = {k: v for k, v, _ in ACTIONS}
GLOBAL = dict(action='handoff', allowed=['handoff', 'wait'], wait_h=6, moves=2)


def seg(name, selected, aria, lg=False, inherited=False):
  opts = ''.join(f'<button type="button" role="radio" aria-checked="{"true" if k == selected else "false"}"{" class=\"on\"" if k == selected else ""}'
                 f'{" style=\"flex: 1 1 0; justify-content: center; height: 40px\"" if lg else ""}>{v}</button>'
                 for k, v, _ in ACTIONS)
  return (f'<div class="seg{" is-inherited" if inherited else ""}" role="radiogroup" aria-label="{aria}"'
          f'{" style=\"display: flex\"" if lg else ""}>{opts}</div>')


def check(on, label, note='', disabled=False, aria=None):
  box = (f'<span class="checkbox{" on" if on else ""}" role="checkbox" aria-checked="{"true" if on else "false"}"'
         f'{" aria-disabled=\"true\"" if disabled else ""} tabindex="0" aria-label="{aria or label}"></span>')
  extra = f'<span class="t-xs fg-3">{note}</span>' if note else ''
  return (f'<label class="rot-check{" is-disabled" if disabled else ""}">{box}<span class="col" style="gap: 1px"><span>{label}</span>{extra}</span></label>')


def stepper(value, unit, aria, lg=False):
  st = ' style="height: 44px"' if lg else ''
  bst = ' style="width: 44px"' if lg else ''
  return (f'<div class="stepper" role="spinbutton" aria-label="{aria}" aria-valuenow="{value}"{st}><button type="button" aria-label="Menos"{bst}>{ico("minus", "ico ico-sm")}</button>'
          f'<output>{value} {unit}</output><button type="button" aria-label="Más"{bst}>{ico("plus", "ico ico-sm")}</button></div>')


def jump(items, active):
  return ('<nav class="row" aria-label="Secciones de proveedores" style="gap: 6px">'
          + ''.join(f'<a href="#" class="chip{" on" if i == active else ""}">{i}</a>' for i in items) + '</nav>')


# ---------------------------------------------------------------- the on-limit card
def head_of(icon, title, hint, id_):
  return f'<div class="card-head" id="{id_}">{ico(icon, "ico fg-3")}<h2 class="t-h2">{title}</h2><span class="mono t-xs fg-3 grow" style="text-align: right">{hint}</span></div>'


def rot_row(title, hint, control):
  return (f'<div class="rot-row"><div class="col" style="gap: 4px; min-width: 0"><span style="font-weight: 500">{title}</span>'
          f'<span class="t-sm fg-2" style="line-height: 1.5">{hint}</span></div><div class="rot-ctl">{control}</div></div>')


def onlimit_card():
  allowed = ''.join([
    check(True, LABEL['handoff'], 'La acción de arriba: siempre está permitida', disabled=True),
    check(False, LABEL['restart']),
    check(True, LABEL['wait'])])
  return f'''<section class="card col" style="flex-shrink: 0; gap: 0; overflow: hidden" aria-labelledby="sec-onlimit">
{head_of('wait', 'Al llegar a un límite', 'solo trabajo lanzado por Agentry', 'sec-onlimit')}
<div class="col" style="padding: 18px; gap: 14px"><p class="t-sm fg-2" style="margin: 0; line-height: 1.5; max-width: 760px">Qué hace Agentry con el trabajo que lanza él (flujos, tareas de una orquestación, el asistente) cuando su proveedor agota el límite de uso. En un chat tuyo no se mueve nada solo: te lo pregunta, y la opción de aquí va primero.</p>
<div class="callout">{ico('info', 'ico fg-3')}<span style="line-height: 1.5"><b style="color: var(--fg); font-weight: 500">Esperar al reinicio</b> es lo que viene de serie. Una instalación nueva no manda trabajo ni resúmenes a otro proveedor hasta que lo actives aquí.</span></div></div>
{rot_row('Qué hacer', ACTIONS[0][2] + ' Con otra opción, el texto de debajo cambia.', seg('a', 'handoff', 'Qué hacer al llegar a un límite'))}
{rot_row('Qué puede elegir una decisión', 'Solo cuenta si el punto «Qué hacer al llegar al límite» de Decisiones está en Sombra o en Activo. Nunca elige fuera de esto.', f'<div class="col" style="gap: 10px">{allowed}</div>')}
{rot_row('Espera máxima', 'Si Agentry no sabe cuándo se renueva el límite, espera hasta este tiempo y después da el trabajo por fallido. De 1 a 48 h.', stepper(6, 'h', 'Espera máxima en horas'))}
{rot_row('Cambios de proveedor por trabajo', 'Pasado este número, el trabajo espera en lugar de seguir saltando entre proveedores. De 0 a 5.', stepper(2, '', 'Cambios de proveedor por trabajo').replace('<output>2 </output>', '<output>2</output>'))}
<div class="row" style="padding: 14px 18px; gap: 8px; justify-content: flex-end; border-top: 1px solid var(--line)"><button type="button" class="btn btn-ghost">Descartar</button><button type="button" class="btn btn-primary">Guardar los cambios</button></div>
</section>'''


# ---------------------------------------------------------------- the mapping editor
TARGETS = ['codex', 'gemini']
# (model, tier, {target: cell}); a cell is ('mapped', id) | ('suggested', id) | ('missing',) | ('gone', id)
MAP = [
  ('Opus 5.5', 'fuerte', False, {'codex': ('mapped', 'gpt-6.1-sol'), 'gemini': ('suggested', 'gemini-3.1-pro')}),
  ('Sonnet 5.5', 'equilibrado', True, {'codex': ('missing',), 'gemini': ('mapped', 'gemini-3.1-flash')}),
  ('Haiku 4.5', 'rápido', False, {'codex': ('mapped', 'gpt-6.1-mini'), 'gemini': ('gone', 'gemini-2.5-flash-lite')}),
]


def model_select(value, aria, lg=False):
  h = ' style="height: 44px; font-size: 16px; width: 100%"' if lg else ' style="width: 100%"'
  return f'<select class="select mono" aria-label="{aria}"{h}><option>{value}</option></select>'


def map_cell(target, cell, model):
  tl = PROV[target][0]
  kind = cell[0]
  aria = f'Equivalente de {model} en {tl}'
  if kind == 'mapped':
    return f'<div class="map-cell">{model_select(cell[1], aria)}</div>'
  if kind == 'missing':
    return (f'<div class="map-cell">{model_select("Elegir modelo…", aria)}<div class="row" style="gap: 8px; flex-wrap: wrap"><span class="badge b-warn">Sin equivalente</span>'
            f'<button type="button" class="btn btn-ghost btn-sm">{ico("sparkle", "ico ico-sm")}Sugerir</button></div>'
            f'<span class="t-xs fg-3" style="line-height: 1.45">Un trabajo con este modelo espera al reinicio.</span></div>')
  if kind == 'gone':
    return (f'<div class="map-cell">{model_select(cell[1], aria)}<div class="row" style="gap: 8px; flex-wrap: wrap"><span class="badge b-warn">Ya no se ofrece</span></div>'
            f'<span class="t-xs fg-3" style="line-height: 1.45">{tl} ya no lista este modelo: se trata como si no hubiera equivalente.</span></div>')
  return (f'<div class="map-cell"><div class="map-suggest" role="group" aria-label="Sugerencia para {model} en {tl}"><div class="row" style="gap: 8px; flex-wrap: wrap"><span class="mono" style="font-size: 13px">{cell[1]}</span><span class="badge b-accent">Sugerido</span></div>'
          f'<span class="t-xs fg-3" style="line-height: 1.45">No vale hasta que lo aceptes.</span>'
          f'<div class="row" style="gap: 6px"><button type="button" class="btn btn-sm">Aceptar</button><button type="button" class="btn btn-ghost btn-sm">Descartar</button></div></div></div>')


def mapping_card():
  seg_from = ('<div class="seg" role="radiogroup" aria-label="Modelos de origen">'
              '<button type="button" role="radio" aria-checked="true" class="on">Claude Code<span class="fg-3 mono" style="font-size: 11px">3</span></button>'
              '<button type="button" role="radio" aria-checked="false">Codex<span class="fg-3 mono" style="font-size: 11px">2</span></button>'
              '<button type="button" role="radio" aria-checked="false">Gemini CLI<span class="fg-3 mono" style="font-size: 11px">3</span></button></div>')
  head = ('<div class="map-row map-head"><span class="t-label">Modelo de Claude Code</span>'
          + ''.join(f'<span class="t-label">Equivale en {PROV[t][0]}</span>' for t in TARGETS) + '</div>')
  rows = ''
  for model, tier, target, cells in MAP:
    flag = '<span class="badge b-warn">Lo pide un trabajo</span>' if target else ''
    rows += (f'<div class="map-row{" is-target" if target else ""}" data-model="{model}"><div class="map-model"><span style="font-weight: 500">{model}</span>'
             f'<span class="mono t-xs fg-3">{tier}</span>{flag}</div>'
             + ''.join(map_cell(t, cells[t], model) for t in TARGETS) + '</div>')
  return f'''<section class="card col" style="flex-shrink: 0; gap: 0; overflow: hidden" aria-labelledby="sec-map">
{head_of('move', 'Equivalencias de modelos', 'empieza vacía', 'sec-map')}
<div class="col" style="padding: 18px; gap: 14px"><p class="t-sm fg-2" style="margin: 0; line-height: 1.5; max-width: 760px">Cuando un trabajo pasa de un proveedor a otro, usa el modelo equivalente que elijas aquí. Sin equivalente, el trabajo espera al reinicio y te lo dice. Nada entra solo: una sugerencia no vale hasta que la aceptas.</p>
<div class="row" style="gap: 12px; flex-wrap: wrap"><span class="t-label" style="color: var(--fg-2)">Desde</span>{seg_from}<span class="grow"></span><span class="mono t-xs fg-3">Se guarda al instante</span></div>
<div class="callout callout-warn">{ico('wait', 'ico', 'color: var(--warn)')}<span style="line-height: 1.5"><b style="color: var(--fg); font-weight: 500">Un trabajo espera esta equivalencia.</b> «Implementar AGN-28» iba a seguir en Codex, pero Sonnet 5.5 no tiene equivalente allí. Elige uno y seguirá cuando se renueve el límite de Claude Code.</span></div></div>
{head}{rows}
</section>'''


# ---------------------------------------------------------------- Settings → Providers, rotation, desktop
def desktop_rotation():
  head = (f'<div class="row" style="gap: 20px; align-items: flex-end"><div class="col grow" style="gap: 4px"><h2 class="t-h1" style="font-size: 20px">Proveedores</h2>'
          f'<p class="fg-2 t-sm" style="margin: 0; max-width: 640px">Qué pasa con el trabajo cuando un proveedor agota su límite, y qué modelo ocupa el lugar de cada uno al cambiar.</p></div></div>')
  main = (f'<main class="col grow" style="padding: 26px 32px; gap: 18px; min-width: 0">{head}'
          f'{jump(["Lista", "Al llegar a un límite", "Equivalencias de modelos"], "Al llegar a un límite")}{onlimit_card()}{mapping_card()}</main>')
  inner = f'<div class="row" style="flex: 1 1 auto; min-height: 0; align-items: stretch; gap: 0; overflow: hidden">{settings_nav()}{main}</div>'
  write('DesktopProveedoresRotacion.html', tall(desktop('Ajustes, proveedores: límites y equivalencias', 'settings', '<span style="font-weight: 500">Ajustes</span>', inner, project='Todos los proyectos', agents=3, running=3), 1700))


# ---------------------------------------------------------------- Settings → Providers, rotation, phone
def mrot_body():
  radios = ''
  for k, v, d in ACTIONS:
    on = k == 'handoff'
    radios += (f'<button type="button" class="rot-radio" role="radio" aria-checked="{"true" if on else "false"}"><span class="prov-radio{" on" if on else ""}"></span>'
               f'<span class="col grow" style="gap: 2px; text-align: left"><span style="font-weight: 500">{v}</span><span class="t-sm fg-2" style="line-height: 1.45">{d}</span></span></button>')
  def sw(on, label, note, disabled=False):
    return (f'<label class="cell" style="min-height: 56px"><span class="col grow" style="gap: 1px; min-width: 0"><span>{label}</span><span class="t-xs fg-3">{note}</span></span>'
            f'<button type="button" class="switch switch-lg{" on" if on else ""}" role="switch" aria-checked="{"true" if on else "false"}" aria-label="{label}"{" disabled" if disabled else ""}></button></label>')
  def step(label, note, value, unit):
    return (f'<div class="cell stacked" style="gap: 8px; padding-top: 12px; padding-bottom: 12px"><div class="row" style="gap: 12px"><span class="col grow" style="gap: 1px"><span>{label}</span><span class="t-xs fg-3" style="line-height: 1.45">{note}</span></span>'
            f'{stepper(value, unit, label, lg=True)}</div></div>')
  return f'''{mhead('Al llegar a un límite', 'MobileProveedores.html')}
<div class="m-body stack" style="gap: 14px; overflow-y: auto">
<p class="t-sm fg-2" style="margin: 0 4px; line-height: 1.5">Qué hace Agentry con el trabajo que lanza él cuando un proveedor agota su límite. En un chat tuyo no se mueve nada solo: te lo pregunta, y la opción de aquí va primero.</p>
<div class="col" style="gap: 8px"><span class="t-label" style="padding: 0 4px">Qué hacer</span><div class="card" style="overflow: hidden" role="radiogroup" aria-label="Qué hacer al llegar a un límite">{radios}</div></div>
<div class="col" style="gap: 8px"><span class="t-label" style="padding: 0 4px">Qué puede elegir una decisión</span><div class="card" style="overflow: hidden">
{sw(True, LABEL['handoff'], 'La acción de arriba: siempre permitida', True)}{sw(False, LABEL['restart'], 'No se ofrece a las decisiones')}{sw(True, LABEL['wait'], 'Permitida')}</div>
<span class="form-hint" style="padding: 0 4px">Solo cuenta si el punto «Qué hacer al llegar al límite» de Decisiones está en Sombra o en Activo.</span></div>
<div class="card" style="overflow: hidden">{step('Espera máxima', 'Sin fecha de reinicio, espera hasta aquí y falla. De 1 a 48 h.', 6, 'h')}{step('Cambios por trabajo', 'Pasados estos, espera. De 0 a 5.', 2, '')}</div>
</div>
<div class="m-foot"><button type="button" class="btn btn-primary btn-lg">Guardar los cambios</button></div>'''


def mobile_rotation():
  write('MobileProveedoresRotacion.html', mobile('Ajustes, al llegar a un límite', mrot_body().replace('<output>2 </output>', '<output>2</output>')))


def mmap_body(sheet=False):
  cards = ''
  for model, tier, target, cells in MAP:
    rows = ''
    for t in TARGETS:
      cell = cells[t]
      tl = PROV[t][0]
      if cell[0] == 'mapped':
        right = f'<span class="mono" style="font-size: 13px">{cell[1]}</span>{ico("right", "ico fg-3")}'
        sub = ''
      elif cell[0] == 'missing':
        right = f'<span class="badge b-warn">Sin equivalente</span>{ico("right", "ico fg-3")}'
        sub = ''
      elif cell[0] == 'gone':
        right = f'<span class="badge b-warn">Ya no se ofrece</span>{ico("right", "ico fg-3")}'
        sub = ''
      else:
        right = f'<span class="badge b-accent">Sugerido</span>'
        sub = ''
      if cell[0] == 'suggested':
        rows += (f'<div class="cell stacked" style="gap: 8px; padding-top: 12px; padding-bottom: 12px"><div class="row" style="gap: 8px"><span class="grow">{tl}</span>{right}</div>'
                 f'<span class="mono" style="font-size: 13px">{cell[1]}</span><span class="t-xs fg-3">No vale hasta que lo aceptes.</span>'
                 f'<div class="row" style="gap: 8px"><button type="button" class="btn btn-lg grow" style="justify-content: center">Aceptar</button><button type="button" class="btn btn-lg btn-ghost grow" style="justify-content: center">Descartar</button></div></div>')
      else:
        rows += f'<a href="MobileProveedoresEquivalenciasPar.html" class="cell" style="min-height: 52px"><span class="grow">{tl}</span>{right}</a>'
    flag = '<span class="badge b-warn">Lo pide un trabajo</span>' if target else ''
    cards += (f'<div class="col" style="gap: 8px"><div class="row" style="gap: 8px; padding: 0 4px"><span style="font-weight: 500">{model}</span><span class="mono t-xs fg-3 grow">{tier}</span>{flag}</div>'
              f'<div class="card" style="overflow: hidden">{rows}</div></div>')
  chips = ('<div class="row" style="gap: 6px; flex-wrap: wrap" role="radiogroup" aria-label="Modelos de origen"><button type="button" role="radio" aria-checked="true" class="chip on" style="height: 44px; padding: 0 16px">Claude Code</button>'
           '<button type="button" role="radio" aria-checked="false" class="chip" style="height: 44px; padding: 0 16px">Codex</button>'
           '<button type="button" role="radio" aria-checked="false" class="chip" style="height: 44px; padding: 0 16px">Gemini CLI</button></div>')
  return f'''{mhead('Equivalencias de modelos', 'MobileProveedores.html')}
<div class="m-body stack" style="gap: 14px; overflow-y: auto">
<p class="t-sm fg-2" style="margin: 0 4px; line-height: 1.5">Al pasar de un proveedor a otro, el trabajo usa el modelo equivalente que elijas. Sin equivalente espera al reinicio. Nada entra solo: una sugerencia no vale hasta que la aceptas.</p>
<div class="callout callout-warn" style="padding: 12px">{ico('wait', 'ico', 'color: var(--warn)')}<span style="line-height: 1.5"><b style="color: var(--fg); font-weight: 500">Un trabajo espera esta equivalencia.</b> Sonnet 5.5 no tiene equivalente en Codex.</span></div>
<div class="col" style="gap: 8px"><span class="t-label" style="padding: 0 4px">Desde</span>{chips}</div>
{cards}
</div>'''


def mobile_mapping():
  write('MobileProveedoresEquivalencias.html', mobile('Ajustes, equivalencias de modelos', mmap_body()))
  models = ''.join(
    f'<button type="button" class="rot-radio" role="radio" aria-checked="{"false"}"><span class="prov-radio"></span>'
    f'<span class="col grow" style="gap: 1px; text-align: left"><span class="mono" style="font-size: 14px">{m}</span><span class="t-xs fg-3">{n}</span></span></button>'
    for i, (m, n) in enumerate([('gpt-6.1-sol', 'fuerte'), ('gpt-6.1-mini', 'rápido'), ('gpt-6.1-codex', 'equilibrado')]))
  none = ('<button type="button" class="rot-radio" role="radio" aria-checked="false"><span class="prov-radio"></span><span class="col grow" style="gap: 1px; text-align: left">'
          '<span>Ninguno</span><span class="t-xs fg-3">Ningún modelo de Codex puede ocupar su lugar: el trabajo espera</span></span></button>')
  sheet = f'''{scrim()}
<div class="sheet" role="dialog" aria-label="Sonnet 5.5 en Codex" style="z-index: 11; padding-bottom: 28px; display: flex; flex-direction: column; gap: 12px; max-height: 92%">
<div class="grab" style="margin-bottom: 0"></div>
<div class="col" style="gap: 4px"><h2 class="t-h2">Sonnet 5.5 en Codex</h2><span class="row" style="gap: 8px"><span class="badge b-warn">Sin equivalente</span><span class="t-sm fg-2">El trabajo con este modelo espera al reinicio.</span></span></div>
<div class="col" style="gap: 0; overflow: hidden" role="radiogroup" aria-label="Modelo de Codex">{models}{none}</div>
<div class="col" style="gap: 8px"><button type="button" class="btn btn-lg btn-primary">Guardar la equivalencia</button>
<button type="button" class="btn btn-lg btn-ghost" style="justify-content: center">{ico("sparkle", "ico ico-sm")}Sugerir una equivalencia</button></div>
</div>'''
  write('MobileProveedoresEquivalenciasPar.html', mobile('Ajustes, equivalencia de un modelo', mmap_body() + '\n' + sheet))


# ---------------------------------------------------------------- the project's override
GLOBAL_ORDER = ['claude-code', 'copilot', 'codex', 'gemini', 'opencode']
IN_ORDER = ['claude-code', 'codex']
OUT_OF_ORDER = [('copilot', 'signed-out'), ('gemini', 'used-before'), ('opencode', 'not-installed')]
PSTATE = {'claude-code': 'ready', 'codex': 'ready'}


def order_rows():
  out = ''
  for i, pid in enumerate(IN_ORDER):
    st = PSTATE[pid]
    out += (f'<div class="prov-order-line"><span class="prov-grip" aria-hidden="true" style="height: 28px">{ico("grip", "ico ico-lg")}</span><span class="mono t-xs fg-3" style="width: 26px">{i + 1}.º</span>'
            f'{mono_ico(pid).replace("proj monogram", "proj monogram prov-mini")}<span class="grow">{PROV[pid][0]}</span>{badge(st)}'
            f'<button type="button" class="btn btn-ghost btn-sm">Quitar del orden</button></div>')
  out += '<div class="t-label" style="padding: 10px 0 2px">Fuera del orden · este proyecto no los usará</div>'
  for pid, st in OUT_OF_ORDER:
    out += (f'<div class="prov-order-line is-out">{mono_ico(pid).replace("proj monogram", "proj monogram prov-mini")}<span class="grow fg-2">{PROV[pid][0]}</span>{badge(st)}'
            f'<button type="button" class="btn btn-ghost btn-sm">Añadir</button></div>')
  return out


def ov_field(title, global_text, changed, control):
  tail = (f'<div class="col" style="align-items: flex-end; gap: 2px"><span class="mono t-xs fg-3">global: {global_text}</span><button type="button" class="btn btn-ghost btn-sm">Usar la global</button></div>'
          if changed else '<span class="mono t-xs fg-3" style="text-align: right">Heredado</span>')
  return f'<div class="ov-field"><div class="col" style="gap: 6px; min-width: 0"><span style="font-weight: 500">{title}</span>{control}</div>{tail}</div>'


def project_providers_card():
  glob = ' · '.join(PROV[p][0] for p in GLOBAL_ORDER)
  order_seg = ('<div class="seg" role="radiogroup" aria-label="Orden de proveedores del proyecto"><button type="button" role="radio" aria-checked="false">Usar el global</button>'
               '<button type="button" role="radio" aria-checked="true" class="on">Orden propio</button></div>')
  allowed = ('<div class="row is-inherited-text" style="gap: 16px; flex-wrap: wrap">' + check(True, LABEL['handoff'], aria='Permitir continuar con un resumen')
             + check(False, LABEL['restart'], aria='Permitir empezar de nuevo') + check(True, LABEL['wait'], aria='Permitir esperar al reinicio') + '</div>')
  fields = (ov_field('Qué hacer', LABEL[GLOBAL['action']].lower(), True, seg('o', 'wait', 'Qué hacer al llegar a un límite en este proyecto'))
            + ov_field('Qué puede elegir una decisión', 'resumen y esperar', False, allowed)
            + ov_field('Espera máxima', '6 h', False, '<span class="mono fg-2">6 h</span>')
            + ov_field('Cambios de proveedor por trabajo', '2', True, stepper(1, '', 'Cambios de proveedor por trabajo').replace('<output>1 </output>', '<output>1</output>')))
  return f'''<section class="card col" style="gap: 0" aria-labelledby="providers-h">
<div class="col" style="padding: 18px; gap: 4px"><h2 class="t-h2" id="providers-h">Proveedores</h2><span class="t-sm fg-2">Qué agentes puede usar este proyecto y qué hace su trabajo al llegar a un límite. Cada ajuste hereda el global hasta que lo cambias aquí.</span></div>
<div class="ov-cols">
<div class="col" style="gap: 10px; padding: 0 18px 18px"><div class="row" style="gap: 12px; flex-wrap: wrap"><span class="t-label" style="color: var(--fg-2)">Orden</span>{order_seg}</div>
<span class="t-xs fg-3" style="line-height: 1.5">Global: {glob}. Un proveedor fuera del orden no recibe nunca trabajo de este proyecto, ni siquiera de otro que se ha quedado sin límite.</span>
<div class="col" style="gap: 0">{order_rows()}</div></div>
<div class="col" style="gap: 0; border-left: 1px solid var(--line)"><div class="row" style="padding: 0 18px 10px"><span class="t-label" style="color: var(--fg-2)">Al llegar a un límite</span></div>{fields}</div>
</div>
</section>'''


def mproject_providers():
  def prow(pid, i, in_order):
    st = PSTATE.get(pid) or dict(OUT_OF_ORDER)[pid]
    if in_order:
      up = f'<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Subir {PROV[pid][0]}"{" disabled" if i == 0 else ""}>{ico("up", "ico ico-lg")}</button>'
      dn = f'<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Bajar {PROV[pid][0]}"{" disabled" if i == len(IN_ORDER) - 1 else ""}>{ico("down", "ico ico-lg")}</button>'
      rm = f'<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Quitar {PROV[pid][0]} del orden">{ico("x", "ico ico-lg")}</button>'
      return (f'<div class="prov-order-row">{mono_ico(pid)}<span class="grow col" style="gap: 1px"><span>{PROV[pid][0]}</span><span class="mono t-xs fg-3">{i + 1}.º · {STATE[st][0]}</span></span>{up}{dn}{rm}</div>')
    return (f'<div class="prov-order-row">{mono_ico(pid)}<span class="grow col" style="gap: 1px"><span class="fg-2">{PROV[pid][0]}</span><span class="mono t-xs fg-3">{STATE[st][0]}</span></span>'
            f'<button type="button" class="btn btn-lg">Añadir</button></div>')
  rows = ''.join(prow(p, i, True) for i, p in enumerate(IN_ORDER))
  outs = ''.join(prow(p, 0, False) for p, _ in OUT_OF_ORDER)
  seg_order = ('<div class="seg" role="radiogroup" aria-label="Orden de proveedores del proyecto" style="display: flex"><button type="button" role="radio" aria-checked="false" style="flex: 1 1 0; justify-content: center; height: 40px">Usar el global</button>'
               '<button type="button" role="radio" aria-checked="true" class="on" style="flex: 1 1 0; justify-content: center; height: 40px">Orden propio</button></div>')
  def mfield(title, global_text, changed, control):
    tail = (f'<div class="row" style="gap: 8px"><span class="mono t-xs fg-3 grow">global: {global_text}</span><button type="button" class="btn btn-ghost btn-lg">Usar la global</button></div>'
            if changed else '<span class="mono t-xs fg-3">Heredado</span>')
    return f'<div class="cell stacked" style="gap: 8px; padding-top: 12px; padding-bottom: 12px"><span style="font-weight: 500">{title}</span>{control}{tail}</div>'
  radios = ''.join(
    f'<button type="button" class="rot-radio" role="radio" aria-checked="{"true" if k == "wait" else "false"}"><span class="prov-radio{" on" if k == "wait" else ""}"></span><span class="col grow" style="gap: 1px; text-align: left"><span>{v}</span></span></button>'
    for k, v, _ in ACTIONS)
  inner = f'''{mhead('Proveedores', 'MobileProyectoAjustes.html')}
<div class="m-body stack" style="gap: 14px; overflow-y: auto">
<p class="t-sm fg-2" style="margin: 0 4px; line-height: 1.5">Qué agentes puede usar este proyecto y qué hace su trabajo al llegar a un límite. Cada ajuste hereda el global hasta que lo cambias.</p>
<div class="col" style="gap: 8px"><span class="t-label" style="padding: 0 4px">Orden</span>{seg_order}
<div class="card" style="overflow: hidden">{rows}</div>
<span class="t-label" style="padding: 6px 4px 0">Fuera del orden</span><div class="card" style="overflow: hidden">{outs}</div>
<span class="form-hint" style="padding: 0 4px">Un proveedor fuera del orden no recibe nunca trabajo de este proyecto.</span></div>
<div class="col" style="gap: 8px"><span class="t-label" style="padding: 0 4px">Al llegar a un límite</span><div class="card" style="overflow: hidden">
{mfield('Qué hacer', 'continuar con un resumen', True, f'<div role="radiogroup" aria-label="Qué hacer al llegar a un límite en este proyecto">{radios}</div>')}
{mfield('Espera máxima', '6 h', False, '<span class="mono fg-2">6 h</span>')}
{mfield('Cambios por trabajo', '2', True, stepper(1, '', 'Cambios de proveedor por trabajo', lg=True).replace('<output>1 </output>', '<output>1</output>'))}
</div></div>
</div>
<div class="m-foot"><button type="button" class="btn btn-primary btn-lg">Guardar los cambios</button></div>'''
  write('MobileProyectoAjustesProveedores.html', mobile('Proveedores del proyecto', inner))


# ---------------------------------------------------------------- DSLimites
CLAUDE = dict(id='claude-code', state='ready', version='2.1.282', path='', account='yeyo@inmoseo.net', reason='')
STATES = [
  ('Con margen', 'Todas las ventanas bajo el 60 %: barras neutras y ningún aviso. Solo hay edad y origen de la lectura.',
   dict(CLAUDE, limit=dict(state='ok', age='hace 3 min', how='durante la última ejecución', windows=[('5 h', 34, 'renueva 14:05'), ('7 d', 21, 'renueva vie 09:00')]))),
  ('Cerca del límite', 'Desde el 60 % la barra pasa a aviso, y desde el 75 % a error. El proveedor sigue recibiendo trabajo.',
   dict(CLAUDE, limit=dict(state='near', age='hace 12 min', how='durante la última ejecución', windows=[('5 h', 68, 'renueva 14:05'), ('7 d', 41, 'renueva vie 09:00')]))),
  ('Límite alcanzado', 'Barra de error en la ventana que manda. Mientras dure, ningún trabajo nuevo empieza en este proveedor.',
   dict(CLAUDE, limit=dict(state='exhausted', age='hace 1 min', how='un turno terminó por el límite', binding='5 h', windows=[('5 h', 100, 'renueva 14:05 · en 2 h 10 min'), ('7 d', 58, 'renueva vie 09:00')]))),
  ('Leído sin gastar', 'Codex permite leer el límite sin gastar nada: la lectura es de ahora y se repite mientras esté cerca o agotado.',
   dict(id='codex', state='ready', version='0.41.0', path='', account='yeyo@inmoseo.net', reason='',
        limit=dict(state='near', age='hace 20 s', how='leído sin gastar', windows=[('5 h', 83, 'renueva 15:40'), ('7 d', 27, 'renueva lun 08:00')]))),
  ('Sin lectura', 'El proveedor no informa de su cuota. Puede recibir trabajo que otro deje, pero Agentry no detecta cuándo se agota.',
   dict(id='opencode', state='ready', version='1.4.2', path='', account='yeyo@inmoseo.net', reason='',
        limit=dict(state='unknown', age='nunca', how='', note='OpenCode no informa de su cuota: Agentry no sabrá cuándo se agota. Puede recibir trabajo de otro proveedor, pero nunca lo deja.'))),
  ('Renovado, sin lectura nueva', 'Pasada la hora de reinicio el proveedor vuelve a recibir trabajo, pero nunca se da por libre sin una lectura nueva.',
   dict(CLAUDE, limit=dict(state='unknown', age='hace 2 h 5 min', how='un turno terminó por el límite', note='El límite se renovó a las 14:05. Agentry no lo da por libre hasta que Claude Code vuelva a informar de su uso.'))),
]


def ds_limits():
  from providers import row, pcell
  cards = ''
  for title, why, p in STATES:
    cards += (f'<div class="col" style="gap: 8px"><div class="col" style="gap: 2px; padding: 0 4px"><span style="font-weight: 500">{title}</span><span class="t-sm fg-2" style="line-height: 1.5">{why}</span></div>'
              f'<section class="card" style="overflow: hidden; padding: 14px 16px">{limit_block(p)}</section></div>')
  phone = ''.join(f'<div class="app m-screen" data-theme="dark" style="width: 390px; height: auto; background: var(--bg); padding: 0"><section class="card" style="overflow: hidden; padding: 14px">{limit_block(p, True)}</section></div>'
                  for _, _, p in (STATES[1], STATES[2], STATES[4]))
  head = ('<header class="col" style="gap: 8px"><span class="t-label">Agentry design system · rotación entre proveedores · límites</span>'
          '<h1 class="t-display" style="margin: 0">Límites de los proveedores</h1>'
          '<p class="fg-2" style="margin: 0; max-width: 900px; line-height: 1.55">Cómo dice Agentry cuánto le queda a cada proveedor. Siempre barras, una palabra de estado junto al color '
          'y la edad de la lectura: un límite es una lectura, no una promesa.</p></header>')
  rules = ('<section class="card col" style="padding: 20px; gap: 10px"><h2 class="t-h2">Reglas</h2><ul class="t-sm fg-2" style="margin: 0; padding-left: 18px; line-height: 1.7">'
           '<li>Las barras de uso son las de siempre: neutras por debajo del 60 %, aviso desde el 60 %, error desde el 75 % o con el límite agotado.</li>'
           '<li>La palabra va con el color: «Cerca del límite» en aviso, «Límite alcanzado» en error, «Sin lectura» en reposo. Con margen no lleva palabra.</li>'
           '<li>Cada ventana lleva su nombre en mono (<span class="mono">5 h</span>, <span class="mono">7 d</span>) y su hora de reinicio, en la zona de la persona.</li>'
           '<li>La edad dice de dónde viene la lectura: durante la última ejecución, leído sin gastar, o un turno que terminó por el límite.</li>'
           '<li>Nada se anima: un límite no es trabajo en curso, así que no lleva <span class="mono">--live</span> ni degradado.</li>'
           '<li>Un proveedor agotado no vuelve a «con margen» solo: tras el reinicio queda «sin lectura» hasta que informe de nuevo.</li></ul></section>')
  body = (f'<div class="app col" data-theme="dark" style="width: 1440px; height: 1300px; padding: 56px 64px; gap: 28px; overflow: hidden">{head}{rules}'
          f'<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px">{cards}</div>'
          f'<div class="col" style="gap: 8px"><span class="t-label">En el móvil</span><div class="row" style="gap: 16px; align-items: flex-start">{phone}</div></div></div>')
  write('DSLimites.html', page('Design system · Límites de los proveedores', body))


if __name__ == '__main__':
  desktop_rotation()
  mobile_rotation()
  mobile_mapping()
  mproject_providers()
  ds_limits()
