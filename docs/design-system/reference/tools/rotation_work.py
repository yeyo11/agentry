# Rotation between providers: automated work and the shell (plans/multi-provider.md, phase 4, P0 `p3`).
# The orchestration with a moved task and two waiting ones (`DesktopOrquestacion`, `MobileOrquestacion`,
# patched in place between <!--rot--> markers, so a second run changes only what is inside them), a moved
# flow run's chat (`DesktopChatFlujoMovido`, `MobileChatFlujoMovido`), the status bar with a limit per
# provider (`StatusBar`), the retirement notice on Home (`Main`, `MobileInicio`) and in Settings →
# Providers (`DesktopProveedoresRetirada`, `MobileProveedoresRetirada`), the Decisions tab with its
# Providers area (`DesktopAjustesDecisionesProveedores`, `MobileAjustesDecisionesProveedores`) and the
# spec page `DSRotacion`. Its own file, so it does not collide with the other P0 tasks' generators.
# Runs on its own; imports common.py, data.py, providers.py, decisions.py and team.py.
#   python3 rotation_work.py
import os
import re
from contextlib import contextmanager

from data import ROLES, role, sico
from common import OUT, P, ico, desktop, mobile, write, page, tabbar, BRAND
from decisions import scrim
import decisions as dec
import providers as prv
from providers import PROV
from desktop import TEAM_LIVE

P.setdefault('ext', prv.P['ext'])

# ---------------------------------------------------------------- data
RESET = '14:05'
RESET_IN = 'en 2 h 10 min'
ACCOUNT = 'yeyo@inmoseo.net'


def mark(pid):
  label, letters, hue = PROV[pid]
  return f'<span class="prov-mark" style="--hue: {hue}" role="img" aria-label="{label}" title="{label}">{letters}</span>'


def chip(pid, now=False, href=None):
  """One provider of a chain. A desktop chip is a link to its chat; a phone's is read, and the card's button opens the newest."""
  cls = 'chain-chip now' if now else 'chain-chip'
  inner = f'{mark(pid)}{PROV[pid][0]}'
  if href:
    return f'<a href="{href}" class="{cls}" aria-label="Abrir el chat de {PROV[pid][0]}">{inner}</a>'
  return f'<span class="{cls}">{inner}</span>'


def arrow():
  return ico('right', 'ico chain-arrow')


def chain(entries, link=True):
  """entries: provider ids, oldest first; the last one is the chat that runs now."""
  parts = []
  for i, pid in enumerate(entries):
    now = i == len(entries) - 1
    parts.append(chip(pid, now, ('DesktopChat.html' if link else None)))
    if not now:
      parts.append(arrow())
  return f'<span class="chain" role="group" aria-label="Proveedores, del primero al actual">{"".join(parts)}</span>'


def decided(text, label):
  return f'<button type="button" class="decided" aria-label="{label}"><span class="decided-face">{text}</span></button>'


# ---------------------------------------------------------------- the status bar, a limit per provider
def lim(pid, kind, pct=None, version='', reset=RESET, tip=''):
  """One provider in the status bar. ok: a quiet bar when a reading exists; near: warn from 60 %; out: bad, with its word."""
  name = PROV[pid][0]
  title = f' title="{tip}"' if tip else ''
  d = lambda cls: f'<span class="dot {cls}" style="width: 6px; height: 6px"></span>'
  href = 'DesktopProveedores.html'
  if kind == 'ok':
    bar = f'<span class="bar bar-thin"><i style="width: {pct}%"></i></span>{pct} %' if pct is not None else ''
    return f'<a href="{href}" class="lim"{title}>{d("dot-ok")}{name} {version}{bar}</a>'
  if kind == 'near':
    return f'<a href="{href}" class="lim near"{title}>{d("dot-warn")}{name} · límite<span class="bar bar-thin warn"><i style="width: {pct}%"></i></span>{pct} %</a>'
  if kind == 'out':
    return f'<a href="{href}" class="lim out"{title}>{d("dot-bad")}{name} · límite agotado<span class="age">vuelve {reset}</span></a>'
  if kind == 'signed-out':
    return f'<a href="{href}" class="lim near"{title}>{d("dot-warn")}{name} · sin sesión</a>'
  raise ValueError(kind)


def statusbar(items, running=3, today='3,41 US$'):
  """The footer of the shell without claude-swap's account: the providers on the right, the way phase 1 drew them."""
  return (f'<footer class="app statusbar" data-theme="dark" style="width: 1184px">\n<span class="grow"></span>\n'
          f'<span class="row" style="gap: 6px"><span class="spin-braille"></span>{running} en marcha</span>\n<span>hoy {today}</span>\n'
          + '\n'.join(items) + '\n</footer>')


TIP_NEAR = ('<span class="tooltip" role="tooltip" style="position: absolute; bottom: 36px; right: 14px"><span style="font-weight: 500">Claude Code · cerca del límite</span>'
            '<span class="mono t-xs" style="opacity: .75">ventana de 5 h al 72 % · vuelve a las 14:05</span>'
            '<span class="mono t-xs" style="opacity: .75">lectura de hace 3 min, de su último turno</span></span>')
TIP_OUT = ('<span class="tooltip" role="tooltip" style="position: absolute; bottom: 36px; right: 14px"><span style="font-weight: 500">Codex · límite agotado</span>'
           '<span class="mono t-xs" style="opacity: .75">ventana de 5 h al 100 % · vuelve a las 14:05, en 2 h 10 min</span>'
           '<span class="mono t-xs" style="opacity: .75">el trabajo espera, pasa a otro proveedor o empieza de nuevo, según tus ajustes</span></span>')


def sb_section(label, bar, tip='', pad=0):
  top = 84 if tip else pad
  tip_html = tip
  return (f'<section style="position: relative; padding-top: {top}px">\n<span class="t-label" style="display: block; padding: 0 14px 6px">{label}</span>\n'
          f'<div style="position: relative">{tip_html}{bar}</div>\n</section>')


def statusbar_component():
  claude_ok = lim('claude-code', 'ok', 45, '2.1.282', tip='Ventana de 5 h · vuelve a las 14:05 · lectura de hace 2 min')
  codex_ok = lim('codex', 'ok', 31, '0.159.3', tip='Ventana de 5 h · vuelve a las 15:40 · lectura de hace 1 min')
  copilot_ok = lim('copilot', 'ok', None, '1.0.90', tip='Copilot no informa de su límite')
  sections = [
    sb_section('Todos listos, con su lectura', statusbar([claude_ok, codex_ok, copilot_ok]), pad=0),
    sb_section('Uno cerca del límite: desde el 60 % de su ventana', statusbar([lim('claude-code', 'near', 72, tip='Ventana de 5 h · 72 % · vuelve a las 14:05'), codex_ok, copilot_ok]), TIP_NEAR),
    sb_section('Uno agotado: lo dice con su palabra y cuándo vuelve', statusbar([claude_ok.replace('45 %', '38 %').replace('width: 45%', 'width: 38%'), lim('codex', 'out', tip='Ventana de 5 h · vuelve a las 14:05'), copilot_ok]), TIP_OUT),
    sb_section('Uno sin sesión', statusbar([claude_ok, lim('copilot', 'signed-out', tip='Copilot · sin sesión')]), pad=0),
    sb_section('Ninguno encontrado', '<footer class="app statusbar" data-theme="dark" style="width: 1184px">\n<span class="grow"></span>\n'
               f'<a href="DesktopProveedores.html" class="row" style="gap: 6px"><span class="dot dot-idle" style="width: 6px; height: 6px"></span>Ningún agente detectado</a>\n</footer>'),
    sb_section('Comprobando', '<footer class="app statusbar" data-theme="dark" style="width: 1184px">\n<span class="grow"></span>\n'
               '<span class="row" style="gap: 6px"><span class="spin-braille"></span>Comprobando agentes…</span>\n</footer>'),
  ]
  body = ('<div class="app" data-theme="dark" style="width: 1184px; display: flex; flex-direction: column; gap: 14px; padding: 12px 0; background: var(--bg)">\n'
          + '\n'.join(sections) + '\n</div>')
  h = page('Barra de estado', body)
  h = h.replace('<title>Agentry · Barra de estado</title>', '<title>Barra de estado (componente)</title>')
  write('StatusBar.html', h)


# ---------------------------------------------------------------- patching the older screens in place
def modernize(h):
  """The older hand-written screens carry a hex background in their head and a pixel radius; the tokens say the same."""
  h = re.sub(r'<style>body\{margin:0;background:#09090b\}</style>(<style>body\{margin:0\}</style>)?', '<style>body{margin:0;background:var(--bg)}</style>', h)
  h = re.sub(r'<script>function t\(\)\{.*?\}addEventListener\("hashchange",t\);addEventListener\("DOMContentLoaded",t\);</script>',
             '<script>function t(){var m=location.hash==="#light"?"light":"dark";document.querySelectorAll("[data-theme]").forEach(function(e){e.setAttribute("data-theme",m)})}addEventListener("hashchange",t);addEventListener("DOMContentLoaded",t);</script>', h, count=1, flags=re.S)
  h = h.replace('</head><body>', '</head><body data-theme="dark">', 1)
  h = re.sub(r'<span style="width: (26|28)px; height: \1px; border-radius: 8px; background: var\(--grad\);.*?</svg></span>',
             lambda m: BRAND if m.group(1) == '26' else m.group(0).replace('border-radius: 8px', 'border-radius: var(--r)'), h, count=1, flags=re.S)
  h = h.replace('border-radius: 8px 0 0 8px', 'border-radius: var(--r) 0 0 var(--r)').replace('border-radius: 0 8px 8px 0', 'border-radius: 0 var(--r) var(--r) 0')
  return h.replace('border-radius: 8px', 'border-radius: var(--r)')


def read(name):
  with open(os.path.join(OUT, name + '.html')) as f:
    return f.read()


def put(h, tag, block, start, end):
  """Writes `block` between <!--tag--> markers. The first run puts the markers over what lies from `start` up to `end`
  (the old block, or nothing when they are the same anchor); later runs replace only what is inside them."""
  o, c = f'<!--{tag}-->', f'<!--/{tag}-->'
  if o in h:
    return h[:h.index(o) + len(o)] + block + h[h.index(c):]
  a, b = h.index(start), h.index(end)
  return h[:a] + o + block + c + '\n' + h[b:]


# ---------------------------------------------------------------- the orchestration, a moved task and two waits
CMD = ('<div class="row mono t-xs" style="gap: 8px; background: var(--bg); border: 1px solid var(--line); border-radius: var(--r); padding: 9px 10px">'
       '<span class="c-live">$</span><span class="ellipsis grow fg-2">timeout 300 pnpm --filter @agentry/web test 2&gt;&amp;1 | tail -150</span><span class="fg-3">1:08</span></div>')
WHY_MAP = 'Opus 5.5 no tiene equivalente en Codex, y el trabajo no puede pasar allí sin uno.'


def wait_line(kind, mobile=False):
  clock = ico('wait', 'ico ico-sm')
  if kind == 'known':
    return (f'<div class="wait-line" role="status">{clock}<span><b>Esperando a Claude Code</b> · vuelve a las <span class="mono">{RESET}</span> ({RESET_IN})'
            f'<span class="why">Llegó a su límite de 5 h. La tarea conserva su sitio y retomará el turno sola.</span></span></div>')
  if kind == 'nomap':
    link = ('' if mobile else ' <a href="DesktopProveedoresRotacion.html" class="c-accent">Elegir el equivalente</a>')
    return (f'<div class="wait-line" role="status">{clock}<span><b>Esperando a Claude Code</b> · vuelve a las <span class="mono">{RESET}</span> ({RESET_IN})'
            f'<span class="why">{WHY_MAP}{link}</span></span></div>')
  raise ValueError(kind)


def card_desktop():
  a = f'''<article class="card energy col" style="padding: 16px; gap: 12px">
<div class="row"><span class="spin-ring"></span><span class="grow" style="font-weight: 600">Spanish copy: config</span>{decided('decidido · 0,91', 'Pasó a Codex por un punto de decisión, con un traspaso. Ver la respuesta')}<span class="mono t-xs fg-3">10:59</span></div>
<div class="chain-row">{chain(['claude-code', 'codex'])}<span class="chain-how">movida · traspaso · 13:48 · gpt-6.1-sol</span></div>
{CMD}
<div class="row t-xs" style="gap: 8px"><span class="badge">copy-config</span><span class="fg-3">tras glossary</span><span class="grow"></span><button type="button" class="btn btn-sm btn-ghost">Enviar pista</button><a href="DesktopChat.html" class="btn btn-sm">Abrir chat</a></div>
</article>'''
  b = '''<article class="card col" style="padding: 16px; gap: 12px">
<div class="row"><span style="width: 16px; height: 16px; border-radius: 50%; background: var(--ok-soft); display: grid; place-items: center"><svg class="ico c-ok" viewBox="0 0 24 24" style="width: 11px; height: 11px; stroke-width: 3"><path d="m5 12 5 5 9-10"></path></svg></span><span class="grow" style="font-weight: 600">Spanish copy: shell and components</span><span class="mono t-xs fg-3">10:28 · 3,51 US$</span></div>
<div class="row t-xs" style="gap: 8px; color: var(--ok); background: var(--ok-soft); border-radius: var(--r); padding: 9px 10px"><svg class="ico ico-sm" viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"></path></svg>Completada en el segundo intento</div>
<div class="row t-xs" style="gap: 8px"><span class="badge">copy-shell</span><span class="fg-3">tras glossary</span><span class="grow"></span><button type="button" class="btn btn-sm btn-ghost">Hacer fork</button><a href="#" class="btn btn-sm">Ver resultado</a></div>
</article>'''
  c = f'''<article class="card col" style="padding: 16px; gap: 12px">
<div class="row">{ico('wait', 'ico ico-sm c-warn')}<span class="grow" style="font-weight: 600">Spanish copy: chats and home</span>{decided('decidido · 0,88', 'Espera al reinicio de Claude Code por un punto de decisión. Ver la respuesta')}<span class="badge b-warn">esperando</span></div>
<div class="chain-row">{chain(['claude-code'])}<span class="chain-how">ocupa su sitio · 3 de 4 en paralelo</span></div>
{wait_line('known')}
<div class="row t-xs" style="gap: 8px"><span class="badge">copy-chats</span><span class="fg-3">tras glossary</span><span class="grow"></span><button type="button" class="btn btn-sm btn-ghost">Dejar de esperar</button><button type="button" class="btn btn-sm">{ico('move', 'ico ico-sm')}Mover ahora</button></div>
</article>'''
  d = f'''<article class="card col" style="padding: 16px; gap: 12px">
<div class="row">{ico('wait', 'ico ico-sm c-warn')}<span class="grow" style="font-weight: 600">Spanish copy: orchestration, schedules, usage</span><span class="badge b-warn">esperando</span></div>
<div class="chain-row">{chain(['claude-code'])}<span class="chain-how">sin equivalente · opus-5.5</span></div>
{wait_line('nomap')}
<div class="row t-xs" style="gap: 8px"><span class="badge">copy-orchestration</span><span class="fg-3">tras glossary</span><span class="grow"></span><button type="button" class="btn btn-sm btn-ghost">Dejar de esperar</button><button type="button" class="btn btn-sm" disabled title="No hay un modelo equivalente en Codex">{ico('move', 'ico ico-sm')}Mover ahora</button></div>
</article>'''
  return f'<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px">\n{a}\n{b}\n{c}\n{d}\n</div>'


def stage_head_desktop():
  return ('<div class="row" style="gap: 10px"><h2 class="t-h2 grow">Etapa 2 · 4 tareas en paralelo</h2>'
          f'<span class="badge b-warn">{ico("wait", "ico ico-sm")}2 esperando</span>'
          '<div class="seg" role="tablist"><button type="button" role="tab" aria-selected="true" class="on">Tareas</button><button type="button" role="tab" aria-selected="false">Grafo</button></div></div>')


ORCH_STATUS = statusbar([lim('claude-code', 'out', tip='Ventana de 5 h · vuelve a las 14:05'), lim('codex', 'ok', 31, '0.159.3', tip='Ventana de 5 h · vuelve a las 15:40 · lectura de hace 1 min')])


def patch_orch_desktop():
  h = modernize(read('DesktopOrquestacion'))
  # The cost is not what the screen is about: the energy border is, and with the shell's primary it is the budget of two gradient surfaces
  h = h.replace('<div class="card kpi grad-border"><span class="t-label">Coste</span><span class="v grad-text">5,61</span><span class="t-xs fg-3">US$</span></div>',
                '<div class="card kpi"><span class="t-label">Coste</span><span class="v">5,61</span><span class="t-xs fg-3">US$ · 1 tarea sin cifra en Codex</span></div>')
  h = h.replace('<div class="card kpi"><span class="t-label">Coste</span><span class="v">5,61</span><span class="t-xs fg-3">US$</span></div>',
                '<div class="card kpi"><span class="t-label">Coste</span><span class="v">5,61</span><span class="t-xs fg-3">US$ · 1 tarea sin cifra en Codex</span></div>')
  block = f'\n{stage_head_desktop()}\n\n{card_desktop()}\n'
  h = put(h, 'rot', block, '<div class="row"><h2 class="t-h2 grow">Etapa 2', '</main>')
  a = h.index('<footer class="app statusbar"')
  b = h.index('</footer>') + len('</footer>')
  h = h[:a] + ORCH_STATUS + h[b:]
  open(os.path.join(OUT, 'DesktopOrquestacion.html'), 'w').write(h)
  print('patched DesktopOrquestacion.html')


def card_mobile():
  a = f'''<article class="card energy col" style="padding: 14px; gap: 10px">
<div class="row"><span class="spin-ring"></span><span class="grow" style="font-weight: 600">Spanish copy: config</span>{decided('decidido', 'Pasó a Codex por un punto de decisión. Ver la respuesta')}<span class="mono t-xs fg-3">10:59</span></div>
<div class="chain-row">{chain(['claude-code', 'codex'], link=False)}<span class="chain-how">traspaso · 13:48</span></div>
<div class="row mono t-xs" style="gap: 6px; background: var(--bg); border: 1px solid var(--line); border-radius: var(--r); padding: 8px 10px"><span class="c-live">$</span><span class="ellipsis fg-2">pnpm --filter @agentry/web test</span></div>
<div class="row"><button type="button" class="btn grow">Enviar pista</button><a href="MobileChat.html" class="btn grow">Abrir chat</a></div>
</article>'''
  b = ('<article class="card row" style="padding: 12px 14px; gap: 10px"><span style="width: 16px; height: 16px; border-radius: 50%; background: var(--ok-soft); display: grid; place-items: center"><svg class="ico c-ok" viewBox="0 0 24 24" style="width: 11px; height: 11px; stroke-width: 3"><path d="m5 12 5 5 9-10"></path></svg></span>'
       '<span class="col grow" style="gap: 1px"><span class="t-sm" style="font-weight: 500">Shell and components</span><span class="mono t-xs c-ok">2.º intento · 10:28</span></span><span class="t-num t-sm">3,51 $</span></article>')
  c = f'''<article class="card col" style="padding: 14px; gap: 10px">
<div class="row">{ico('wait', 'ico ico-sm c-warn')}<span class="grow t-sm" style="font-weight: 500">Chats and home</span>{decided('decidido', 'Espera al reinicio de Claude Code por un punto de decisión. Ver la respuesta')}<span class="badge b-warn">esperando</span></div>
<div class="chain-row">{chain(['claude-code'], link=False)}<span class="chain-how">ocupa su sitio</span></div>
{wait_line('known', True)}
<div class="row"><button type="button" class="btn grow">Dejar de esperar</button><button type="button" class="btn grow">{ico('move', 'ico')}Mover ahora</button></div>
</article>'''
  d = f'''<article class="card col" style="padding: 14px; gap: 10px">
<div class="row">{ico('wait', 'ico ico-sm c-warn')}<span class="grow t-sm" style="font-weight: 500">Orchestration, schedules, usage</span><span class="badge b-warn">esperando</span></div>
<div class="chain-row">{chain(['claude-code'], link=False)}<span class="chain-how">sin equivalente · opus-5.5</span></div>
{wait_line('nomap', True)}
<div class="row"><button type="button" class="btn grow">Dejar de esperar</button><a href="MobileProveedoresRotacion.html" class="btn grow">Elegir equivalente</a></div>
</article>'''
  return f'{a}\n{b}\n{c}\n{d}'


def patch_orch_mobile():
  h = modernize(read('MobileOrquestacion'))
  h = h.replace('<span class="row t-xs mono" style="gap: 6px"><span class="spin-braille"></span><span class="c-live">en curso</span></span></span>',
                '<span class="row t-xs mono" style="gap: 6px"><span class="spin-braille"></span><span class="c-live">en curso</span><span class="c-warn">· 2 esperando</span></span></span>')
  h = h.replace('class="app m-screen glow-top" data-theme="dark" style="background-size: 100% 300px"', 'class="app m-screen glow-top" data-theme="dark" style="background-size: 100% 300px; height: auto; min-height: 844px"')
  h = put(h, 'rot', f'\n{card_mobile()}\n', '<article class="card energy col"', '</div>\n</div>\n</body>')
  open(os.path.join(OUT, 'MobileOrquestacion.html'), 'w').write(h)
  print('patched MobileOrquestacion.html')


# ---------------------------------------------------------------- run
if __name__ == '__main__':
  import rotation_decisions
  import rotation_flow
  patch_orch_desktop()
  patch_orch_mobile()
  statusbar_component()
  rotation_flow.all_flow()
  rotation_decisions.all_decisions()
