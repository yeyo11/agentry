# Merging a change request (plans/code-hosts.md, phase 4, P0). One function per task, each under its own banner:
# m-p1 is the merge block on the item page. m-p2 (the blocked states sheet) and m-p3 (the orchestration's merge and
# the board badge) add theirs below. Runs on its own: it imports common.py, data.py, tasks.py, checks.py and
# reviews.py (the item page it extends and the review block that sits above the merge block).
#   python3 merge.py
from data import *
from common import P, ico, desktop, mobile, write, page, av
from tasks import _captured, _swap, detail_desktop, mtask_head, MR_BRANCH
from checks import HOST as MR_HOST, foot_mr
import reviews as rev

P.setdefault('ext', EXT_PATH)

# ---------------------------------------------------------------- shared
SUBJECT = {'github': 'Plantillas de proyecto (#12)', 'gitlab': 'Plantillas de proyecto'}
BODY = '* feat(projects): plantillas integradas\n* test(projects): aplicar plantilla'
NEW_HEAD = 'c92e4b1'

# method key -> seg label, what it does. GitHub offers up to three, in the repository's order, and only the
# ones the repository allows; GitLab fixes the method per project and offers squash apart.
METHODS = [
  ('squash', 'Squash', 'Un solo commit en main, con el asunto y el cuerpo de abajo.'),
  ('merge', 'Fusión', 'Un commit de fusión con el mensaje de GitHub; los commits de la rama se conservan.'),
  ('rebase', 'Rebase', 'Los commits de la rama se aplican sobre main uno a uno, sin commit de fusión.'),
]
KINDS = {  # host-side word of the method, for the armed line
  'squash': 'squash', 'merge': 'commit de fusión', 'rebase': 'rebase',
}


def btn(label, mobile, cls='btn', icon=None, extra=''):
  size = ' btn-lg' if mobile else ' btn-sm'
  return f'<button type="button" class="{cls}{size}"{extra}>{ico(icon, "ico ico-sm" if not mobile else "ico") if icon else ""}{label}</button>'


def braille(label, mobile, cls='btn'):
  # A live wait: the spinner stands next to the verb, and the button is disabled (nothing to click yet)
  size = ' btn-lg' if mobile else ' btn-sm'
  return f'<button type="button" class="{cls}{size}" disabled aria-busy="true"><span class="spin-braille" aria-hidden="true"></span>{label}</button>'


def ring(label, mobile, cls='btn btn-primary'):
  size = ' btn-lg' if mobile else ' btn-sm'
  return f'<button type="button" class="{cls}{size}" disabled aria-busy="true"><span class="spin-ring" aria-hidden="true"></span>{label}</button>'


def check_box(label, on, mobile, note='', disabled=False):
  box = f'<span class="checkbox{" on" if on else ""}" role="checkbox" aria-checked="{"true" if on else "false"}"></span>'
  dis = ' aria-disabled="true"' if disabled else ''
  n = f'<span class="t-xs fg-3" style="display: block; margin-top: 2px; line-height: 1.45">{note}</span>' if note else ''
  return f'<label class="mg-check"{dis}>{box}<span class="col" style="gap: 0; min-width: 0"><span>{label}</span>{n}</span></label>'


def method_seg(on, mobile, allowed=('squash', 'merge', 'rebase')):
  """The method as a segmented control: one button per method the repository allows, never radios of the browser."""
  opts = [m for m in METHODS if m[0] in allowed]
  flex = ' style="flex: 1 1 0; justify-content: center"' if mobile else ''
  bs = ''.join(f'<button type="button" role="radio" aria-checked="{"true" if k == on else "false"}"'
               f'{" class=" + chr(34) + "on" + chr(34) if k == on else ""}{flex}>{lbl}</button>' for k, lbl, _ in opts)
  disp = ' style="display: flex"' if mobile else ''
  what = next(w for k, _, w in opts if k == on)
  return (f'<div class="seg" role="radiogroup" aria-label="Método de fusión"{disp}>{bs}</div>'
          f'<span class="t-xs fg-3" style="line-height: 1.45">{what}</span>')


def fields(host, mobile):
  """The squash commit: subject and body, prefilled the way the host would."""
  big = ' field-lg' if mobile else ''
  fs = ' style="font-size: 16px"' if mobile else ''
  area = ' style="min-height: 96px"' if mobile else ''
  return (f'<label class="col" style="gap: 6px"><span class="t-label">Asunto</span><span class="field field-mono{big}">'
          f'<input value="{SUBJECT[host]}" aria-label="Asunto del commit"{fs}></span></label>'
          f'<label class="col" style="gap: 6px"><span class="t-label">Cuerpo (opcional)</span><span class="field field-area field-mono"{area}>'
          f'<textarea rows="3" aria-label="Cuerpo del commit"{fs}>{BODY}</textarea></span></label>')


def row(key, value, side='', mobile=False):
  s = f'<span class="rv-side">{side}</span>' if side else ''
  return f'<div class="rv-row"><span class="rv-k t-label">{key}</span><span class="rv-v">{value}</span>{s}</div>'


def stacked(key, inner, mobile=False):
  return f'<div class="rv-row"><span class="rv-k t-label">{key}</span><span class="rv-v"><span class="mg-fields">{inner}</span></span></div>'


def sub(host):
  name, noun, num, _ = MR_HOST[host]
  return f'{noun} {num} · {MR_BRANCH} · {rev.HEAD_SHA}'


def head(host, badge):
  name, noun, num, _ = MR_HOST[host]
  return (f'<div class="row" style="gap: 10px; flex-wrap: wrap"><span class="col" style="gap: 2px"><h2 class="t-h2">Fusión</h2>'
          f'<span class="mono t-xs fg-3">{sub(host)}</span></span><span class="grow"></span>{badge}</div>')


def mhead(host, badge):
  return (f'<div class="row" style="gap: 8px; padding: 0 2px; flex-wrap: wrap"><span class="t-label">Fusión</span>'
          f'<span class="mono t-xs fg-3 grow">{sub(host)}</span>{badge}</div>')


def wrap(host, badge, rows, foot, mobile):
  h = mhead(host, badge) if mobile else head(host, badge)
  return f'<section class="mg" aria-label="Fusión">{h}<div class="rv-card">{rows}{foot}</div></section>'


BADGE = {
  'ready': f'<span class="badge b-ok">{ico("check", "ico ico-sm")}lista para fusionar</span>',
  'warn': '<span class="badge b-warn">se puede, con aviso</span>',
  'armed': '<span class="badge b-idle">fusión automática activada</span>',
  'waiting': '<span class="badge b-live">esperando a la pipeline</span>',
  'running': '<span class="badge b-live">pipeline en marcha</span>',
  'checks': '<span class="badge">CI pendiente</span>',
  'moved': '<span class="badge b-warn">la rama cambió</span>',
  'merging': '<span class="badge b-live">fusionando</span>',
  'merged': f'<span class="badge b-ok">{ico("check", "ico ico-sm")}fusionada</span>',
}


def foot(note, acts, mobile):
  return f'<div class="mg-foot"><span class="note">{note}</span><span class="mg-acts">{acts}</span></div>'


def branch_row(host, mobile, delete=True, forced=False):
  name = MR_HOST[host][0]
  if forced:
    box = check_box(f'Borrar la rama <span class="mono">task/agn-26</span> en {name}', True, mobile,
                    f'El proyecto la borra al fusionar, con su propio ajuste en {name}.', disabled=True)
  else:
    box = check_box(f'Borrar la rama <span class="mono">task/agn-26</span> en {name} al fusionar', delete, mobile,
                    'La rama local se queda: los cambios de la tarea la leen.')
  return stacked('Rama', box, mobile)


def merge_lead(mobile, lead):
  # With a draft review the Submit action is the page's gradient: the merge button stays a plain one.
  return btn('Fusionar', mobile, 'btn btn-primary' if lead else 'btn', 'branch')


def block_ready(host='github', mobile=False, lead=True, method='squash', warning=False, squash_forced=False):
  """A change request that can merge now: the method, the commit for a squash, the branch box and the one action."""
  name, noun, num, _ = MR_HOST[host]
  rows = ''
  if host == 'github':
    rows += stacked('Método', method_seg(method, mobile), mobile)
  else:
    rows += row('Método', '<span class="badge">commit de fusión</span><span class="t-xs fg-3">Lo fija GitLab para este proyecto</span>')
    rows += row('Squash', check_box('Aplastar los commits en uno', method == 'squash', mobile,
                                   'El proyecto lo exige.' if squash_forced else 'Lo propone el proyecto; puedes cambiarlo.', squash_forced), '')
  if method == 'squash':
    rows += stacked('Mensaje', fields(host, mobile), mobile)
  rows += branch_row(host, mobile)
  if warning:
    rows += row('Aviso', f'<span class="badge b-warn">{ico("warn", "ico ico-sm")}no obligatoria</span><span class="t-xs fg-2">lint-docs falló; {name} no la exige para fusionar.</span>')
  note = 'Al fusionar, la tarea pasa sola a Hecho.'
  return wrap(host, BADGE['warn' if warning else 'ready'], rows, foot(note, merge_lead(mobile, lead), mobile), mobile)


def block_offer(host, mobile=False, lead=True):
  """Required checks are still running: Fusionar is not offered, arming is."""
  name, noun, num, _ = MR_HOST[host]
  rows = row('Método', '<span class="badge">squash</span><span class="t-xs fg-3">Es el método por defecto del repositorio</span>')
  rows += row('Comprobaciones', f'{ci_badge("pending")}<span class="t-xs fg-2">2 obligatorias sin terminar</span>', '')
  note = f'{name} fusionará la {noun} cuando terminen. Sin Agentry abierto también.'
  return wrap(host, BADGE['checks'], rows, foot(note, btn('Activar fusión automática', mobile, 'btn btn-primary' if lead else 'btn', 'play'), mobile), mobile)


def armed_rows(host, who, when, method, waits, mobile, side_off=True):
  off = btn('Desactivar', mobile)
  rows = row('Fusión automática', f'<span class="badge b-idle">activada</span><span class="mono t-xs fg-2">@{who} · {when} · {KINDS[method]}</span>', off, mobile)
  rows += row('Espera a', waits)
  return rows


def block_armed(host, mobile=False):
  name, noun, num, _ = MR_HOST[host]
  if host == 'github':
    waits = f'{ci_badge("pending")}<span class="t-xs fg-2">2 comprobaciones obligatorias</span>'
  else:
    waits = '<span class="badge b-live">en marcha</span><span class="mono t-xs fg-2">pipeline 4821 · commit ' + rev.HEAD_SHA + '</span>'
  rows = armed_rows(host, 'yeyo', 'hace 4 min', 'squash', waits, mobile)
  rows += row('Mensaje', f'<span class="mono t-xs fg-2" style="overflow-wrap: anywhere">{SUBJECT[host]}</span>')
  rows += row('Rama', '<span class="t-xs fg-2">Se borra al fusionar</span>')
  note = 'Si Agentry sube cambios a la rama, la desactiva antes y te avisa para que la actives otra vez.'
  return wrap(host, BADGE['armed'], rows, foot(note, '', mobile), mobile)


def block_waiting(mobile=False, attached=False, lead=True):
  """GitLab: merging before the head's pipeline exists merged before it attached (recorded), so the wait is shown and
  Fusionar stays off until the pipeline for this commit has finished."""
  host = 'gitlab'
  if attached:
    verb = (f'<span class="mg-live"><span class="spin-braille" aria-hidden="true"></span><span class="col" style="gap: 2px">'
            f'<span>Pipeline 4821 en marcha</span><span class="mono t-xs fg-3">commit {rev.HEAD_SHA} · lleva 1:12</span></span></span>')
    badge = BADGE['running']
    acts = btn('Fusionar al terminar la pipeline', mobile, 'btn btn-primary' if lead else 'btn', 'play') + btn('Fusionar', mobile, extra=' disabled')
    note = 'Fusionar se activa cuando la pipeline de este commit termine.'
  else:
    verb = (f'<span class="mg-live"><span class="spin-braille" aria-hidden="true"></span><span class="col" style="gap: 2px">'
            f'<span>Esperando a la pipeline</span><span class="mono t-xs fg-3">commit {rev.HEAD_SHA} · GitLab aún no la ha asociado · se comprueba cada 10 s</span></span></span>')
    badge = BADGE['waiting']
    acts = btn('Fusionar al terminar la pipeline', mobile, extra=' disabled') + braille('Esperando a la pipeline', mobile)
    note = 'Fusionar ahora podría saltarse la pipeline del commit que acabas de subir.'
  rows = row('Método', '<span class="badge">commit de fusión</span><span class="t-xs fg-3">Lo fija GitLab para este proyecto</span>')
  rows += row('Pipeline', verb)
  return wrap(host, badge, rows, foot(note, acts, mobile), mobile)


def block_moved(host='github', mobile=False):
  name, noun, num, _ = MR_HOST[host]
  rows = row('Commit', f'<span class="mono t-xs fg-2">{rev.HEAD_SHA}</span><span class="t-xs fg-3">el que viste</span>')
  rows += row('Ahora', f'<span class="mono t-xs fg-2">{NEW_HEAD}</span><span class="t-xs fg-3">1 commit nuevo de @marta.ruiz</span>',
              btn('Ver los cambios', mobile, 'btn btn-ghost'))
  callout = (f'<div class="rv-row"><span class="callout callout-warn" role="note" style="align-items: flex-start; grid-column: 1 / -1">'
             f'{ico("warn", "ico", "flex-shrink: 0; color: var(--warn); margin-top: 1px")}<span><b style="color: var(--fg); font-weight: 500">La rama cambió mientras mirabas, y no se fusionó nada.</b> '
             f'Lee los cambios nuevos y vuelve a fusionar: Agentry nunca fusiona un commit que no hayas visto.</span></span></div>')
  acts = btn('Fusionar', mobile, extra=' disabled') + btn('Volver a leer', mobile, 'btn btn-primary', 'retry')
  return wrap(host, BADGE['moved'], callout + rows, foot('', acts, mobile), mobile)


def block_merging(host='github', mobile=False):
  name, noun, num, _ = MR_HOST[host]
  rows = row('Método', '<span class="badge">squash</span>')
  rows += row('Mensaje', f'<span class="mono t-xs fg-2" style="overflow-wrap: anywhere">{SUBJECT[host]}</span>')
  rows += row('Rama', '<span class="t-xs fg-2">Se borra al fusionar</span>')
  return wrap(host, BADGE['merging'], rows, foot(f'Enviando la fusión a {name}…', ring('Fusionando', mobile), mobile), mobile)


def block_merged(host='github', mobile=False):
  name, noun, num, _ = MR_HOST[host]
  rows = row('Fusionada', f'<span class="mono t-xs fg-2">@yeyo · hace un momento · squash</span>', '')
  rows += row('Commit', f'<span class="mono t-xs fg-2">e41b7d2 en main</span>')
  rows += row('Rama', '<span class="t-xs fg-2">Borrada en GitHub; la local se queda</span>')
  return wrap(host, BADGE['merged'], rows, foot('La tarea pasó a Hecho.', btn('Ver la tarea', mobile, 'btn btn-ghost'), mobile), mobile)


# ---------------------------------------------------------------- the item page
def scene(draft):
  """The review block above the merge block: approved and clean, with or without the person's draft notes."""
  return rev.scene('github', decision='approved', approvals='aprobada por marta.ruiz', people=[('marta.ruiz', 24, 'approved')],
                   open_=0, done=2, drafts=rev.DRAFTS[:2], bar='drafts' if draft else 'empty')


def item_desktop(name, title, draft, height=1240):
  s = scene(draft)
  h = _captured(detail_desktop)
  h = _swap(h, '<span class="badge b-idle">te espera</span>', '<span class="badge b-idle">espera tu fusión</span>')
  h = _swap(h, 'style="line-height: 1.6; max-width: 720px"', 'style="line-height: 1.6; max-width: 720px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden"')
  crit = '<section class="col" style="gap: 8px"><div class="row" style="gap: 10px"><h2 class="t-h2">Criterios'
  h = _swap(h, crit, rev.block(s) + block_ready('github', lead=not draft) + crit)
  diff = '<div class="row" style="gap: 8px"><a href="#" class="btn btn-sm grow">'
  h = _swap(h, diff, rev.pr_row('github') + diff)
  h = _swap(h, 'height: 1024px', f'height: {height}px')
  write(name, h.replace('<title>Agentry · Tarea (desktop)', f'<title>Agentry · {title} (desktop)'))


def item_mobile(name, title, draft, shift=0, method='squash'):
  # The page as it looks scrolled down to the merge block; with a draft, its Submit bar is the last thing above it
  s = scene(draft)
  head_ = mtask_head().replace('<span class="badge b-idle">te espera</span>', '<span class="badge b-idle">espera tu fusión</span>')
  s['drafts'] = s['drafts'][:1]
  body = (rev.bar(s, True) if draft else '') + block_ready('github', True, lead=not draft, method=method)
  # Scrolled down: what does not fit is the part above (the shift), never the merge button
  inner = (f'{head_}\n<div class="m-body stack" style="gap: 14px"><div class="col" style="gap: 14px; margin-top: -{shift}px">{body}</div></div>\n'
           f'{foot_mr().replace("MR !12", "PR #12")}')
  write(name, mobile(title, inner))


# ---------------------------------------------------------------- the states sheet
def states(mobile):
  return [
    ('GitHub: con aviso', 'UNSTABLE: una comprobación que el repositorio no exige falló. Se puede fusionar; el aviso lo dice con su palabra.',
     block_ready('github', mobile, warning=True)),
    ('GitHub: ofrece la fusión automática', 'BLOCKED por comprobaciones obligatorias pendientes y allow_auto_merge activo: Fusionar no se ofrece y activar es lo primero.',
     block_offer('github', mobile)),
    ('GitHub: fusión automática activada', 'Quién, cuándo y con qué método; Desactivar. Agentry la desactiva antes de subir a la rama y lo avisa.',
     block_armed('github', mobile)),
    ('GitLab: esperando a la pipeline', 'waiting-for-pipeline: el commit nuevo aún no tiene pipeline. Lo único vivo es el spinner junto al verbo; Fusionar sigue apagado.',
     block_waiting(mobile)),
    ('GitLab: pipeline en marcha', 'La pipeline del commit existe y no ha terminado: se puede activar la fusión automática, no fusionar ahora.',
     block_waiting(mobile, attached=True)),
    ('GitLab: fusión automática activada', 'merge_when_pipeline_succeeds: lo mismo que en GitHub, con la pipeline como lo que se espera.',
     block_armed('gitlab', mobile)),
    ('GitLab: squash obligatorio', 'squash_option always: la casilla va marcada y apagada, y el método lo fija el proyecto.',
     block_ready('gitlab', mobile, squash_forced=True)),
    ('La rama cambió', 'head-moved: el commit que viste ya no es el de la rama. No se fusiona nada hasta volver a leer.',
     block_moved('github', mobile)),
    ('Fusionando', 'La petición está en vuelo: el anillo del botón es lo único vivo.', block_merging('github', mobile)),
    ('Fusionada', 'El bloque se queda como registro; la tarea ya está en Hecho.', block_merged('github', mobile)),
  ]


def states_desktop():
  grid = ''.join(rev.cell(*c) for c in states(False))
  head_ = ('<header class="col" style="gap: 6px"><span class="t-label">Fusión de una PR o una MR</span>'
           '<h1 class="t-h1">Los estados del bloque de fusión</h1>'
           '<p class="t-sm fg-2" style="margin: 0; max-width: 820px; line-height: 1.5">El bloque en GitHub y en GitLab: lista con aviso, con la fusión automática ofrecida y activada, '
           'esperando a la pipeline, con la rama cambiada, fusionando y fusionada. Cada celda es una pantalla; el estado principal es '
           '<a href="DesktopTareaFusion.html" class="c-accent">la propia página de la tarea</a>, y los motivos por los que no se puede fusionar están en '
           '<a href="DSFusion.html" class="c-accent">DSFusion</a>.</p></header>')
  body = (f'<div class="app col" data-theme="dark" style="width: 1440px; height: 2420px; padding: 32px 40px; gap: 22px; overflow: hidden">{head_}'
          f'<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 26px 28px; align-items: start">{grid}</div></div>')
  write('DesktopTareaFusionEstados.html', page('Tarea, estados de la fusión (desktop)', body))


def states_mobile():
  grid = ''.join(rev.cell(*c) for c in states(True))
  body = (f'<div class="app m-screen" data-theme="dark" style="height: auto; overflow: visible"><div class="m-body stack" style="gap: 22px; overflow: visible; padding-top: 16px">'
          f'<h1 class="t-h1">Estados de la fusión</h1>{grid}</div></div>')
  write('MobileTareaFusionEstados.html', page('Tarea, estados de la fusión (móvil)', body, mobile=True))


def m_p1():
  item_desktop('DesktopTareaFusion.html', 'Tarea con fusión', draft=False)
  item_desktop('DesktopTareaFusionBorrador.html', 'Tarea con fusión y borrador', draft=True, height=1360)
  item_mobile('MobileTareaFusion.html', 'Tarea con fusión', draft=False)
  item_mobile('MobileTareaFusionBorrador.html', 'Tarea con fusión y borrador', draft=True, shift=85, method='merge')
  states_desktop()
  states_mobile()


# ================================================================ m-p2 · the blocked states sheet
# tone -> notice class, badge class, mark icon (None: the ring spinner). A status colour always has its word.
#   bad: failed or in conflict · warn: a rule or a missing piece stops it · idle: waits for the person ·
#   live: the host is working on it now · '': a state, not a fault
TONE = {
  'bad': ('bad', 'b-bad', 'x'),
  'warn': ('warn', 'b-warn', 'warn'),
  'idle': ('idle', 'b-idle', 'wait'),
  'live': ('live', 'b-live', None),
  '': ('', '', 'block'),
}
HOSTS = {'github': ('GitHub', 'PR', '#12'), 'gitlab': ('GitLab', 'MR', '!12')}
HEAD = 'task/agn-26'
BASE = 'main'


def tone_mark(tone, small=False):
  cls, _, icon = TONE[tone]
  if icon is None:
    return '<span class="spin-ring" aria-hidden="true"></span>'
  return ico(icon, 'ico ico-sm' if small else 'ico')


def tone_badge(tone, word):
  # the notice's own icon sits beside it, so the badge carries the word alone
  return f'<span class="badge {TONE[tone][1]}">{word}</span>'.replace('badge "', 'badge"')


def acts(items, mobile=False):
  """The remedy: a neutral button that does it in Agentry, or a link to the host's own page. Never a command."""
  out = ''
  for label, kind in items:
    if kind == 'ext':
      out += f'<a href="#" class="btn {"btn-lg" if mobile else "btn-sm"}" target="_blank" rel="noreferrer">{ext_ico()}{label}</a>'
    else:
      out += f'<button type="button" class="btn {"btn-lg" if mobile else "btn-sm"}">{label}</button>'
  return f'<div class="mb-acts">{out}</div>' if out else ''


def note(tone, word, code, text, detail, actions=(), mobile=False):
  cls = TONE[tone][0]
  body = (f'<div class="mb-body"><div class="mb-head">{tone_badge(tone, word)}<span class="mb-code">{code}</span></div>'
          f'<span class="mb-text">{text}</span><span class="mb-detail">{detail}</span>{acts(actions, mobile)}</div>')
  return f'<div class="mb-note {cls}" role="status" data-reason="{code}">{tone_mark(tone)}{body}</div>'


# code, tone, word, then per host: (the text, the host's own field and value, the remedy) or None when the host
# has no such state. The text is the table's, with {noun} and the names filled in as the host calls them.
# Every row of "What blocks a merge", in the order Agentry reads them: the first that applies is shown.
ROWS = [
  ('not-open', '', 'cerrada',
   ('Esta PR está cerrada.', 'state: CLOSED · MERGED', []),
   ('Esta MR está cerrada.', 'state: closed · merged · locked', [])),
  ('computing', 'live', 'calculando',
   ('GitHub aún está calculando si se puede fusionar.', 'mergeStateStatus: UNKNOWN · se resuelve en 2–5 s', [('Actualizar', 'btn')]),
   ('GitLab aún está calculando si se puede fusionar.', 'mergeabilityChecks: CHECKING · detailed_merge_status: checking', [('Actualizar', 'btn')])),
  ('draft', 'idle', 'borrador',
   ('Esta PR es un borrador.', 'isDraft: true', [('Marcar como lista', 'btn')]),
   ('Esta MR es un borrador.', 'detailed_merge_status: draft_status', [('Marcar como lista', 'btn')])),
  ('conflicts', 'bad', 'en conflicto',
   (f'{HEAD} tiene conflictos con {BASE}.', 'mergeStateStatus: DIRTY', [(f'Actualizar desde {BASE}', 'btn')]),
   (f'{HEAD} tiene conflictos con {BASE}.', 'detailed_merge_status: conflict', [(f'Actualizar desde {BASE}', 'btn')])),
  ('nothing-to-merge', 'warn', 'sin cambios',
   None,
   (f'{HEAD} no tiene nada que {BASE} no tenga.', 'detailed_merge_status: commits_status', [('Cerrar', 'btn')])),
  ('behind', 'warn', 'desactualizada',
   (f'{BASE} exige que {HEAD} esté al día.', 'mergeStateStatus: BEHIND', [(f'Actualizar desde {BASE}', 'btn')]),
   (f'{BASE} exige que {HEAD} esté al día.', 'detailed_merge_status: need_rebase', [(f'Actualizar desde {BASE}', 'btn')])),
  ('checks-running', 'live', 'en marcha',
   ('Las comprobaciones obligatorias no han terminado.', 'mergeStateStatus: BLOCKED · una comprobación obligatoria pendiente', [('Fusión automática', 'btn')]),
   ('Las comprobaciones obligatorias no han terminado.', 'detailed_merge_status: ci_still_running', [('Fusión automática', 'btn')])),
  ('checks-failing', 'bad', 'fallida',
   ('La comprobación obligatoria unit ha fallado.', 'mergeStateStatus: BLOCKED · una comprobación obligatoria fallida',
    [('Arreglar las comprobaciones fallidas', 'btn'), ('Repetir', 'btn')]),
   ('La comprobación obligatoria unit-tests ha fallado.', 'detailed_merge_status: ci_must_pass · head_pipeline: failed',
    [('Arreglar las comprobaciones fallidas', 'btn'), ('Repetir', 'btn')])),
  ('checks-missing', 'warn', 'sin informar',
   ('La comprobación obligatoria unit no ha informado del último commit.', 'mergeStateStatus: BLOCKED · un contexto obligatorio sin resultado',
    [('Repetir toda la ejecución', 'btn')]),
   None),
  ('external-checks', 'warn', 'bloqueada',
   None,
   ('Las comprobaciones externas tienen que pasar primero.', 'detailed_merge_status: status_checks_must_pass', [('Abrir en GitLab', 'ext')])),
  ('review-required', 'warn', 'sin aprobar',
   ('Hace falta la aprobación de alguien con acceso de escritura.', 'reviewDecision: REVIEW_REQUIRED · mergeStateStatus: BLOCKED', [('Pedir revisores', 'btn')]),
   ('Hace falta la aprobación de alguien con acceso de escritura.', 'detailed_merge_status: not_approved', [('Pedir revisores', 'btn')])),
  ('changes-requested', 'warn', 'cambios pedidos',
   ('Un revisor ha pedido cambios.', 'reviewDecision: CHANGES_REQUESTED', [('Atender con un agente', 'btn')]),
   ('Un revisor ha pedido cambios.', 'detailed_merge_status: requested_changes', [('Atender con un agente', 'btn')])),
  ('threads-unresolved', 'warn', 'sin resolver',
   ('Hay que resolver todas las conversaciones antes.', 'required_review_thread_resolution · hilos sin resolver', [('Ver hilos sin resolver', 'btn')]),
   ('Hay que resolver todas las conversaciones antes.', 'detailed_merge_status: discussions_not_resolved', [('Ver hilos sin resolver', 'btn')])),
  ('tracker-key-missing', 'warn', 'sin clave',
   None,
   ('GitLab exige una clave de Jira en el título o en la descripción.', 'detailed_merge_status: jira_association_missing', [('Editar el título', 'btn')])),
  ('title-rejected', 'warn', 'título rechazado',
   None,
   ('El título no cumple el patrón que exige este proyecto.', 'detailed_merge_status: title_regex', [('Editar el título', 'btn')])),
  ('blocked-by-dependency', 'warn', 'depende de otra',
   None,
   ('Otra merge request tiene que fusionarse antes.', 'detailed_merge_status: merge_request_blocked', [('Abrir en GitLab', 'ext')])),
  ('not-yet', 'warn', 'programada',
   None,
   ('Esta merge request no puede fusionarse antes de su hora programada.', 'detailed_merge_status: merge_time', [])),
  ('locked-files', 'warn', 'archivos bloqueados',
   None,
   ('Otra persona tiene bloqueados archivos de esta merge request.', 'detailed_merge_status: locked_paths · locked_lfs_files', [('Abrir en GitLab', 'ext')])),
  ('merge-queue', 'warn', 'por cola',
   ('Esta rama se fusiona mediante una cola; añádela allí.', 'regla merge_queue', [('Abrir en GitHub', 'ext')]),
   ('Esta rama se fusiona mediante una cola; añádela allí.', 'merge_trains_enabled', [('Abrir en GitLab', 'ext')])),
  ('blocked-by-policy', 'warn', 'bloqueada',
   (f'Las reglas de GitHub para {BASE} aún no permiten esta fusión.', 'mergeStateStatus: BLOCKED · nada de lo anterior', [('Abrir en GitHub', 'ext')]),
   (f'Las reglas de GitLab para {BASE} aún no permiten esta fusión.', 'security_policy_violations · cualquier valor que no esté en esta tabla', [('Abrir en GitLab', 'ext')])),
]
# Not blockers: Merge is offered. The first carries a warning, the second nothing.
OK_ROWS = [
  ('ok · con aviso', 'warn', 'aviso',
   ('Algunas comprobaciones que no son obligatorias han fallado.', 'mergeStateStatus: UNSTABLE · HAS_HOOKS', [('Fusionar', 'primary')]),
   None),
  ('ok', 'ok', 'lista',
   ('Nada bloquea la fusión.', 'mergeStateStatus: CLEAN', [('Fusionar', 'primary')]),
   ('Nada bloquea la fusión.', 'detailed_merge_status: mergeable', [('Fusionar', 'primary')])),
]
TONE['ok'] = ('ok', 'b-ok', 'check')


def host_cell(host, tone, word, code, spec, merge_primary=False):
  if spec is None:
    name = HOSTS[host][0]
    return f'<div class="t-xs fg-3" style="padding: 12px 2px; line-height: 1.5">{name} no tiene este estado.</div>'
  text, detail, actions = spec
  btns = [(l, 'btn' if k == 'primary' else k) for l, k in actions]
  n = note(tone, word, code, text, detail, btns)
  return n.replace('<button type="button" class="btn btn-sm">Fusionar</button>',
                   '<button type="button" class="btn btn-sm btn-primary">Fusionar</button>') if merge_primary else n


GRID = 'display: grid; grid-template-columns: 150px minmax(0, 1fr) minmax(0, 1fr); gap: 20px; align-items: start'


def table_row(i, row, merge_primary=False):
  code, tone, word, gh, gl = row
  head = (f'<div class="col" style="gap: 6px; padding-top: 4px"><span class="mono t-xs fg-3">{i}</span>'
          f'<span class="mono t-sm" style="font-weight: 500; overflow-wrap: anywhere">{code}</span></div>')
  return (f'<div style="{GRID}; padding: 14px 0; border-top: 1px solid var(--line)">{head}'
          f'{host_cell("github", tone, word, code, gh, merge_primary)}{host_cell("gitlab", tone, word, code, gl, merge_primary)}</div>')


def table_section():
  cols = (f'<div style="{GRID}; padding-bottom: 8px"><span class="t-label">Orden</span>'
          f'<span class="row t-label" style="gap: 6px">GitHub<span class="fg-3">·</span>PR #12</span>'
          f'<span class="row t-label" style="gap: 6px">GitLab<span class="fg-3">·</span>MR !12</span></div>')
  rows = ''.join(table_row(f'{i + 1:02d}', r) for i, r in enumerate(ROWS))
  ok = ''.join(table_row('—', r, merge_primary=r[0] == 'ok') for r in OK_ROWS)
  return (f'<section class="col" style="gap: 0"><span class="t-label" style="padding-bottom: 6px">Qué bloquea una fusión · la tabla entera</span>'
          f'<p class="t-sm fg-2" style="margin: 0 0 14px; max-width: 900px; line-height: 1.5">Se lee en este orden y se muestra el primero que aplica; los demás quedan debajo, en una línea. '
          f'Debajo de cada frase va el campo del host que la causa, en mono. Los dos últimos no bloquean: ofrecen «Fusionar».</p>'
          f'{cols}{rows}{ok}</section>')


# ---------------------------------------------------------------- the corrections of m0
def merge_btn(disabled, mobile=False, label='Fusionar'):
  return f'<button type="button" class="btn {"btn-lg" if mobile else "btn-sm"}"{" disabled" if disabled else ""}>{label}</button>'


def case(title, text, inner):
  return (f'<div class="col" style="gap: 10px"><span class="t-sm" style="font-weight: 600">{title}</span>'
          f'<span class="t-xs fg-3" style="line-height: 1.5; min-height: 54px">{text}</span>{inner}</div>')


def correction_section():
  unchecked = (f'<div class="card col" style="padding: 14px; gap: 10px"><div class="row" style="gap: 10px"><span class="t-label grow">Fusionar</span>'
               f'<span class="mono t-xs fg-3">MR !12</span></div>'
               f'<div class="callout" style="align-items: flex-start">{ico("info", "ico", "flex-shrink: 0; color: var(--fg-3); margin-top: 1px")}'
               f'<span class="col" style="gap: 4px; min-width: 0"><span>GitLab aún no ha comprobado la fusión: lo hará al fusionar.</span>'
               f'<span class="mb-detail">detailed_merge_status: unchecked · has_conflicts: false</span></span></div>'
               f'<div class="row" style="gap: 8px">{merge_btn(False)}</div></div>')
  checking = (f'<div class="card col" style="padding: 14px; gap: 10px"><div class="row" style="gap: 10px"><span class="t-label grow">Fusionar</span>'
              f'<span class="mono t-xs fg-3">MR !12</span></div>'
              + note('live', 'calculando', 'computing', 'GitLab aún está calculando si se puede fusionar.', 'mergeabilityChecks: CHECKING', [('Actualizar', 'btn')])
              + f'<div class="row" style="gap: 8px">{merge_btn(True)}</div></div>')
  failed = (f'<div class="card col" style="padding: 14px; gap: 10px"><div class="row" style="gap: 10px"><span class="t-label grow">Fusionar</span>'
            f'<span class="mono t-xs fg-3">MR !12</span></div>'
            + note('bad', 'en conflicto', 'conflicts', f'{HEAD} tiene conflictos con {BASE}.', 'detailed_merge_status: unchecked · mergeabilityChecks: CONFLICT FAILED', [(f'Actualizar desde {BASE}', 'btn')])
            + f'<div class="row" style="gap: 8px">{merge_btn(True)}</div></div>')
  nopipe = note('warn', 'sin pipeline', 'checks-missing', 'Este proyecto exige que pase un pipeline y el último commit no tiene ninguno.',
                'only_allow_merge_if_pipeline_succeeds · detailed_merge_status: ci_must_pass · head_pipeline: null', [('Abrir en GitLab', 'ext')])
  nopipe = (f'<div class="card col" style="padding: 14px; gap: 10px"><div class="row" style="gap: 10px"><span class="t-label grow">Fusionar</span>'
            f'<span class="mono t-xs fg-3">MR !12</span></div>{nopipe}<div class="row" style="gap: 8px">{merge_btn(True)}</div></div>')
  moved = note('warn', 'rama movida', 'head-moved', 'Han llegado commits nuevos a la rama desde que mirabas. Revísalos y fusiona.',
               'viste a1b2c3d · ahora e4f5a6b', [('Actualizar', 'btn')])
  moved = (f'<div class="card col" style="padding: 14px; gap: 10px"><div class="row" style="gap: 10px"><span class="t-label grow">Fusionar</span>'
           f'<span class="mono t-xs fg-3">PR #12</span></div>{moved}<div class="row" style="gap: 8px">{merge_btn(True)}</div></div>')
  ff = note('warn', 'desactualizada', 'behind', f'{BASE} exige que {HEAD} esté al día.',
            'merge_method: ff · detailed_merge_status: need_rebase · también lo dice un conflicto', [('Rebasar en GitLab', 'btn')])
  ff = (f'<div class="card col" style="padding: 14px; gap: 10px"><div class="row" style="gap: 10px"><span class="t-label grow">Fusionar</span>'
        f'<span class="mono t-xs fg-3">MR !12</span></div>{ff}'
        f'<span class="t-xs fg-3" style="line-height: 1.45">Solo con el worktree limpio; después se trae el resultado y no queda nada por subir.</span>'
        f'<div class="row" style="gap: 8px">{merge_btn(True)}</div></div>')
  cols = lambda *cs: f'<div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; align-items: start">{"".join(cs)}</div>'
  return (f'<section class="col" style="gap: 14px"><span class="t-label">Lo que corrigen las grabaciones de m0</span>'
          f'<p class="t-sm fg-2" style="margin: 0; max-width: 900px; line-height: 1.5">GitLab tarda minutos en pasar de <span class="mono">unchecked</span> a un valor firme, '
          f'así que «calculando» no puede ser su estado de reposo. Se lee <span class="mono">mergeabilityChecks</span>: solo un <span class="mono">CHECKING</span> real es «calculando», '
          f'y un <span class="mono">FAILED</span> se traduce con la misma tabla.</p>'
          + cols(case('1 · unchecked no desactiva Fusionar', 'GitLab vuelve a comprobar al fusionar y, si hay un conflicto, lo dice entonces. Un aviso quieto, sin color de estado ni movimiento.', unchecked),
                 case('2 · Solo un CHECKING real es «calculando»', 'Es el único caso con anillo y con Fusionar desactivado. Sale solo cuando la lectura cambia.', checking),
                 case('3 · unchecked con un FAILED es el bloqueo de siempre', 'La misma tabla: aquí es un conflicto, que GitLab ya sabía aunque has_conflicts dijera false.', failed))
          + cols(case('4 · ci_must_pass sin pipeline', 'Si el proyecto exige pipeline, no tener ninguno no es «sin CI»: Fusionar sigue desactivado y no hay nada que repetir.', nopipe),
                 case('5 · head-moved', 'Han llegado commits después de que miraras. Fusionar se desactiva hasta que Actualizar muestre la rama nueva; nunca se fusiona código que no has visto.', moved),
                 case('6 · need_rebase en un proyecto ff', 'Un conflicto también se lee como need_rebase. Rebasar en GitLab es la acción de ese proyecto.', ff))
          + '</section>')


# ---------------------------------------------------------------- the block with a blocker, on a phone
def others_list(items):
  lis = ''.join(f'<li class="{t}">{tone_mark(t, True)}<span class="mono t-xs">{c}</span><span class="grow">{x}</span></li>' for c, t, x in items)
  return f'<ul class="mb-others" aria-label="Otros bloqueos">{lis}</ul>'


def block_card(host, mobile=False):
  name, noun, num = HOSTS[host]
  first = ROWS[3]
  spec = first[3] if host == 'github' else first[4]
  text, detail, actions = spec
  n = note('bad', 'en conflicto', 'conflicts', text, detail, actions, mobile)
  others = others_list([('checks-failing', 'bad', 'La comprobación obligatoria ' + ('unit' if host == 'github' else 'unit-tests') + ' ha fallado.'),
                        ('review-required', 'warn', 'Hace falta una aprobación.')])
  pad = '14px' if mobile else '14px 16px'
  btn = f'<button type="button" class="btn btn-lg grow" style="justify-content: center" disabled>Fusionar</button>' if mobile else merge_btn(True)
  return (f'<section class="card col" style="padding: {pad}; gap: 12px" aria-label="Fusionar"><div class="row" style="gap: 10px"><h2 class="t-h2 grow">Fusionar</h2>'
          f'<span class="mono t-xs fg-3">{noun} {num} · {name}</span></div>{n}{others}<div class="row" style="gap: 8px">{btn}</div></section>')


def phone_frame(inner):
  return (f'<div class="app m-screen" data-theme="dark" style="width: 390px; height: auto; border-radius: var(--r-xl); border: 1px solid var(--line-2); overflow: hidden; padding: 14px">'
          f'<div class="col" style="gap: 12px">{inner}</div></div>')


def block_section():
  desktop_ = (f'<div class="col" style="gap: 8px"><span class="t-sm" style="font-weight: 600">Escritorio: el primero, y los demás debajo</span>'
              f'{block_card("github")}</div>')
  phone = (f'<div class="col" style="gap: 8px"><span class="t-sm" style="font-weight: 600">Móvil: la misma tarjeta, con botones de 44 px</span>{phone_frame(block_card("gitlab", True))}</div>')
  return (f'<section class="col" style="gap: 14px"><span class="t-label">El bloque de fusión con un bloqueo</span>'
          f'<p class="t-sm fg-2" style="margin: 0; max-width: 900px; line-height: 1.5">Fusionar se desactiva y dice por qué, en vez de desaparecer. Muestra el primer bloqueo con su remedio; '
          f'los demás, una línea cada uno con su código. Ningún remedio es el degradado, que queda para Fusionar cuando nada bloquea.</p>'
          f'<div style="display: grid; grid-template-columns: minmax(0, 1fr) 390px; gap: 40px; align-items: start">{desktop_}{phone}</div></section>')


# ---------------------------------------------------------------- the sheet
RULES = [
  ('01', 'El primero que aplica gana', 'Se lee la tabla en orden y se muestra un solo bloqueo con su remedio. Los demás van debajo, en una línea con su código, para que se vea lo que falta después.'),
  ('02', 'Cada color, una cosa', 'Rojo: en conflicto o fallida. Aviso: una regla o una pieza que falta lo frena. Idle: te espera a ti. Cian: el host está calculando o hay comprobaciones en marcha, y solo ahí algo se mueve. Siempre con su palabra.'),
  ('03', 'Un remedio, nunca un comando', 'Una acción de Agentry o un enlace al host, neutros. Si no hay remedio (una hora programada), no se inventa uno. Agentry no ofrece saltarse una regla.'),
  ('04', 'La palabra sigue al host', 'PR y #12 en GitHub, MR y !12 en GitLab. El campo que lo causa se nombra como lo nombra cada host, en mono.'),
]


def rules_section():
  cards = ''.join(f'<div class="card col" style="padding: 18px; gap: 8px"><span class="mono t-xs fg-3">{n}</span><h2 class="t-h2">{t}</h2>'
                  f'<p class="t-sm fg-2" style="margin: 0; line-height: 1.5">{x}</p></div>' for n, t, x in RULES)
  return f'<section style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px">{cards}</section>'


DS_HEIGHT = 5500


def ds_merge():
  head = ('<header class="col" style="gap: 8px"><span class="t-label">Agentry design system · alojamientos de código · fusión</span>'
          '<h1 class="t-display" style="margin: 0">Por qué no se puede fusionar</h1>'
          '<p class="fg-2" style="margin: 0; max-width: 900px; line-height: 1.55">Cada estado que impide fusionar una PR o una MR, en GitHub y en GitLab: su frase, el campo del host que lo causa y su remedio. '
          'Una palabra junto a cada color y una sola acción por bloqueo.</p></header>')
  sections = [rules_section(), table_section(), correction_section(), block_section()]
  body = (f'<div class="app col" data-theme="dark" style="width: 1440px; height: {DS_HEIGHT}px; padding: 56px 64px; gap: 40px; overflow: hidden">'
          f'{head}{"".join(sections)}</div>')
  write('DSFusion.html', page('Design system · Fusión', body))


def m_p2():
  ds_merge()


# ---------------------------------------------------------------- run
if __name__ == '__main__':
  m_p1()
  m_p2()
