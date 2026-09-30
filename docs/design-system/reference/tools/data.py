# The work items the prototypes show, one set for every screen so they agree.
from common import *

# key: dict(type, title, status, prio, epic, labels, who, crit, comments, live, blocked, child)
W = {
  'AGN-45': dict(t='story', title='Filtros guardados en la lista de tareas', s='backlog', p='medium', labels=['web']),
  'AGN-38': dict(t='bug', title='El FAB tapa la última fila en el iPhone SE', s='backlog', p='medium', labels=['móvil']),
  'AGN-44': dict(t='task', title='Documentar las plantillas de proyecto', s='backlog', p='low', epic='eco', labels=['docs']),
  'AGN-41': dict(t='story', title='Exportar el tablero a Markdown', s='backlog', p='low'),
  'AGN-47': dict(t='epic', title='Asistente de proyecto', s='todo', p='medium', child=(0, 0)),
  'AGN-39': dict(t='bug', title='La barra de uso no se actualiza al cambiar de cuenta', s='todo', p='urgent', labels=['web', 'uso'], who='Y'),
  'AGN-36': dict(t='task', title='Tablas de tareas en SQLite', s='todo', p='high', epic='eco', labels=['core'], crit=(0, 4)),
  'AGN-33': dict(t='story', title='Enlazar tareas con chats y orquestaciones', s='todo', p='high', epic='eco', blocked='AGN-36', crit=(0, 5)),
  'AGN-28': dict(t='story', title='Tablero con columnas fijas y límites', s='in_progress', p='high', epic='eco', who='Y', crit=(2, 5), comments=2, live='chat'),
  'AGN-30': dict(t='task', title='API de tareas y del tablero', s='in_progress', p='medium', epic='eco', labels=['api'], crit=(1, 4), live='orch'),
  'AGN-31': dict(t='bug', title='El resumen de coste cuenta la caché dos veces', s='in_progress', p='high', labels=['core', 'coste'], who='Y', crit=(1, 3)),
  'AGN-35': dict(t='task', title='Clave por proyecto al estilo YouTrack', s='in_progress', p='medium', epic='eco', crit=(1, 2)),
  'AGN-26': dict(t='story', title='Plantillas de proyecto', s='in_review', p='medium', epic='eco', labels=['core', 'api'], who='Y', crit=(5, 5), comments=4, chat=True),
  'AGN-29': dict(t='task', title='Historial automático de cambios', s='in_review', p='low', epic='eco', crit=(2, 2), chat=True),
  'AGN-24': dict(t='task', title='Ajustes por proyecto en un JSON', s='done', p='medium', epic='eco', crit=(3, 3)),
  'AGN-22': dict(t='bug', title='Parpadeo del tema al cargar la app', s='done', p='high', labels=['web']),
  'AGN-19': dict(t='story', title='Night Shift en la web', s='done', p='medium', labels=['web'], crit=(6, 6)),
  'AGN-12': dict(t='epic', title='Ecosistema de proyectos', s='in_progress', p='high', child=(3, 11)),
}
LIMITS = {'in_progress': 3, 'in_review': 3}
DONE_MORE = 9


def by_col(s, keys=None):
  ks = keys or W.keys()
  return [k for k in ks if W[k]['s'] == s]


def counted(keys):
  # An epic groups work rather than being some: no column count, open figure or limit counts it
  # (countsInColumn in apps/web/src/lib/work-items.ts)
  return [k for k in keys if W[k]['t'] != 'epic']


ROLES = {'PO': (300, 'Product Owner'), 'AR': (215, 'Arquitecto'), 'DEV': (90, 'Desarrollador'), 'QA': (330, 'QA'), 'DOC': (45, 'Redactor técnico')}


def role(ab, size='sm'):
  h, name = ROLES[ab]
  return f'<span class="role-av {size}" style="--hue: {h}" role="img" aria-label="{name}" title="{name}">{ab}</span>'


def actor(who):
  """Who is on the card now, at the head of its strip: a role's squircle, the person's round
  monogram, or an orchestration's glyph. The shape says it before the words do."""
  if who == 'orch':
    return f'<span class="actor-orch" role="img" aria-label="Orquestación" title="Orquestación">{ico("orch", "ico ico-sm")}</span>'
  if who == 'Y':
    return '<span class="proj monogram wi-assignee xs" style="--hue: 24" role="img" aria-label="Tu chat" title="Tu chat">Y</span>'
  return role(who, 'xs')


def live_strip(who, verb, t, detail=''):
  d = f'<span class="detail">{detail}</span>' if detail else ''
  return f'<div class="wi-strip live" role="status">{actor(who)}<span class="spin-braille" aria-hidden="true"></span><span class="verb">{verb}</span><time>{t}</time>{d}</div>'


def orch_strip(node='nodo 3 de 9'):
  return ('<div class="wi-strip live" role="status">' + actor('orch') + '<span class="spin-braille" aria-hidden="true"></span>'
          f'<span class="verb mono" style="flex: 0 0 auto; font-size: 11.5px">{node}</span>'
          '<span class="segbar" aria-hidden="true"><i class="ok"></i><i class="ok"></i><i class="live" style="--p: 55%"></i><i></i><i></i><i></i><i></i><i></i><i></i></span></div>')


def wait_strip(text, approve=False):
  btn = f'<button type="button" class="btn btn-sm">{ico("check", "ico ico-sm")}Aprobar y pasar a Hecho</button>' if approve else ''
  return f'<div class="wi-strip wait"><span class="badge b-idle">te espera</span><span class="verb">{text}</span>{btn}</div>'


def fail_strip(who, what, why):
  return f'<div class="wi-strip fail" role="status">{actor(who)}{ico("x", "ico", "color: var(--bad)")}<span class="verb"><b>Falló</b> {what} · {why}</span></div>'


def quote_strip(who, text):
  return f'<div class="wi-strip">{actor(who)}<span class="verb" style="color: var(--fg-2); font-weight: 400">«{text}»</span></div>'


def queue_strip(who, text):
  return f'<div class="wi-strip">{actor(who)}{ico("wait", "ico", "color: var(--fg-3)")}<span class="verb" style="color: var(--fg-2); font-weight: 400">{text}</span></div>'


def bounce(n, of=3):
  return f'<span class="bounce" title="QA la devolvió {n} {"vez" if n == 1 else "veces"} de {of} posibles">{ico("bounce")}rebote {n} de {of}</span>'


def crit_fact(a, b):
  full = ' full' if a == b else ''
  return (f'<span class="wi-fact wi-crit{full}" title="Criterios de aceptación: {a} de {b}"><span class="bar"><i style="width: {a / b * 100:.0f}%"></i></span>{a}/{b}</span>')


def card(k, sel=None, who=None, strip=None, lead_facts=(), crit=None, comments=None, show_epic=True, proj=None, mark=''):
  """One work item on the board, in the order a person reads it: what it is (type, key, priority),
  its title, where it belongs (epic, labels), its facts (criteria, blockers, comments) with its
  assignee, and what is happening to it now in the strip at its foot."""
  w = W[k]
  done = w['s'] == 'done'
  epic_card = w['t'] == 'epic'
  if strip is None:
    live = w.get('live')
    strip = live_strip('Y', 'Ejecutando', '4:12', 'pnpm test') if live == 'chat' else orch_strip() if live == 'orch' else ''
  live_now = 'wi-strip live' in strip
  cls = 'wi-card' + (' done' if done else '') + (' rail-live' if live_now else '') + (' sel' if sel is True else '')
  chk = '<span class="checkbox on" role="checkbox" aria-checked="true" aria-label="Seleccionada"></span>' if sel else ''
  top = f'<div class="wi-card-top">{chk}{tico(w["t"])}<span class="wi-key">{k}</span><span class="grow"></span>{"" if done else prio(w["p"])}</div>'
  title = f'<p class="wi-card-title">{w["title"]}</p>'
  if done:
    return f'<article class="{cls}" aria-label="{k} · {w["title"]}">{top}{title}</article>'
  ctx_bits = []
  if proj: ctx_bits.append(proj)
  if show_epic and w.get('epic'):
    n, h = EPICS[w['epic']]
    ctx_bits.append(f'<span class="wi-epic bare" style="--hue: {h}">{n}</span>')
  if w.get('labels'):
    ctx_bits.append('<span class="row" style="gap: 6px">' + ''.join(f'<span class="wi-tag">{l}</span>' for l in w['labels']) + '</span>')
  # The mark sits with where the card belongs, not in the top row, which is full at a card's width
  if mark: ctx_bits.append(mark)
  ctx = f'<div class="wi-card-ctx">{"".join(ctx_bits)}</div>' if ctx_bits else ''
  body = ''
  if epic_card:
    d, n = w['child']
    # An epic just created has no tasks yet: it says so instead of drawing an empty bar
    body = (f'<div class="wi-card-epic"><span class="ms-bar"><i class="done" style="width: {d / n * 100:.0f}%"></i></span><span>{d}/{n} tareas</span></div>' if n
            else '<div class="wi-card-epic"><span>sin tareas todavía</span></div>')
  facts = list(lead_facts)
  ctx_has_role = False
  if w.get('blocked'):
    facts.append(f'<span class="wi-fact" title="Bloqueada por {w["blocked"]}">{ico("block")}{w["blocked"]}</span>')
  c = crit or w.get('crit')
  if c:
    facts.append(crit_fact(*c))
  nc = comments if comments is not None else w.get('comments')
  if nc:
    facts.append(f'<span class="wi-fact" title="{nc} comentarios">{ico("comment")}{nc}</span>')
  who = who or w.get('who')
  # The strip's actor is the assignee at work: when they are the same, the strip says it once
  assignee = (av('Y') if who == 'Y' else role(who)) if who and actor(who) not in strip else ''
  # An assignee with no facts beside it ends the context line instead of opening a row of its own
  if assignee and not facts and ctx:
    ctx = ctx[:-len('</div>')] + f'<span class="grow"></span>{assignee}</div>'
    assignee = ''
  foot = f'<div class="wi-card-foot">{"".join(facts)}{assignee}</div>' if (facts or assignee) else ''
  return f'<article class="{cls}" aria-label="{k} · {w["title"]}">{top}{title}{ctx}{body}{foot}{strip}</article>'


def col(s, keys, sel_mode=False, selected=(), extra='', role_head='', cards=None, limits=True, more=None, add=True, marks=None):
  name = COL_WORD[s]
  real = counted(keys)
  n = len(real) + (DONE_MORE if s == 'done' else 0)
  lim = LIMITS.get(s) if limits else None
  over = lim is not None and n > lim
  cnt = f'<span class="wi-col-count"><b>{n}</b>/{lim}</span>' if lim else f'<span class="wi-col-count"><b>{n}</b></span>'
  plus = f'<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Nueva tarea en {name}">{ico("plus", "ico ico-sm")}</button>' if add else ''
  head = f'<div class="wi-col-head">{sico(s)}<span class="t-label">{name}</span>{cnt}<span class="grow"></span>{role_head}{plus}</div>'
  warn = f'<div class="wi-col-limit" role="status">{ico("warn")}Sobre el límite: {n} de {lim}</div>' if over else ''
  if cards is None:
    cards = ''.join(card(k, (k in selected) if sel_mode and s != 'done' and W[k]['t'] != 'epic' else None, mark=(marks or {}).get(k, '')) for k in keys)
  if more is None and s == 'done':
    more = DONE_MORE
  more_btn = f'<button type="button" class="wi-col-more">Mostrar {more} más{ico("down", "ico ico-sm")}</button>' if more else ''
  return f'<section class="wi-col{" over" if over else ""}" aria-label="{name}">{head}{warn}<div class="wi-col-body">{cards}{more_btn}{extra}</div></section>'


# ---------- Pull requests and merge requests on a card (docs/plans/code-hosts.md, phase 1) ----------
# Pieces the board, the item page and the readiness sheet share. The noun and the number follow the host:
# "MR !12" on GitLab, "PR #12" on GitHub.
EXT_PATH = 'M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'


def ext_ico(cls='ico ico-sm'):
  P.setdefault('ext', EXT_PATH)
  return ico('ext', cls)


def ci_badge(ci):
  """A PR's checks as a badge with its word: passing ok, failing bad, pending neutral and still."""
  word, cls, icon = {'passing': ('CI superada', ' b-ok', 'check'), 'failing': ('CI fallida', ' b-bad', 'x'),
                     'pending': ('CI pendiente', '', 'wait'), 'none': ('sin CI', '', 'block')}[ci]
  return f'<span class="badge pr-ci{cls}" data-ci="{ci}">{ico(icon, "ico ico-sm")}{word}</span>'


def pr_ref(host, n):
  return f'{"MR" if host == "gitlab" else "PR"} {"!" if host == "gitlab" else "#"}{n}'


def pr_strip(host, n, verb, ci=None, link=True):
  """An open PR or MR on a card's strip: the number in mono, what it waits for, the CI badge and an
  icon link to the host that never opens the card."""
  ref = pr_ref(host, n)
  name = 'GitLab' if host == 'gitlab' else 'GitHub'
  lnk = f'<a href="#" class="pr-link" aria-label="Abrir {ref} en {name}" target="_blank" rel="noreferrer">{ext_ico()}</a>' if link else ''
  return f'<div class="wi-strip wait"><span class="pr-num" style="white-space: nowrap">{ref}</span><span class="verb" style="flex: 1 1 auto; min-width: 8em">{verb}</span>{ci_badge(ci) if ci else ""}{lnk}</div>'


def no_pr_line(text, remedy=None):
  """The warn line of a not-ready project, with its remedies (label, opens the host's site) as links under it."""
  r = ''.join(f'<a href="#" class="pr-remedy">{label}{ext_ico() if out else ""}</a>' for label, out in (remedy or ()))
  return f'<span class="no-pr">{ico("warn", "ico")}<span>{text}</span></span>{r}'


def approve_strip(text, label, note=''):
  """A card that waits for the person: why, and the approval with its wording for the project."""
  return (f'<div class="wi-strip wait"><span class="badge b-idle">te espera</span><span class="verb">{text}</span>{note}'
          f'<button type="button" class="btn btn-sm">{ico("check", "ico ico-sm")}{label}</button></div>')
