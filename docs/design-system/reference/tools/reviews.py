# Reviews of a change request (plans/code-hosts.md, phase 3, P0). One function per task, each under its own
# banner: r-p1 is the review threads in the diff. r-p2 and r-p3 add theirs below. Runs on its own: it
# imports common.py, data.py and decisions.py.
#   python3 reviews.py
import html as _html
import re

from data import *
from common import P, ico, desktop, mobile, write
from decisions import scrim

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


# ---------------------------------------------------------------- run
if __name__ == '__main__':
  r_p1()
