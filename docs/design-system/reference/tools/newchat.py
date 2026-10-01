# New chat with the provider picker (plans/multi-provider.md, phase 3, P0 task p2): the provider, the
# model list and the mode list that follow it, a model picker that is disabled with its reason, and the
# state where no provider can run chats. Desktop with a menu open, phone with a Sheet.
# Rewrites DesktopNuevoChat and MobileNuevoChat (they had no generator, only HTML) and adds the states.
# Runs on its own: it imports common.py, decisions.py (scrim) and providers.py (the data and the art).
#   python3 newchat.py
from common import P, ico, desktop, mobile, write, BRAND
from decisions import scrim
from providers import PROV, MACHINE_A, STATE, badge, INSTALL_BODY, _il

# What the app's ProviderBadge draws: the provider's monogram in its own hue. Drawn here as the first-run
# and Settings rows draw it, until the badge of the chat page screens (p1) is the one source.
def pbadge(pid, size=20):
  label, letters, hue = PROV[pid]
  fs = 9 if size < 24 else 11
  return (f'<span class="proj monogram" style="--hue: {hue}; width: {size}px; height: {size}px; font-size: {fs}px; border-radius: var(--r-xs)" '
          f'aria-hidden="true">{letters}</span>')


# The ready providers with a session driver, in the person's order, the default first
READY = [
  dict(id='claude-code', version='2.1.282', default=True),
  dict(id='codex', version='0.159.3'),
  dict(id='copilot', version='1.0.90'),
]

# The catalogue of each provider (GET /providers/:id/models): label, id in mono, default flag. Codex's list is
# `model/list` as recorded on 2026-10-01; Copilot's catalogue is `auto` and nothing else, and it cannot be switched.
MODELS = {
  'claude-code': [('Modelo predeterminado', 'el de tu configuración', True), ('Fable 5.1', 'claude-fable-5-1', False),
                  ('Opus 5.5', 'claude-opus-5-5', False), ('Sonnet 5.5', 'claude-sonnet-5-5', False),
                  ('Haiku 4.5', 'claude-haiku-4-5-20251001', False)],
  'codex': [(i, '', d) for i, d in [('gpt-6.1-sol', True), ('gpt-6-astra', False), ('gpt-6-sol', False), ('gpt-6-luna', False),
                                     ('gpt-5.6-sol', False), ('gpt-5.6-terra', False), ('gpt-5.6-luna', False), ('gpt-5.5', False)]],
  'copilot': [('auto', '', True)],
}
MODEL_CHIP = {'claude-code': 'Modelo predeterminado', 'codex': 'gpt-6.1-sol', 'copilot': 'auto'}

# The modes each provider honours (permissionModes()): label, the provider's own value in mono, selected.
# The values are the ones recorded in the plan: Codex's approval policy and sandbox, Copilot's session modes.
MODES = {
  'claude-code': [('Manual', 'manual', False), ('Acepta ediciones', 'acceptEdits', True), ('Plan', 'plan', False), ('Automático', 'auto', False),
                  ('No preguntar', 'dontAsk', False), ('Omitir permisos', 'bypassPermissions', False)],
  'codex': [('Manual', 'on-request · read-only', False), ('Acepta ediciones', 'on-request · workspace-write', True),
            ('Omitir permisos', 'never · danger-full-access', False)],
  'copilot': [('Manual', 'agent', True), ('Plan', 'plan', False), ('Omitir permisos', 'allow_all', False)],
}
MODE_CHIP = {k: next(m[0] for m in v if m[2]) for k, v in MODES.items()}

# How the agent is named in a sentence (the app's {{agent}}), shorter than the provider's label
AGENT = {'claude-code': 'Claude Code', 'codex': 'Codex', 'copilot': 'Copilot'}
LOCKED_REASON = 'Copilot elige el modelo cuando empieza el chat.'

# Why nothing can run a chat: the machine of providers.py with Claude Code signed out
NONE = [
  ('claude-code', 'signed-out', 'Instalado, pero sin sesión iniciada.'),
  ('copilot', 'incompatible', 'La 2.0.0 es más nueva de lo que Agentry sabe usar (1.x).'),
  ('codex', 'not-installed', 'No hay rastro de Codex en este equipo.'),
  ('gemini', 'disabled', 'Está desactivado en Ajustes.'),
]

CHEV = ico('down', 'ico ico-sm')
SEND_ARROW = '<svg class="ico ico-sm" viewBox="0 0 24 24" style="stroke-width: 2.2"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>'
LOCK = ico('lock', 'ico ico-sm')


# ---------------------------------------------------------------- the three menus, shared by both sizes
def prov_items(cur, sheet=False):
  out = []
  for p in READY:
    label = PROV[p['id']][0]
    on = p['id'] == cur
    dflt = '<span class="badge b-accent">Predeterminado</span>' if p.get('default') else ''
    out.append(opt(f'{pbadge(p["id"], 28 if sheet else 22)}<span class="grow col" style="gap: 1px; min-width: 0"><span class="row" style="gap: 8px; flex-wrap: wrap"><span>{label}</span>{dflt}</span>'
                   f'<span class="mono t-xs fg-3">v{p["version"]}</span></span>', on, sheet, f'{label}'))
  return out


def model_items(cur, sheet=False):
  out = []
  for label, ident, dflt in MODELS[cur]:
    sub = f'<span class="mono t-xs fg-3">{ident}</span>' if ident else ''
    tag = '<span class="badge b-accent">Predeterminado</span>' if dflt and cur != 'claude-code' else ''
    name = f'<span class="{"mono" if cur == "codex" else ""}">{label}</span>'
    out.append(opt(f'<span class="grow col" style="gap: 1px; min-width: 0"><span class="row" style="gap: 8px; flex-wrap: wrap">{name}{tag}</span>{sub}</span>',
                   dflt, sheet, label))
  return out


def mode_items(cur, sheet=False):
  out = []
  for label, native, on in MODES[cur]:
    out.append(opt(f'<span class="grow col" style="gap: 1px; min-width: 0"><span>{label}</span><span class="mono t-xs fg-3">{native}</span></span>', on, sheet, label))
  return out


def opt(inner, on, sheet, label):
  if sheet:
    mark = ico('check', 'ico ico-lg', 'color: var(--accent)') if on else '<span style="width: 20px"></span>'
    return (f'<button type="button" class="list-row{" sel" if on else ""}" role="menuitemradio" aria-checked="{"true" if on else "false"}" '
            f'aria-label="{label}" style="min-height: 56px; width: 100%; text-align: left; gap: 12px; border: 0; background: transparent; color: var(--fg); font: inherit">{inner}{mark}</button>')
  mark = ico('check', 'ico ico-sm', 'color: var(--accent)') if on else '<span style="width: 14px"></span>'
  return (f'<button type="button" class="menu-item{" on" if on else ""}" role="menuitemradio" aria-checked="{"true" if on else "false"}" '
          f'style="height: auto; min-height: 40px; padding: 6px 10px">{inner}{mark}</button>')


def menu(kind, items, width, note=''):
  head = {'prov': 'Agente', 'model': 'Modelo', 'mode': 'Modo de permisos'}[kind]
  foot = f'<div class="form-hint" style="padding: 8px 10px 4px; border-top: 1px solid var(--line); margin-top: 4px">{note}</div>' if note else ''
  return (f'<div class="menu" role="menu" aria-label="{head}" style="position: absolute; top: calc(100% + 6px); left: 0; z-index: 20; width: {width}px; animation: none">'
          f'<span class="t-label" style="padding: 6px 10px 4px">{head}</span>{"".join(items)}{foot}</div>')


# ---------------------------------------------------------------- desktop
def chip_wrap(chip, menu_html=''):
  return f'<div style="position: relative">{chip}{menu_html}</div>'


def dchips(cur, open_):
  proj = f'<button type="button" class="chip">{ico("folder", "ico ico-sm")}claude-wrapper{CHEV}</button>'
  prov = (f'<button type="button" class="chip" aria-haspopup="menu" aria-expanded="{"true" if open_ == "prov" else "false"}" aria-label="Agente: {PROV[cur][0]}">'
          f'{pbadge(cur, 18)}{PROV[cur][0]}{CHEV}</button>')
  mono = ' class="mono"' if cur == 'codex' else ''
  if cur == 'copilot':
    model = f'<button type="button" class="chip" disabled aria-label="Modelo: auto. {LOCKED_REASON}" style="cursor: not-allowed">{LOCK}Modelo: auto</button>'
  else:
    model = (f'<button type="button" class="chip" aria-haspopup="menu" aria-expanded="{"true" if open_ == "model" else "false"}" aria-label="Modelo">'
             f'<span{mono}>{MODEL_CHIP[cur]}</span>{CHEV}</button>')
  mode = (f'<button type="button" class="chip" aria-haspopup="menu" aria-expanded="{"true" if open_ == "mode" else "false"}" aria-label="Modo de permisos">'
          f'{MODE_CHIP[cur]}{CHEV}</button>')
  menus = {
    'prov': menu('prov', prov_items(cur), 290, 'Solo aparecen los agentes listos. El orden y el resto, en Ajustes → Proveedores.'),
    'model': menu('model', model_items(cur), 300, '' if cur != 'codex' else '8 modelos · cambiar de modelo a mitad de chat hace que Codex compacte la conversación.'),
    'mode': menu('mode', mode_items(cur), 310),
  }
  return ''.join([
    f'<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Adjuntar archivos">{ico("clip")}</button>',
    proj,
    chip_wrap(prov, menus['prov'] if open_ == 'prov' else ''),
    chip_wrap(model, menus['model'] if open_ == 'model' else ''),
    chip_wrap(mode, menus['mode'] if open_ == 'mode' else ''),
  ])


STARTERS = [
  ('info', 'book', 'Lee este proyecto y cuéntame cómo está organizado'),
  ('idle', 'search', 'Busca dónde se manejan los reintentos y explícame la política'),
  ('ok', 'check', 'Añade un test para el caso en que falta el archivo'),
]
COMMAND_ART = '''<rect x="0" y="0" width="240" height="160" class="f-dots" mask="url(#il-fade)"></rect>
<ellipse cx="120" cy="80" rx="96" ry="34" class="ln-soft"></ellipse>
<circle cx="120" cy="80" r="54" class="ln-soft dash a-orbit"></circle>
<path d="M104 70 L78 44 M138 70 L166 38 M138 92 L168 120" class="ln-soft a-dash"></path>
<circle cx="120" cy="80" r="34" class="halo"></circle>
<circle cx="120" cy="80" r="24" class="f-grad"></circle>
<text x="120" y="85.5" text-anchor="middle" class="glyph-white">›_</text>
<g class="a-float"><rect x="12" y="28" width="70" height="22" rx="11" class="c2"></rect><circle cx="25" cy="39" r="3.5" class="f-live a-pulse"></circle><text x="34" y="42.5" class="txt">tests</text></g>
<g class="a-float-2"><rect x="158" y="22" width="70" height="22" rx="11" class="c2"></rect><circle cx="171" cy="33" r="3.5" class="f-ok"></circle><text x="180" y="36.5" class="txt">review</text></g>
<g class="a-float"><rect x="164" y="114" width="64" height="22" rx="11" class="c2"></rect><circle cx="177" cy="125" r="3.5" class="f-grad"></circle><text x="186" y="128.5" class="txt">docs</text></g>'''
SEG = ('<div class="seg" role="tablist" aria-label="Tipo"><button type="button" role="tab" aria-selected="true" class="on">' + ico('chats', 'ico ico-sm') + 'Chat</button>'
       '<button type="button" role="tab" aria-selected="false">' + ico('orch', 'ico ico-sm') + 'Orquestación</button></div>')


def desktop_new(name, title, cur, open_=None):
  agent = AGENT[cur]
  hint = f'<span class="row t-sm fg-2" style="gap: 8px; width: 780px">{ico("info", "ico ico-sm", "flex-shrink: 0")}{LOCKED_REASON}</span>' if cur == 'copilot' else ''
  starters = ''.join(
    f'<button type="button" class="card card-link col" style="text-align: left; padding: 14px; gap: 10px; min-height: 104px"><span class="proj" style="background: var(--{c}-soft); color: var(--{c})">{ico(i, "ico ico-sm")}</span><span class="t-sm" style="line-height: 1.45">{t}</span></button>'
    for c, i, t in STARTERS)
  main = f'''<main class="page glow-top" style="align-items: center; padding-top: 36px; gap: 22px; background-size: 100% 520px">
<div class="col" style="align-items: center; gap: 12px; text-align: center">
<div class="app" data-theme="dark" style="display: inline-block; background: transparent">{_il('il-sm', COMMAND_ART)}</div>
<h1 class="t-display" style="margin: 0; font-size: 40px">¿Qué <span class="grad-text">construimos</span> hoy?</h1>
<p class="fg-2" style="margin: 0; font-size: 15px">{agent} lo ejecuta en tu proyecto y responde aquí.</p>
</div>
{SEG}
<div class="card grad-border col" style="width: 780px; border-radius: var(--r-xl); gap: 0; overflow: visible; box-shadow: 0 30px 80px -30px color-mix(in srgb, var(--accent-2) 45%, transparent)">
<label style="display: flex; padding: 18px 20px 8px"><textarea rows="4" placeholder="Describe la tarea: un cambio, una revisión, una investigación…" aria-label="Instrucción" style="width: 100%; border: 0; outline: 0; resize: none; background: transparent; font-size: 16px; line-height: 1.55; padding: 0"></textarea></label>
<div class="row" style="padding: 10px 12px 12px; gap: 6px; border-top: 1px solid var(--line)">
{dchips(cur, open_)}
<span class="grow"></span>
<button type="button" class="btn btn-primary">Empezar{SEND_ARROW}</button>
</div>
</div>
{hint}
<span class="mono t-xs fg-3">se ejecuta en ~/Escritorio/claude-wrapper · arrastra o pega archivos para adjuntarlos · <span class="kbd">Ctrl</span> <span class="kbd">↵</span> para empezar</span>
<div class="col" style="width: 780px; gap: 10px; margin-top: 14px">
<span class="t-label">Para empezar</span>
<div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px">{starters}</div>
</div>
</main>'''
  write(name, desktop(title, 'chats', '<span style="font-weight: 500">Nuevo chat</span>', main, agents=3, running=3))


def none_rows():
  out = []
  for pid, st, why in NONE:
    out.append(f'<div class="row" style="gap: 12px; padding: 12px 14px; border-top: 1px solid var(--line); align-items: flex-start">{pbadge(pid, 28)}'
               f'<div class="col grow" style="gap: 2px; min-width: 0"><span style="font-weight: 500">{PROV[pid][0]}</span><span class="t-sm fg-2">{why}</span></div>{badge(st)}</div>')
  out[0] = out[0].replace('border-top: 1px solid var(--line); ', '')
  return ''.join(out)


def none_head():
  return ('<h2 class="t-h2">Ningún agente puede ejecutar chats ahora</h2>'
          '<p>Para empezar un chat hace falta un agente listo en este equipo. Estos son los que Agentry conoce y lo que le falta a cada uno.</p>')


def desktop_none(name, title):
  main = f'''<main class="page glow-top" style="align-items: center; padding-top: 36px; gap: 22px; background-size: 100% 520px">
<div class="empty-state" style="padding: 8px 24px 0">{_il('il-lg', INSTALL_BODY)}
{none_head()}
<div class="row" style="gap: 8px"><a href="DesktopProveedores.html" class="btn btn-primary">Abrir Proveedores</a><button type="button" class="btn">{ico("retry", "ico")}Volver a comprobar</button></div>
</div>
<section class="card" style="width: 640px; overflow: hidden" aria-label="Agentes conocidos">{none_rows()}</section>
</main>'''
  write(name, desktop(title, 'chats', '<span style="font-weight: 500">Nuevo chat</span>', main, agents=0, running=0))


# ---------------------------------------------------------------- phone
def mchips(cur):
  mono = ' class="mono"' if cur == 'codex' else ''
  proj = f'<button type="button" class="chip" style="height: 32px">{ico("folder", "ico ico-sm")}claude-wrapper</button>'
  prov = f'<button type="button" class="chip" aria-label="Agente: {PROV[cur][0]}">{pbadge(cur, 20)}{PROV[cur][0]}{CHEV}</button>'
  if cur == 'copilot':
    model = f'<button type="button" class="chip" disabled aria-label="Modelo: auto. {LOCKED_REASON}">{LOCK}Modelo: auto</button>'
  else:
    model = f'<button type="button" class="chip" aria-label="Modelo"><span{mono}>{MODEL_CHIP[cur]}</span>{CHEV}</button>'
  mode = f'<button type="button" class="chip" aria-label="Modo de permisos">{MODE_CHIP[cur]}{CHEV}</button>'
  return f'<div class="row" style="gap: 6px; flex-wrap: wrap">{proj}{prov}{model}{mode}</div>'


def sheet(kind, cur):
  head, sub, items, note = {
    'prov': ('Agente', 'Elige quién ejecuta este chat. El modelo y los modos cambian con él.', prov_items(cur, True),
             'Solo aparecen los agentes listos. El orden y el resto, en Ajustes → Proveedores.'),
    'model': ('Modelo', f'Los modelos de {AGENT[cur]}.', model_items(cur, True),
              'Cambiar de modelo a mitad de chat hace que Codex compacte la conversación.' if cur == 'codex' else ''),
    'mode': ('Modo de permisos', f'Los modos que {AGENT[cur]} sabe respetar.', mode_items(cur, True), ''),
  }[kind]
  note_html = f'<span class="form-hint">{note}</span>' if note else ''
  return f'''{scrim()}
<div class="sheet" role="dialog" aria-label="{head}" style="z-index: 11; padding-bottom: 28px; display: flex; flex-direction: column; gap: 12px; max-height: 92%">
<div class="grab" style="margin-bottom: 0"></div>
<div class="col" style="gap: 2px"><h2 class="t-h2">{head}</h2><span class="t-sm fg-2">{sub}</span></div>
<div class="col" style="gap: 0; overflow: hidden" role="menu" aria-label="{head}">{"".join(items)}</div>
{note_html}
<button type="button" class="btn btn-lg">Cerrar</button>
</div>'''


def mobile_new(name, title, cur, sheet_kind=None):
  agent = AGENT[cur]
  starters = ''.join(
    f'<button type="button" class="card card-link row" style="text-align: left; padding: 12px 14px; gap: 12px; min-height: 56px"><span class="proj" style="background: var(--{c}-soft); color: var(--{c})">{ico(i, "ico ico-sm")}</span><span class="t-sm grow">{t}</span></button>'
    for c, i, t in STARTERS)
  hint = f'<span class="row t-sm fg-2" style="gap: 8px; padding: 0 4px">{ico("info", "ico ico-sm", "flex-shrink: 0")}{LOCKED_REASON}</span>' if cur == 'copilot' else ''
  inner = f'''<header class="row" style="flex-shrink: 0; padding: 8px 4px; gap: 4px">
<a href="MobileChats.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Cerrar">{ico("x", "ico ico-lg")}</a>
<div class="grow" style="display: flex; justify-content: center"><div class="seg" role="tablist" aria-label="Tipo"><button type="button" role="tab" aria-selected="true" class="on">Chat</button><button type="button" role="tab" aria-selected="false">Orquestación</button></div></div>
<span style="width: 44px"></span>
</header>
<div class="col" style="flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 8px 18px 16px; gap: 18px">
<div style="align-self: center"><div class="app" data-theme="dark" style="display: inline-block; background: transparent">{_il('il-sm', COMMAND_ART)}</div></div>
<div class="col" style="gap: 8px"><h1 class="t-display" style="margin: 0; font-size: 30px">¿Qué <span class="grad-text">construimos</span>?</h1><p class="fg-2" style="margin: 0">{agent} lo ejecuta en tu proyecto y responde aquí.</p></div>
<div class="col" style="gap: 8px">
<span class="t-label">Para empezar</span>
{starters}
</div>
</div>
<div class="col" style="flex-shrink: 0; padding: 10px 12px 28px; gap: 10px; border-top: 1px solid var(--line); background: var(--bg-1)">
{mchips(cur)}
{hint}
<div class="card grad-border row" style="border-radius: var(--r-xl); padding: 4px; gap: 4px; align-items: flex-end">
<button type="button" class="btn btn-ghost btn-icon" aria-label="Adjuntar" style="width: var(--touch); height: var(--touch); border-radius: 50%">{ico("plus", "ico ico-lg")}</button>
<label class="grow" style="display: flex; min-height: var(--touch); align-items: center"><textarea rows="1" placeholder="¿Qué debería hacer {agent}?" aria-label="Instrucción" style="width: 100%; border: 0; outline: 0; resize: none; background: transparent; font-size: 16px; padding: 0"></textarea></label>
<a href="MobileChat.html" class="btn btn-primary btn-icon" aria-label="Empezar" style="width: var(--touch); height: var(--touch); border-radius: 50%">{ico("send", "ico ico-lg", "stroke-width: 2.2")}</a>
</div>
</div>
{sheet(sheet_kind, cur) if sheet_kind else ''}'''
  write(name, mobile(title, inner))


def mobile_none(name, title):
  rows = ''.join(
    f'<div class="row" style="gap: 12px; padding: 12px 14px; {"" if i == 0 else "border-top: 1px solid var(--line); "}align-items: flex-start">{pbadge(pid, 28)}'
    f'<div class="col grow" style="gap: 4px; min-width: 0"><span class="row" style="gap: 8px; flex-wrap: wrap"><span style="font-weight: 500">{PROV[pid][0]}</span>{badge(st)}</span><span class="t-sm fg-2">{why}</span></div></div>'
    for i, (pid, st, why) in enumerate(NONE))
  inner = f'''<header class="row" style="flex-shrink: 0; padding: 8px 4px; gap: 4px">
<a href="MobileChats.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Cerrar">{ico("x", "ico ico-lg")}</a>
<h1 class="t-h1 grow" style="text-align: center">Nuevo chat</h1>
<span style="width: 44px"></span>
</header>
<div class="col" style="flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 0 18px 16px; gap: 16px">
<div class="empty-state" style="padding: 0 6px">{_il('il-md', INSTALL_BODY)}
{none_head()}
</div>
<section class="card" style="overflow: hidden" aria-label="Agentes conocidos">{rows}</section>
</div>
<div class="col" style="flex-shrink: 0; padding: 12px 18px 28px; gap: 8px; border-top: 1px solid var(--line); background: var(--bg-1)">
<a href="MobileProveedores.html" class="btn btn-lg btn-primary">Abrir Proveedores</a>
<button type="button" class="btn btn-lg">{ico("retry", "ico")}Volver a comprobar</button>
</div>'''
  write(name, mobile(title, inner))


if __name__ == '__main__':
  desktop_new('DesktopNuevoChat.html', 'Nuevo chat', 'claude-code', open_='prov')
  desktop_new('DesktopNuevoChatCodex.html', 'Nuevo chat, modelos de Codex', 'codex', open_='model')
  desktop_new('DesktopNuevoChatCodexModos.html', 'Nuevo chat, modos de Codex', 'codex', open_='mode')
  desktop_new('DesktopNuevoChatCopilot.html', 'Nuevo chat, modelo fijo de Copilot', 'copilot')
  desktop_none('DesktopNuevoChatSinProveedor.html', 'Nuevo chat, ningún agente listo')
  mobile_new('MobileNuevoChat.html', 'Nuevo chat', 'claude-code', sheet_kind='prov')
  mobile_new('MobileNuevoChatCodex.html', 'Nuevo chat, modelos de Codex', 'codex', sheet_kind='model')
  mobile_new('MobileNuevoChatCodexModos.html', 'Nuevo chat, modos de Codex', 'codex', sheet_kind='mode')
  mobile_new('MobileNuevoChatCopilot.html', 'Nuevo chat, modelo fijo de Copilot', 'copilot')
  mobile_none('MobileNuevoChatSinProveedor.html', 'Nuevo chat, ningún agente listo')
