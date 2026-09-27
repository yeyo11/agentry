from data import *


def part_of(mobile=False):
  # The chat header's context row: the work item this chat works on (the app's .chat-part-of).
  if mobile:
    return f'''<div class="part-of" style="margin: 0 16px; min-height: 48px">{ico('tasks', 'ico fg-3')}<span class="wi-key">AGN-28</span><a href="MobileTarea.html" class="ellipsis grow" style="font-size: 14px">Tablero con columnas fijas y límites</a>{sico('in_progress')}</div>'''
  return f'''<div class="part-of" style="white-space: nowrap">{ico('tasks', 'ico fg-3')}<span>Trabaja en</span><span class="wi-key boxed">AGN-28</span><a href="DesktopTarea.html" class="ellipsis">Tablero con columnas fijas y límites</a><span class="grow"></span><span class="row t-xs" style="gap: 6px">{sico('in_progress')}En curso</span><span class="mono t-xs fg-3">criterios 2/5</span></div>'''


PROMPT = '''<b>AGN-28 · Tablero con columnas fijas y límites</b><br>Cinco columnas fijas con un límite opcional por columna. Pasarse se permite y se ve en ámbar.<br><span class="fg-2">Criterios de aceptación:</span><br>1. Las cinco columnas salen en su orden · 2. El límite se ve en la cabecera · …'''


def chat_desktop():
  menu = f'''<div class="menu" role="menu" aria-label="Acciones del mensaje" style="position: absolute; right: -8px; top: 34px; width: 280px; z-index: 5">
<button type="button" role="menuitem" class="menu-item">{ico('copy')}Copiar el mensaje</button>
<button type="button" role="menuitem" class="menu-item">{ico('fork')}Hacer fork desde aquí</button>
<hr class="divider" style="margin: 4px 0">
<button type="button" role="menuitem" class="menu-item on" style="height: auto; padding: 8px 10px; align-items: flex-start">{ico('tasks', 'ico', 'margin-top: 2px')}<span class="col" style="gap: 2px">Crear una tarea con este mensaje<span class="t-xs fg-3">En Backlog de claude-wrapper, enlazada a este chat</span></span></button>
</div>'''
  main = f'''<div class="row" style="flex: 1 1 auto; min-height: 0; align-items: stretch; gap: 0">
<div class="col grow" style="gap: 0; min-width: 0">
<div class="row" style="height: 56px; padding: 0 20px 0 12px; border-bottom: 1px solid var(--line); gap: 10px; flex-shrink: 0">
<a href="DesktopChats.html" class="btn btn-ghost btn-icon btn-sm" aria-label="Volver a chats">{ico('left')}</a>
<span class="col grow" style="gap: 1px; min-width: 0"><span class="ellipsis" style="font-weight: 600">Trabaja en AGN-28: tablero con columnas fijas y límites</span><span class="mono t-xs fg-3">claude-wrapper · b67aa3 · opus-5.5</span></span>
<span class="badge b-live"><span class="spin-braille" style="width: auto"></span>trabajando · 4:12</span>
<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Buscar en el chat">{ico('search')}</button>
<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Más acciones">{ico('more', 'ico', 'stroke-width: 3')}</button>
</div>
<div style="padding: 12px 32px 0; display: flex; justify-content: center; flex-shrink: 0"><div style="width: 100%; max-width: 740px">{part_of()}</div></div>
<div style="flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; justify-content: center; padding: 20px 32px 0">
<div class="col" style="width: 100%; max-width: 740px; gap: 16px; font-size: 14.5px; line-height: 1.65">
<div style="align-self: flex-end; max-width: 82%; background: var(--bg-3); border: 1px solid var(--line); border-radius: var(--r-xl) var(--r-xl) var(--r-xs) var(--r-xl); padding: 11px 15px; font-size: 14px">{PROMPT}</div>
<div class="row t-xs" style="gap: 8px; font-family: var(--mono); color: var(--fg-3)">{ico('check', 'ico ico-sm c-ok', 'stroke-width: 2.4')}<span>5 herramientas · 2 min 10 s</span><span class="badge">Read ×3</span><span class="badge">Edit</span><span class="badge">Bash</span>{ico('down', 'ico ico-sm')}</div>
<div style="position: relative; margin: -8px -14px; padding: 8px 14px; border-radius: var(--r-lg); background: var(--bg-2); box-shadow: inset 0 0 0 1px var(--line)">
<div class="row" style="position: absolute; right: 8px; top: -14px; gap: 2px; padding: 2px; border-radius: var(--r); background: var(--bg-2); box-shadow: var(--shadow-pop)"><button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Copiar el mensaje">{ico('copy', 'ico ico-sm')}</button><button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Acciones del mensaje" style="background: var(--bg-4); color: var(--fg)">{ico('more', 'ico ico-sm', 'stroke-width: 3')}</button></div>
{menu}
<p style="margin: 0">Las columnas ya salen de <code>COLUMNS</code> en orden, y el límite se lee de los ajustes del proyecto. Mientras lo probaba he visto otra cosa que no es de esta tarea: <b>mover una tarjeta con el teclado no anuncia la columna nueva</b> a un lector de pantalla. Lo dejo anotado aquí para no mezclarlo con este cambio.</p>
</div>
<p style="margin: 0">Sigo con el criterio 3: la cabecera en ámbar cuando la columna pasa su límite, con la palabra al lado.</p>
<div class="row t-sm" style="gap: 8px"><span class="spin-braille"></span><span class="shimmer" style="font-weight: 500">Ejecutando</span><span class="mono t-xs fg-3">pnpm test · 4:12</span></div>
</div>
</div>
<div style="display: flex; justify-content: center; padding: 12px 32px 18px; flex-shrink: 0">
<div class="col" style="width: 100%; max-width: 780px; gap: 8px">
<div class="card energy" style="border-radius: var(--r-xl); padding: 10px; display: flex; align-items: flex-end; gap: 8px">
<button type="button" class="btn btn-ghost btn-icon" aria-label="Adjuntar">{ico('clip')}</button>
<label class="grow" style="display: flex; min-height: 36px; align-items: center"><textarea rows="1" placeholder="Envía un mensaje de seguimiento…" aria-label="Mensaje" style="width: 100%; border: 0; outline: 0; resize: none; background: transparent; font-size: 14.5px; padding: 0"></textarea></label>
<button type="button" class="btn btn-danger btn-sm" style="height: 36px"><svg viewBox="0 0 24 24" style="width: 12px; height: 12px; fill: currentColor" aria-hidden="true"><path d="M6 6h12v12H6z"></path></svg>Detener</button>
<button type="button" class="btn btn-primary btn-icon" aria-label="Enviar">{ico('send', 'ico', 'stroke-width: 2.2')}</button>
</div>
<div class="row" style="gap: 6px"><button type="button" class="chip">Opus 5.5</button><button type="button" class="chip">Acepta ediciones</button><button type="button" class="chip">{ico('branch', 'ico ico-sm')}task/agn-28</button><span class="grow"></span><span class="t-xs fg-3 mono">↵ enviar · ⇧↵ salto</span></div>
</div>
</div>
</div>
<aside aria-label="Detalles del chat" class="col" style="width: 320px; flex-shrink: 0; border-left: 1px solid var(--line); background: var(--bg-1); gap: 0">
<div class="tabs" role="tablist" style="padding: 8px 16px 0; height: 56px; align-items: flex-end"><button type="button" role="tab" aria-selected="true" class="tab on">Resumen</button><button type="button" role="tab" aria-selected="false" class="tab">Actividad</button><button type="button" role="tab" aria-selected="false" class="tab">Cambios</button><button type="button" role="tab" aria-selected="false" class="tab">Entorno</button></div>
<div class="col" style="padding: 18px; gap: 22px">
<section class="row" style="gap: 14px"><span class="ring" style="--p: 22; --c: var(--fg-2); width: 60px; height: 60px; font-size: 12px">22%</span><span class="col" style="gap: 3px"><span class="t-label">Contexto</span><span class="t-sm">221.304 de 1 M tokens</span></span></section>
<section class="col" style="gap: 0">
<div class="row" style="padding-bottom: 8px"><span class="t-label grow">Tarea</span><a href="DesktopTarea.html" class="t-xs c-accent">Abrir</a></div>
<div class="prop-row"><span class="k" style="width: 90px">Clave</span><span class="v"><span class="wi-key boxed">AGN-28</span></span></div>
<div class="prop-row"><span class="k" style="width: 90px">Estado</span><span class="v">{sico('in_progress')}En curso</span></div>
<div class="prop-row"><span class="k" style="width: 90px">Criterios</span><span class="v"><span class="mono t-xs">2/5</span><span class="ms-bar" style="width: 90px; height: 4px"><i class="done" style="width: 40%"></i></span></span></div>
<div class="prop-row"><span class="k" style="width: 90px">Worktree</span><span class="v mono t-xs ellipsis">task/agn-28</span></div>
<div class="prop-row"><span class="k" style="width: 90px">Al terminar</span><span class="v t-xs fg-2" style="line-height: 1.4">pasa a En revisión si el turno acaba bien</span></div>
</section>
<section class="col" style="gap: 0">
<span class="t-label" style="padding-bottom: 8px">Chat</span>
<div class="prop-row"><span class="k" style="width: 90px">Modo</span><span class="v">Interactivo</span></div>
<div class="prop-row"><span class="k" style="width: 90px">Permisos</span><span class="v"><span class="badge">acceptEdits</span></span></div>
<div class="prop-row"><span class="k" style="width: 90px">Coste</span><span class="v t-num">1,26 US$</span></div>
<div class="prop-row"><span class="k" style="width: 90px">Mensajes</span><span class="v t-num">14</span></div>
</section>
</div>
</aside>
</div>'''
  write('DesktopChatTarea.html', desktop('Chat de una tarea', 'chats', '<a href="DesktopChats.html" class="fg-2">Chats</a><span class="fg-3">/</span><span class="mono" style="font-weight: 500">b67aa3</span>', main))


def chat_mobile():
  inner = f'''<header class="row" style="flex-shrink: 0; padding: 8px 4px; gap: 2px">
<a href="MobileChats.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver">{ico('left', 'ico ico-lg', 'stroke-width: 2')}</a>
<span class="col grow" style="gap: 2px; min-width: 0"><span class="ellipsis" style="font-weight: 600; font-size: 16px">Trabaja en AGN-28: tablero con…</span><span class="row t-xs mono" style="gap: 6px"><span class="spin-braille"></span><span class="c-live">trabajando · 4:12</span></span></span>
<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Más acciones">{ico('more', 'ico ico-lg', 'stroke-width: 3')}</button>
</header>
{part_of(True)}
<div class="col" style="flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 16px 16px 0; gap: 14px; font-size: 15px; line-height: 1.6">
<div class="row t-xs" style="gap: 8px; font-family: var(--mono); color: var(--fg-3)">{ico('check', 'ico ico-sm c-ok', 'stroke-width: 2.4')}<span>5 herramientas · 2 min 10 s</span></div>
<p style="margin: 0; padding: 10px 12px; border-radius: var(--r-lg); background: var(--bg-2); box-shadow: inset 0 0 0 1px var(--line-2)">Las columnas ya salen en orden. He visto otra cosa que no es de esta tarea: <b>mover una tarjeta con el teclado no anuncia la columna nueva</b> a un lector de pantalla.</p>
<p style="margin: 0" class="fg-2">Sigo con el criterio 3: la cabecera en ámbar cuando…</p>
</div>
<div style="position: absolute; inset: 0; z-index: 10; background: color-mix(in srgb, var(--bg) 60%, transparent)"></div>
<div class="sheet" role="dialog" aria-label="Acciones del mensaje" style="z-index: 11; padding-bottom: 34px">
<div class="grab"></div>
<p class="t-sm fg-2" style="margin: 0 4px 12px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden">«Las columnas ya salen en orden. He visto otra cosa que no es de esta tarea: mover una tarjeta con el teclado…»</p>
<div class="col" style="gap: 8px">
<button type="button" class="btn btn-lg" style="justify-content: flex-start; height: 52px">{ico('copy', 'ico ico-lg')}Copiar el mensaje</button>
<button type="button" class="btn btn-lg" style="justify-content: flex-start; height: 52px">{ico('fork', 'ico ico-lg')}Hacer fork desde aquí</button>
<button type="button" class="btn btn-lg" style="justify-content: flex-start; height: auto; min-height: 60px; padding: 10px 18px; background: var(--bg-4); border-color: var(--line-3)">{ico('tasks', 'ico ico-lg')}<span class="col" style="gap: 2px; align-items: flex-start"><span>Crear una tarea con este mensaje</span><span class="t-xs fg-3" style="font-weight: 400">En Backlog, enlazada a este chat</span></span></button>
<button type="button" class="btn btn-ghost btn-lg" style="height: 52px">Cancelar</button>
</div>
</div>'''
  write('MobileChatTarea.html', mobile('Chat de una tarea', inner))


if __name__ == '__main__':
  chat_desktop(); chat_mobile()
