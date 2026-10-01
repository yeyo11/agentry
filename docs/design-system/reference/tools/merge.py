# Merging of a change request (plans/code-hosts.md, phase 4, P0). One function per task, each under its own
# banner: m-p3 is the orchestration's merge and the board card's auto-merge badge. m-p1 and m-p2 add theirs.
# Runs on its own: it imports common.py, data.py, board.py, hosts.py and checks.py (the orchestration page it extends).
#   python3 merge.py
from data import *
from common import P, ico, desktop, mobile, write, tabbar
from board import head, toolbar, epics_first, marks, mhead, mrow, msection, jump, mtoolbar, mproject_chip, mview_seg
from checks import orch_head, mr_row, m_head, BRANCH, HEAD
from hosts import orch_steps


# ================================================================ m-p3 · the orchestration's merge, the board badge
# Merging is the person's click, from this page: never from a run. The integration branch has its own
# MR !14 on GitLab (git.inmoseo.net). What differs from an item's merge is what happens after: the
# worktrees go, and the branch box deletes the integration branch, not a task's.
METHODS = ['Squash', 'Merge commit', 'Rebase']


def method_seg():
  opts = ''.join(f'<button type="button" role="radio" aria-checked="{"true" if i == 0 else "false"}"{" class=\"on\"" if i == 0 else ""}>{m}</button>' for i, m in enumerate(METHODS))
  return f'<div class="seg" role="radiogroup" aria-label="Método de fusión">{opts}</div>'


def branch_box():
  return (f'<label class="omrg-row"><span class="checkbox on" role="checkbox" aria-checked="true"></span>'
          f'<span>Borrar <span class="mono">{BRANCH}</span> en git.inmoseo.net al fusionar</span></label>')


def commit_fields(mobile=False):
  rows = 2 if mobile else 3
  return (f'<div class="col" style="gap: 8px"><span class="t-label">Mensaje del squash</span>'
          f'<label class="field"><input type="text" aria-label="Asunto del commit" value="Redacta la copia en español de España (!14)" style="font-family: var(--mono)"></label>'
          f'<label class="field field-area"><textarea rows="{rows}" aria-label="Cuerpo del commit" placeholder="Cuerpo, opcional">Glosario revisado y los locales es de las seis tareas.</textarea></label></div>')


def guard():
  return (f'<span class="omrg-guard">Se fusiona el commit <span class="mono">{HEAD}</span>, el que ves aquí. '
          'Si la rama cambia antes, no se fusiona nada.</span>')


def omrg_desktop():
  summary = '<span class="mono t-xs fg-2" style="font-variant-numeric: tabular-nums">CI superada · sin conflictos con main · sin revisiones pendientes</span>'
  after = ('<span class="t-xs fg-3 grow" style="line-height: 1.45">Al fusionar, Agentry marca la orquestación como fusionada y quita los 7 worktrees. '
           'La rama local se queda.</span>')
  return (f'<section class="card card-pad col" style="gap: 14px"><div class="row" style="gap: 10px"><h2 class="t-h2 grow">Su merge request</h2>'
          f'<span class="mono t-xs fg-2">6/6 ramas de tarea fusionadas</span></div>{mr_row("passing", "lista para fusionar")}'
          '<hr style="border: 0; border-top: 1px solid var(--line); margin: 0; width: 100%">'
          f'<div class="row" style="gap: 10px; flex-wrap: wrap"><h2 class="t-h2 grow">Fusionar</h2>{summary}</div>'
          f'<div class="omrg-opts"><div class="col" style="gap: 10px"><span class="t-label">Método</span>{method_seg()}'
          f'<span class="t-xs fg-3" style="line-height: 1.45">main permite squash, merge commit y rebase. Squash es el que usa por defecto.</span>{branch_box()}</div>'
          f'{commit_fields()}</div>'
          f'<div class="row" style="gap: 10px">{after}<button type="button" class="btn btn-primary">{ico("check")}Fusionar MR !14</button></div>'
          f'{guard()}</section>')


def omrg_page_desktop():
  main = f'''<main class="page" style="gap: 18px">
{orch_head()}
{orch_steps('wait')}
{omrg_desktop()}
</main>'''
  crumb = '<a href="DesktopOrquestaciones.html" class="fg-2">Orquestaciones</a><span class="fg-3">/</span><span style="font-weight: 500">spanish-copy</span>'
  write('DesktopOrquestacionFusion.html', desktop('Orquestación, fusionar', 'orch', crumb, main))


def omrg_page_mobile():
  chips = ''.join(f'<span class="badge b-ok" style="height: 28px; flex-shrink: 0">✓ {s}</span>' for s in ['etapas', 'integración', 'verificación'])
  chips += '<span class="badge b-idle" style="height: 28px; flex-shrink: 0">MR !14</span>'
  mr = (f'<a href="#" class="pr-row" target="_blank" rel="noreferrer" aria-label="Abrir MR !14 en GitLab"><span class="pr-num">MR !14</span><span class="pr-branch">{BRANCH} → main</span>'
        f'<span class="badge b-idle">lista para fusionar</span>{ci_badge("passing")}</a>')
  body = (f'<section class="card col" style="padding: 14px; gap: 12px">{mr}'
          '<span class="mono t-xs fg-2" style="line-height: 1.5">CI superada · sin conflictos con main · sin revisiones pendientes</span>'
          f'<span class="t-label">Método</span>{method_seg()}'
          f'{branch_box()}{commit_fields(True)}{guard()}'
          '<span class="t-xs fg-3" style="line-height: 1.45">Al fusionar, Agentry marca la orquestación como fusionada y quita los 7 worktrees. La rama local se queda.</span></section>')
  foot = f'<div class="m-foot"><button type="button" class="btn btn-lg btn-primary grow" style="justify-content: center">{ico("check", "ico ico-lg")}Fusionar MR !14</button></div>'
  inner = f'{m_head()}\n<div class="m-body" style="gap: 14px"><div class="row" style="gap: 6px; overflow: hidden">{chips}</div>{body}</div>\n{foot}'
  write('MobileOrquestacionFusion.html', mobile('Orquestación, fusionar', inner, 'glow-top', 'background-size: 100% 300px'))


def auto_line(method='squash'):
  """The card's second line when auto-merge is armed: the word, never colour alone. Nothing is working, so nothing moves."""
  return (f'<span class="pr-auto"><span class="badge">{ico("wait", "ico ico-sm")}fusión automática</span>'
          f'<span>se fusiona sola al pasar la CI · {method}</span></span>')


def armed_strip(host='gitlab', n=12, link=True):
  return pr_strip(host, n, 'esperando fusión', ci='pending', link=link).replace('</div>', auto_line() + '</div>', 1)


def board_fusion_desktop():
  # AGN-26's MR !12 has auto-merge armed while its CI runs; AGN-29's is ready and waits for the person.
  cards = {
    'AGN-26': card('AGN-26', strip=armed_strip()),
    'AGN-29': card('AGN-29', strip=pr_strip('gitlab', 13, 'esperando fusión', ci='passing')),
  }
  cols = ''.join(col(s, epics_first(by_col(s)), cards=(''.join(cards[k] for k in by_col(s)) if s == 'in_review' else None), marks=marks()) for s, _ in COLS)
  main = f'''<main class="page" style="gap: 16px; position: relative">
{head('claude-wrapper · 13 abiertas · clave <span class="mono">AGN</span>')}
{toolbar()}
<div class="wi-board">{cols}</div>
</main>'''
  write('DesktopTableroFusion.html', desktop('Tablero · fusión automática', 'tasks', '<span style="font-weight: 500">Tareas</span>', main))


def board_fusion_mobile():
  rows = mrow('AGN-26', strip=armed_strip(link=False)) + mrow('AGN-29', strip=pr_strip('gitlab', 13, 'esperando fusión', ci='passing', link=False))
  sel = f'<a href="MobileTableroSeleccion.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Seleccionar para orquestar">{ico("tasks", "ico ico-lg")}</a>'
  inner = f'''{mhead('Tareas', None, 'MobileMas.html', mproject_chip() + sel)}
<div class="m-body stack" style="gap: 12px; margin-bottom: 76px">
{mview_seg('board')}
{mtoolbar()}
{jump('in_review')}
{msection('in_review', [], rows_html=rows)}
</div>
<a href="MobileNuevaTarea.html" class="fab" aria-label="Nueva tarea" style="padding: 0; width: 56px">{ico('plus', 'ico ico-lg', 'stroke-width: 2.2')}</a>
{tabbar('more')}'''
  write('MobileTableroFusion.html', mobile('Tablero · fusión automática', inner, 'has-fab'))


def all_m_p3():
  omrg_page_desktop()
  omrg_page_mobile()
  board_fusion_desktop()
  board_fusion_mobile()


if __name__ == '__main__':
  all_m_p3()
