# In-app setup (docs/plans/in-app-setup.md, step 4 "Design"): the setup assistant that replaces the first
# run (Acceso → Agentes → Código y tareas → Listo), the sign-in panel under a row in each of its states, and
# Settings → Security with the line about how secrets are kept. Desktop and phone, plus the states sheet
# DSConfiguracion. Runs on its own; imports common.py, providers.py (rows, badges, the first-run page) and
# decisions.py (the settings nav, the scrim). It also adds its screens to manifest.json and index.html, once.
#   python3 setup.py
import json, os
from common import P, ico, desktop, mobile, write, page, tabbar, BRAND, OUT
from decisions import SETTINGS_NAV, scrim
from providers import PROV, badge, _il

P.update({
  'ext': 'M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  'key': 'M15 7a4 4 0 1 1-3.9 5H4v3H2v-5h9.1A4 4 0 0 1 15 7z',
  'shield': 'M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z',
})

# ---------------------------------------------------------------- data
# Every tool the setup signs in: the five agents of providers.py, and gh, glab and YouTrack with the
# monograms hosts.py and trackers.py give them (a hue that is never red, green or cyan; no brand art).
TOOL = {pid: (label, letters, hue) for pid, (label, letters, hue) in PROV.items()}
TOOL.update({'gh': ('GitHub', 'GH', 262), 'glab': ('GitLab', 'GL', 45), 'youtrack': ('YouTrack', 'YT', 75)})

STEPS = ('Acceso', 'Agentes', 'Código y tareas', 'Listo')

# Why a sign-in ended badly, by the API's code (LoginErrorCode, and the `expired` state). Bad when it failed,
# warn when the code only ran out of time; the code itself goes under the sentence in mono.
FAIL = {
  'cli-refused': ('bad', '{t} ha rechazado el inicio de sesión. Si era una clave, comprueba que es correcta y no ha caducado.', 'Reintentar'),
  'not-signed-in': ('bad', 'El comando ha terminado, pero {t} sigue sin sesión.', 'Reintentar'),
  'no-code': ('bad', '{t} ha terminado sin mostrar un código. Prueba con una clave.', 'Usar una clave'),
  'cli-missing': ('bad', 'No se encuentra el programa de {t} en este equipo.', 'Ver instalación'),
  'spawn-failed': ('bad', 'No se ha podido iniciar {t}.', 'Reintentar'),
  'timeout': ('bad', '{t} no ha respondido a tiempo y Agentry lo ha detenido.', 'Reintentar'),
  'expired': ('warn', 'El código ha caducado: nadie lo aprobó en 15 minutos.', 'Pedir otro código'),
}


# ---------------------------------------------------------------- pieces
def mono(tool):
  label, letters, hue = TOOL[tool]
  return f'<span class="proj monogram" style="--hue: {hue}" role="img" aria-label="{label}" title="{label}">{letters}</span>'


def ext():
  return ico('ext', 'ico ico-sm')


def seg(label, options, on, big=False):
  """The Segmented control of packages/ui (ui.tsx): a radiogroup of 2 to 5 options."""
  cls = ' style="display: flex"' if big else ' style="align-self: flex-start"'
  btns = ''.join(f'<button type="button" role="radio" aria-checked="{"true" if o == on else "false"}"{" class=on" if o == on else ""}>{o}</button>' for o in options)
  return f'<div class="seg" role="radiogroup" aria-label="{label}"{cls}>{btns}</div>'.replace('class=on', 'class="on"')


def setup_steps(active, skipped=(), bare=False):
  out = []
  for i, n in enumerate(STEPS, 1):
    if i in skipped:
      cls, lead, tail = 'step skipped', f'<span class="n">{i}</span>', '<span class="step-skip">omitido</span>'
    else:
      cls = 'step' + (' on' if i == active else (' done' if i < active else ''))
      lead, tail = (ico('check', 'ico ico-sm') if i < active else f'<span class="n">{i}</span>'), ''
    cur = ' aria-current="step"' if i == active else ''
    out.append(f'<div class="{cls}"{cur}><span class="step-name">{lead}{n}</span>{tail}</div>')
  return f'<div class="steps{" steps-bare" if bare else ""}" aria-label="Pasos de la configuración">{"".join(out)}</div>'


def srow(tool, state, account, meta, reason, actions='', open_=False):
  """A compact readiness row (.prov-row.compact), the first run's, for an agent, a host or YouTrack."""
  label = TOOL[tool][0]
  cls = 'prov-row compact' + (' open' if open_ else '')
  return (f'<div class="{cls}" data-tool="{tool}">{mono(tool)}'
          f'<div class="prov-id"><span class="prov-name">{label}</span><span class="t-sm fg-2">{account}</span><span class="prov-meta ellipsis">{meta}</span></div>'
          f'<div class="prov-state">{badge(state)}<p class="prov-reason">{reason}</p></div>'
          f'<div class="prov-actions">{actions}</div></div>')


def signin_btn(tool, pressed=False):
  p = ' aria-pressed="true"' if pressed else ''
  return f'<button type="button" class="btn"{p} aria-label="Iniciar sesión en {TOOL[tool][0]}">Iniciar sesión</button>'


def signout_btn(tool):
  return f'<button type="button" class="btn btn-ghost" aria-label="Cerrar sesión en {TOOL[tool][0]}">Cerrar sesión</button>'


def key_field(label, placeholder, big=False):
  size = ' field-lg' if big else ''
  st = ' style="font-size: 16px"' if big else ''
  return (f'<label class="col" style="gap: 6px"><span class="t-label">{label}</span>'
          f'<span class="field field-mono{size}">{ico("key", "ico fg-3")}<input type="password" class="mono" autocomplete="off" placeholder="{placeholder}" aria-label="{label}"{st}></span></label>')


def vendor_link(text, big=False):
  st = ' style="min-height: 44px; display: inline-flex; align-items: center; gap: 5px"' if big else ' style="display: inline-flex; align-items: center; gap: 5px"'
  return f'<a href="#" class="c-accent t-sm"{st}>{text}{ext()}</a>'


# The panel's pieces, shared by the desktop panel and the phone Sheet ------------------------------
def claude_key_body(big=False):
  hint = 'Se guarda cifrado y solo lo reciben los procesos de Claude Code. No se vuelve a mostrar.'
  return (f'{seg("Qué vas a pegar", ("Token de OAuth", "Clave de API"), "Token de OAuth", big)}'
          f'<p class="signin-note">Claude Code no tiene un inicio de sesión que Agentry pueda hacer por ti. En <b>tu propio ordenador</b>, donde ya usas Claude, '
          f'ejecuta <code>claude setup-token</code> en una terminal: abre el navegador, entras con tu suscripción y te muestra un token que dura un año. Pégalo aquí.</p>'
          f'{vendor_link("Cómo se crea el token", big)}'
          f'{key_field("Token de OAuth", "sk-ant-oat01-…", big)}<span class="form-hint">{hint}</span>')


def stdin_key_body(tool, what, link, hint, big=False):
  return (f'{key_field(what, "Pega el token", big)}{vendor_link(link, big)}<span class="form-hint">{hint}</span>')


def device_box(tool, url, code, left='caduca en 14:12', big=False):
  """The one live surface while it waits: where to go, the code, and the braille spinner next to the verb."""
  copy = f'<button type="button" class="btn{" btn-lg" if big else ""}" aria-label="Copiar el código">{ico("copy", "ico")}Copiar</button>'
  return (f'<div class="signin-device energy" role="group" aria-label="Código de {TOOL[tool][0]}">'
          f'<ol class="signin-steps"><li><span class="n">1</span><span>Abre esta página en cualquier dispositivo: <a href="#" class="signin-url">{url}{ext()}</a></span></li>'
          f'<li><span class="n">2</span><span>Escribe este código y aprueba el acceso.</span></li></ol>'
          f'<div class="signin-code-box"><span class="signin-code" aria-label="Código {code}">{code}</span>{copy}</div>'
          f'<div class="signin-wait" role="status"><span class="spin-braille" aria-hidden="true"></span>Esperando a que lo apruebes<span class="left">{left}</span></div></div>')


def codex_note(big=False):
  return (f'<p class="signin-note">Si ChatGPT no deja entrar con un código, activa antes el inicio de sesión con código de dispositivo en los ajustes de seguridad de tu cuenta de ChatGPT.</p>'
          f'{vendor_link("Abrir los ajustes de ChatGPT", big)}')


def result(code, tool, big=False):
  tone, text, action = FAIL[code]
  icon = 'wait' if tone == 'warn' else 'warn'
  return (f'<div class="signin-result{" warn" if tone == "warn" else ""}" role="alert">{ico(icon, "ico")}'
          f'<div class="col" style="gap: 2px"><span>{text.format(t=TOOL[tool][0])}</span><span class="mono">{code}</span></div></div>'), action


def panel(tool, body, buttons, methods=None):
  """The desktop panel under the row: .prov-bin.signin. `methods` is the Código / Clave choice of a tool with both."""
  label = TOOL[tool][0]
  choice = seg('Cómo iniciar sesión', ('Código', 'Clave'), methods) if methods else ''
  head = f'<div class="signin-head"><span class="t-label grow">Iniciar sesión en {label}</span>{choice}</div>'
  return f'<div class="prov-bin signin" role="group" aria-label="Iniciar sesión en {label}">{head}{body}<div class="row" style="gap: 8px">{buttons}</div></div>'


# ---------------------------------------------------------------- desktop: the assistant
def foot(back=True, note='', skip=True, primary='Continuar'):
  b = f'<button type="button" class="btn btn-ghost">{ico("left", "ico")}Volver</button>' if back else ''
  n = f'<span class="prov-step-note">{note}</span>' if note else ''
  s = '<button type="button" class="btn btn-ghost">Omitir</button>' if skip else ''
  return f'<div class="setup-foot">{b}{n}<span class="grow"></span>{s}<button type="button" class="btn btn-primary">{primary}</button></div>'


def head(title, text):
  return (f'<div class="col" style="gap: 10px"><h1 class="t-display" style="margin: 0">{title}</h1>'
          f'<p class="fg-2" style="margin: 0; max-width: 640px; line-height: 1.55">{text}</p></div>')


def brand(step):
  return (f'<div class="row" style="gap: 10px; height: 32px">{BRAND}<span style="font-weight: 600; font-size: 15px; letter-spacing: -0.02em">Agentry</span>'
          f'<span class="grow"></span><span class="t-label">Configuración · paso {step} de 4</span></div>')


def dpage(name, title, step, body, skipped=(), h=1024):
  inner = f'<div class="prov-first" style="padding: 32px 0 40px">{brand(step)}{setup_steps(step, skipped)}{body}</div>'
  write(name, page(title + ' (desktop)', f'<div class="app glow-top" data-theme="dark" style="width: 1440px; height: {h}px; overflow: hidden">{inner}</div>'))


TOKEN = 'agt_7Qm2vX9kLp4RzT8wNc3HbY6sJd1FgE5u'


def access_card(big=False):
  mode = seg('Modo de autenticación', ('Ninguno', 'Token'), 'Token', big)
  copy = f'<button type="button" class="btn{" btn-lg" if big else ""}" aria-label="Copiar el token">{ico("copy", "ico")}Copiar</button>'
  shown = (f'<div class="col" style="gap: 8px; padding: 14px; border-radius: var(--r-lg); background: var(--bg-2); border: 1px solid var(--line)">'
           f'<span style="font-weight: 500">Copia este token ahora</span><span class="t-sm fg-2">Solo se muestra esta vez. Este navegador ya lo usa; cualquier otra cosa que llame a la API lo necesitará.</span>'
           f'<div class="row" style="gap: 8px; flex-wrap: wrap"><code class="grow" style="font-size: 12.5px; padding: 6px 8px; overflow-wrap: anywhere">{TOKEN}</code>{copy}</div></div>')
  lg = ' btn-lg' if big else ''
  other = (f'<div class="row" style="gap: 8px; flex-wrap: wrap"><button type="button" class="btn{lg}">Generar otro</button>'
           f'<button type="button" class="btn btn-ghost{lg}">Usar mi propio token…</button></div>')
  return (f'<section class="card col" style="padding: 18px; gap: 14px" aria-labelledby="acc-h">'
          f'<div class="row" style="gap: 10px">{ico("shield", "ico fg-3")}<h2 class="t-h2 grow" id="acc-h">Acceso</h2><span class="badge b-ok">token</span></div>'
          f'{mode}<p class="t-sm fg-2" style="margin: 0; line-height: 1.5">Toda petición debe llevar el token. Con «Ninguno», cualquiera que llegue al puerto puede usar Agentry: vale en tu propio equipo, no en una red.</p>'
          f'{shown}{other}<span class="form-hint">OIDC y el modo solo lectura están en Ajustes → Seguridad.</span></section>')


def secrets_callout(big=False):
  return (f'<div class="callout callout-warn" style="align-items: flex-start">{ico("lock", "ico", "flex-shrink: 0; color: var(--warn)")}'
          f'<div class="col" style="gap: 4px; flex: 1 1 0; min-width: 0"><span style="font-weight: 500; color: var(--fg)">Las claves que guardes se cifran, pero la clave está junto a los datos</span>'
          f'<span>Protege una copia de los archivos, no el volumen. Pasa la clave en <span class="mono">AGENTRY_SECRET_KEY</span> para que viva fuera de él.</span>'
          f'{vendor_link("Cómo pasar la clave", big)}</div></div>')


def d_access():
  body = (head('Quién puede abrir Agentry', 'Ahora mismo cualquiera que llegue a este puerto puede usarlo. Si Agentry corre en un servidor o en una red, pide un token.')
          + access_card() + secrets_callout()
          + foot(back=False, note='Lo cambias cuando quieras en Ajustes → Seguridad.'))
  dpage('DesktopConfiguracionAcceso.html', 'Configuración, acceso', 1, body)


AGENTS_HEAD = head('Inicia sesión en tus agentes', 'Cada agente usa su propia cuenta. Inicia sesión aquí, con un código o con una clave: no hace falta abrir una terminal en el servidor.')


def agents_card(rows):
  return f'<section class="card" style="overflow: hidden" aria-label="Agentes">{"".join(rows)}</section>'


def claude_ready():
  return srow('claude-code', 'ready', 'yeyo@inmoseo.net', 'v2.1.282 · token de OAuth', 'Con sesión iniciada y respondiendo.', signout_btn('claude-code'))


def codex_ok():
  return srow('codex', 'ready', 'yeyo@inmoseo.net', 'v0.46.0 · ~/.local/bin/codex', 'Sesión iniciada con un código hace un momento.', signout_btn('codex'))


def gemini_out():
  return srow('gemini', 'signed-out', 'Sin cuenta', 'v0.9.1 · ~/.nvm/…/bin/gemini', 'Instalado, pero sin una clave.', signin_btn('gemini'))


def copilot_out(open_=False):
  return srow('copilot', 'signed-out', 'Sin cuenta', 'v1.0.4 · /usr/local/bin/copilot', 'Instalado, pero sin sesión iniciada.', signin_btn('copilot', open_), open_)


def opencode_missing():
  return srow('opencode', 'not-installed', 'Sin cuenta', '', 'No hay rastro de OpenCode en este equipo.', f'<button type="button" class="btn">Instalar{ext()}</button>')


def d_agents_device():
  codex = srow('codex', 'signed-out', 'Sin cuenta', 'v0.46.0 · ~/.local/bin/codex', 'Instalado, pero sin sesión iniciada.', signin_btn('codex', True), True)
  p = panel('codex', codex_note() + device_box('codex', 'auth.openai.com/codex/device', 'K7QM-4XPD'),
            '<button type="button" class="btn btn-ghost">Cancelar</button>', methods='Código')
  body = AGENTS_HEAD + agents_card([claude_ready(), codex, p, gemini_out(), copilot_out(), opencode_missing()]) + foot(note='1 de 5 listo')
  dpage('DesktopConfiguracionAgentes.html', 'Configuración, agentes: Codex esperando el código', 2, body, h=1100)


def d_agents_key():
  claude = srow('claude-code', 'signed-out', 'Sin cuenta', 'v2.1.282 · ~/.local/bin/claude', 'Instalado, pero sin sesión iniciada.', signin_btn('claude-code', True), True)
  p = panel('claude-code', claude_key_body(), '<button type="button" class="btn">Guardar y comprobar</button><button type="button" class="btn btn-ghost">Cancelar</button>')
  body = AGENTS_HEAD + agents_card([claude, p, codex_ok(), gemini_out(), copilot_out(), opencode_missing()]) + foot(note='1 de 5 listo')
  dpage('DesktopConfiguracionAgentesClave.html', 'Configuración, agentes: el token de Claude Code', 2, body, h=1100)


def d_agents_failed():
  msg, action = result('expired', 'copilot')
  p = panel('copilot', msg, f'<button type="button" class="btn">{ico("retry", "ico ico-sm")}{action}</button><button type="button" class="btn btn-ghost">Cancelar</button>', methods='Código')
  body = AGENTS_HEAD + agents_card([claude_ready(), codex_ok(), gemini_out(), copilot_out(True), p, opencode_missing()]) + foot(note='2 de 5 listos')
  dpage('DesktopConfiguracionAgentesFallo.html', 'Configuración, agentes: Codex listo y el código de Copilot caducado', 2, body)


def gh_ready():
  return srow('gh', 'ready', 'yeyo-dev en github.com', 'gh 2.92.0 · /usr/bin/gh', 'Con sesión iniciada y respondiendo.', '<button type="button" class="btn btn-ghost">Añadir otro host</button>')


def glab_body(big=False):
  host = (f'<label class="col" style="gap: 6px"><span class="t-label">Host</span><span class="field field-mono{" field-lg" if big else ""}">{ico("git", "ico fg-3")}'
          f'<input class="mono" value="gitlab.com" aria-label="Host de GitLab"{" style=\"font-size: 16px\"" if big else ""}></span></label>')
  return host + stdin_key_body('glab', 'Token de acceso personal', 'Crear un token en gitlab.com',
                               'Con los permisos api y write_repository. glab lo guarda en su propia configuración; Agentry no se queda con una copia.', big)


def youtrack_out():
  return srow('youtrack', 'signed-out', 'Sin cuenta', 'youtrack-app 0.4.1', 'Indica a Agentry la dirección de tu YouTrack y un token permanente.', '<button type="button" class="btn">Conectar</button>')


def d_hosts():
  glab = srow('glab', 'signed-out', 'Sin cuenta', 'glab 1.120.0 · ~/.local/bin/glab', 'Instalado, pero sin sesión en ningún host.', signin_btn('glab', True), True)
  p = panel('glab', glab_body(), '<button type="button" class="btn">Guardar y comprobar</button><button type="button" class="btn btn-ghost">Cancelar</button>', methods='Clave')
  card = f'<section class="card" style="overflow: hidden" aria-label="Código y tareas">{gh_ready()}{glab}{p}{youtrack_out()}</section>'
  body = (head('Conecta tu código y tus tareas', 'GitHub y GitLab para las PR y las MR de tus proyectos; YouTrack para traer sus tareas. Todo es opcional.')
          + card + foot(note='1 de 3 listo'))
  dpage('DesktopConfiguracionIntegraciones.html', 'Configuración, código y tareas', 3, body)


# The summary of the last step: (icon or tool, name, detail, badge state or 'skipped', where it is in Settings, link)
SUMMARY = [
  ('shield', 'Acceso', 'Token', 'ready', 'Ajustes → Seguridad', 'DesktopAjustesSeguridad.html'),
  ('claude-code', 'Claude Code', 'yeyo@inmoseo.net', 'ready', 'Ajustes → Proveedores', 'DesktopProveedores.html'),
  ('codex', 'Codex', 'yeyo@inmoseo.net', 'ready', 'Ajustes → Proveedores', 'DesktopProveedores.html'),
  ('gemini', 'Gemini CLI', 'Sin clave', 'skipped', 'Ajustes → Proveedores', 'DesktopProveedores.html'),
  ('copilot', 'GitHub Copilot', 'El código caducó', 'signed-out', 'Ajustes → Proveedores', 'DesktopProveedores.html'),
  ('gh', 'GitHub', 'yeyo-dev en github.com', 'ready', 'Ajustes → Integraciones', 'DesktopIntegraciones.html'),
  ('glab', 'GitLab', 'Sin sesión', 'skipped', 'Ajustes → Integraciones', 'DesktopIntegraciones.html'),
  ('youtrack', 'YouTrack', 'Sin conectar', 'skipped', 'Ajustes → Integraciones', 'DesktopIntegraciones.html'),
]


def sum_rows(big=False):
  out = []
  for what, name, detail, state, where, href in SUMMARY:
    lead = mono(what) if what in TOOL else f'<span class="pick-ico">{ico(what, "ico")}</span>'
    b = '<span class="badge">Omitido</span>' if state == 'skipped' else badge(state)
    h = href.replace('Desktop', 'Mobile') if big else href
    out.append(f'<div class="setup-sum-row">{lead}<span class="col" style="gap: 1px; min-width: 0"><span style="font-weight: 500">{name}</span>'
               f'<span class="t-sm fg-2 ellipsis">{detail}</span></span>{b}<a href="{h}" class="setup-where">{where}</a></div>')
  return ''.join(out)


def d_done():
  il = _il('', WELCOME_BODY)
  top = (f'<div class="row" style="gap: 24px; align-items: center"><div style="flex-shrink: 0">{il}</div>'
         f'<div class="col" style="gap: 10px"><h1 class="t-display" style="margin: 0">Agentry está listo</h1>'
         f'<p class="fg-2" style="margin: 0; line-height: 1.55">Esto es lo que ha quedado hecho. Lo que has omitido sigue en Ajustes, en el mismo panel que has visto aquí, y no vuelve a salir este asistente.</p></div></div>')
  card = f'<section class="card" style="overflow: hidden" aria-label="Resumen">{sum_rows()}</section>'
  body = top + card + f'<div class="setup-foot"><button type="button" class="btn btn-ghost">{ico("left", "ico")}Volver</button><span class="grow"></span><button type="button" class="btn btn-primary">Empezar a usar Agentry</button></div>'
  dpage('DesktopConfiguracionListo.html', 'Configuración, listo', 4, body, skipped=(3,))


# The set's `welcome` illustration, as it is in illustrations/welcome.svg
WELCOME_BODY = '''<rect x="0" y="0" width="240" height="160" class="f-dots" mask="url(#il-fade)"></rect>
<ellipse cx="120" cy="80" rx="96" ry="34" class="ln-soft"></ellipse>
<circle cx="120" cy="80" r="54" class="ln-soft dash a-orbit"></circle>
<path d="M104 70 L78 44 M138 70 L166 38 M138 92 L168 120" class="ln-soft a-dash"></path>
<circle cx="120" cy="80" r="34" class="halo"></circle>
<circle cx="120" cy="80" r="24" class="f-grad"></circle>
<text x="120" y="85.5" text-anchor="middle" class="glyph-white">›_</text>
<g class="a-float"><rect x="12" y="28" width="70" height="22" rx="11" class="c2"></rect><circle cx="25" cy="39" r="3.5" class="f-live a-pulse"></circle><text x="34" y="42.5" class="txt">tests</text></g>
<g class="a-float-2"><rect x="158" y="22" width="70" height="22" rx="11" class="c2"></rect><circle cx="171" cy="33" r="3.5" class="f-ok"></circle><text x="180" y="36.5" class="txt">review</text></g>
<g class="a-float"><rect x="164" y="114" width="64" height="22" rx="11" class="c2"></rect><circle cx="177" cy="125" r="3.5" class="f-grad"></circle><text x="186" y="128.5" class="txt">docs</text></g>'''


# ---------------------------------------------------------------- Settings → Security
def security_nav():
  out = []
  for g, items in SETTINGS_NAV:
    if g == 'Agentry':
      items = ['Apariencia', 'Notificaciones', 'Editor', 'Cuenta', 'Proveedores', 'Integraciones', 'Decisiones']
    links = ''.join(f'<a href="#" class="nav-item{" on" if i == "Seguridad" else ""}" style="height: 30px; font-size: 13px">{i}</a>' for i in items)
    out.append(f'<div class="col" style="gap: 1px"><span class="t-label" style="padding: 0 10px 4px">{g}</span>{links}</div>')
  return ('<nav aria-label="Secciones de ajustes" class="col" style="width: 236px; flex-shrink: 0; padding: 26px 12px 20px 24px; gap: 16px; overflow: hidden; border-right: 1px solid var(--line)">'
          '<h1 class="t-h1" style="padding-left: 10px; font-size: 20px">Ajustes</h1>' + ''.join(out) + '</nav>')


def secrets_card(big=False):
  path = '/data/secret.key'
  return (f'<section class="card col" style="padding: 18px; gap: 12px" aria-labelledby="sec-h">'
          f'<div class="row" style="gap: 10px">{ico("lock", "ico fg-3")}<h2 class="t-h2 grow" id="sec-h">Secretos</h2><span class="badge b-ok">cifrados</span></div>'
          f'<p class="t-sm fg-2" style="margin: 0; line-height: 1.55">Las claves de los agentes, el token de YouTrack y lo que pegas al iniciar sesión se guardan cifrados en <span class="mono">secrets.json</span>, '
          f'y cada uno solo llega a los procesos de su herramienta. Nunca se muestran, ni en un registro ni en una respuesta de la API.</p>'
          f'<div class="callout callout-warn" style="align-items: flex-start">{ico("warn", "ico", "flex-shrink: 0; color: var(--warn)")}<div class="col" style="gap: 4px; flex: 1 1 0; min-width: 0">'
          f'<span style="font-weight: 500; color: var(--fg)">La clave está junto a los datos</span>'
          f'<span>Agentry la creó en <span class="mono">{path}</span> porque no recibió ninguna. Protege una copia de los archivos, como una copia de seguridad, pero no el volumen: quien lo lea tiene las dos cosas.</span>'
          f'<span>Recomendado: pasa la clave en la variable de entorno <span class="mono">AGENTRY_SECRET_KEY</span> y guárdala fuera del volumen.</span>'
          f'{vendor_link("Cómo pasar la clave", big)}</div></div></section>')


def readonly_card():
  return (f'<section class="card col" style="padding: 18px; gap: 10px"><div class="row" style="gap: 10px"><h2 class="t-h2 grow">Modo solo lectura</h2><span class="badge">escritura permitida</span></div>'
          f'<p class="t-sm fg-2" style="margin: 0">Actívalo para enseñar el panel a alguien sin dejar que cambie nada: toda petición que escriba se rechaza con 405.</p>'
          f'<label class="row" style="gap: 10px"><span class="switch" role="switch" aria-checked="false" tabindex="0" aria-label="Rechazar toda escritura"></span><span class="t-sm">Rechazar toda escritura</span></label></section>')


def sec_access_card(big=False):
  lg = ' btn-lg' if big else ''
  return (f'<section class="card col" style="padding: 18px; gap: 12px"><div class="row" style="gap: 10px"><h2 class="t-h2 grow">Acceso</h2><span class="badge b-ok">token</span></div>'
          f'{seg("Modo de autenticación", ("Ninguno", "Token", "OIDC"), "Token", big)}'
          f'<p class="t-sm fg-2" style="margin: 0">Toda petición debe llevar el token Bearer que fijes abajo. Este navegador lo guarda en su propio almacenamiento.</p>'
          f'<div class="row" style="gap: 8px; flex-wrap: wrap; padding-top: 4px; border-top: 1px solid var(--line)"><span class="t-label grow" style="padding-top: 10px">Token · fijado</span></div>'
          f'<div class="row" style="gap: 8px; flex-wrap: wrap"><button type="button" class="btn{lg}">Rotar el token</button><button type="button" class="btn btn-ghost{lg}">Usar mi propio token…</button>'
          f'<button type="button" class="btn btn-ghost btn-danger{lg}" disabled>Eliminar el token</button></div></section>')


def d_security():
  head_ = ('<div class="col" style="gap: 4px"><h2 class="t-h1" style="font-size: 20px">Seguridad</h2>'
           '<p class="fg-2 t-sm" style="margin: 0; max-width: 640px">Quién puede usar este wrapper y cómo se guardan los secretos que le das.</p></div>')
  main = f'<main class="col grow" style="padding: 26px 32px; gap: 16px; min-width: 0; max-width: 860px">{head_}{secrets_card()}{sec_access_card()}{readonly_card()}</main>'
  inner = f'<div class="row" style="flex: 1 1 auto; min-height: 0; align-items: stretch; gap: 0; overflow: hidden">{security_nav()}{main}</div>'
  write('DesktopAjustesSeguridad.html', desktop('Ajustes, seguridad', 'settings', '<span style="font-weight: 500">Ajustes</span>', inner, project='Todos los proyectos'))


# ---------------------------------------------------------------- phone
def mbrand(step):
  # The phone's step bar keeps only the bars; the step's name rides with its number here
  return (f'<div class="row" style="gap: 10px; height: 32px">{BRAND}<span style="font-weight: 600; font-size: 15px">Agentry</span>'
          f'<span class="grow"></span><span class="t-label">{step} de 4 · {STEPS[step - 1]}</span></div>')


def mhead_(title, text):
  return (f'<div class="col" style="gap: 6px"><h1 class="t-h1">{title}</h1>'
          f'<p class="t-sm fg-2" style="margin: 0; line-height: 1.5">{text}</p></div>')


def mfoot(back=True, skip=True, primary='Continuar'):
  b = f'<button type="button" class="btn btn-lg btn-ghost grow" style="justify-content: center">{ico("left", "ico")}Volver</button>' if back else ''
  s = '<button type="button" class="btn btn-lg btn-ghost grow" style="justify-content: center">Omitir</button>' if skip else ''
  row = f'<div class="row" style="gap: 8px">{b}{s}</div>' if (b or s) else ''
  return f'<div class="m-foot" style="flex-direction: column"><button type="button" class="btn btn-lg btn-primary">{primary}</button>{row}</div>'


def mpage(name, title, step, body, foot_, sheet='', skipped=()):
  inner = (f'<div class="m-body glow-top" style="padding-top: 16px; gap: 14px">{mbrand(step)}{setup_steps(step, skipped, bare=True)}{body}</div>\n{foot_}')
  write(name, mobile(title, inner + ('\n' + sheet if sheet else '')))


def mcell(tool, state, meta, reason, action=''):
  label = TOOL[tool][0]
  head = (f'<div class="prov-cell-head">{mono(tool)}<div class="grow"><span style="font-weight: 500">{label}</span>'
          f'<span class="prov-meta">{meta}</span></div>{badge(state)}</div>')
  act = f'<div class="row" style="gap: 8px">{action}</div>' if action else ''
  return f'<div class="prov-cell" data-tool="{tool}">{head}<p class="prov-reason">{reason}</p>{act}</div>'


def m_signin(tool):
  return f'<button type="button" class="btn btn-lg grow" style="justify-content: center" aria-label="Iniciar sesión en {TOOL[tool][0]}">Iniciar sesión</button>'


def m_agents_cells(codex_state='signed-out', copilot_reason='Instalado, pero sin sesión iniciada.'):
  codex = (mcell('codex', 'ready', 'v0.46.0 · yeyo@inmoseo.net', 'Sesión iniciada con un código hace un momento.') if codex_state == 'ready'
           else mcell('codex', 'signed-out', 'v0.46.0', 'Instalado, pero sin sesión iniciada.', m_signin('codex')))
  return ('<section class="card" style="overflow: hidden" aria-label="Agentes">'
          + mcell('claude-code', 'ready', 'v2.1.282 · yeyo@inmoseo.net', 'Con sesión iniciada y respondiendo.')
          + codex
          + mcell('gemini', 'signed-out', 'v0.9.1', 'Instalado, pero sin una clave.', m_signin('gemini'))
          + mcell('copilot', 'signed-out', 'v1.0.4', copilot_reason, m_signin('copilot'))
          + mcell('opencode', 'not-installed', '', 'No hay rastro de OpenCode en este equipo.', f'<button type="button" class="btn btn-lg grow" style="justify-content: center">Instalar{ext()}</button>')
          + '</section>')


M_AGENTS_HEAD = mhead_('Inicia sesión en tus agentes', 'Con un código o con una clave, sin abrir una terminal en el servidor.')


def sheet(tool, state, body, buttons, methods=None):
  label = TOOL[tool][0]
  choice = seg('Cómo iniciar sesión', ('Código', 'Clave'), methods, True) if methods else ''
  return f'''{scrim()}
<div class="sheet" role="dialog" aria-label="Iniciar sesión en {label}" style="z-index: 11; padding-bottom: 28px; display: flex; flex-direction: column; gap: 12px; max-height: 92%; overflow: hidden">
<div class="grab" style="margin-bottom: 0"></div>
<div class="prov-cell-head">{mono(tool)}<div class="grow"><h2 class="t-h2">Iniciar sesión en {label}</h2></div>{badge(state)}</div>
{choice}{body}
<div class="col" style="gap: 8px">{buttons}</div>
</div>'''


def m_access():
  body = mhead_('Quién puede abrir Agentry', 'Si corre en un servidor o en una red, pide un token.') + access_card(True)
  mpage('MobileConfiguracionAcceso.html', 'Configuración, acceso', 1, body, mfoot(back=False))


def m_agents():
  mpage('MobileConfiguracionAgentes.html', 'Configuración, agentes', 2, M_AGENTS_HEAD + m_agents_cells(), mfoot())


def m_agents_device():
  s = sheet('codex', 'signed-out', codex_note(True) + device_box('codex', 'auth.openai.com/codex/device', 'K7QM-4XPD', big=True),
            '<button type="button" class="btn btn-lg" style="justify-content: center">Cancelar</button>', methods='Código')
  mpage('MobileConfiguracionAgentesCodigo.html', 'Configuración, agentes: Codex esperando el código', 2, M_AGENTS_HEAD + m_agents_cells(), mfoot(), sheet=s)


def m_agents_key():
  s = sheet('claude-code', 'signed-out', claude_key_body(True),
            '<button type="button" class="btn btn-lg btn-primary">Guardar y comprobar</button><button type="button" class="btn btn-lg btn-ghost" style="justify-content: center">Cancelar</button>')
  mpage('MobileConfiguracionAgentesClave.html', 'Configuración, agentes: el token de Claude Code', 2, M_AGENTS_HEAD + m_agents_cells(), mfoot(), sheet=s)


def m_agents_failed():
  msg, action = result('expired', 'copilot', True)
  s = sheet('copilot', 'signed-out', msg,
            f'<button type="button" class="btn btn-lg btn-primary">{ico("retry", "ico")}{action}</button><button type="button" class="btn btn-lg btn-ghost" style="justify-content: center">Cancelar</button>', methods='Código')
  mpage('MobileConfiguracionAgentesFallo.html', 'Configuración, agentes: Codex listo y el código de Copilot caducado', 2,
        M_AGENTS_HEAD + m_agents_cells('ready', 'El código caducó sin que se aprobara.'), mfoot(), sheet=s)


def m_hosts():
  card = ('<section class="card" style="overflow: hidden" aria-label="Código y tareas">'
          + mcell('gh', 'ready', 'gh 2.92.0 · yeyo-dev en github.com', 'Con sesión iniciada y respondiendo.')
          + mcell('glab', 'signed-out', 'glab 1.120.0', 'Instalado, pero sin sesión en ningún host.', m_signin('glab'))
          + mcell('youtrack', 'signed-out', 'youtrack-app 0.4.1', 'Indica a Agentry la dirección de tu YouTrack y un token permanente.',
                  '<button type="button" class="btn btn-lg grow" style="justify-content: center">Conectar</button>')
          + '</section>')
  s = sheet('glab', 'signed-out', glab_body(True),
            '<button type="button" class="btn btn-lg btn-primary">Guardar y comprobar</button><button type="button" class="btn btn-lg btn-ghost" style="justify-content: center">Cancelar</button>', methods='Clave')
  body = mhead_('Conecta tu código y tus tareas', 'GitHub y GitLab para las PR y las MR; YouTrack para sus tareas. Todo es opcional.') + card
  mpage('MobileConfiguracionIntegraciones.html', 'Configuración, código y tareas', 3, body, mfoot())
  mpage('MobileConfiguracionIntegracionesClave.html', 'Configuración, código y tareas: el token de GitLab', 3, body, mfoot(), sheet=s)


def m_done():
  top = (f'<div class="col" style="gap: 6px; align-items: center; text-align: center">{_il("il-sm", WELCOME_BODY)}<h1 class="t-h1">Agentry está listo</h1>'
         f'<p class="t-sm fg-2" style="margin: 0; line-height: 1.5">Lo que has omitido sigue en Ajustes, en el mismo panel.</p></div>')
  body = top + f'<section class="card" style="overflow: hidden" aria-label="Resumen">{sum_rows(True)}</section>'
  mpage('MobileConfiguracionListo.html', 'Configuración, listo', 4, body, mfoot(skip=False, primary='Empezar a usar Agentry'), skipped=(3,))


def m_security():
  hd = (f'<header class="m-head" style="padding-left: 4px"><a href="MobileAjustes.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver">{ico("left", "ico ico-lg", "stroke-width: 2")}</a>'
        f'<h1 class="t-h1 grow">Seguridad</h1></header>')
  inner = f'{hd}<div class="m-body" style="gap: 12px">{secrets_card(True)}{sec_access_card(True)}</div>\n{tabbar("more")}'
  write('MobileAjustesSeguridad.html', mobile('Ajustes, seguridad', inner))


# ---------------------------------------------------------------- DSConfiguracion: every state of the panel
def ds_block(title, note, inner):
  return (f'<section class="col" style="gap: 10px"><div class="col" style="gap: 2px"><h3 class="t-h2">{title}</h3><span class="t-sm fg-2">{note}</span></div>'
          f'<div class="card" style="overflow: hidden">{inner}</div></section>')


def ds():
  btns = '<button type="button" class="btn">Guardar y comprobar</button><button type="button" class="btn btn-ghost">Cancelar</button>'
  gemini_row = srow('gemini', 'signed-out', 'Sin cuenta', 'v0.9.1', 'Instalado, pero sin una clave.', signin_btn('gemini', True), True)
  gemini = panel('gemini', key_field('Clave de API de Gemini', 'Pega la clave') + vendor_link('Crear una clave en aistudio.google.com')
                 + '<span class="form-hint">Se guarda cifrada y solo la reciben los procesos de Gemini CLI.</span>', btns)
  copilot_row = copilot_out(True)
  copilot = panel('copilot', stdin_key_body('copilot', 'Token de GitHub', 'Crear un token en github.com',
                  'Un token de grano fino con el permiso Copilot Requests. Copilot lo guarda en su configuración; Agentry no se queda con una copia.'), btns, methods='Clave')
  opencode_row = srow('opencode', 'signed-out', 'Sin cuenta', 'v1.4.2', 'Instalado, pero sin la clave de ningún proveedor.', signin_btn('opencode', True), True)
  opencode = panel('opencode', seg('Proveedor de la clave', ('Anthropic', 'OpenAI', 'Google', 'OpenRouter'), 'Anthropic')
                   + key_field('ANTHROPIC_API_KEY', 'Pega la clave') + '<span class="form-hint">OpenCode usa la clave del proveedor que elijas; Agentry la cifra y se la da en esa variable.</span>', btns)
  starting_row = srow('codex', 'signed-out', 'Sin cuenta', 'v0.46.0', 'Instalado, pero sin sesión iniciada.', signin_btn('codex', True), True)
  starting = panel('codex', '<div class="signin-wait" style="border-top: 0; padding-top: 0" role="status"><span class="spin-braille" aria-hidden="true"></span>Pidiendo un código a Codex…</div>',
                   '<button type="button" class="btn btn-ghost">Cancelar</button>', methods='Código')
  fails = []
  for code in FAIL:
    msg, action = result(code, 'codex')
    icon = '' if action in ('Usar una clave', 'Ver instalación') else ico('retry', 'ico ico-sm')
    tail = ext() if action == 'Ver instalación' else ''
    fails.append(f'<div class="col" style="gap: 8px; padding: 14px 18px; border-bottom: 1px solid var(--line)">{msg}<div class="row" style="gap: 8px"><button type="button" class="btn">{icon}{action}{tail}</button><button type="button" class="btn btn-ghost">Cancelar</button></div></div>')
  secrets = ''.join(f'<div class="row" style="gap: 14px; padding: 14px 18px; border-bottom: 1px solid var(--line); align-items: flex-start"><span class="badge {b}" style="flex-shrink: 0">{w}</span><div class="col" style="gap: 2px"><span class="mono t-xs fg-3">{k}</span><span class="t-sm">{t}</span></div></div>'
                    for b, w, k, t in [
                      ('b-ok', 'cifrados', 'sealed · key from env', 'Las claves se guardan cifradas con la clave que llega en AGENTRY_SECRET_KEY. Es lo recomendado; no hay aviso.'),
                      ('b-ok', 'cifrados', 'sealed · keyBeside', 'Cifrados, con el aviso warn «La clave está junto a los datos» y la recomendación de pasarla por el entorno (como en DesktopAjustesSeguridad).'),
                      ('b-warn', 'sin cifrar', 'not sealed', 'No hay clave (una app de escritorio sin llavero, una instalación desde el código): los valores se guardan en claro, con permisos 0600. El aviso dice eso mismo y cómo pasar una clave.')])
  steps_demo = ''.join(f'<div style="padding: 14px 18px; border-bottom: 1px solid var(--line)">{setup_steps(a, s)}</div>' for a, s in [(1, ()), (3, ()), (4, (3,))])
  body = f'''<div class="app col" data-theme="dark" style="width: 1440px; padding: 40px 56px; gap: 28px; background: var(--bg)">
<header class="col" style="gap: 6px"><span class="t-label">Design system · configuración</span><h1 class="t-display" style="margin: 0">El asistente y el panel de inicio de sesión</h1>
<p class="fg-2" style="margin: 0; max-width: 900px; line-height: 1.55">Cada estado del panel que se abre bajo una fila (<span class="mono">.prov-bin.signin</span>) y, en un móvil, en un Sheet con las mismas piezas. Los códigos en mono son los de la API (<span class="mono">LoginState</span>, <span class="mono">LoginErrorCode</span>). Mientras un código espera, su caja es lo único vivo de la pantalla.</p></header>
<div class="row" style="gap: 28px; align-items: flex-start">
<div class="col grow" style="gap: 28px; flex-basis: 0">
{ds_block('La barra de pasos', 'Primer paso, un paso a mitad y el último con «Código y tareas» omitido: barra punteada y la palabra, sin color de estado.', steps_demo)}
{ds_block('Clave en el entorno: Gemini', 'Agentry la guarda cifrada y la da solo a los procesos de Gemini CLI. Campo de solo escritura; el enlace va a la página del proveedor.', gemini_row + gemini)}
{ds_block('Clave por stdin: Copilot, con los dos métodos', 'El CLI la guarda donde siempre. Con dos métodos, el control segmentado «Código / Clave» encabeza el panel.', copilot_row + copilot)}
{ds_block('Varias variables: OpenCode', 'Un segmentado elige la variable; el nombre del campo es la variable, en mono.', opencode_row + opencode)}
</div>
<div class="col grow" style="gap: 28px; flex-basis: 0">
{ds_block('Código, empezando (starting)', 'Antes de que el CLI muestre la URL y el código: el spinner braille junto al verbo. Aún sin borde de energía.', starting_row + starting)}
{ds_block('Fallos y caducidad', 'bad cuando falló, warn cuando el código caducó. Cancelado (cancelled) no dice nada: el panel se cierra y la fila queda como estaba. Copilot no documenta cómo cerrar sesión desde un programa: su fila no ofrece «Cerrar sesión» y dice por qué.', "".join(fails))}
{ds_block('Cómo se guardan los secretos', 'La línea de Ajustes → Seguridad, por SecretStorageStatus.', secrets)}
</div></div></div>'''
  write('DSConfiguracion.html', page('Design system · configuración', body))


# ---------------------------------------------------------------- manifest and index
SCREENS = [
  ('DSConfiguracion.html', 'Design system · Configuración: el panel de inicio de sesión', 1440, 1980),
  ('DesktopConfiguracionAcceso.html', 'Desktop · Configuración, acceso', 1440, 1024),
  ('DesktopConfiguracionAgentes.html', 'Desktop · Configuración, agentes: Codex esperando el código', 1440, 1100),
  ('DesktopConfiguracionAgentesClave.html', 'Desktop · Configuración, agentes: el token de Claude Code', 1440, 1100),
  ('DesktopConfiguracionAgentesFallo.html', 'Desktop · Configuración, agentes: código caducado', 1440, 1024),
  ('DesktopConfiguracionIntegraciones.html', 'Desktop · Configuración, código y tareas', 1440, 1024),
  ('DesktopConfiguracionListo.html', 'Desktop · Configuración, listo', 1440, 1024),
  ('DesktopAjustesSeguridad.html', 'Desktop · Ajustes, seguridad y secretos', 1440, 1024),
  ('MobileConfiguracionAcceso.html', 'Móvil · Configuración, acceso', 390, 844),
  ('MobileConfiguracionAgentes.html', 'Móvil · Configuración, agentes', 390, 844),
  ('MobileConfiguracionAgentesCodigo.html', 'Móvil · Configuración, Codex esperando el código', 390, 844),
  ('MobileConfiguracionAgentesClave.html', 'Móvil · Configuración, el token de Claude Code', 390, 844),
  ('MobileConfiguracionAgentesFallo.html', 'Móvil · Configuración, código caducado', 390, 844),
  ('MobileConfiguracionIntegraciones.html', 'Móvil · Configuración, código y tareas', 390, 844),
  ('MobileConfiguracionIntegracionesClave.html', 'Móvil · Configuración, el token de GitLab', 390, 844),
  ('MobileConfiguracionListo.html', 'Móvil · Configuración, listo', 390, 844),
  ('MobileAjustesSeguridad.html', 'Móvil · Ajustes, seguridad y secretos', 390, 844),
]


def register():
  mf = os.path.join(OUT, 'manifest.json')
  entries = json.load(open(mf))
  have = {e['file'] for e in entries}
  entries += [dict(file=f, title=t, w=w, h=h) for f, t, w, h in SCREENS if f not in have]
  with open(mf, 'w') as fh:
    fh.write(json.dumps(entries, indent=2, ensure_ascii=False) + '\n')
  ix = os.path.join(OUT, 'index.html')
  s = open(ix).read()
  if 'DesktopConfiguracionAcceso.html' in s:
    return
  shots = ''.join(f'<div class="shot"><a href="{f}"><img src="screenshots/{f[:-5]}-dark.webp" alt="{t}"></a><a href="{f}" class="t-sm">{t}</a>'
                  f'<span class="mono t-xs fg-3">{f} · {w}×{h} · <a class="c-accent" href="screenshots/{f[:-5]}-light.webp">light</a></span></div>\n' for f, t, w, h in SCREENS)
  sec = (f'<section class="col" style="gap:12px"><h2 class="t-h2">In-app setup <span class="t-label" style="margin-left:8px">Plan: in-app-setup.md</span></h2><div class="grid">\n'
         f'{shots}</div></section>\n')
  s = s.replace('</div></body></html>', sec + '</div></body></html>')
  open(ix, 'w').write(s)


if __name__ == '__main__':
  d_access()
  d_agents_device()
  d_agents_key()
  d_agents_failed()
  d_hosts()
  d_done()
  d_security()
  m_access()
  m_agents()
  m_agents_device()
  m_agents_key()
  m_agents_failed()
  m_hosts()
  m_done()
  m_security()
  ds()
  register()
