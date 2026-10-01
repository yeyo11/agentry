# Reviews of a change request (plans/code-hosts.md, phase 3, P0). One function per task, each under its own
# banner: r-p1 is the review threads in the diff, r-p2 the review block on the item page, r-p3 the Address with an
# agent dialog. Runs on its own: it imports common.py, data.py, decisions.py, tasks.py and checks.py.
#   python3 reviews.py
import html as _html
import re

from data import *
from common import P, ico, desktop, mobile, write, page, av
from decisions import scrim
from tasks import _captured, _swap, detail_desktop, mtask_head, wrap_paths, MR_BRANCH
from checks import HOST as MR_HOST, host_link, foot_mr, pframe
import decisions as dec


# ---------------------------------------------------------------- shared
# host id -> name, noun, number. The desktop screen is a GitHub pull request and the phone one a GitLab merge
# request, so both are drawn; nothing in a thread depends on the host but its noun.
HOST = {
  'github': ('GitHub', 'PR', '#12'),
  'gitlab': ('GitLab', 'MR', '!12'),
}
BRANCH = 'task/agn-26 → main'
FILE_DIR = 'packages/core/src/'
FILE_NAME = 'project-settings.ts'
OLD_HEAD = 'a81d3f0'
HUE = {'marta': 215, 'dani': 300, 'yeyo': 24}

KWS = 'import|from|const|export|function|return|if|throw|new|type|void|string'
TOK = re.compile(r"(?P<com>/\*\*.*?\*/)|(?P<str>'[^']*'|`[^`]*`)|(?P<kw>\b(?:" + KWS + r")\b)|(?P<num>\b\d+\b)|(?P<type>\b[A-Z][A-Za-z]+\b)|(?P<fn>\b[a-z][A-Za-z]*(?=\())")


def hl(src, wd=()):
  """One line of code with the muted syntax classes. `wd` are substrings that carry the changed-word mark."""
  def one(m):
    k = m.lastgroup
    return f'<span class="sx-{k}">{_html.escape(m.group(0))}</span>'
  out, pos = '', 0
  for m in TOK.finditer(src):
    out += _html.escape(src[pos:m.start()]) + one(m)
    pos = m.end()
  out += _html.escape(src[pos:])
  for w in wd:
    out = out.replace(_html.escape(w), f'<span class="wd">{_html.escape(w)}</span>', 1)
  return out


def mono(letter, who, size=''):
  return f'<span class="proj monogram" style="--hue: {HUE[who]}" role="img" aria-label="{who}" title="{who}">{letter}</span>'


def who_line(who, when, extra=''):
  return f'<span class="rt-who"><b>{who}</b><time>{when}</time>{extra}</span>'


def comment(who, when, body, sugg=None, mobile=False):
  return (f'<div class="rt-comment">{mono(who[0].upper(), who)}<div class="col" style="gap: 0; min-width: 0">'
          f'{who_line(who, when)}<p class="rt-body">{body}</p>{sugg or ""}</div></div>')


def sugg(line, old, new):
  """A suggestion as the host sends it: the line it replaces and the line it proposes, drawn as a two-line change."""
  return (f'<div class="rt-sugg"><div class="rt-sugg-head">{ico("sparkle", "ico ico-sm")}Sugerencia<span class="grow"></span>línea {line}</div>'
          f'<div class="rt-sugg-row del"><i>−</i><code>{hl(old)}</code></div>'
          f'<div class="rt-sugg-row add"><i>+</i><code>{hl(new)}</code></div></div>')


def status(kind):
  return {
    'open': '<span class="badge b-idle">sin resolver</span>',
    'resolved': f'<span class="badge b-ok">{ico("check", "ico ico-sm")}resuelto</span>',
    'outdated': '<span class="badge">desactualizado</span>',
    'draft': '<span class="badge b-idle">borrador</span>',
  }[kind]


def btn(label, mobile, cls='btn', icon=None):
  size = ' btn-lg' if mobile else ' btn-sm'
  return f'<button type="button" class="{cls}{size}">{ico(icon, "ico ico-sm") if icon else ""}{label}</button>'


def reply_foot(mobile, resolved=False):
  # Replying posts at once (it is not part of the draft review); only a line note waits for the review to be sent.
  act = btn('Reabrir', mobile) if resolved else btn('Resolver', mobile, icon='check')
  if mobile:
    return f'<div class="rt-foot">{btn("Responder", mobile, icon="comment")}{act}</div>'
  return (f'<div class="rt-foot"><label class="field" style="gap: 6px">{ico("comment", "ico ico-sm")}'
          f'<input placeholder="Responder…" aria-label="Responder al hilo"></label>{act}</div>')


def thread(kind, where, comments, mobile=False, count_note='', hunk=''):
  n = comments.count('class="rt-comment"')
  cnt = f'<span class="grow"></span><span class="mono t-xs fg-3">{n} comentario{"s" if n != 1 else ""}</span>'
  head = f'<div class="rt-head">{status(kind)}<span class="where">{where}</span>{count_note}{cnt}</div>'
  return f'<article class="rt {kind}" aria-label="Hilo de revisión en {where}">{head}{hunk}{comments}{reply_foot(mobile, kind == "resolved")}</article>'


def hunk(rows, note):
  r = ''.join(f'<div class="rt-hunk-row {k}"><i>{s}</i><code>{hl(c)}</code></div>' for k, s, c in rows)
  return f'<div class="rt-hunk"><div class="rt-hunk-note">{note}</div>{r}</div>'


def fold(text, mobile=False, what='Mostrar'):
  return f'<div class="rt-fold"><span class="grow">{text}</span><button type="button" class="btn btn-ghost">{what}</button></div>'


def draft_note(where, body, mobile=False, fix=None):
  # A line note the person wrote and has not sent: dashed, "borrador", and the way to change it.
  s = f'<div class="rt-sugg"><div class="rt-sugg-head">{ico("sparkle", "ico ico-sm")}Sugerencia</div>{fix}</div>' if fix else ''
  acts = f'<div class="rt-foot">{btn("Editar", mobile, icon="edit")}{btn("Eliminar", mobile, "btn btn-ghost", "trash")}</div>'
  return (f'<article class="rt draft" aria-label="Nota en borrador en {where}"><div class="rt-head">{status("draft")}<span class="where">{where}</span>'
          f'<span class="grow"></span><span class="t-xs fg-3">solo la ves tú</span></div>'
          f'<div class="rt-comment">{mono("Y", "yeyo")}<div class="col" style="gap: 0; min-width: 0">{who_line("yeyo", "ahora")}<p class="rt-body">{body}</p>{s}</div></div>{acts}</article>')


def pill(n, open_):
  cls = ' open' if open_ else ''
  return f'<span class="dv-note-pill{cls}" role="img" aria-label="{n} comentario{"s" if n != 1 else ""}">{ico("comment", "ico ico-sm")}{n}</span>'


def row(kind, num, code, wd=(), pill_html='', noted=False, add=False, sel=False, ghost=False):
  cls = f'dv-row {kind}' + (' noted' if noted else '') + (' sel' if sel else '')
  plus = f'<button type="button" class="dv-add" aria-label="Añadir una nota en la línea {num}">{ico("plus", "ico ico-sm")}</button>' if add else ''
  g = '<button type="button" class="dv-ghost" aria-label="Mostrar lo quitado">−1</button>' if ghost else ''
  return f'<div class="{cls}">{plus}<span class="dv-num">{num}</span><span class="dv-rail"></span><span class="dv-code">{hl(code, wd)}</span>{pill_html}{g}</div>'


def gap(text, where, mobile=False):
  w = '' if mobile else f'<span class="fold-where">· en <span class="where">{where}</span></span>'
  return f'<div class="dv-fold"><svg class="ico ico-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 15 5 5 5-5M7 9l5-5 5 5"></path></svg><span>{text}</span>{w}<button type="button" class="btn btn-ghost">Mostrar</button></div>'


# The code the screens draw: packages/core/src/project-settings.ts, new side, in Reading
L1 = "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';"
L5 = "/** The project's settings live in one JSON file at its root. */"
L6 = "const SETTINGS_FILE = '.agentry/settings.json';"
L8 = 'export function readSettings(dir: string): ProjectSettings {'
L9 = "  const raw = readFileSync(join(dir, SETTINGS_FILE), 'utf8');"
L10 = '  return JSON.parse(raw) as ProjectSettings;'
L10_FIX = '  return parseSettings(raw, dir);'
L36 = 'export function writeSettings(dir: string, next: ProjectSettings): void {'
L37 = "  mkdirSync(join(dir, '.agentry'), { recursive: true });"
L38 = "  writeFileSync(join(dir, SETTINGS_FILE), JSON.stringify(next, null, 2) + '\\n');"

RESOLVED = lambda mobile: comment('marta', 'hace 1 d', '¿Por qué una ruta fija y no un ajuste del proyecto?') + comment('yeyo', 'hace 1 d', 'Es el fichero donde viven los ajustes; no hay otro sitio donde guardarlo.')
OPEN = lambda mobile: (comment('marta', 'hace 3 h', 'Un JSON a medias tumba la carga de todo el proyecto. Mejor validarlo y volver a los valores por defecto.',
                               sugg(10, L10, L10_FIX), mobile)
                       + comment('yeyo', 'hace 40 min', 'Buena idea. Lo hago en el siguiente commit.'))
OUTDATED = lambda mobile: (comment('dani', 'hace 2 d', 'Este <code>JSON.parse</code> sin <code>try</code> se rompe si el fichero está a medias.')
                           + comment('yeyo', 'hace 2 d', 'Cierto; lo cambio a partir de este commit.'))
HUNK = lambda: hunk([('ctx', ' ', 'function load(file: string) {'), ('ctx', ' ', "  const raw = readFileSync(file, 'utf8');"),
                     ('add', '+', '  return JSON.parse(raw);')], f'línea original 31 · {OLD_HEAD}')


# ---------------------------------------------------------------- r-p1
def file_head(host, mobile=False):
  """The file header of the review: path, counts, the reading mode and the file's threads in one chip."""
  seg = ('<div class="seg seg-compact" role="radiogroup" aria-label="Cómo comparar" style="padding: 2px">'
         f'<button type="button" role="radio" aria-checked="true" class="on" style="height: 26px; padding: 0 9px">{ico("list", "ico ico-sm")}<span class="lbl">Lectura</span></button>'
         f'<button type="button" role="radio" aria-checked="false" style="height: 26px; padding: 0 9px">{ico("menu", "ico ico-sm")}<span class="lbl">Unificado</span></button></div>')
  return (f'<div class="dv-head"><span class="path grow"><span class="dir">{FILE_DIR}</span><span class="name">{FILE_NAME}</span></span>'
          f'<span class="cnt"><span class="a">+38</span> <span class="d">−12</span></span>'
          f'<span style="width: 1px; height: 20px; background: var(--line-2); margin: 0 4px"></span>{seg}'
          f'<span class="chip" style="height: 28px">{ico("comment", "ico ico-sm")}3 hilos<span class="n">1 sin resolver</span></span></div>')


def fmap_row(letter, name, a, d, on=False, threads=0):
  t = f'<span class="row mono t-xs fg-2" style="gap: 3px" title="{threads} hilos">{ico("comment", "ico ico-sm")}{threads}</span>' if threads else ''
  cls = 'frow sel' if on else 'frow'
  return (f'<a href="#" class="{cls}"><span class="st st-{letter.lower()}">{letter}</span><span class="row" style="gap: 6px; min-width: 0"><span class="fname">{name}</span></span>'
          f'<span class="row" style="gap: 8px">{t}<span class="cnt"><span class="a">+{a}</span> <span class="d">{"−" + str(d) if d else ""}</span></span></span></a>')


def fdir(path):
  return f'<div class="fdir"><svg class="ico ico-sm" viewBox="0 0 24 24" style="width: 12px; height: 12px" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>{path}</div>'


def file_aside():
  return f'''<aside class="col" style="width: 288px; flex-shrink: 0; gap: 0; border-right: 1px solid var(--line); background: var(--bg-1)" aria-label="Archivos cambiados">
<div class="row" style="height: 46px; padding: 0 12px 0 18px; gap: 8px; border-bottom: 1px solid var(--line)"><span class="t-label">Archivos</span><span class="count">4</span><span class="grow"></span><span class="mono t-xs fg-3">3 hilos</span></div>
<nav class="fmap grow" style="padding: 8px 0; overflow: hidden">
{fdir('apps/api/src/routes')}
{fmap_row('M', 'projects.ts', 21, 19)}
{fdir('packages/core/src')}
{fmap_row('A', 'project-templates.ts', 142, 0)}
{fmap_row('M', FILE_NAME, 38, 12, True, 3)}
{fdir('packages/core/test')}
{fmap_row('M', 'project-templates.test.ts', 13, 6)}
</nav>
</aside>'''


def review_head(host):
  name, noun, num = HOST[host]
  return f'''<header class="row" style="flex-shrink: 0; gap: 12px; padding: 12px 20px 12px 12px; border-bottom: 1px solid var(--line)">
<a href="DesktopTareaMR.html" class="btn btn-ghost btn-icon btn-sm" aria-label="Volver a la tarea">{ico('left')}</a>
<div class="col grow" style="gap: 2px; min-width: 0"><span class="t-xs fg-3 ellipsis">AGN-26 · Plantillas de proyecto</span>
<div class="row" style="gap: 12px"><h1 class="t-h1" style="font-size: 20px">Cambios de la {noun} {num}</h1><span class="mono t-xs fg-3" style="white-space: nowrap">{BRANCH} · 4 archivos</span><span class="cnt"><span class="a">+214</span> <span class="d">−37</span></span></div></div>
<span class="chip" style="height: 32px">{ico('edit', 'ico ico-sm')}Tu borrador<span class="n">1 nota</span></span>
<a href="#" class="btn btn-sm" target="_blank" rel="noreferrer">{ext_ico()}Abrir {noun} {num} en {name}</a>
</header>'''


def compose_desktop(line, text, fix_text=None):
  """The note composer inline, under its line. One gradient: Añadir a la revisión."""
  tools_on = fix_text is not None
  fix = (f'<div class="rt-sugg"><div class="rt-sugg-head">{ico("sparkle", "ico ico-sm")}Sugerencia<span class="grow"></span>sustituye la línea {line}</div>'
         f'<label class="field field-area field-mono" style="border: 0; border-radius: 0; background: var(--bg)"><textarea rows="2" aria-label="Línea propuesta">{_html.escape(fix_text)}</textarea></label></div>') if tools_on else ''
  return f'''<article class="rt compose" aria-label="Nota nueva en la línea {line}"><div class="rt-head"><span class="where">{FILE_NAME}:{line}</span><span class="grow"></span><span class="t-xs fg-3">nota nueva</span></div>
<div class="rt-edit"><label class="field field-area"><textarea rows="2" aria-label="Nota">{text}</textarea></label>{fix}
<div class="rt-tools"><button type="button" class="btn btn-sm" aria-pressed="{"true" if tools_on else "false"}">{ico('sparkle', 'ico ico-sm')}Sugerir un cambio</button><span class="hint">Solo la ves tú hasta que envíes la revisión.</span>
<button type="button" class="btn btn-sm btn-ghost">Cancelar</button><button type="button" class="btn btn-sm btn-primary">Añadir a la revisión</button></div></div></article>'''


def diff_desktop_a():
  body = '\n'.join([
    fold('1 hilo desactualizado · de un commit anterior', False, 'Mostrar'),
    row('mod', 1, L1, wd=('mkdirSync, ', ', writeFileSync'), ghost=True),
    row('ctx', 4, ''),
    row('add', 5, L5),
    row('add', 6, L6, pill_html=pill(2, False), noted=True),
    fold('Hilo resuelto · marta · 2 comentarios', False),
    row('ctx', 7, ''),
    row('ctx', 8, L8),
    row('add', 9, L9),
    row('add', 10, L10, pill_html=pill(2, True), noted=True),
    thread('open', f'{FILE_NAME}:10', OPEN(False)),
    row('ctx', 11, '}'),
    gap('24 líneas sin cambios', 'writeSettings()'),
    row('ctx', 36, L36),
    row('add', 37, L37),
    row('add', 38, L38, noted=True, pill_html=pill(1, False)),
    draft_note(f'{FILE_NAME}:38', 'Escribir a un temporal y renombrar: si el proceso se corta a medias, el fichero de ajustes no queda truncado.'),
    row('ctx', 39, '}'),
  ])
  return f'<div class="app dv dv-read dv-review" data-theme="dark" style="display: block; flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 10px 0 0">{body}</div>'


WRAP = '<div class="app dv dv-read dv-review" data-theme="dark" style="display: block; flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 10px 0 0">'


def diff_desktop_b():
  # The composer open on line 9, the way a note starts: the "+" in the gutter, the suggestion switched on
  body = '\n'.join([
    fold('1 hilo desactualizado · de un commit anterior', False),
    row('ctx', 4, ''),
    row('add', 5, L5),
    row('add', 6, L6, pill_html=pill(2, False), noted=True),
    fold('Hilo resuelto · marta · 2 comentarios', False),
    row('ctx', 7, ''),
    row('ctx', 8, L8),
    row('add', 9, L9, add=True, sel=True),
    compose_desktop(9, 'Aquí el fichero puede no existir: ¿devolvemos los valores por defecto?', L9.replace('readFileSync', 'existsSync')),
    row('add', 10, L10, pill_html=pill(2, True), noted=True),
    fold('Hilo abierto · marta, yeyo · 2 comentarios', False),
    row('ctx', 11, '}'),
    gap('24 líneas sin cambios', 'writeSettings()'),
    row('ctx', 36, L36),
    row('add', 37, L37),
    row('add', 38, L38, noted=True, pill_html=pill(1, False)),
    fold('Borrador · 1 nota tuya', False, 'Mostrar'),
    row('ctx', 39, '}'),
  ])
  return f'{WRAP}{body}</div>'


def diff_desktop_c():
  # What folds, open: an outdated thread with the comment's own hunk, and a resolved one with its way back
  body = '\n'.join([
    thread('outdated', f'{FILE_NAME} · línea original 31 · {OLD_HEAD}', OUTDATED(False), hunk=HUNK(), count_note='<span class="t-xs fg-3">el código cambió después del comentario</span>'),
    row('add', 5, L5),
    row('add', 6, L6, pill_html=pill(2, False), noted=True),
    thread('resolved', f'{FILE_NAME}:6', RESOLVED(False), count_note='<span class="t-xs fg-3">por marta · hace 1 d</span>'),
    row('ctx', 7, ''),
    row('ctx', 8, L8),
  ])
  return f'{WRAP}{body}</div>'


def desktop_page(name, title, host, diff):
  crumb = '<a href="DesktopTablero.html" class="fg-2">Tareas</a><span class="fg-3">/</span><a href="DesktopTareaMR.html" class="fg-2">AGN-26</a><span class="fg-3">/</span><span style="font-weight: 500">Cambios</span>'
  main = f'''{review_head(host)}
<div class="row" style="flex: 1 1 auto; min-height: 0; align-items: stretch; gap: 0">
{file_aside()}
<section class="col grow" style="gap: 0; min-width: 0" aria-label="{FILE_DIR}{FILE_NAME}">
{file_head(host)}
{diff}
</section>
</div>'''
  write(name, desktop(title, 'tasks', crumb, main, agents=2, running=2))


def phone_head():
  return (f'<header class="m-head" style="padding-left: 4px; gap: 2px; border-bottom: 1px solid var(--line)"><a href="MobileTareaMR.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver a la tarea">{ico("left", "ico ico-lg", "stroke-width: 2")}</a>'
          f'<span class="col grow" style="gap: 1px; min-width: 0"><span class="mono" style="font-size: 16px; font-weight: 600">{FILE_NAME}</span>'
          f'<span class="mono t-xs fg-3 ellipsis">{FILE_DIR[:-1]} · <span class="c-ok">+38</span> <span class="c-bad">−12</span></span></span>'
          f'<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Más acciones del archivo">{ico("more", "ico ico-lg", "stroke-width: 3")}</button></header>')


def phone_bar():
  return (f'<div class="row" style="flex-shrink: 0; gap: 10px; padding: 10px 16px; flex-wrap: wrap">'
          f'<div class="seg" role="radiogroup" aria-label="Cómo comparar"><button type="button" role="radio" aria-checked="true" class="on" style="height: 30px">Lectura</button><button type="button" role="radio" aria-checked="false" style="height: 30px">Unificado</button></div>'
          f'<span class="grow"></span><span class="mono t-xs fg-2">3 hilos · 1 sin resolver</span></div>'
          f'<div class="row" style="flex-shrink: 0; gap: 8px; padding: 0 16px 10px"><span class="mono t-xs fg-3">MR !12 · {BRANCH}</span><span class="grow"></span>'
          f'<span class="row t-xs fg-2" style="gap: 5px">{ico("edit", "ico ico-sm")}Tu borrador · 1 nota</span></div>')


def phone_diff(variant='threads'):
  if variant == 'folded':
    rows = [thread('outdated', 'línea original 31 · ' + OLD_HEAD, OUTDATED(True), mobile=True, hunk=HUNK()),
            row('add', 6, L6, noted=True),
            thread('resolved', f'línea 6', RESOLVED(True), mobile=True)]
  else:
    rows = [fold('1 hilo desactualizado', True),
            row('ctx', 4, ''),
            row('add', 5, L5),
            row('add', 6, L6, noted=True),
            fold('Hilo resuelto · marta · 2 comentarios', True),
            row('ctx', 7, ''),
            row('ctx', 8, L8),
            row('add', 9, L9, sel=variant == 'compose'),
            row('add', 10, L10, noted=True),
            thread('open', 'línea 10', OPEN(True), mobile=True),
            row('ctx', 11, '}')]
  body = '\n'.join(rows)
  return f'<div class="app dv dv-read dv-wrap dv-review" data-theme="dark" style="display: block; width: 390px; flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 10px 0 0">{body}</div>'


def phone_screen(name, title, overlay='', variant='threads'):
  inner = f'{phone_head()}\n{phone_bar()}\n<div style="flex: 1 1 auto; min-height: 0; overflow: hidden; border-top: 1px solid var(--line); display: flex; flex-direction: column">{phone_diff(variant)}</div>\n{overlay}'
  write(name, mobile(title, inner))


def compose_sheet():
  fix = (f'<div class="rt-sugg"><div class="rt-sugg-head">{ico("sparkle", "ico ico-sm")}Sugerencia<span class="grow"></span>sustituye la línea 9</div>'
         f'<label class="field field-area field-mono" style="border: 0; border-radius: 0; background: var(--bg)"><textarea rows="2" aria-label="Línea propuesta" style="font-size: 16px">{_html.escape(L9.replace("readFileSync", "existsSync"))}</textarea></label></div>')
  return f'''{scrim()}
<div class="sheet" role="dialog" aria-label="Nota nueva en la línea 9" style="z-index: 11; padding: 10px 16px 28px; display: flex; flex-direction: column; gap: 12px; max-height: 90%; overflow: hidden">
<div class="grab" style="margin-bottom: 0"></div>
<div class="row" style="gap: 10px"><span class="col grow" style="gap: 2px; min-width: 0"><b style="font-weight: 500; font-size: 15px">Nota nueva</b><span class="mono t-xs fg-3 ellipsis">{FILE_NAME}:9</span></span><button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Cerrar">{ico('x', 'ico ico-lg')}</button></div>
<div class="rt-sugg" style="margin-top: 0"><div class="rt-sugg-row add"><i>+</i><code>{hl(L9)}</code></div></div>
<label class="field field-area"><textarea rows="3" aria-label="Nota" style="font-size: 16px">Aquí el fichero puede no existir: ¿devolvemos los valores por defecto?</textarea></label>
<button type="button" class="btn btn-lg" aria-pressed="true" style="justify-content: center">{ico('sparkle', 'ico')}Sugerir un cambio</button>
{fix}
<span class="t-xs fg-3">Solo la ves tú hasta que envíes la revisión.</span>
<div class="row" style="gap: 8px"><button type="button" class="btn btn-lg" style="flex: 1 1 0; justify-content: center">Cancelar</button><button type="button" class="btn btn-primary btn-lg" style="flex: 2 1 0; justify-content: center">Añadir a la revisión</button></div>
</div>'''


def r_p1():
  desktop_page('DesktopRevisionHilos.html', 'Revisión, hilos en el diff', 'github', diff_desktop_a())
  desktop_page('DesktopRevisionHilosNota.html', 'Revisión, nota nueva y hilos desplegados', 'github', diff_desktop_b())
  desktop_page('DesktopRevisionHilosPlegados.html', 'Revisión, hilos desactualizados y resueltos', 'github', diff_desktop_c())
  phone_screen('MobileRevisionHilos.html', 'Revisión, hilos en el diff')
  phone_screen('MobileRevisionHilosNota.html', 'Revisión, nota nueva', compose_sheet(), 'compose')
  phone_screen('MobileRevisionHilosPlegados.html', 'Revisión, hilos desactualizados y resueltos', variant='folded')



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
  name, noun, num, _ = MR_HOST[host]
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
  name, noun, num, _ = MR_HOST[host]
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
  name, noun, num, _ = MR_HOST[host]
  size = 'btn btn-lg' if mobile else 'btn btn-sm'
  return f'''<section class="callout" aria-label="{"Merge request" if host == "gitlab" else "Pull request"}" style="align-items: flex-start; flex-wrap: wrap">{ico('branch', 'ico fg-3', 'flex-shrink: 0; margin-top: 2px')}
<div class="col grow" style="gap: 6px; min-width: 0"><span class="row" style="gap: 8px; flex-wrap: wrap"><b style="color: var(--fg); font-weight: 500">La {noun} {num} espera que la fusiones en {name}</b>{ci_badge('passing')}</span>
<span>Cuando se fusione, la tarea pasará sola a Hecho.</span></div>
{"" if mobile else f'<a href="#" class="{size}" target="_blank" rel="noreferrer">{ext_ico()}Abrir {noun} {num} en {name}</a>'}</section>'''


def pr_row(host):
  name, noun, num, _ = MR_HOST[host]
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
  name, noun, num, _ = MR_HOST[host]
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
  name, noun, num, _ = MR_HOST[host]
  dialog = f'''<div class="scrim" style="z-index: 5">
<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="rv-submit-title" style="width: 560px">
<div class="dialog-head">{ico("edit", "ico fg-3")}<div class="col grow" style="gap: 2px"><h2 id="rv-submit-title" class="t-h2">Enviar tu revisión</h2><span class="mono t-xs fg-3">{noun} {num} · {MR_BRANCH} · {HEAD_SHA}</span></div><button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Cerrar">{ico("x")}</button></div>
<div class="dialog-body">{submit_body(host)}</div>
<div class="dialog-foot"><span class="grow"></span><button type="button" class="btn btn-ghost">Cancelar</button><button type="button" class="btn btn-primary">Enviar revisión</button></div>
</div></div>'''
  return dialog


def submit_sheet(host):
  name, noun, num, _ = MR_HOST[host]
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


P.setdefault('ext', EXT_PATH)

# ---------------------------------------------------------------- shared
HEAD = 'a1b2c3d'      # the head the threads were read on
PUSHED = 'a8f3c21'    # the commit the Developer pushed
# host id -> "PR #12" / "MR !12"
def ref(host):
  return f'{MR_HOST[host][1]} {MR_HOST[host][2]}'


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
ADDR_RESOLVED = 2   # threads the host already has resolved: not sent, said in one line

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


def addr_cell(k, v):
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
          + addr_cell('Los atiende', '<span class="mono t-sm">Desarrollador · sonnet</span>')
          + addr_cell('Worktree', '<span class="mono t-sm">task/agn-26</span>')
          + addr_cell('Resueltos', f'<span class="t-sm fg-2">{ADDR_RESOLVED} hilos resueltos: no se envían</span>')
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
  name = MR_HOST[host][0]
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
    acts += f'<a href="#" class="{size} btn-ghost" target="_blank" rel="noreferrer">{ext_ico()}Abrir el hilo en {MR_HOST[host][0]}</a>'
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
  name, noun = MR_HOST[host][0], MR_HOST[host][1]
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
  r_p1()
  r_p2()
  all_r_p3()
