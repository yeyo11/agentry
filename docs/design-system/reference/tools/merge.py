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


# ---------------------------------------------------------------- run
if __name__ == '__main__':
  m_p1()
