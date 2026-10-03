# Rotation between providers, P0 `p3` (second part): a flow run that moved (`DesktopChatFlujoMovido`,
# `MobileChatFlujoMovido`) and the retirement notice on Home (`Main`, `MobileInicio`, patched in place
# between <!--rot-home--> markers) and in Settings → Providers (`DesktopProveedoresRetirada`,
# `MobileProveedoresRetirada`). Imported and run by rotation_work.py; it can also run on its own.
#   python3 rotation_flow.py
import os

from data import role, sico
from common import OUT, ico, desktop, mobile, write
import providers as prv
from providers import PROV
from desktop import TEAM_LIVE
from rotation_work import ACCOUNT, chain, mark, modernize, put, read


# ---------------------------------------------------------------- a flow run that moved
def part_of(mobile=False):
  if mobile:
    return (f'<a href="MobileTarea.html" class="part-of" style="margin: 0 16px">{role("DEV", "xs")}<span class="col grow" style="gap: 2px; min-width: 0">'
            f'<span class="row t-xs" style="gap: 6px"><span>Implementación de</span><span class="wi-key">AGN-28</span><span class="grow"></span><span class="row" style="gap: 5px">{sico("in_progress")}En curso</span></span>'
            f'<span class="ellipsis t-sm" style="font-weight: 600">Tablero con columnas fijas</span></span></a>')
  return (f'<div class="part-of" style="white-space: nowrap">{role("DEV", "xs")}<span>Implementación de</span><span class="wi-key boxed">AGN-28</span>'
          f'<a href="DesktopTarea.html" class="ellipsis">Tablero con columnas fijas</a><span class="grow"></span><span class="row t-xs" style="gap: 6px">{sico("in_progress")}En curso</span>'
          f'<span class="mono t-xs fg-3">criterios 2/4</span></div>')


def moved_note(mobile=False):
  size = 'btn btn-lg' if mobile else 'btn btn-sm'
  acts = (f'<div class="row" style="gap: 8px; flex-wrap: wrap"><button type="button" class="{size}">Ver el traspaso</button>'
          f'<a href="{"Mobile" if mobile else "Desktop"}Chat.html" class="{size} btn-ghost">Abrir el chat anterior</a></div>')
  how = ('Claude Code llegó a su límite de 5 h y el trabajo siguió en Codex, con un traspaso. Sigue siendo la ejecución de Desarrollador de AGN-28.' if not mobile
         else 'Claude Code llegó a su límite de 5 h y el trabajo siguió en Codex, con un traspaso. Es la misma ejecución de AGN-28.')
  return (f'<div class="callout" role="status" style="align-items: flex-start">{ico("move", "ico fg-3", "flex-shrink: 0; margin-top: 2px")}<div class="col" style="gap: 8px; min-width: 0">'
          f'<span><b style="color: var(--fg); font-weight: 500">Esta ejecución continúa aquí desde Claude Code.</b> {how}</span>'
          f'<div class="chain-row">{chain(["claude-code", "codex"], link=not mobile)}<span class="chain-how">traspaso · 13:48 · gpt-6.1-sol</span></div>{acts}</div></div>')


def handoff_bubble():
  return (f'<div class="col" style="align-self: flex-end; max-width: 82%; gap: 4px; background: var(--bg-2); border: 1px dashed var(--line-3); border-radius: var(--r-xl) var(--r-xl) var(--r-xs) var(--r-xl); padding: 11px 15px; font-size: 14px">'
          f'<span class="row t-xs" style="gap: 6px; color: var(--fg-3); font-family: var(--mono)">{ico("flow", "ico ico-sm")} flujo automático · En curso → Desarrollador</span>'
          f'<span><b>Traspaso desde Claude Code</b> · 4,2 KiB<br>Lo pedido, lo hecho, dónde queda y lo que falta, sacado de su chat y del worktree <span class="mono">task/agn-28</span>.</span></div>')


def prov_badge(pid):
  label, letters, hue = PROV[pid]
  return f'<span class="prov-badge"><span class="prov-mark" style="--hue: {hue}" aria-hidden="true">{letters}</span>{label}</span>'


def working_line():
  return ('<div class="row t-sm" style="gap: 8px"><span class="spin-braille"></span><span class="shimmer">Codex está trabajando</span>'
          '<span class="mono t-xs fg-3">pnpm test · 0:42</span></div>')


def flow_moved_desktop():
  main = f'''<div class="row" style="flex: 1 1 auto; min-height: 0; align-items: stretch; gap: 0">
<div class="col grow" style="gap: 0; min-width: 0">
<div class="row" style="height: 56px; padding: 0 20px 0 12px; border-bottom: 1px solid var(--line); gap: 10px; flex-shrink: 0">
<a href="DesktopEquipoActividad.html" class="btn btn-ghost btn-icon btn-sm" aria-label="Volver">{ico('left')}</a>
<span class="col grow" style="gap: 3px; min-width: 0"><span class="ellipsis" style="font-weight: 600">Desarrollador implementa AGN-28: tablero con columnas fijas</span><span class="row mono t-xs fg-3" style="gap: 8px">claude-wrapper · 7e41c0 {prov_badge('codex')} gpt-6.1-sol</span></span>
<span class="badge b-live"><span class="spin-braille" style="width: auto"></span>en marcha</span><span class="mono t-xs fg-3">9 min 12 s</span>
<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Buscar en el chat">{ico('search')}</button>
<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Más acciones">{ico('more', 'ico', 'stroke-width: 3')}</button>
</div>
<div style="padding: 12px 32px 0; display: flex; justify-content: center; flex-shrink: 0"><div class="col" style="width: 100%; max-width: 740px; gap: 10px">{part_of()}{moved_note()}</div></div>
<div style="flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; justify-content: center; padding: 20px 32px 0">
<div class="col" style="width: 100%; max-width: 740px; gap: 16px; font-size: 14px; line-height: 1.65">
{handoff_bubble()}
<p style="margin: 0">Retomo desde el traspaso: las columnas ya salen en orden fijo y el estado se guarda al recargar. Falta el test que lo comprueba tras una recarga.</p>
<div class="row t-xs" style="gap: 8px; font-family: var(--mono); color: var(--fg-3)">{ico('check', 'ico ico-sm c-ok', 'stroke-width: 2.4')}<span>2 herramientas · 21 s</span><span class="badge">Read ×2</span>{ico('down', 'ico ico-sm')}</div>
<p style="margin: 0">Escribo el test en <code>board-order.test.ts</code> y lo ejecuto.</p>
{working_line()}
</div>
</div>
<div style="display: flex; justify-content: center; padding: 12px 32px 18px; flex-shrink: 0">
<div class="col" style="width: 100%; max-width: 780px; gap: 8px">
<div class="card" style="border-radius: var(--r-xl); padding: 10px; display: flex; align-items: flex-end; gap: 8px">
<button type="button" class="btn btn-ghost btn-icon" aria-label="Adjuntar">{ico('clip')}</button>
<label class="grow" style="display: flex; min-height: 36px; align-items: center"><textarea rows="1" placeholder="Escribe para intervenir: el flujo sigue trabajando" aria-label="Mensaje" style="width: 100%; border: 0; outline: 0; resize: none; background: transparent; font-size: 14px; padding: 0"></textarea></label>
<button type="button" class="btn btn-primary btn-icon" aria-label="Enviar">{ico('send', 'ico', 'stroke-width: 2.2')}</button>
</div>
<div class="row" style="gap: 6px"><button type="button" class="chip" disabled>gpt-6.1-sol</button><button type="button" class="chip">Aceptar ediciones</button><button type="button" class="chip">{ico('branch', 'ico ico-sm')}task/agn-28</button><span class="grow"></span><span class="t-xs fg-3 mono">↵ enviar · ⇧↵ salto</span></div>
</div>
</div>
</div>
<aside aria-label="Detalles del chat" class="col" style="width: 320px; flex-shrink: 0; border-left: 1px solid var(--line); background: var(--bg-1); gap: 0">
<div class="tabs" role="tablist" style="padding: 8px 16px 0; height: 56px; align-items: flex-end"><button type="button" role="tab" aria-selected="true" class="tab on">Resumen</button><button type="button" role="tab" aria-selected="false" class="tab">Actividad</button><button type="button" role="tab" aria-selected="false" class="tab">Cambios</button><button type="button" role="tab" aria-selected="false" class="tab">Entorno</button></div>
<div class="col" style="padding: 18px; gap: 22px">
<section class="col" style="gap: 0">
<div class="row" style="padding-bottom: 8px"><span class="t-label grow">Ejecución del flujo</span><a href="DesktopEquipoActividad.html" class="t-xs c-accent">Todas</a></div>
<div class="prop-row"><span class="k" style="width: 104px">Miembro</span><span class="v">{role('DEV', 'sm')}Desarrollador</span></div>
<div class="prop-row"><span class="k" style="width: 104px">Etapa</span><span class="v">Implementación · En curso</span></div>
<div class="prop-row"><span class="k" style="width: 104px">Proveedor</span><span class="v">{chain(['claude-code', 'codex'])}</span></div>
<div class="prop-row"><span class="k" style="width: 104px">Modelo</span><span class="v"><span class="model-tag">gpt-6.1-sol</span></span></div>
<div class="prop-row"><span class="k" style="width: 104px">Estado</span><span class="v"><span class="badge b-live"><span class="spin-braille" style="width: auto"></span>en marcha</span></span></div>
<div class="prop-row"><span class="k" style="width: 104px">Movimientos</span><span class="v t-num">1 de 2</span></div>
<div class="prop-row"><span class="k" style="width: 104px">Duración</span><span class="v">9 min 12 s</span></div>
<div class="prop-row"><span class="k" style="width: 104px">Coste</span><span class="v t-num">0,71 US$</span><span class="t-xs fg-3">Codex no informa del coste</span></div>
</section>
<section class="col" style="gap: 0">
<div class="row" style="padding-bottom: 8px"><span class="t-label grow">Tarea</span><a href="DesktopTarea.html" class="t-xs c-accent">Abrir</a></div>
<div class="prop-row"><span class="k" style="width: 104px">Clave</span><span class="v"><span class="wi-key boxed">AGN-28</span></span></div>
<div class="prop-row"><span class="k" style="width: 104px">Estado</span><span class="v">{sico('in_progress')}En curso</span></div>
<div class="prop-row"><span class="k" style="width: 104px">Criterios</span><span class="v"><span class="mono t-xs">2/4</span><span class="wi-crit"><span class="bar"><i style="width: 50%"></i></span></span></span></div>
</section>
</div>
</aside>
</div>'''
  crumb = '<a href="DesktopChats.html" class="fg-2">Chats</a><span class="fg-3">/</span><span class="mono" style="font-weight: 500">7e41c0</span>'
  write('DesktopChatFlujoMovido.html', desktop('Chat de una ejecución de flujo que cambió de proveedor', 'chats', crumb, main, live=TEAM_LIVE, agents=3, running=3))


def flow_moved_mobile():
  inner = f'''<header class="row" style="flex-shrink: 0; padding: 8px 4px; gap: 2px">
<a href="MobileEquipoActividad.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver">{ico('left', 'ico ico-lg', 'stroke-width: 2')}</a>
<span class="col grow" style="gap: 3px; min-width: 0"><span style="font-weight: 600; font-size: 16px; line-height: 1.3">Desarrollador implementa AGN-28</span><span class="row" style="gap: 8px">{prov_badge('codex')}<span class="row t-xs mono" style="gap: 6px"><span class="spin-braille"></span><span class="c-live">en marcha</span></span></span></span>
<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Más acciones">{ico('more', 'ico ico-lg', 'stroke-width: 3')}</button>
</header>
{part_of(True)}
<div class="col" style="flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 12px 16px 0; gap: 14px; font-size: 15px; line-height: 1.6">
{moved_note(True)}
<div class="col" style="align-self: flex-end; max-width: 88%; gap: 4px; background: var(--bg-2); border: 1px dashed var(--line-3); border-radius: var(--r-xl) var(--r-xl) var(--r-xs) var(--r-xl); padding: 10px 14px; font-size: 14px; line-height: 1.5"><span class="row t-xs" style="gap: 6px; color: var(--fg-3); font-family: var(--mono)">{ico('flow', 'ico ico-sm')} flujo automático</span><span><b>Traspaso desde Claude Code</b> · 4,2 KiB</span></div>
<p style="margin: 0">Retomo desde el traspaso: falta el test del orden tras recargar.</p>
{working_line()}
</div>
<div class="m-foot" style="align-items: center"><label class="field field-lg grow"><input type="text" placeholder="Escribe para intervenir" aria-label="Mensaje" style="font-size: 16px"></label><button type="button" class="btn btn-primary btn-icon btn-lg" aria-label="Enviar" style="flex: 0 0 auto">{ico('send', 'ico ico-lg', 'stroke-width: 2.2')}</button></div>'''
  write('MobileChatFlujoMovido.html', mobile('Chat de una ejecución de flujo que cambió de proveedor', inner))


# ---------------------------------------------------------------- the retirement notice
def notice(mob=False):
  """What changed with claude-swap, which account is in force, what is gone and what was left alone."""
  if mob:
    acct = (f'<b>{ACCOUNT}</b>, la que dejó activa claude-swap. Claude Code la usa como siempre. Para cambiarla, inicia sesión de nuevo en Claude Code '
            f'o guarda un token en Ajustes.')
    acct_link = '<a href="MobileAjustes.html" class="btn btn-lg" style="margin-top: 8px; justify-content: center">Abrir Ajustes → Cuenta</a>'
    proj_links = ''.join(f'<a href="MobileProyectoAjustes.html" class="chip" style="margin: 8px 6px 0 0">{p}</a>' for p in ('claude-wrapper', 'google-docs-mcp'))
  else:
    acct = (f'<b>{ACCOUNT}</b>, la que dejó activa claude-swap. Claude Code la usa como siempre. Para cambiarla, inicia sesión de nuevo en Claude Code '
            f'o guarda un token en <a href="DesktopAjustes.html" class="c-accent">Ajustes → Cuenta</a>.')
    acct_link = ''
    proj_links = ''.join(f'<a href="DesktopProyectoAjustes.html" class="chip" style="margin-left: 6px">{p}</a>' for p in ('claude-wrapper', 'google-docs-mcp'))
  facts = f'''<dl class="retire-facts">
<dt>Cuenta en uso</dt><dd>{acct}{acct_link}</dd>
<dt>Qué ha cambiado</dt><dd>Cuando un proveedor llega a su límite, el trabajo ya no rota de cuenta: continúa en otro con un traspaso, empieza de nuevo allí o espera al reinicio. Lo eliges en «Cuando un proveedor llega a su límite». Hasta que lo cambies, espera.</dd>
<dt>Políticas quitadas</dt><dd>Dos proyectos tenían una política de rotación que ya no existe. Cada uno abre su orden de proveedores:{'<br>' if mob else ''}{proj_links}</dd>
<dt>Sin tocar</dt><dd>claude-swap y sus cuentas siguen donde estaban, y <span class="mono">cswap</span> funciona desde una terminal.</dd>
</dl>'''
  ok = '<button type="button" class="btn btn-lg">Entendido</button>' if mob else ''
  rm = (f'<button type="button" class="btn {"btn-lg " if mob else "btn-sm "}btn-danger">{ico("trash", "ico" if mob else "ico ico-sm")}Quitar la copia de claude-swap de Agentry</button>'
        f'<span class="t-xs fg-3 grow" style="line-height: 1.45">Borra solo la que Agentry instaló en su carpeta de datos. Nada más.</span>')
  head_btn = '' if mob else '<button type="button" class="btn btn-sm">Entendido</button>'
  sub = ('Ahora el trabajo pasa de un proveedor a otro cuando uno llega a su límite. Este aviso sale una sola vez.' if not mob
         else 'El trabajo pasa de un proveedor a otro cuando uno llega a su límite. Este aviso sale una sola vez.')
  return f'''<section class="card retire" aria-labelledby="retire-title">
<div class="retire-head"><span class="proj" style="background: var(--idle-soft); color: var(--idle); flex-shrink: 0">{ico('info', 'ico ico-sm')}</span>
<span class="col grow" style="gap: 2px; min-width: 0"><h2 class="t-h2" id="retire-title">Agentry ya no cambia de cuenta de Claude</h2><span class="t-sm fg-2" style="line-height: 1.45">{sub}</span></span>{head_btn}</div>
{facts}
<div class="retire-foot">{ok}{rm}</div>
</section>'''


def home_notice_desktop():
  return ('<section class="card">\n<div class="card-head"><h2 class="t-h2 grow">Proveedores</h2><span class="badge b-idle">1 aviso</span>'
          '<a href="DesktopProveedoresRetirada.html" class="btn btn-ghost btn-sm">Ver proveedores<svg class="ico ico-sm" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"></path></svg></a></div>\n'
          '<div class="row" style="padding: 14px 18px; gap: 12px">\n'
          f'<span class="proj" style="background: var(--idle-soft); color: var(--idle)">{ico("info", "ico ico-sm")}</span>\n'
          f'<span class="col grow" style="gap: 1px"><span style="font-weight: 600">Agentry ya no cambia de cuenta de Claude</span><span class="t-xs fg-3 mono">Claude Code sigue con {ACCOUNT} · el trabajo pasa entre proveedores</span></span>\n'
          '<button type="button" class="btn btn-sm btn-ghost">Entendido</button><a href="DesktopProveedoresRetirada.html" class="btn btn-sm">Ver qué cambia</a>\n</div>\n</section>\n\n')


def home_notice_mobile():
  return (f'<section class="col" style="gap: 8px">\n<div class="row"><span class="t-label grow">Proveedores</span><a href="MobileProveedoresRetirada.html" class="t-xs fg-2" style="min-height: 44px; display: inline-flex; align-items: center">Ver todos</a></div>\n'
          f'<div class="card col" style="padding: 14px; gap: 12px">\n<div class="row" style="gap: 10px"><span class="proj" style="background: var(--idle-soft); color: var(--idle)">{ico("info", "ico ico-sm")}</span>'
          f'<span class="col grow" style="gap: 1px"><span style="font-weight: 600">Agentry ya no cambia de cuenta de Claude</span><span class="mono t-xs fg-3">sigue con {ACCOUNT}</span></span></div>\n'
          '<div class="row"><button type="button" class="btn grow" style="justify-content: center">Entendido</button><a href="MobileProveedoresRetirada.html" class="btn grow" style="justify-content: center">Ver qué cambia</a></div>\n</div>\n</section>\n\n')


def patch_home():
  h = modernize(read('Main'))
  anchor = '<section class="card energy">'
  h = put(h, 'rot-home', home_notice_desktop(), anchor, anchor)
  open(os.path.join(OUT, 'Main.html'), 'w').write(h)
  print('patched Main.html')
  h = modernize(read('MobileInicio'))
  anchor = '<section class="col" style="gap: 8px">\n<div class="row"><span class="t-label grow">En marcha</span>'
  h = put(h, 'rot-home', home_notice_mobile(), anchor, anchor)
  open(os.path.join(OUT, 'MobileInicio.html'), 'w').write(h)
  print('patched MobileInicio.html')


def captured(fn, *a, **kw):
  got, real = [], prv.write
  prv.write = lambda name, html: got.append(html)
  try:
    fn(*a, **kw)
  finally:
    prv.write = real
  return got[0]


def retirement_screens():
  h = captured(prv.desktop_settings, 'x', 'Ajustes, proveedores con el aviso de claude-swap', prv.MACHINE_A)
  anchor = '<section class="card grad-border col"'
  assert anchor in h
  write('DesktopProveedoresRetirada.html', h.replace(anchor, notice() + anchor, 1))
  h = captured(prv.mobile_settings, 'x', 'Ajustes, proveedores con el aviso de claude-swap', prv.MACHINE_A)
  anchor = '<div class="m-body" style="gap: 12px">'
  assert anchor in h
  write('MobileProveedoresRetirada.html', h.replace(anchor, anchor + notice(True), 1))


def all_flow():
  flow_moved_desktop()
  flow_moved_mobile()
  patch_home()
  retirement_screens()


if __name__ == '__main__':
  all_flow()
