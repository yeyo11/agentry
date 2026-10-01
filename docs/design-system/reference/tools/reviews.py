# Reviews of a change request (plans/code-hosts.md, phase 3, P0). One function per task, each under its own
# banner: r-p2 is the review block on the item page. r-p1 (threads in the diff) and r-p3 (Address with an
# agent) add theirs below. Runs on its own: it imports common.py, data.py, decisions.py, tasks.py (the item page
# it extends) and checks.py (the host table and the link to the host).
#   python3 reviews.py
from data import *
from common import P, ico, desktop, mobile, write, page, av
from decisions import scrim
from tasks import _captured, _swap, detail_desktop, mtask_head, wrap_paths, MR_BRANCH
from checks import HOST, host_link, foot_mr

P.setdefault('ext', EXT_PATH)
HEAD_SHA = 'a81d3f0'


# ---------------------------------------------------------------- r-p2 · the review block on the item page
# The person's draft notes: path, line, text, whether it is a suggestion. They are rows on the server, so a
# reload or a second tab shows the same bar.
DRAFTS = [
  ('packages/core/src/project-templates.ts', '142', 'Esto debería leer el límite de la columna, no el de la plantilla.', False),
  ('apps/web/src/pages/NewProject.tsx', '58', 'Propongo este cambio: el nombre ya viene recortado del formulario.', True),
  ('packages/core/test/templates-apply.test.ts', '57–60', 'Falta el caso con el límite en 0.', False),
]

# state -> word, badge class. A status colour always comes with its word.
DECISION = {
  'required': ('revisión necesaria', 'b-idle'),
  'pending': ('falta aprobación', 'b-idle'),
  'changes': ('cambios pedidos', 'b-warn'),
  'approved': ('aprobada', 'b-ok'),
}
PERSON = {
  'approved': ('aprobó', 'b-ok'),
  'changes': ('pidió cambios', 'b-warn'),
  'commented': ('comentó', ''),
  'waiting': ('pendiente', 'b-idle'),
}
# What the host said when it refused, in the words of the reasons table of the plan
OWN = {
  'github': 'GitHub no deja aprobar ni pedir cambios en tu propia PR. Puedes comentar y pedir la revisión de otras personas.',
  'gitlab': 'Esta MR es tuya: GitLab no deja aprobarla tú. Puedes comentar y pedir la revisión de otras personas.',
}


def scene(host, **kw):
  """One state of the block. The defaults are the item page's: a GitLab MR by someone else, with the draft ready."""
  base = dict(host=host, decision='pending', approvals='1 de 2 aprobaciones',
              people=[('marta.ruiz', 24, 'approved'), ('dani.lopez', 200, 'waiting')],
              open_=2, done=1, drafts=DRAFTS, bar='drafts', own=False, mine=False, author='marta.ruiz')
  base.update(kw)
  return base


def decision_row(s):
  word, cls = DECISION[s['decision']]
  return (f'<div class="rv-row"><span class="rv-k t-label">Decisión</span><span class="rv-v"><span class="badge {cls}">{word}</span>'
          f'<span>{s["approvals"]}</span></span></div>')


def people_row(s, mobile):
  chips = ''.join(f'<span class="rv-person">{av(n[0].upper(), h)}<span class="name">{n}</span>'
                  f'<span class="badge {PERSON[st][1]}">{PERSON[st][0]}</span></span>' for n, h, st in s['people'])
  size = 'btn-lg' if mobile else 'btn-sm'
  ask = f'<button type="button" class="btn btn-ghost {size}" aria-haspopup="dialog">{ico("plus", "ico ico-sm" if not mobile else "ico")}Pedir revisión</button>'
  return f'<div class="rv-row"><span class="rv-k t-label">Revisores</span><span class="rv-v">{chips}</span><span class="rv-side">{ask}</span></div>'


def threads_row(s, mobile):
  size = 'btn-lg' if mobile else 'btn-sm'
  if s['open_']:
    word = f'<span class="badge b-warn">{s["open_"]} sin resolver</span>'
  else:
    word = f'<span class="badge b-ok">{ico("check", "ico ico-sm")}todo resuelto</span>'
  done = f'<span class="mono t-xs fg-3">{s["done"]} resuelto{"s" if s["done"] != 1 else ""}</span>' if s['done'] else ''
  see = f'<a href="DesktopRevisionHilos.html" class="btn btn-ghost {size}">Ver en los cambios</a>'
  agent = (f'<button type="button" class="btn {size}">{ico("sparkle", "ico ico-sm" if not mobile else "ico")}Atender con un agente</button>'
           if s['open_'] else '')
  return (f'<div class="rv-row"><span class="rv-k t-label">Hilos</span><span class="rv-v">{word}{done}</span>'
          f'<span class="rv-side">{see}{agent}</span></div>')


def note_row(path, line, text, suggestion=False, mark=None):
  """A draft note: where it goes in mono, what it says, and (while a send is half done) what became of it."""
  tag = '<span class="badge b-accent">sugerencia</span>' if suggestion else ''
  state = ''
  if mark == 'saved':
    state = f'<span class="badge b-ok">{ico("check", "ico ico-sm")}guardado</span>'
  elif mark == 'failed':
    state = f'<span class="badge b-bad">{ico("x", "ico ico-sm")}falló</span>'
  return (f'<li class="rv-note"><span class="rv-where"><span class="p">{path}</span><span class="l">:{line}</span></span>{tag}{state}'
          f'<span class="rv-text">{text}</span></li>')


def count_words(drafts):
  n = len(drafts)
  sug = sum(1 for d in drafts if d[3])
  return f'{n} comentario{"s" if n != 1 else ""}' + (f' · {sug} sugerencia{"s" if sug != 1 else ""}' if sug else '')


def callout(kind, icon, text, extra=''):
  warn = ' callout-warn' if kind == 'warn' else ''
  colour = 'var(--warn)' if kind == 'warn' else 'var(--fg-3)'
  return (f'<div class="callout{warn}" role="note" style="align-items: flex-start">{ico(icon, "ico", f"flex-shrink: 0; color: {colour}; margin-top: 1px")}'
          f'<span class="col grow" style="gap: 6px; min-width: 0"><span>{text}</span>{extra}</span></div>')


def bar(s, mobile):
  """The person's draft review. Its one gradient action sends it; on GitHub, approving and asking for changes
  are a link to the host (decision 1 of the plan), and on one's own change request they are not offered."""
  host, kind = s['host'], s['bar']
  name, noun, num, _ = HOST[host]
  size = 'btn-lg' if mobile else 'btn-sm'
  dr = s['drafts']
  if kind == 'empty':
    body = (f'<span class="t-sm fg-2" style="line-height: 1.5">Todavía no hay comentarios. Pulsa en una línea de los cambios para dejar uno; se envían todos juntos, como una sola revisión.</span>'
            f'<div class="rv-foot"><a href="DesktopCambios.html" class="btn {size}">{ico("git", "ico ico-sm" if not mobile else "ico")}Ver los cambios</a></div>')
    return (f'<section class="rv-draft" aria-label="Tu revisión"><div class="rv-draft-head">{ico("edit", "ico fg-3")}<b>Tu revisión</b>'
            f'<span class="badge">sin borrador</span></div>{body}</section>')
  extra = ''
  if kind == 'partly':
    marks = ['saved', 'saved', 'failed']
    why = 'Esa línea ya no forma parte de los cambios de la MR en GitLab.'
    head_badge = '<span class="badge b-warn">envío a medias</span>'
    sub = f'<span class="mono t-xs fg-3">2 de {len(dr)} guardados</span>'
    notes = ''.join(note_row(*d, mark=m) for d, m in zip(dr, marks))
    extra = callout('warn', 'warn', f'<b style="color: var(--fg); font-weight: 500">2 de {len(dr)} comentarios se guardaron como borradores en GitLab y el envío se detuvo.</b> {why}')
    acts = (f'<button type="button" class="btn btn-ghost {size}">Descartar los guardados</button>'
            f'<button type="button" class="btn btn-primary {size}">Publicar los guardados</button>')
  else:
    head_badge = '<span class="badge">borrador</span>'
    sub = f'<span class="mono t-xs fg-3">{count_words(dr)}</span>'
    notes = ''.join(note_row(*d) for d in dr)
    if kind == 'posting':
      acts = (f'<button type="button" class="btn btn-primary {size}" disabled aria-busy="true"><span class="spin-ring" aria-hidden="true"></span>Enviando</button>')
    else:
      acts = (f'<button type="button" class="btn btn-ghost {size}">{ico("trash", "ico ico-sm" if not mobile else "ico")}Descartar</button>'
              f'<button type="button" class="btn btn-primary {size}">Enviar revisión</button>')
  side = ''
  if kind == 'pending-exists':
    extra = callout('warn', 'warn', f'<b style="color: var(--fg); font-weight: 500">Tienes una revisión en {name} sin enviar.</b> Envíala o descártala allí primero.',
                    f'<span class="row" style="gap: 4px 16px"><a href="#" class="pr-remedy" target="_blank" rel="noreferrer">Abrir en {name}{ext_ico()}</a></span>')
    acts = f'<button type="button" class="btn btn-primary {size}" disabled>Enviar revisión</button>'
  if s['own']:
    extra += callout('info', 'info', OWN[host])
  elif host == 'github' and kind in ('drafts', 'pending-exists'):
    # Approve and request changes are not offered on GitHub: the link takes the person there
    side = (f'<div class="rv-open"><span class="t-xs fg-3" style="line-height: 1.45">Aprobar o pedir cambios se hace en GitHub.</span>'
            f'{host_link(host, mobile, "Abrir en GitHub")}</div>')
  head = (f'<div class="rv-draft-head">{ico("edit", "ico fg-3")}<b>Tu revisión</b>{head_badge}{sub}</div>')
  return (f'<section class="rv-draft" aria-label="Tu revisión">{head}{extra}<ul class="rv-notes">{notes}</ul>'
          f'<div class="rv-foot">{acts}</div>{side}</section>')


def mine_row(s, mobile):
  """GitLab: your own approval can be taken back."""
  size = 'btn-lg' if mobile else 'btn-sm'
  return (f'<div class="rv-row"><span class="rv-k t-label">Tu aprobación</span><span class="rv-v"><span class="badge b-ok">{ico("check", "ico ico-sm")}aprobada</span>'
          f'<span class="mono t-xs fg-3">commit {HEAD_SHA}</span></span><span class="rv-side"><button type="button" class="btn btn-ghost {size}">Revocar mi aprobación</button></span></div>')


def block(s, mobile=False):
  host = s['host']
  name, noun, num, _ = HOST[host]
  rows = decision_row(s) + people_row(s, mobile) + threads_row(s, mobile) + (mine_row(s, mobile) if s['mine'] else '')
  sub = f'{noun} {num} · abierta por @{s["author"]}' if not s['own'] else f'{noun} {num} · abierta por ti'
  head = (f'<div class="row" style="gap: 10px; flex-wrap: wrap"><span class="col" style="gap: 2px"><h2 class="t-h2">Revisión</h2>'
          f'<span class="mono t-xs fg-3">{sub}</span></span></div>')
  if mobile:
    head = f'<div class="row" style="gap: 8px; padding: 0 2px"><span class="t-label grow">Revisión</span><span class="mono t-xs fg-3">{sub}</span></div>'
  return (f'<section class="col" aria-label="Revisión" style="gap: 10px">{head}'
          f'<div class="rv-card">{rows}</div>{bar(s, mobile)}</section>')


# ---------------------------------------------------------------- the item page
def mr_panel(host, mobile=False):
  name, noun, num, _ = HOST[host]
  size = 'btn btn-lg' if mobile else 'btn btn-sm'
  return f'''<section class="callout" aria-label="{"Merge request" if host == "gitlab" else "Pull request"}" style="align-items: flex-start; flex-wrap: wrap">{ico('branch', 'ico fg-3', 'flex-shrink: 0; margin-top: 2px')}
<div class="col grow" style="gap: 6px; min-width: 0"><span class="row" style="gap: 8px; flex-wrap: wrap"><b style="color: var(--fg); font-weight: 500">La {noun} {num} espera que la fusiones en {name}</b>{ci_badge('passing')}</span>
<span>Cuando se fusione, la tarea pasará sola a Hecho.</span></div>
{"" if mobile else f'<a href="#" class="{size}" target="_blank" rel="noreferrer">{ext_ico()}Abrir {noun} {num} en {name}</a>'}</section>'''


def pr_row(host):
  name, noun, num, _ = HOST[host]
  return (f'<a href="#" class="pr-row" target="_blank" rel="noreferrer" aria-label="Abrir {noun} {num} en {name}"><span class="pr-num">{noun} {num}</span>'
          f'<span class="pr-branch">{MR_BRANCH}</span>{ci_badge("passing")}{ext_ico()}</a>')


def item_desktop(name, title, s, overlay=''):
  h = _captured(detail_desktop)
  h = _swap(h, '<span class="badge b-idle">te espera</span>', '<span class="badge b-idle">espera tu fusión</span>')
  # The description keeps two lines: the review is what this screen is about
  h = _swap(h, 'style="line-height: 1.6; max-width: 720px"', 'style="line-height: 1.6; max-width: 720px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden"')
  crit = '<section class="col" style="gap: 8px"><div class="row" style="gap: 10px"><h2 class="t-h2">Criterios'
  h = _swap(h, crit, mr_panel(s['host']) + block(s) + crit)
  diff = '<div class="row" style="gap: 8px"><a href="#" class="btn btn-sm grow">'
  h = _swap(h, diff, pr_row(s['host']) + diff)
  if overlay:
    h = _swap(h, '\n</div>\n<script>t()</script>', f'\n{overlay}\n</div>\n<script>t()</script>')
  write(name, h.replace('<title>Agentry · Tarea (desktop)', f'<title>Agentry · {title} (desktop)'))


def item_mobile(name, title, s, overlay=''):
  # The page as it looks scrolled down to the review: the header stays, the title and the description are above
  head = mtask_head().replace('<span class="badge b-idle">te espera</span>', '<span class="badge b-idle">espera tu fusión</span>')
  inner = f'{head}\n<div class="m-body stack" style="gap: 14px">{mr_panel(s["host"], True)}{block(s, True)}</div>\n{foot_mr().replace("MR !12", "MR !12" if s["host"] == "gitlab" else "PR #12")}\n{overlay}'
  write(name, mobile(title, inner))


# ---------------------------------------------------------------- the submit dialog and its Sheet
def seg_event(host, own, phone=False):
  """Comment, plus Approve on GitLab when the viewer is not the author. A segmented control, never radios of the browser."""
  opts = [('comment', 'Comentar')]
  if host == 'gitlab' and not own:
    opts.append(('approve', 'Comentar y aprobar'))
  bs = ''.join(f'<button type="button" role="radio" aria-checked="{"true" if i == 0 else "false"}"{" class=&quot;on&quot;" if i == 0 else ""}'
               f'{" style=&quot;flex: 1; justify-content: center&quot;" if phone else ""}>{t}</button>'
               for i, (_, t) in enumerate(opts)).replace('&quot;', '"')
  return f'<div class="seg" role="radiogroup" aria-label="Cómo se envía"{" style=&quot;display: flex&quot;" if phone else ""}>{bs}</div>'.replace('&quot;', '"')


def submit_body(host, mobile=False):
  name, noun, num, _ = HOST[host]
  dr = DRAFTS
  area = (f'<label class="col" style="gap: 6px"><span class="t-label">Resumen (opcional)</span><span class="field field-area"'
          f'{" style=&quot;min-height: 104px&quot;" if mobile else ""}><textarea rows="3" aria-label="Resumen de la revisión"'
          f'{" style=&quot;font-size: 16px&quot;" if mobile else ""} placeholder="Qué opinas de la {noun} en conjunto"></textarea></span></label>').replace('&quot;', '"')
  notes = (f'<div class="col" style="gap: 8px"><span class="t-label">Se envía con {count_words(dr)}</span>'
           f'<ul class="rv-notes">{"".join(note_row(*d) for d in dr)}</ul></div>')
  if host == 'gitlab':
    how = (f'{seg_event(host, False, mobile)}'
           f'<span class="t-xs fg-3" style="line-height: 1.5">Comentar publica los comentarios a la vez. Aprobar, además, aprueba el commit <span class="mono">{HEAD_SHA}</span>: si llegan commits nuevos antes, {name} lo rechaza.</span>')
  else:
    how = (f'<span class="row" style="gap: 8px; flex-wrap: wrap"><span class="badge">comentario</span>'
           f'<span class="t-xs fg-3">Se envía como una revisión de comentarios, de una vez.</span></span>'
           f'<div class="rv-open">{host_link(host, mobile, "Aprobar o pedir cambios en GitHub")}</div>')
  return f'{how}{area}{notes}'


def submit_dialog(host):
  name, noun, num, _ = HOST[host]
  dialog = f'''<div class="scrim" style="z-index: 5">
<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="rv-submit-title" style="width: 560px">
<div class="dialog-head">{ico("edit", "ico fg-3")}<div class="col grow" style="gap: 2px"><h2 id="rv-submit-title" class="t-h2">Enviar tu revisión</h2><span class="mono t-xs fg-3">{noun} {num} · {MR_BRANCH} · {HEAD_SHA}</span></div><button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Cerrar">{ico("x")}</button></div>
<div class="dialog-body">{submit_body(host)}</div>
<div class="dialog-foot"><span class="grow"></span><button type="button" class="btn btn-ghost">Cancelar</button><button type="button" class="btn btn-primary">Enviar revisión</button></div>
</div></div>'''
  return dialog


def submit_sheet(host):
  name, noun, num, _ = HOST[host]
  return f'''{scrim()}
<div class="sheet" role="dialog" aria-label="Enviar tu revisión" style="z-index: 11; padding-bottom: 28px; display: flex; flex-direction: column; gap: 12px; max-height: 92%; overflow: hidden">
<div class="grab" style="margin-bottom: 0"></div>
<div class="col" style="gap: 2px"><h2 class="t-h2">Enviar tu revisión</h2><span class="mono t-xs fg-3">{noun} {num} · {HEAD_SHA}</span></div>
{submit_body(host, True)}
<div class="row" style="gap: 8px"><button type="button" class="btn btn-lg">Cancelar</button><button type="button" class="btn btn-lg btn-primary grow" style="justify-content: center">Enviar revisión</button></div>
</div>'''


# ---------------------------------------------------------------- states
def cell(label, note, body):
  return (f'<div class="col" style="gap: 8px; min-width: 0"><span class="t-label" style="padding: 0 2px">{label}</span>'
          f'<span class="t-xs fg-3" style="padding: 0 2px; line-height: 1.45">{note}</span>{body}</div>')


def states(mobile):
  gh = lambda **kw: scene('github', **{'decision': 'required', 'approvals': 'Falta una revisión de alguien con permiso de escritura', **kw})
  return [
    ('GitHub: borrador', 'Aprobar y pedir cambios no se ofrecen en Agentry: llevan a GitHub.', block(gh(people=[('marta.ruiz', 24, 'waiting')], open_=1, done=0), mobile)),
    ('GitHub: cambios pedidos', 'Lo dice GitHub (reviewDecision); sin borrador, la barra invita a empezar uno.',
     block(gh(decision='changes', approvals='marta.ruiz pidió cambios', people=[('marta.ruiz', 24, 'changes'), ('dani.lopez', 200, 'commented')], bar='empty'), mobile)),
    ('GitHub: una PR tuya', 'Aprobar y pedir cambios en la propia PR los rechaza GitHub (own-change-request): no se ofrecen ni se enlazan.',
     block(gh(own=True, people=[], open_=0, done=2, author='yeyo'), mobile)),
    ('GitHub: revisión sin enviar', 'pending-review-exists: hay un borrador del propio GitHub; Agentry no lo borra.',
     block(gh(people=[('marta.ruiz', 24, 'waiting')], bar='pending-exists'), mobile)),
    ('GitLab: enviando', 'Un envío en curso: lo único vivo es el anillo del botón.', block(scene('gitlab', bar='posting'), mobile)),
    ('GitLab: envío a medias', 'review-partly-posted: un comentario falló tras guardar otros; la persona elige.', block(scene('gitlab', bar='partly'), mobile)),
    ('GitLab: una MR tuya', 'Aprobar no aparece; sí se puede comentar y pedir revisores.',
     block(scene('gitlab', own=True, people=[('marta.ruiz', 24, 'waiting')], author='yeyo'), mobile)),
    ('GitLab: ya la aprobaste', 'Revocar solo existe en GitLab (D9); GitHub no tiene ese concepto.',
     block(scene('gitlab', decision='pending', approvals='2 de 2 aprobaciones · faltan hilos por resolver',
                 people=[('marta.ruiz', 24, 'approved'), ('dani.lopez', 200, 'waiting')], mine=True, bar='empty'), mobile)),
  ]


def states_desktop():
  grid = ''.join(cell(*c) for c in states(False))
  head = ('<header class="col" style="gap: 6px"><span class="t-label">Revisión de una PR o una MR</span>'
          '<h1 class="t-h1">Los estados del bloque de revisión</h1>'
          '<p class="t-sm fg-2" style="margin: 0; max-width: 820px; line-height: 1.5">El bloque en GitHub y en GitLab: con borrador, con cambios pedidos, en una PR o MR propia, '
          'con una revisión sin enviar en GitHub, enviando, con el envío a medias y con tu aprobación puesta. Cada celda es una pantalla; el estado principal '
          'es <a href="DesktopTareaRevision.html" class="c-accent">la propia página de la tarea</a>.</p></header>')
  body = (f'<div class="app col" data-theme="dark" style="width: 1440px; height: 2760px; padding: 32px 40px; gap: 22px; overflow: hidden">{head}'
          f'<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 26px 28px; align-items: start">{grid}</div></div>')
  write('DesktopTareaRevisionEstados.html', page('Tarea, estados de la revisión (desktop)', body))


def states_mobile():
  grid = ''.join(cell(*c) for c in states(True))
  body = (f'<div class="app m-screen" data-theme="dark" style="height: auto; overflow: visible"><div class="m-body stack" style="gap: 22px; overflow: visible; padding-top: 16px">'
          f'<h1 class="t-h1">Estados de la revisión</h1>{grid}</div></div>')
  write('MobileTareaRevisionEstados.html', page('Tarea, estados de la revisión (móvil)', body, mobile=True))


def r_p2():
  s = scene('gitlab')
  item_desktop('DesktopTareaRevision.html', 'Tarea con revisión', s)
  item_desktop('DesktopTareaRevisionEnvio.html', 'Tarea, enviar la revisión', s, overlay=submit_dialog('gitlab'))
  item_mobile('MobileTareaRevision.html', 'Tarea con revisión', s)
  item_mobile('MobileTareaRevisionEnvio.html', 'Tarea, enviar la revisión', s, overlay=submit_sheet('gitlab'))
  states_desktop()
  states_mobile()


# ---------------------------------------------------------------- run
if __name__ == '__main__':
  r_p2()
