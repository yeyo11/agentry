# Reviews of a change request (plans/code-hosts.md, phase 3, P0). One function per task, each under its own
# banner: r-p3 is the Address with an agent dialog, its review.triage marks and the "Atendido en" follow-up
# (DSRevision). r-p1 (threads in the diff) and r-p2 (the item page's review block) add theirs below.
# Runs on its own: it imports common.py, data.py, tasks.py and checks.py (the fix panel and the item page it extends).
#   python3 reviews.py
from data import *
from common import P, ico, write, page
import decisions as dec
from tasks import MR_BRANCH
from checks import HOST, pframe

P.setdefault('ext', EXT_PATH)

# ---------------------------------------------------------------- shared
HEAD = 'a1b2c3d'      # the head the threads were read on
PUSHED = 'a8f3c21'    # the commit the Developer pushed
# host id -> "PR #12" / "MR !12"
def ref(host):
  return f'{HOST[host][1]} {HOST[host][2]}'


# One unresolved thread, as the Address dialog lists it: path and new-side lines, who opened it, the first
# comment, how many comments it has, the triage mark (None when review.triage is off), whether it is outdated
# and the result the Developer reports once it has run: (addressed, sentence).
def t(tid, path, line, by, body, n, mark, outdated=False, result=None):
  return dict(id=tid, path=path, line=line, by=by, body=body, n=n, mark=mark, outdated=outdated, result=result)


THREADS = [
  t('t1', 'packages/core/src/project-templates.ts', '142', 'marta-gil',
    '`limits` se asigna y no se usa. ¿Lo quitamos o lo aplicamos de verdad a las columnas de la plantilla?', 2, 'agent',
    result=(True, 'Aplica los límites a las columnas y quita la variable suelta.')),
  t('t2', 'apps/web/src/pages/projects/NewProject.tsx', '88', 'dpacheco',
    'Este texto no pasa por i18n: falta la clave en `en` y en `es`.', 1, 'agent',
    result=(True, 'Añade la clave en los dos idiomas.')),
  t('t3', 'packages/core/src/project-templates.ts', '57', 'marta-gil',
    '¿Por qué el orden de las columnas es fijo? Yo lo dejaría configurable por plantilla.', 3, 'person',
    result=(False, 'Es una decisión de diseño: no cambió nada y lo deja para ti.')),
  t('t4', 'packages/core/test/templates-apply.test.ts', '58', 'dpacheco',
    'Falta el caso de una plantilla sin límites.', 1, 'agent', outdated=True,
    result=(True, 'Añade el caso y comprueba que no falla.')),
  t('t5', 'apps/web/src/styles/templates.css', '12', 'marta-gil',
    'Gracias, así queda mucho mejor.', 1, 'none'),
]
RESOLVED = 2   # threads the host already has resolved: not sent, said in one line

# triage mark -> word, badge class, icon, what it preselects. A suggestion is not a status: only the
# agent's mark takes the accent; the person's is idle because it is the one that waits for a person.
MARK = {
  'agent': ('agente', 'b-accent', 'code', 'Un cambio concreto que el desarrollador puede hacer.'),
  'person': ('persona', 'b-idle', 'user', 'Una pregunta, una decisión de diseño o un desacuerdo.'),
  'none': ('sin acción', '', 'block', 'Un agradecimiento, un punto ya resuelto o un detalle ya hecho.'),
}


def mark_badge(m):
  word, cls, icon, _ = MARK[m]
  return f'<span class="badge {cls}">{ico(icon, "ico ico-sm")}{word}</span>'


def short(body):
  """The body with its backticks as <code>: a comment's own formatting, kept to a minimum."""
  out, tick = '', False
  for part in body.split('`'):
    out += f'<span class="mono" style="color: var(--fg)">{part}</span>' if tick else part
    tick = not tick
  return out


def cell(k, v):
  return f'<div class="col" style="gap: 4px; min-width: 0"><span class="t-label">{k}</span>{v}</div>'


# ---------------------------------------------------------------- the thread rows of the dialog
def thread_row(x, on, mobile=False, triage=True):
  """One thread to choose. A desktop row is a label with the app's checkbox; a phone has no checkboxes, so the
  whole row is a pressed button that says "Elegido" in words."""
  path = f'<span class="addr-path">{x["path"]}:{x["line"]}</span>'
  marks = (mark_badge(x['mark']) if triage and x['mark'] else '')
  out = f'<span class="badge">{ico("wait", "ico ico-sm")}desactualizado</span>' if x['outdated'] else ''
  n = f'{x["n"]} comentario' + ('s' if x['n'] > 1 else '')
  by = f'<span class="addr-by"><span class="mono">{x["by"]}</span> · {n}</span>'
  if x['outdated']:
    by = f'<span class="addr-by"><span class="mono">{x["by"]}</span> · {n} · el código ha cambiado desde el commit <span class="mono">9e41d07</span></span>'
  main = (f'<span class="addr-main"><span class="addr-head">{path}{out}{marks}</span><p class="addr-quote">{short(x["body"])}</p>{by}</span>')
  if mobile:
    state = (f'<span class="addr-state on">{ico("check", "ico ico-sm")}Elegido</span>' if on
             else f'<span class="addr-state">{ico("plus", "ico ico-sm")}Elegir</span>')
    return (f'<button type="button" class="addr-thread{" on" if on else ""}" aria-pressed="{"true" if on else "false"}" '
            f'aria-label="Elegir el hilo de {x["path"]}:{x["line"]}">{main}{state}</button>')
  chk = f'<span class="checkbox{" on" if on else ""}" role="checkbox" aria-checked="{"true" if on else "false"}" aria-label="Elegir el hilo de {x["path"]}:{x["line"]}"></span>'
  return f'<label class="addr-thread{" on" if on else ""}">{chk}{main}</label>'


def chosen(triage):
  return {x['id'] for x in THREADS if triage and x['mark'] == 'agent'}


def thread_list(mobile, triage):
  on = chosen(triage)
  return f'<div class="addr-list">{"".join(thread_row(x, x["id"] in on, mobile, triage) for x in THREADS)}</div>'


def list_head(triage, mobile=False):
  """Above the list: how many are open, who suggested the choice, and the shortcut that follows the marks."""
  n = len(chosen(triage))
  src = ('<span class="decided-face" title="Lo sugiere review.triage">sugerido · review.triage</span>' if triage
         else '<span class="decided-face">sin triaje</span>')
  btn = ''
  if triage:
    size = 'btn btn-lg' if mobile else 'btn btn-sm btn-ghost'
    wide = ' style="flex: 1 1 100%; justify-content: center"' if mobile else ''
    btn = f'<button type="button" class="{size}"{wide}>Elegir solo los del agente</button>'
  return (f'<div class="row" style="gap: 8px; flex-wrap: wrap"><span class="t-label">Hilos sin resolver · {len(THREADS)}</span>{src}<span class="grow"></span>'
          f'{btn}</div>')


# ---------------------------------------------------------------- the dialog and its Sheet
def notes(host, triage):
  untrusted = (f'<div class="callout" style="align-items: flex-start">{ico("lock", "ico", "flex-shrink: 0; color: var(--fg-3); margin-top: 1px")}'
               f'<span><b style="color: var(--fg); font-weight: 500">Los comentarios son de otras personas.</b> El desarrollador los pesa como peticiones, no como órdenes: '
               f'hace lo que la tarjeta y el comentario acuerdan, y te dice cuáles ha atendido y cuáles no, y por qué.</span></div>')
  push = (f'<div class="callout" style="align-items: flex-start">{ico("info", "ico", "flex-shrink: 0; color: var(--fg-3); margin-top: 1px")}'
          f'<span>Como lo pides tú, el cambio se sube solo cuando QA lo dé por bueno. Mover la tarjeta antes retira ese permiso. '
          f'No se responde ni se resuelve nada en la {ref(host)}: eso lo haces tú después.</span></div>')
  off = ''
  if not triage:
    off = (f'<div class="callout callout-warn" style="align-items: flex-start">{ico("warn", "ico", "flex-shrink: 0; color: var(--warn); margin-top: 1px")}'
           f'<span><b style="color: var(--fg); font-weight: 500">review.triage está apagado.</b> Ningún hilo viene elegido de antemano: elige los que quieras que atienda el desarrollador.</span></div>')
  return off + untrusted + push


def facts(mobile=False):
  return ('<div class="row" style="gap: 12px 28px; flex-wrap: wrap; align-items: flex-start">'
          + cell('Los atiende', '<span class="mono t-sm">Desarrollador · sonnet</span>')
          + cell('Worktree', '<span class="mono t-sm">task/agn-26</span>')
          + cell('Resueltos', f'<span class="t-sm fg-2">{RESOLVED} hilos resueltos: no se envían</span>')
          + '</div>')


def intro():
  return ('El desarrollador de la tarea recibe cada hilo elegido —el archivo, las líneas, el trozo del diff y todos sus comentarios con su autor— y hace el cambio que pidan. '
          'No sube nada por su cuenta.')


def sub(host):
  return f'<span class="mono t-xs fg-3">{MR_BRANCH} · {HEAD}</span>'


def foot_label(triage):
  n = len(chosen(triage))
  return f'Atender {n} comentarios' if n > 1 else ('Atender 1 comentario' if n == 1 else 'Elige un hilo')


def dialog(host, triage, variant):
  n = len(chosen(triage))
  body = (f'<p class="t-sm fg-2" style="margin: 0; line-height: 1.55">{intro()}</p>'
          f'<div class="col" style="gap: 8px">{list_head(triage)}{thread_list(False, triage)}</div>'
          f'{notes(host, triage)}{facts()}')
  disabled = '' if n else ' disabled'
  d = f'''<div class="scrim" style="z-index: 5">
<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="addr-title-{variant}" style="width: 600px">
<div class="dialog-head">{ico("comment", "ico fg-3")}<div class="col grow" style="gap: 2px"><h2 id="addr-title-{variant}" class="t-h2">Atender con un agente los comentarios de la {ref(host)}</h2>{sub(host)}</div><button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Cerrar">{ico("x")}</button></div>
<div class="dialog-body">{body}</div>
<div class="dialog-foot"><span class="t-xs fg-3">{n} de {len(THREADS)} elegidos</span><span class="grow"></span><button type="button" class="btn btn-ghost">Cancelar</button><button type="button" class="btn btn-primary"{disabled}>{foot_label(triage)}</button></div>
</div></div>'''
  return (f'<div class="app" data-theme="dark" style="position: relative; width: 640px; height: 1200px; border-radius: var(--r-xl); border: 1px solid var(--line-2); overflow: hidden; background: var(--bg-1)">{d}</div>')


def sheet(host, triage):
  n = len(chosen(triage))
  name = HOST[host][0]
  pr = (f'<a href="#" class="pr-row" aria-label="Abrir {ref(host)} en {name}"><span class="pr-num">{ref(host)}</span><span class="pr-branch">{MR_BRANCH}</span>{ci_badge("passing")}{ext_ico()}</a>')
  behind = f'<div class="m-body" style="gap: 12px"><div class="row" style="gap: 6px">{tico("story", True)}<span class="wi-key boxed">AGN-26</span></div>{pr}</div>'
  disabled = '' if n else ' disabled'
  s = f'''{dec.scrim()}
<div class="sheet" role="dialog" aria-label="Atender con un agente" style="z-index: 11; padding-bottom: 28px; display: flex; flex-direction: column; gap: 12px; max-height: 97%; overflow: hidden">
<div class="grab" style="margin-bottom: 0"></div>
<div class="col" style="gap: 2px"><h2 class="t-h2">Atender con un agente los comentarios de la {ref(host)}</h2>{sub(host)}</div>
<p class="t-sm fg-2" style="margin: 0; line-height: 1.5">{intro()}</p>
<div class="col" style="gap: 8px">{list_head(triage, True)}{thread_list(True, triage)}</div>
{notes(host, triage)}
<div class="row" style="gap: 8px"><button type="button" class="btn btn-lg">Cancelar</button><button type="button" class="btn btn-lg btn-primary grow" style="justify-content: center"{disabled}>{foot_label(triage)}</button></div>
</div>'''
  return pframe(behind + s, pad="0", height=1620)


def dialog_section():
  rows = ''
  for host, triage, variant, title, note in [
      ('github', True, 'triage', 'Con review.triage activo (PR de GitHub)',
       'Los tres hilos que el triaje marca «agente» vienen elegidos; «persona» y «sin acción» no. La marca solo elige de antemano: un clic cambia cualquier hilo y el botón cuenta lo elegido.'),
      ('gitlab', False, 'plain', 'Con review.triage apagado (MR de GitLab)',
       'Sin marcas y sin nada elegido: el botón principal espera a que elijas al menos un hilo. El aviso dice por qué.')]:
    rows += (f'<div class="col" style="gap: 12px"><div class="col" style="gap: 4px"><span class="t-sm" style="font-weight: 600">{title}</span>'
             f'<span class="t-xs fg-3" style="line-height: 1.45; max-width: 760px">{note}</span></div>'
             f'<div style="display: grid; grid-template-columns: 640px 390px; gap: 48px; align-items: start">{dialog(host, triage, variant)}{sheet(host, triage)}</div></div>')
  return f'<section class="col" style="gap: 28px"><span class="t-label">El diálogo de atender, y su Sheet en el móvil</span>{rows}</section>'


# ---------------------------------------------------------------- the marks
def marks_section():
  cards = ''
  for m, example in [('agent', 'Falta el caso de una plantilla sin límites.'), ('person', '¿Por qué el orden de las columnas es fijo?'),
                     ('none', 'Gracias, así queda mucho mejor.')]:
    word, _, _, what = MARK[m]
    pre = 'Viene elegido.' if m == 'agent' else 'No viene elegido.'
    cards += (f'<div class="card col" style="padding: 18px; gap: 10px"><div class="row" style="gap: 8px">{mark_badge(m)}<span class="mono t-xs fg-3">«{word}»</span></div>'
              f'<span class="t-sm" style="font-weight: 500">{what}</span>'
              f'<p class="addr-quote" style="-webkit-line-clamp: 3">{example}</p><span class="t-xs fg-3">{pre}</span></div>')
  asks = ('<div class="col" style="gap: 6px"><span class="t-label">La pregunta</span>'
          '<span class="t-sm" style="font-weight: 500">¿Quién debería atender este comentario de la revisión?</span>'
          '<span class="t-xs fg-3" style="line-height: 1.5; max-width: 720px">Una sola vez por hilo sin resolver, hasta 40, con la ruta, el autor, si está desactualizado y el cuerpo cortado a 1 KiB. '
          'Es un punto que sugiere, por proyecto: no mueve nada, no responde y no resuelve.</span></div>')
  return (f'<section class="col" style="gap: 14px"><span class="t-label">Las marcas de review.triage</span>{asks}'
          f'<div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px">{cards}</div></section>')


# ---------------------------------------------------------------- the item page after the run
def item_status(state):
  if state == 'addressing':
    return f'<span class="badge">{sico("in_progress")}en curso</span><span class="badge"><span class="spin-braille" aria-hidden="true"></span>atendiendo comentarios</span>'
  return f'<span class="badge">{sico("in_review")}en revisión</span><span class="badge b-idle">comentarios por cerrar</span>'


def live_rows(mobile):
  """The threads the Developer is working on: the same row without its checkbox."""
  rows = ''.join(
    f'<div class="addr-thread static"><span class="addr-main"><span class="addr-head"><span class="addr-path">{x["path"]}:{x["line"]}</span>'
    f'{"<span class=\"badge\">" + ico("wait", "ico ico-sm") + "desactualizado</span>" if x["outdated"] else ""}</span>'
    f'<span class="addr-by"><span class="mono">{x["by"]}</span> · {x["n"]} comentario{"s" if x["n"] > 1 else ""}</span></span></div>'
    for x in THREADS if x['mark'] == 'agent')
  return f'<div class="addr-list" aria-label="Hilos que atiende">{rows}</div>'


def addressing_panel(host, mobile=False):
  size = 'btn btn-lg' if mobile else 'btn btn-sm'
  return (f'<section class="fix-panel live rail-live" aria-label="Atender los comentarios"><div class="fix-head">'
          f'<div class="col grow" style="gap: 4px"><span class="fix-title"><span class="spin-braille" aria-hidden="true"></span>El desarrollador atiende 3 comentarios<time class="mono t-xs fg-3" style="font-weight: 400">1:12</time></span>'
          f'<span class="fix-sub">Lo has pedido tú: si QA da el cambio por bueno, se sube solo. Mover la tarjeta mientras tanto retira ese permiso.</span></div></div>'
          f'{live_rows(mobile)}'
          f'<div class="fix-foot"><a href="DesktopChatTarea.html" class="{size}">{ico("chats", "ico ico-sm")}Ver el chat del desarrollador</a></div></section>')


# state of each thread once the Developer pushed: replied, resolved
FOLLOW = {'t1': (True, True), 't2': (True, False), 't4': (False, False), 't3': (False, False)}


def done_row(x, host, mobile):
  addressed, _ = x['result']
  replied, resolved = FOLLOW[x['id']]
  size = 'btn btn-lg' if mobile else 'btn btn-sm'
  path = f'<span class="addr-path">{x["path"]}:{x["line"]}</span>'
  if addressed:
    word = '<span class="badge b-ok">' + ico('check', 'ico ico-sm') + 'atendido</span>'
  else:
    word = '<span class="badge">' + ico('block', 'ico ico-sm') + 'sin atender</span>'
  states = ''
  if replied:
    states += f'<span class="badge b-ok">{ico("check", "ico ico-sm")}respondido</span>'
  if resolved:
    states += f'<span class="badge b-ok">{ico("check", "ico ico-sm")}resuelto</span>'
  why = f'<span class="addr-why">{x["result"][1]}</span>'
  acts = ''
  if addressed and not resolved:
    if not replied:
      acts += f'<button type="button" class="{size}">{ico("comment", "ico ico-sm")}Responder «Atendido en {PUSHED}»</button>'
    acts += f'<button type="button" class="{size}">{ico("check", "ico ico-sm")}Resolver</button>'
  if not addressed:
    acts += f'<a href="#" class="{size} btn-ghost" target="_blank" rel="noreferrer">{ext_ico()}Abrir el hilo en {HOST[host][0]}</a>'
  act_row = f'<div class="addr-acts">{acts}</div>' if acts else ''
  quote = '' if resolved else f'<p class="addr-quote">{short(x["body"])}</p>'
  return (f'<div class="addr-done{" resolved" if resolved else ""}"><div class="addr-head">{path}{word}{states}</div>{quote}{why}{act_row}</div>')


def followup_panel(host, mobile=False):
  size = 'btn btn-lg' if mobile else 'btn btn-sm'
  primary = 'btn btn-lg btn-primary' if mobile else 'btn btn-sm btn-primary'
  wide = ' style="flex: 1 1 100%; justify-content: center"' if mobile else ''
  rows = ''.join(done_row(x, host, mobile) for x in THREADS if x['result'] and x['id'] in FOLLOW)
  return (f'<section class="fix-panel wait" aria-label="Comentarios atendidos"><div class="fix-head">'
          f'<div class="col grow" style="gap: 4px"><span class="fix-title">{ico("wait", "ico", "color: var(--idle)")}El desarrollador atendió 3 de 4 comentarios<span class="badge b-idle">te esperan</span></span>'
          f'<span class="fix-sub">QA lo dio por bueno y se subió <span class="mono">{PUSHED}</span> a <span class="mono">task/agn-26</span>: la {ref(host)} ya lo tiene. '
          f'Agentry no responde ni resuelve nada por su cuenta.</span></div></div>'
          f'<div class="addr-list">{rows}</div>'
          f'<div class="addr-reply"><span class="t-label">Respuesta que se publicará</span><span class="mono">Atendido en {PUSHED}</span></div>'
          f'<div class="fix-foot"><button type="button" class="{primary}"{wide}>{ico("check", "ico ico-sm")}Responder y resolver 2 hilos</button>'
          f'<a href="DesktopCambios.html" class="{size}">{ico("git", "ico ico-sm")}Ver el diff</a>'
          f'<span class="grow"></span><span class="mono t-xs fg-3" style="font-variant-numeric: tabular-nums">+24 −9 · 3 archivos</span></div></section>')


def item_excerpt(state, host, mobile=False):
  name, noun = HOST[host][0], HOST[host][1]
  word = 'pull request' if host == 'github' else 'merge request'
  pr = (f'<a href="#" class="pr-row" target="_blank" rel="noreferrer" aria-label="Abrir {ref(host)} en {name}"><span class="pr-num">{ref(host)}</span>'
        f'<span class="pr-branch">{MR_BRANCH}</span>{ci_badge("passing")}{ext_ico()}</a>')
  panel = addressing_panel(host, mobile) if state == 'addressing' else followup_panel(host, mobile)
  if mobile:
    head = (f'<div class="row" style="gap: 6px; flex-wrap: wrap"><a href="MobileTablero.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver al tablero" style="margin-left: -10px">{ico("left", "ico ico-lg", "stroke-width: 2")}</a>'
            f'{tico("story", True)}<span class="wi-key boxed">AGN-26</span></div>'
            f'<div class="row" style="gap: 6px; flex-wrap: wrap">{item_status(state)}</div>'
            f'<h1 class="t-h2" style="font-size: 17px; line-height: 1.35">Plantillas de proyecto</h1>')
    return f'<div class="col" style="gap: 12px">{head}<span class="t-label" style="padding: 0 2px">Su {word}</span>{pr}{panel}</div>'
  head = (f'<div class="row" style="gap: 10px; flex-wrap: wrap"><a href="DesktopTablero.html" class="btn btn-icon btn-sm" aria-label="Volver al tablero">{ico("left")}</a>'
          f'{tico("story", True)}<span class="wi-key boxed">AGN-26</span>{item_status(state)}<span class="grow"></span>'
          f'<a href="DesktopChatTarea.html" class="btn btn-sm">{ico("chats", "ico ico-sm")}Ver el chat</a></div>')
  return (f'<div class="card col" style="padding: 18px; gap: 14px">{head}<h1 class="t-h1" style="font-size: 22px">Plantillas de proyecto</h1>'
          f'<div class="row" style="gap: 10px"><h2 class="t-h2 grow">Su {word}</h2></div>{pr}{panel}</div>')


ITEM_STATES = [
  ('addressing', 'github', 'addressing', 'El desarrollador trabaja los tres hilos elegidos. Solo se mueve lo que trabaja: braille, tiempo y raíl en cian. Un hilo desactualizado lo dice.'),
  ('followup', 'gitlab', 'tras la subida', 'QA dio el cambio por bueno y se subió solo, porque lo pediste tú. Cada hilo dice si se atendió y por qué; lo que no, se queda para ti, con un enlace al hilo.'),
]


def item_section():
  rows = ''
  for state, host, code, note in ITEM_STATES:
    head = (f'<div class="col" style="gap: 6px"><span class="mono t-sm" style="font-weight: 500">{code}</span>'
            f'<span class="row t-xs fg-2" style="gap: 6px">{ref(host)}</span><span class="t-xs fg-3" style="line-height: 1.45">{note}</span></div>')
    rows += (f'<div style="display: grid; grid-template-columns: 220px minmax(0, 1fr) 390px; gap: 40px; align-items: start; padding: 18px 0; border-top: 1px solid var(--line)">'
             f'{head}{item_excerpt(state, host)}{pframe(item_excerpt(state, host, True))}</div>')
  return f'<section class="col" style="gap: 0"><span class="t-label" style="padding-bottom: 14px">La página de la tarea, durante y después</span>{rows}</section>'


# ---------------------------------------------------------------- the sheet of rules and the page
RULES = [
  ('01', 'Una marca solo elige de antemano',
   'review.triage pone «agente», «persona» o «sin acción» a cada hilo y solo deja elegidos los del agente. Un clic cambia cualquiera; por una marca no se envía ni se hace nada.'),
  ('02', 'Los comentarios son peticiones, no órdenes',
   'Los escribe otra gente. El desarrollador hace lo que la tarjeta y el comentario acuerdan y dice cuáles atendió y cuáles no, con su porqué. El diálogo lo avisa antes de empezar.'),
  ('03', 'Agentry no responde ni resuelve solo',
   'Tras la subida ofrece «Responder “Atendido en {sha}”» y «Resolver» por hilo, y una acción para los que quedan. Es siempre un clic tuyo, también cuando lo pidió una persona.'),
  ('04', 'Una acción primaria por zona',
   '«Atender N comentarios» es el degradado del diálogo; tras la subida lo es «Responder y resolver N» de la página. En el móvil no hay casillas: la fila entera es el botón y dice «Elegido».'),
]


def rules_section():
  cards = ''.join(f'<div class="card col" style="padding: 18px; gap: 8px"><span class="mono t-xs fg-3">{n}</span><h2 class="t-h2">{h}</h2>'
                  f'<p class="t-sm fg-2" style="margin: 0; line-height: 1.5">{x.replace("{sha}", PUSHED)}</p></div>' for n, h, x in RULES)
  return f'<section style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px">{cards}</section>'


DS_HEIGHT = 6460


def ds_revision():
  head = ('<header class="col" style="gap: 8px"><span class="t-label">Agentry design system · alojamientos de código · revisiones</span>'
          '<h1 class="t-display" style="margin: 0">Atender con un agente</h1>'
          '<p class="fg-2" style="margin: 0; max-width: 900px; line-height: 1.55">Qué ve la persona cuando pide que un agente atienda los comentarios de una revisión: el diálogo que elige los hilos, '
          'las marcas con las que review.triage sugiere cuáles, la página de la tarea mientras trabaja y el seguimiento «Atendido en» que deja cada hilo en manos de quien lo abrió. '
          'Una palabra junto a cada color, una acción primaria por zona, y nada se responde ni se resuelve sin un clic de una persona.</p></header>')
  sections = [rules_section(), marks_section(), dialog_section(), item_section()]
  body = (f'<div class="app col" data-theme="dark" style="width: 1440px; height: {DS_HEIGHT}px; padding: 56px 64px; gap: 40px; overflow: hidden">'
          f'{head}{"".join(sections)}</div>')
  write('DSRevision.html', page('Design system · Revisiones', body))


def all_r_p3():
  ds_revision()


# ---------------------------------------------------------------- run
if __name__ == '__main__':
  all_r_p3()
