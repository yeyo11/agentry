# The Agentry assistant's entry (CW-30, CW-18 and CW-17): the global "Asistente" item, its /assistant screen with
# the greeting, the starters and the composer, and one assistant chat holding a write behind the host prompt.
# Writes DesktopAsistenteAgentry, DesktopAsistenteAgentryChat, MobileAsistenteAgentry, MobileAsistenteAgentryChat and
# MobileAsistenteAgentryMas (the Más page with the new item, lifted from MobileMas.html).
# Runs on its own; imports common.py.
from common import *

PROJECT = 'claude-wrapper'
# The starters follow what the MCP server offers: reads first, then the writes that ask permission
STARTERS = [
  ('tasks', 'Estado del tablero', '¿Cómo va AGN-12?', False),
  ('orch', 'Orquestaciones', '¿Por qué ha fallado la última orquestación?', False),
  ('flow', 'Flujos y equipo', '¿Qué tarjetas está esperando el equipo?', False),
  ('usage', 'Uso y límites', '¿Cuánto he gastado hoy?', False),
  ('edit', 'Crear una tarea', 'Crea una tarea en AGN para revisar los límites de las columnas', True),
  ('retry', 'Reintentar un fallo', 'Reintenta la tarea que falló en ecosystem-foundation', True),
]
GREETING = 'Hola, soy el asistente de Agentry'
SUB = 'Te cuento cómo van tus proyectos, tareas, orquestaciones y el uso. Antes de escribir nada, te pido permiso.'
ASK = 'Crea una tarea en AGN para revisar los límites de las columnas, prioridad media'


def mark(sm=False):
  return f'<span class="ai-mark{" sm" if sm else ""}" aria-hidden="true">{ico("sparkle")}</span>'


def starter(s):
  icon, title, ask, writes = s
  badge = '<span class="badge b-warn">pide permiso</span>' if writes else ''
  return f'<button type="button" class="as-starter">{ico(icon)}<span class="as-starter-body"><span class="as-starter-title">{title}</span><span class="as-starter-ask">«{ask}»</span></span>{badge}</button>'


FIGURES = '<p class="as-figures" aria-label="Ahora mismo"><span><b class="live">2</b> chats en marcha</span><span><b class="live">1</b> orquestación</span><span>hoy <b>3,41 US$</b></span></p>'


def context_chip():
  return f'<span class="chip as-context">{ico("folder", "ico ico-sm")}<span class="ellipsis">Con {PROJECT} como contexto</span><button type="button" class="x" aria-label="Quitar el contexto">{ico("x", "ico ico-sm")}</button></span>'


def entry_composer(mobile=False):
  if mobile:
    return f'''<div class="col" style="flex-shrink: 0; padding: 10px 12px 12px; gap: 10px; border-top: 1px solid var(--line); background: var(--bg-1)">
<div class="row" style="gap: 6px">{context_chip()}<button type="button" class="chip">Sonnet</button></div>
<div class="card row" style="border-radius: var(--r-xl); padding: 4px; gap: 4px; align-items: flex-end">
<label class="grow" style="display: flex; min-height: var(--touch); align-items: center; padding-left: 12px"><textarea rows="1" placeholder="Pregunta o pide algo…" aria-label="Mensaje" style="width: 100%; border: 0; outline: 0; resize: none; background: transparent; font-size: 16px; padding: 0"></textarea></label>
<button type="button" class="btn btn-primary btn-icon" aria-label="Enviar" style="width: var(--touch); height: var(--touch); border-radius: 50%">{ico("send", "ico ico-lg", "stroke-width: 2.2")}</button>
</div>
</div>'''
  return f'''<div style="display: flex; justify-content: center; padding: 12px 32px 20px; flex-shrink: 0">
<div class="col" style="width: 100%; max-width: 740px; gap: 8px">
<div class="card" style="border-radius: var(--r-xl); padding: 10px; display: flex; align-items: flex-end; gap: 8px">
<label class="grow" style="display: flex; min-height: 36px; align-items: center; padding-left: 8px"><textarea rows="1" placeholder="Pregunta por proyectos, tareas, orquestaciones o uso…" aria-label="Mensaje" style="width: 100%; border: 0; outline: 0; resize: none; background: transparent; font-size: 14px; padding: 0"></textarea></label>
<button type="button" class="btn btn-primary btn-icon" aria-label="Enviar">{ico("send", "ico", "stroke-width: 2.2")}</button>
</div>
<div class="row" style="gap: 6px">{context_chip()}<button type="button" class="chip">Sonnet</button><span class="grow"></span><span class="row t-xs fg-3 mono" style="gap: 6px">{ico("lock", "ico ico-sm")}Pide permiso antes de escribir</span></div>
</div>
</div>'''


def desktop_entry():
  main = f'''<div class="col" style="flex: 1 1 auto; min-height: 0">
<div style="flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; justify-content: center; padding: 72px 32px 0">
<div class="col" style="width: 100%; max-width: 740px; gap: 28px">
<div class="as-hello">{mark()}<h1 class="t-h1" style="font-size: 34px; line-height: 1.15">{GREETING}</h1><p class="as-hello-sub">{SUB}</p>{FIGURES}</div>
<section class="col" style="gap: 10px" aria-label="Para empezar"><span class="t-label">Para empezar</span>
<div class="as-starters">{"".join(starter(s) for s in STARTERS)}</div></section>
</div>
</div>
{entry_composer()}
</div>'''
  crumb = '<span style="font-weight: 500">Asistente</span>'
  write('DesktopAsistenteAgentry.html', desktop('Asistente de Agentry', 'assistant', crumb, main, assistant=True))


def prompt_block(mobile=False):
  if mobile:
    inp = '''<span class="k">proyecto</span>   AGN
<span class="k">tipo</span>       tarea
<span class="k">título</span>     Revisar los límites
              de las columnas
<span class="k">prioridad</span>  media
<span class="k">columna</span>    Backlog'''
  else:
    inp = '''<span class="k">proyecto</span>   AGN
<span class="k">tipo</span>       tarea
<span class="k">título</span>     Revisar los límites de las columnas
<span class="k">prioridad</span>  media
<span class="k">columna</span>    Backlog'''
  size = ' btn-lg' if mobile else ' btn-sm'
  # The app's placeholder is longer than a phone's input: the phone shows the short form
  reason = '¿Por qué no? (opcional)' if mobile else '¿Por qué no? (se envía al modelo al denegar)'
  return f'''<div class="permission" role="group" aria-label="Permiso para escribir" aria-live="polite">
<div class="permission-head">{ico("conn", "ico")}<strong>Crear tarea en AGN</strong><span class="fg-2 t-sm">quiere ejecutarse</span></div>
<pre class="permission-input" role="group" aria-label="Lo que quiere ejecutar" tabindex="0">{inp}</pre>
<p class="permission-note">Se crea en el Backlog de AGN, enlazada a este chat. Si deniegas, no se escribe nada.</p>
<div class="permission-actions">
<button type="button" class="btn btn-primary{size}">{ico("check", "ico ico-sm")}Permitir</button>
<button type="button" class="btn btn-danger{size}">{ico("x", "ico ico-sm")}Denegar</button>
<label class="field permission-reason"><input type="text" placeholder="{reason}" aria-label="Motivo para denegar"></label>
</div>
</div>'''


TOOLS = '<span class="badge">Tablero de AGN</span><span class="badge">AGN-12</span>'
REPLY = 'No hay ninguna tarea abierta sobre los límites de las columnas. Voy a crear una en el Backlog de AGN. <b>Necesito tu permiso para escribir.</b>'
GREET_MSG = f'<div class="as-greeting">{mark(True)}<span>{GREETING}. Pregúntame por tus proyectos, tareas, orquestaciones o el uso.</span></div>'


def desktop_chat():
  main = f'''<div class="col grow" style="gap: 0; min-width: 0; min-height: 0">
<div class="row" style="height: 56px; padding: 0 20px 0 12px; border-bottom: 1px solid var(--line); gap: 10px; flex-shrink: 0">
<a href="DesktopChats.html" class="btn btn-ghost btn-icon btn-sm" aria-label="Volver a chats">{ico('left')}</a>
{mark(True)}
<span class="col grow" style="gap: 1px; min-width: 0"><span class="ellipsis" style="font-weight: 600">{ASK}</span><span class="mono t-xs fg-3">asistente · {PROJECT} · c41e9b · sonnet</span></span>
<span class="badge b-warn">{ico("lock", "ico ico-sm")}necesita tu permiso</span>
<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Buscar en el chat">{ico('search')}</button>
<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Más acciones">{ico('more', 'ico', 'stroke-width: 3')}</button>
</div>
<div style="flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; justify-content: center; padding: 24px 32px 0">
<div class="col" style="width: 100%; max-width: 740px; gap: 16px; font-size: 14px; line-height: 1.65">
{GREET_MSG}
<div style="align-self: flex-end; max-width: 82%; background: var(--bg-3); border: 1px solid var(--line); border-radius: var(--r-xl) var(--r-xl) var(--r-xs) var(--r-xl); padding: 11px 15px">{ASK}</div>
<div class="row t-xs" style="gap: 8px; font-family: var(--mono); color: var(--fg-3)">{ico('check', 'ico ico-sm c-ok', 'stroke-width: 2.4')}<span>2 consultas · 3 s</span>{TOOLS}</div>
<p style="margin: 0">{REPLY}</p>
</div>
</div>
<div style="display: flex; justify-content: center; padding: 12px 32px 0; flex-shrink: 0"><div style="width: 100%; max-width: 740px">{prompt_block()}</div></div>
<div style="display: flex; justify-content: center; padding: 12px 32px 20px; flex-shrink: 0">
<div class="col" style="width: 100%; max-width: 740px; gap: 8px">
<div class="card" style="border-radius: var(--r-xl); padding: 10px; display: flex; align-items: flex-end; gap: 8px">
<label class="grow" style="display: flex; min-height: 36px; align-items: center; padding-left: 8px"><textarea rows="1" placeholder="Responde o escribe otra cosa…" aria-label="Mensaje" style="width: 100%; border: 0; outline: 0; resize: none; background: transparent; font-size: 14px; padding: 0"></textarea></label>
<button type="button" class="btn btn-icon" aria-label="Enviar" disabled>{ico("send", "ico", "stroke-width: 2.2")}</button>
</div>
<div class="row" style="gap: 6px"><button type="button" class="chip">Sonnet</button><span class="grow"></span><span class="t-xs fg-3 mono">↵ enviar · ⇧↵ salto</span></div>
</div>
</div>
</div>'''
  crumb = '<a href="DesktopAsistenteAgentry.html" class="fg-2">Asistente</a><span class="fg-3">/</span><span class="mono" style="font-weight: 500">c41e9b</span>'
  write('DesktopAsistenteAgentryChat.html', desktop('Chat del asistente de Agentry', 'assistant', crumb, main, assistant=True, agents=2))


def mobile_entry():
  inner = f'''<header class="m-head"><h1 class="t-h1 grow">Asistente</h1></header>
<div class="m-body" style="gap: 18px; padding-top: 8px">
<div class="as-hello">{mark()}<h2 class="t-h1">{GREETING}</h2><p class="as-hello-sub" style="font-size: 14px">{SUB}</p>{FIGURES}</div>
<section class="col" style="gap: 8px" aria-label="Para empezar"><span class="t-label">Para empezar</span>
<div class="as-starters">{"".join(starter(s) for s in (STARTERS[0], STARTERS[3], STARTERS[4]))}</div></section>
</div>
{entry_composer(True)}
{tabbar('more')}'''
  write('MobileAsistenteAgentry.html', mobile('Asistente de Agentry', inner))


def mobile_chat():
  inner = f'''<header class="row" style="flex-shrink: 0; padding: 8px 4px; gap: 2px">
<a href="MobileChats.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver">{ico('left', 'ico ico-lg', 'stroke-width: 2')}</a>
<span class="col grow" style="gap: 2px; min-width: 0"><span style="font-weight: 600; font-size: 16px; line-height: 1.3">{ASK}</span><span class="row t-xs mono" style="gap: 6px"><span class="c-warn">necesita tu permiso</span></span></span>
<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Más acciones">{ico('more', 'ico ico-lg', 'stroke-width: 3')}</button>
</header>
<div class="col" style="flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 12px 16px 0; gap: 14px; font-size: 15px; line-height: 1.6">
{GREET_MSG}
<div style="align-self: flex-end; max-width: 88%; background: var(--bg-3); border: 1px solid var(--line); border-radius: var(--r-xl) var(--r-xl) var(--r-xs) var(--r-xl); padding: 10px 14px">{ASK}</div>
<div class="row t-xs" style="gap: 8px; font-family: var(--mono); color: var(--fg-3)">{ico('check', 'ico ico-sm c-ok', 'stroke-width: 2.4')}<span>2 consultas · 3 s</span></div>
<p style="margin: 0">{REPLY}</p>
</div>
<div style="flex-shrink: 0; padding: 12px 12px 0">{prompt_block(True)}</div>
<div class="col" style="flex-shrink: 0; padding: 10px 12px 28px">
<div class="card row" style="border-radius: var(--r-xl); padding: 4px; gap: 4px; align-items: flex-end">
<label class="grow" style="display: flex; min-height: var(--touch); align-items: center; padding-left: 12px"><textarea rows="1" placeholder="Responde o escribe otra cosa…" aria-label="Mensaje" style="width: 100%; border: 0; outline: 0; resize: none; background: transparent; font-size: 16px; padding: 0"></textarea></label>
<button type="button" class="btn btn-icon" aria-label="Enviar" disabled style="width: var(--touch); height: var(--touch); border-radius: 50%">{ico("send", "ico ico-lg", "stroke-width: 2.2")}</button>
</div>
</div>'''
  write('MobileAsistenteAgentryChat.html', mobile('Chat del asistente de Agentry', inner))


def mobile_mas():
  # The Más page keeps its list; the assistant is the first row, with the sparkle on the neutral .ai-mark tile
  s = open(os.path.join(OUT, 'MobileMas.html')).read()
  row = (f'<a href="MobileAsistenteAgentry.html" class="cell">{mark()}<span class="grow" style="font-weight: 500">Asistente</span>'
         f'<span class="mono t-xs fg-3">pregunta o pide</span>{ico("right", "ico fg-3")}</a>\n\n')
  marker = '<nav aria-label="Secciones" class="card" style="overflow: hidden">\n\n'
  assert marker in s
  write('MobileAsistenteAgentryMas.html', s.replace(marker, marker + row, 1))


if __name__ == '__main__':
  desktop_entry(); desktop_chat(); mobile_entry(); mobile_chat(); mobile_mas()
