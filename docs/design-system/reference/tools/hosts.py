# Code hosts (plans/code-hosts.md, phase 1, P0): the screens of GitHub and GitLab support. Runs on its own,
# after nothing: it imports common.py, data.py, board.py and tasks.py for the screens it varies.
#   python3 hosts.py
# Each task of P0 keeps its screens in its own section below, so the sections merge without touching
# one another.
from data import *
from board import mrow
from decisions import scrim

# ================================================================ p3 · readiness notes and MR wording
# The seven reasons a project offers no PR or MR (PullRequestNotReadyReason in plans/code-hosts.md, "Readiness"),
# each as the board's quiet note and the item page's note, with its remedy. A remedy is a link, or an
# Agentry action, never a command to copy: (label, True) opens the host's or the CLI's own page.
#   code, when, host (for the noun), board line, item sentence, the CLI's own line, remedies
REASONS = [
  ('not-git', 'la ruta no es un repositorio git', None,
   'Sin PR ni MR: el proyecto no es un repositorio git.',
   'Aprobarla no abre una PR ni una MR: el proyecto no es un repositorio git.',
   'fatal: not a git repository (or any of the parent directories): .git', []),
  ('no-remote', 'falta el remoto origin', None,
   'Sin PR ni MR: el proyecto no tiene remoto.',
   'Aprobarla no abre una PR ni una MR: el proyecto no tiene un remoto llamado origin.',
   "error: No such remote 'origin'", [('Cómo añadir un remoto', True)]),
  ('unsupported-host', 'ni gh ni glab conocen el host', None,
   'Sin PR ni MR: Agentry no llega a git.inmoseo.net.',
   'Aprobarla no abre una PR ni una MR: Agentry no llega a git.inmoseo.net, porque ni gh ni glab han iniciado sesión allí.',
   'git.inmoseo.net · pagos/api', [('Abrir Ajustes → Integraciones', False)]),
  ('no-default-branch', 'ni git ni la CLI la nombran', 'github',
   'Sin PR: no se encuentra la rama predeterminada.',
   'Aprobarla no abre una PR: Agentry no ha encontrado la rama predeterminada de este repositorio.',
   'gh: HTTP 404: Not Found (repos/yeyo/claude-wrapper)', [('Documentación de gh', True)]),
  ('cli-missing', 'glab no se encuentra o no responde', 'gitlab',
   'Sin MR: glab no está instalado.',
   'Aprobarla no abre una MR: glab no está instalado, o Agentry no lo encuentra.',
   'glab: command not found', [('Ver instalación', True), ('Elegir binario', False)]),
  ('cli-incompatible', 'versión por debajo del mínimo', 'gitlab',
   'Sin MR: glab 1.80.0 es demasiado antigua.',
   'Aprobarla no abre una MR: glab 1.80.0 es anterior a la 1.120.0, la más antigua con la que funciona Agentry.',
   'glab 1.80.0', [('Ver instalación', True)]),
  ('cli-signed-out', 'la CLI no tiene sesión en ese host', 'gitlab',
   'Sin MR: glab no ha iniciado sesión.',
   'Aprobarla no abre una MR: glab no ha iniciado sesión en git.inmoseo.net.',
   'glab auth status --hostname git.inmoseo.net · salida 1', [('Cómo iniciar sesión', True)]),
]


def board_note(r, mobile=False):
  """The quiet note on the card of an item that waits for the person: the warn line and its remedy
  above the approval, which stays "Aprobar y pasar a Hecho" because no PR or MR will open."""
  code, _, _, line, _, detail, remedy = r
  note = no_pr_line(line, remedy)
  strip = (f'<div class="wi-strip wait"><span class="badge b-idle">te espera</span><span class="verb">QA la dio por buena</span>{note}'
           f'<button type="button" class="btn btn-sm" title="{detail}">{ico("check", "ico ico-sm")}Aprobar y pasar a Hecho</button></div>')
  return strip


def item_note(r):
  """The item page's note: the reason in a sentence, the CLI's own line in mono, and the remedy."""
  code, _, _, _, sentence, detail, remedy = r
  links = ''.join(f'<a href="#" class="pr-remedy">{label}{ext_ico() if out else ""}</a>' for label, out in remedy)
  links = f'<span class="row" style="gap: 4px 16px; flex-wrap: wrap">{links}</span>' if links else ''
  return (f'<div class="pr-not-ready" role="note" data-reason="{code}">{ico("warn", "ico")}'
          f'<div class="col" style="gap: 4px; min-width: 0"><span>{sentence}</span><span class="detail">{detail}</span>{links}</div></div>')


def reason_row(r):
  code, when, host, *_ = r
  noun = 'MR' if host == 'gitlab' else 'PR' if host == 'github' else 'PR ni MR'
  head = (f'<div class="col" style="gap: 6px"><span class="mono t-sm" style="font-weight: 500">{code}</span>'
          f'<span class="t-xs fg-3" style="line-height: 1.45">{when}</span>'
          f'<span class="row t-xs fg-2" style="gap: 6px">{"GitLab" if host == "gitlab" else "GitHub" if host == "github" else "sin host"}<span class="fg-3">·</span>{noun}</span></div>')
  board = card('AGN-29', strip=board_note(r))
  item = f'<div class="card col" style="padding: 14px 16px; gap: 10px"><span class="row" style="gap: 8px">{tico("story", True)}<span class="wi-key boxed">AGN-29</span><span class="badge b-idle">te espera</span></span>{item_note(r)}<div class="row" style="gap: 8px"><button type="button" class="btn btn-sm">{ico("check", "ico ico-sm")}Aprobar y pasar a Hecho</button></div></div>'
  return f'<div style="display: grid; grid-template-columns: 210px 340px minmax(0, 1fr); gap: 28px; align-items: start; padding: 18px 0; border-top: 1px solid var(--line)">{head}{board}{item}</div>'


def ready_row():
  head = ('<div class="col" style="gap: 6px"><span class="mono t-sm" style="font-weight: 500">ready</span>'
          '<span class="t-xs fg-3" style="line-height: 1.45">Con la CLI lista, la aprobación abre la solicitud.</span>'
          '<span class="row t-xs fg-2" style="gap: 6px">GitLab<span class="fg-3">·</span>MR</span></div>')
  board = card('AGN-29', strip=approve_strip('QA la dio por buena', 'Aprobar y abrir MR'))
  item = (f'<div class="card col" style="padding: 14px 16px; gap: 10px"><span class="row" style="gap: 8px">{tico("story", True)}<span class="wi-key boxed">AGN-29</span><span class="badge b-idle">te espera</span></span>'
          f'<span class="t-sm fg-2" style="line-height: 1.5">Aprobarla abre su MR hacia <span class="mono">main</span>.</span>'
          f'<div class="row" style="gap: 8px"><button type="button" class="btn btn-sm">{ico("check", "ico ico-sm")}Aprobar y abrir MR</button></div></div>')
  return f'<div style="display: grid; grid-template-columns: 210px 340px minmax(0, 1fr); gap: 28px; align-items: start; padding: 18px 0">{head}{board}{item}</div>'


def readiness_sheet():
  """DSIntegraciones, section "Avisos de preparación". The page is written by whoever runs last with
  the sections it knows: SECTIONS is the list other tasks of P0 add their own to."""
  cols_head = ('<div style="display: grid; grid-template-columns: 210px 340px minmax(0, 1fr); gap: 28px; padding-bottom: 8px">'
               '<span class="t-label">Motivo</span><span class="t-label">En el tablero</span><span class="t-label">En la tarea</span></div>')
  rows = ready_row() + ''.join(reason_row(r) for r in REASONS)
  phone_r = REASONS[6]
  phone = (f'<div class="app m-screen" data-theme="dark" style="width: 390px; height: auto; border-radius: var(--r-xl); border: 1px solid var(--line-2); overflow: hidden; padding: 14px 0 16px">'
           f'<div class="m-body stack" style="gap: 12px; overflow: visible">'
           f'{mrow("AGN-29", strip=board_note(phone_r))}'
           f'<div class="card col" style="padding: 14px; gap: 8px"><span class="row" style="gap: 8px">{tico("story", True)}<span class="wi-key boxed">AGN-29</span><span class="badge b-idle">te espera</span></span>{item_note(phone_r)}</div>'
           f'</div></div>')
  rules = [
    ('01', 'Una línea, un motivo', 'El aviso dice por qué no se abre la PR o la MR, en el color de aviso y con su palabra. La línea de la CLI va debajo, en mono, o como título en la tarjeta.'),
    ('02', 'El remedio es un enlace', 'Una página de instalación, la documentación o Ajustes → Integraciones. Nunca un comando para copiar. not-git no tiene remedio: no hay nada que enlazar.'),
    ('03', 'La aprobación no cambia', 'Sin PR ni MR, aprobar sigue pasando la tarea a Hecho. Con la CLI lista, el botón dice «Aprobar y abrir MR» o «Aprobar y abrir PR».'),
    ('04', 'La palabra sigue al host', 'MR y !12 en GitLab, PR y #12 en GitHub. Sin host conocido, «PR ni MR».'),
  ]
  principles = ''.join(f'<div class="card col" style="padding: 18px; gap: 8px"><span class="mono t-xs fg-3">{n}</span><h2 class="t-h2">{t}</h2><p class="t-sm fg-2" style="margin: 0; line-height: 1.5">{x}</p></div>' for n, t, x in rules)
  head = ('<header class="col" style="gap: 8px"><span class="t-label">Agentry design system · integraciones · avisos de preparación</span>'
          '<h1 class="t-display" style="margin: 0">Cuando un proyecto no puede abrir PR ni MR</h1>'
          '<p class="fg-2" style="margin: 0; max-width: 900px; line-height: 1.55">Siete motivos, del repositorio a la sesión de la CLI. Cada uno aparece dos veces: como línea discreta '
          'en la tarjeta del tablero y como nota en la página de la tarea, y las dos llevan su remedio.</p></header>')
  body = f'''<div class="app col" data-theme="dark" style="width: 1440px; height: 3100px; padding: 56px 64px; gap: 36px; overflow: hidden">
{head}
<section style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px">{principles}</section>
<section class="col" id="avisos" style="gap: 0"><span class="t-label" style="padding-bottom: 14px">Los siete avisos</span>{cols_head}{rows}</section>
<section class="col" style="gap: 12px"><span class="t-label">Móvil: sin sesión en GitLab</span>{phone}</section>
</div>'''
  write('DSIntegraciones.html', page('Design system · Integraciones', body))


# ---------------------------------------------------------------- the orchestration's merge request
ORCH_STEPS = ['Etapa 1', 'Etapa 2', 'Etapa 3', 'Integración', 'Verificación', 'Síntesis']


def orch_steps(last):
  """The seven steps of a finished run; the last, the merge request, is idle while it waits."""
  done = ''.join(f'<li class="col" style="gap: 8px"><div class="bar ok"><i style="width: 100%"></i></div><span class="row t-sm" style="gap: 6px; font-weight: 500">{ico("check", "ico ico-sm", "color: var(--ok)")}{s}</span><span class="mono t-xs fg-3">hecha</span></li>' for s in ORCH_STEPS)
  word = {'todo': ('pendiente', 'fg-3', 'fg-2'), 'wait': ('esperando fusión', 'fg-2', 'fg-2')}[last]
  tail = f'<li class="col" style="gap: 8px"><div class="bar"><i style="width: 0"></i></div><span class="t-sm {word[2]}">Merge request</span><span class="mono t-xs {word[1]}">{word[0]}</span></li>'
  return f'<ol aria-label="Pasos" style="margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px">{done}{tail}</ol>'


def orch_integration(opened):
  branch = f'<span class="row" style="gap: 8px">{ico("branch", "ico fg-3")}<span class="mono t-sm">orch/spanish-copy</span><span class="mono t-xs fg-3">desde main</span></span>'
  merged = '<span class="mono t-xs fg-2">6/6 ramas de tarea fusionadas</span>'
  if opened:
    mr = (f'<a href="#" class="pr-row" target="_blank" rel="noreferrer" aria-label="Abrir MR !14 en GitLab" style="min-height: 44px"><span class="pr-num">MR !14</span>'
          f'<span class="pr-branch">orch/spanish-copy → main</span><span class="badge b-idle">esperando fusión</span>{ci_badge("passing")}{ext_ico()}</a>')
    foot = (f'<div class="row" style="gap: 10px"><span class="t-xs fg-3 grow" style="line-height: 1.45">Agentry sigue la MR en git.inmoseo.net con glab 1.120.0. Cuando se fusione, te lo dirá aquí y quitará los worktrees.</span>'
            f'<a href="#" class="btn" target="_blank" rel="noreferrer">{ext_ico()}Abrir MR !14 en GitLab</a></div>')
    title = 'Su merge request'
  else:
    mr = ''
    foot = (f'<div class="row" style="gap: 10px"><span class="t-xs fg-3 grow" style="line-height: 1.45">Sube la rama a origin y abre una merge request hacia main en git.inmoseo.net con glab.</span>'
            f'<button type="button" class="btn btn-primary">{ico("branch", "ico")}Abrir merge request</button></div>')
    title = 'Integración'
  return (f'<section class="card card-pad col" style="gap: 14px"><div class="row" style="gap: 10px"><h2 class="t-h2 grow">{title}</h2>{merged}</div>'
          f'{branch}{mr}{foot}</section>')


def orch_main(opened):
  return f'''<main class="page" style="gap: 18px">
<div class="row" style="gap: 12px">
<a href="DesktopOrquestaciones.html" class="btn btn-icon btn-sm" aria-label="Volver a orquestaciones">{ico('left')}</a>
<h1 class="t-h1">spanish-copy</h1>
<span class="badge b-ok" style="height: 24px">{ico('check', 'ico ico-sm')}completada</span>
<span class="grow"></span>
<button type="button" class="btn">{ico('folder')}Ver worktree</button>
</div>
<div class="card card-pad col" style="gap: 10px">
<span class="t-label">Objetivo</span>
<p style="margin: 0; line-height: 1.55">Rewrite the Spanish UI copy so it reads as written in Spanish from Spain: a revised glossary, then every es locale file.</p>
<div class="row" style="gap: 6px; flex-wrap: wrap"><span class="badge">sonnet</span><span class="badge">un worktree por tarea</span><span class="badge">6 tareas</span><span class="badge">20:32</span></div>
</div>
{orch_steps('wait' if opened else 'todo')}
{orch_integration(opened)}
</main>'''


def orch_dialog():
  return f'''<div class="scrim" style="z-index: 30">
<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="push-title" style="width: 520px">
<div class="dialog-head"><h2 id="push-title" class="t-h2 grow">¿Subir <span class="mono">orch/spanish-copy</span>?</h2><button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Cerrar">{ico('x')}</button></div>
<div class="dialog-body">
<p class="t-sm fg-2" style="margin: 0; line-height: 1.55">La rama se sube a origin y se abre una merge request para ella con glab.</p>
<div class="callout" style="align-items: flex-start">{ico('git', 'ico fg-3', 'flex-shrink: 0; margin-top: 1px')}<span class="col" style="gap: 4px"><span class="mono" style="color: var(--fg)">orch/spanish-copy → main</span><span class="mono t-xs fg-3">git.inmoseo.net · pagos/api · glab 1.120.0 · yeyo</span></span></div>
</div>
<div class="dialog-foot"><span class="grow"></span><button type="button" class="btn btn-ghost">Cancelar</button><button type="button" class="btn btn-primary">Subir y abrir la MR</button></div>
</div>
</div>'''


def orch_mr_desktop(name, opened, dialog=False):
  crumb = '<a href="DesktopOrquestaciones.html" class="fg-2">Orquestaciones</a><span class="fg-3">/</span><span style="font-weight: 500">spanish-copy</span>'
  write(name, desktop('Orquestación con MR', 'orch', crumb, orch_main(opened), overlay=orch_dialog() if dialog else ''))


def orch_mr_mobile(name, opened, dialog=False):
  head = (f'<header class="row" style="flex-shrink: 0; padding: 8px 4px; gap: 2px"><a href="MobileOrquestaciones.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver">{ico("left", "ico ico-lg", "stroke-width: 2")}</a>'
          f'<span class="col grow" style="gap: 2px"><span style="font-weight: 600; font-size: 16px">spanish-copy</span><span class="row t-xs mono c-ok" style="gap: 6px">{ico("check", "ico ico-sm")}completada</span></span>'
          f'<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Más acciones">{ico("more", "ico ico-lg", "stroke-width: 3")}</button></header>')
  chips = ''.join(f'<span class="badge b-ok" style="height: 28px; flex-shrink: 0">✓ {s.lower()}</span>' for s in ['etapas', 'integración', 'verificación']) \
    + ('<span class="badge b-idle" style="height: 28px; flex-shrink: 0">MR !14</span>' if opened else '<span class="badge" style="height: 28px; flex-shrink: 0">merge request</span>')
  if opened:
    card_ = (f'<section class="card col" style="padding: 14px; gap: 12px"><span class="row" style="gap: 8px"><span class="t-label grow">Su merge request</span><span class="mono t-xs fg-3">6/6 ramas fusionadas</span></span>'
             f'<a href="#" class="pr-row" target="_blank" rel="noreferrer" aria-label="Abrir MR !14 en GitLab"><span class="pr-num">MR !14</span><span class="pr-branch">orch/spanish-copy → main</span>'
             f'<span class="badge b-idle">esperando fusión</span>{ci_badge("passing")}</a>'
             f'<span class="t-xs fg-3" style="line-height: 1.45">Agentry sigue la MR en git.inmoseo.net. Cuando se fusione, te lo dirá aquí y quitará los worktrees.</span></section>')
    foot = f'<div class="m-foot"><a href="#" class="btn btn-lg grow" style="justify-content: center" target="_blank" rel="noreferrer">{ext_ico("ico ico-lg")}Abrir MR !14 en GitLab</a></div>'
  else:
    card_ = (f'<section class="card col" style="padding: 14px; gap: 10px"><span class="row" style="gap: 8px"><span class="t-label grow">Integración</span><span class="mono t-xs fg-3">6/6 ramas fusionadas</span></span>'
             f'<span class="row" style="gap: 8px">{ico("branch", "ico fg-3")}<span class="mono t-sm">orch/spanish-copy</span><span class="mono t-xs fg-3">desde main</span></span>'
             f'<span class="t-xs fg-3" style="line-height: 1.45">Sube la rama a origin y abre una merge request hacia main en git.inmoseo.net con glab.</span></section>')
    foot = f'<div class="m-foot"><button type="button" class="btn btn-lg btn-primary grow" style="justify-content: center">{ico("branch", "ico ico-lg")}Abrir merge request</button></div>'
  sheet_ = ''
  if dialog:
    sheet_ = f'''{scrim()}
<div class="sheet" role="dialog" aria-label="Subir la rama" style="z-index: 11; padding-bottom: 28px; display: flex; flex-direction: column; gap: 12px">
<div class="grab" style="margin-bottom: 0"></div>
<div class="col" style="gap: 2px"><h2 class="t-h2">¿Subir <span class="mono">orch/spanish-copy</span>?</h2></div>
<p class="t-sm fg-2" style="margin: 0; line-height: 1.5">La rama se sube a origin y se abre una merge request para ella con glab.</p>
<div class="callout" style="align-items: flex-start">{ico('git', 'ico fg-3', 'flex-shrink: 0; margin-top: 1px')}<span class="col" style="gap: 4px; min-width: 0"><span class="mono" style="color: var(--fg)">orch/spanish-copy → main</span><span class="mono t-xs fg-3" style="overflow-wrap: anywhere">git.inmoseo.net · pagos/api · glab 1.120.0 · yeyo</span></span></div>
<div class="row" style="gap: 8px"><button type="button" class="btn btn-lg">Cancelar</button><button type="button" class="btn btn-lg btn-primary grow" style="justify-content: center">Subir y abrir la MR</button></div>
</div>'''
  inner = (f'{head}\n<div class="m-body" style="gap: 14px"><p class="t-sm fg-2" style="margin: 0; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden">Rewrite the Spanish UI copy so it reads as written in Spanish from Spain: a revised glossary, then every es locale file.</p>'
           f'<div class="row" style="gap: 6px; overflow: hidden">{chips}</div>{card_}</div>\n{foot}\n{sheet_}')
  write(name, mobile('Orquestación con MR', inner, 'glow-top', 'background-size: 100% 300px'))


# ---------------------------------------------------------------- run
if __name__ == '__main__':
  readiness_sheet()
  orch_mr_desktop('DesktopOrquestacionMR.html', True)
  orch_mr_desktop('DesktopOrquestacionMRSubir.html', False, dialog=True)
  orch_mr_mobile('MobileOrquestacionMR.html', True)
  orch_mr_mobile('MobileOrquestacionMRSubir.html', False, dialog=True)
