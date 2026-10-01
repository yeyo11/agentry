# Chat page and chats list with the provider (plans/multi-provider.md, phase 3, P0 task p1).
# The four screens it changes (DesktopChat, MobileChat, DesktopChats, MobileChats) were written as HTML
# before the generators, so this script patches them in place and is safe to run again: a screen that
# already carries a .prov-badge or .prov-mark is left as it is. It also writes the variants for a Codex
# and a Copilot chat from the patched Claude chat, and the phone's details Sheet with the native id.
# Runs on its own, after nothing (imports providers.py for the labels and hues).
#   python3 chatproviders.py
import os
import re

from common import OUT, ico, write, desktop, mobile
from providers import PROV

CHATS = {  # per provider: what differs between the three chats of the prototypes
  'claude-code': dict(
    id='b67aa3', native=None, model='opus-5.5', model_chip='Opus 5.5', mode='bypassPermissions', mode_chip='Sin pedir permisos',
    version='2.1.282'),
  'codex': dict(
    id='7e41c0', native='0197c3a2-5b0e-7d41-9c4a-2f6b81e04b1d', model='gpt-6.1-sol', model_chip='gpt-6.1-sol',
    mode='acceptEdits', mode_chip='Aceptar ediciones', version='0.159.3',
    title='Añade un test para el parser de fechas y arregla lo que falle',
    short='Añade un test para el parser de fechas', list_title='Añade un test para el parser de fechas y arregla lo que falle',
    detail='pnpm test', ctx=('19', '52.310 de 272 k tokens'), messages='14', start='1 oct, 09:42',
    usage=[('gpt-6.1-sol', '41,2 k', '5,9 k', '38,1 k')]),
  'copilot': dict(
    id='a19f52', native='5f3b2c71-08d4-4e9a-b6c3-7a1d90e8c254', model='auto', model_chip='Lo elige Copilot', mode='manual',
    mode_chip='Preguntar', version='1.0.90',
    title='Explica cómo se calcula la próxima ejecución de una programación',
    short='Explica cómo se calcula la próxima ejecución', list_title='Explica cómo se calcula la próxima ejecución de una programación',
    detail='read · scheduler.ts', ctx=('15', '19.200 de 128 k tokens'), messages='9', start='1 oct, 10:05',
    usage=[('auto', '17,4 k', '1,8 k', '9,6 k')]),
}


# ---------------------------------------------------------------- pieces
def mark(pid, extra=''):
  label, letters, hue = PROV[pid]
  return f'<span class="prov-mark" style="--hue: {hue}" role="img" aria-label="{label}" title="{label}">{letters}</span>'


def badge(pid):
  label, letters, hue = PROV[pid]
  return (f'<span class="prov-badge"><span class="prov-mark" style="--hue: {hue}" aria-hidden="true">{letters}</span>{label}</span>')


def read(name):
  with open(os.path.join(OUT, name)) as f:
    return f.read()


def sub(s, old, new, count=1):
  """A replacement that fails loudly: a pattern that stops matching means the screen changed under us."""
  if old not in s:
    raise SystemExit(f'pattern not found: {old[:90]}')
  return s.replace(old, new, count)


def done(s):
  return 'prov-badge' in s or 'prov-mark' in s


# ---------------------------------------------------------------- the chat page, desktop
def desktop_chat_base(s):
  """Claude's chat, with the badge beside the model, the working line naming the agent and the details."""
  c = CHATS['claude-code']
  s = sub(s, '<span class="mono t-xs fg-3">claude-wrapper · b67aa3 · opus-5.5</span>',
          f'<span class="row t-xs" style="gap: 8px"><span class="mono fg-3">claude-wrapper · {c["id"]}</span>{badge("claude-code")}<span class="mono fg-3">{c["model"]}</span></span>')
  s = sub(s, '<span class="shimmer" style="font-weight: 500">Ejecutando</span><span class="mono t-xs fg-3">Compare styles · 15s</span>',
          '<span class="shimmer" style="font-weight: 500">Claude Code está trabajando</span><span class="mono t-xs fg-3">Compare styles · 15s</span>')
  s = sub(s, '<span class="t-label" style="padding-bottom: 8px">Chat</span>\n',
          '<span class="t-label" style="padding-bottom: 8px">Chat</span>\n'
          f'<div class="row t-sm" style="padding: 8px 0; border-top: 1px solid var(--line)"><span class="fg-3" style="width: 90px">Agente</span>{badge("claude-code")}</div>\n')
  return s


def desktop_chat_for(base, pid):
  c = CHATS[pid]
  label = PROV[pid][0]
  s = base
  s = sub(s, 'Agentry · Chat (desktop)', f'Agentry · Chat de {label} (desktop)')
  s = sub(s, '>b67aa3</span>\n</nav>', f'>{c["id"]}</span>\n</nav>')
  s = s.replace('claude-wrapper-b67aa3', f'claude-wrapper-{c["id"]}').replace('Compare styles', c['detail'])
  s = sub(s, 'Revisa la PWA y la app desktop para mejorarlas</span>', f'{c["title"]}</span>')
  s = sub(s, f'claude-wrapper · b67aa3</span>{badge("claude-code")}<span class="mono fg-3">opus-5.5',
          f'claude-wrapper · {c["id"]}</span>{badge(pid)}<span class="mono fg-3">{c["model"]}')
  s = sub(s, f'<span class="fg-3" style="width: 90px">Agente</span>{badge("claude-code")}', f'<span class="fg-3" style="width: 90px">Agente</span>{badge(pid)}')
  s = sub(s, 'Claude Code está trabajando', f'{label} está trabajando')
  s = transcript(s, pid)
  # composer: the model and the mode are the provider's; what it lacks (preset, the CLI's MCP) is not shown
  chips = re.search(r'<div class="row" style="gap: 6px"><button type="button" class="chip">Opus 5\.5.*?(?=<span class="grow"></span>)', s, re.S)
  assert chips
  if pid == 'copilot':
    model = f'<button type="button" class="chip" disabled aria-disabled="true" title="Copilot elige el modelo cuando empieza el chat" style="color: var(--fg-3); cursor: default">{ico("lock", "ico ico-sm")}{c["model_chip"]}</button>'
  else:
    model = f'<button type="button" class="chip">{c["model_chip"]}</button>'
  mode = f'<button type="button" class="chip">{c["mode_chip"]}</button>'
  s = s.replace(chips.group(0), f'<div class="row" style="gap: 6px">{model}{mode}')
  # details: context, cost (none reported), the chat's rows
  s = sub(s, '--p: 14; width: 60px; height: 60px; font-size: 12px">14%', f'--p: {c["ctx"][0]}; width: 60px; height: 60px; font-size: 12px">{c["ctx"][0]}%')
  s = sub(s, '144.826 de 1 M tokens', c['ctx'][1])
  s = re.sub(r'<section class="col" style="gap: 8px">\n<div class="row"><span class="t-label grow">Coste</span>.*?</section>',
             lambda m: usage_section(label, c['usage']), s, count=1, flags=re.S)
  s = sub(s, '<span class="badge b-accent">bypassPermissions</span>', f'<span class="badge b-accent">{c["mode"]}</span>')
  s = re.sub(r'<div class="row t-sm" style="padding: 8px 0; border-top: 1px solid var\(--line\)"><span class="fg-3" style="width: 90px">Sesión</span>.*?</div>\n',
             lambda m: session_rows(c), s, count=1, flags=re.S)
  s = sub(s, '<span class="t-num">109</span>', f'<span class="t-num">{c["messages"]}</span>')
  s = sub(s, '<span>25 sep, 16:18</span>', f'<span>{c["start"]}</span>')
  return s


def transcript(s, pid):
  """The conversation of a non-Claude chat. Tool names are the ones its stream reports: Codex's items,
  Copilot's ACP tool kinds."""
  c = CHATS[pid]
  tools = {
    'codex': (('2 herramientas · 1 s', ['commandExecution ×2']), ('3 herramientas · 42 s', ['commandExecution ×2', 'fileChange'])),
    'copilot': (('4 herramientas · 3 s', ['read ×3', 'execute']), ('1 herramienta · 12 s', ['edit'])),
  }[pid]
  prose = {
    'codex': (
      'Lo primero es ver qué casos cubre el parser de <code>packages/core/src/dates.ts</code>. Leo los tests actuales y escribo el que falta.',
      'El test nuevo falla con fechas sin año: <code>parseDate(\'3 oct\')</code> devuelve <code>Invalid Date</code>. Lo corrijo en el parser y vuelvo a lanzar la suite.',
      ['<strong>Año implícito:</strong> si falta, usa el año en curso.', '<strong>Sin cambios de API:</strong> la firma de <code>parseDate</code> es la misma.']),
    'copilot': (
      'La próxima ejecución se calcula en <code>scheduler.ts</code>: parte de la última y suma el intervalo de la expresión cron.',
      'Hay un caso que falla: al cambiar la hora de verano, una programación de las 02:30 se salta un día. Te propongo normalizar a UTC antes de sumar.',
      ['<strong>Normalizar a UTC:</strong> el cálculo no depende de la zona del equipo.', '<strong>Un test por cambio de hora:</strong> marzo y octubre.']),
  }[pid]
  prompt = {
    'codex': 'Añade un test para el parser de fechas y arregla lo que falle.',
    'copilot': 'Explica cómo se calcula la próxima ejecución de una programación y dime si hay algún caso que falle.',
  }[pid]

  def tool_line(t):
    badges = ''.join(f'<span class="badge">{b}</span>' for b in t[1])
    return (f'<div class="row t-xs" style="gap: 8px; font-family: var(--mono); color: var(--fg-3)"><svg class="ico ico-sm c-ok" viewBox="0 0 24 24" style="stroke-width: 2.4"><path d="m5 12 5 5 9-10"></path></svg>'
            f'<span>{t[0]}</span>{badges}<svg class="ico ico-sm" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"></path></svg></div>')

  items = ''.join(f'<li>{i}</li>' for i in prose[2])
  body = (f'<div style="align-self: flex-end; max-width: 78%; background: var(--bg-3); border: 1px solid var(--line); border-radius: var(--r-xl) var(--r-xl) var(--r-xs) var(--r-xl); padding: 11px 15px">{prompt}</div>\n\n'
          f'{tool_line(tools[0])}\n\n<p style="margin: 0">{prose[0]}</p>\n\n{tool_line(tools[1])}\n\n<p style="margin: 0">{prose[1]}</p>\n'
          f'<ul style="margin: 0; padding-left: 20px" class="col">{items}</ul>\n')
  rx = re.compile(r'<div style="align-self: flex-end; max-width: 78%.*?(?=<div class="row t-sm" style="gap: 8px"><span class="spin-braille"></span><span class="shimmer")', re.S)
  assert rx.search(s)
  return rx.sub(lambda m: body, s, count=1)


def usage_section(label, rows):
  """Cost: none of the other providers report it (Codex and Copilot stream tokens only), so the number
  and its gradient give way to a sentence; the tokens stay."""
  lines = ''.join(
    f'<div class="row t-sm" style="gap: 6px"><span class="grow">{m}</span><span class="mono t-xs" style="width: 44px; text-align: right">{i}</span>'
    f'<span class="mono t-xs" style="width: 50px; text-align: right">{o}</span><span class="mono t-xs" style="width: 50px; text-align: right">{k}</span></div>\n'
    for m, i, o, k in rows)
  return ('<section class="col" style="gap: 8px">\n'
          '<div class="row"><span class="t-label grow">Coste</span><span class="t-sm fg-2">Sin coste</span></div>\n'
          f'<span class="t-xs fg-3">{label} no informa del coste, solo de los tokens.</span>\n'
          '<div class="row th" style="gap: 6px"><span class="grow">Modelo</span><span style="width: 44px; text-align: right">Entr.</span><span style="width: 50px; text-align: right">Sal.</span><span style="width: 50px; text-align: right">Caché</span></div>\n'
          f'{lines}</section>')


def copy_btn(what):
  return f'<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Copiar {what}">{ico("copy", "ico ico-sm")}</button>'


def session_rows(c):
  """The chat's id and, below it and secondary, the id the agent's own session has. Claude's two are one."""
  row = 'class="row t-sm" style="padding: 8px 0; border-top: 1px solid var(--line)"'
  chat = (f'<div {row}><span class="fg-3" style="width: 90px">Id del chat</span><span class="mono t-xs grow">{c["id"]}</span>{copy_btn("id del chat")}</div>\n')
  native = (f'<div {row}><span class="fg-3" style="width: 90px">Id nativo</span><span class="mono t-xs fg-2 grow ellipsis">{c["native"][:8]}…{c["native"][-4:]}</span>{copy_btn("id nativo")}</div>\n')
  return chat + native


# ---------------------------------------------------------------- the chat page, phone
def mobile_chat_base(s):
  s = sub(s, '<span class="row t-xs mono" style="gap: 6px"><span class="spin-braille"></span><span class="c-live">trabajando</span><span class="fg-3">· 14% · 2,55 US$</span></span>',
          f'<span class="row t-xs mono" style="gap: 8px">{badge("claude-code")}<span class="spin-braille"></span><span class="c-live">trabajando</span></span>')
  s = sub(s, '<span class="shimmer" style="font-weight: 500">Ejecutando</span><span class="mono t-xs fg-3">Compare styles · 15s</span>',
          '<span class="shimmer" style="font-weight: 500; white-space: nowrap; flex-shrink: 0">Claude Code está trabajando</span><span class="mono t-xs fg-3 ellipsis">Compare styles · 15s</span>')
  return s


def mobile_chat_for(base, pid):
  c = CHATS[pid]
  label = PROV[pid][0]
  s = base
  s = sub(s, 'Revisa la PWA y la app desktop</span>', f'{c["short"]}</span>')
  s = sub(s, badge('claude-code'), badge(pid))
  s = sub(s, 'Claude Code está trabajando', f'{label} está trabajando')
  s = s.replace('Compare styles', c['detail'])
  s = transcript_mobile(s, pid)
  chips = re.search(r'<div class="row" style="gap: 6px; overflow: hidden"><button type="button" class="chip" style="height: 32px">Opus 5\.5.*?</div>', s, re.S)
  assert chips
  if pid == 'copilot':
    model = f'<button type="button" class="chip" style="height: 32px; color: var(--fg-3); cursor: default" disabled aria-disabled="true" title="Copilot elige el modelo cuando empieza el chat">{ico("lock", "ico ico-sm")}{c["model_chip"]}</button>'
  else:
    model = f'<button type="button" class="chip" style="height: 32px">{c["model_chip"]}</button>'
  mode = f'<button type="button" class="chip" style="height: 32px">{c["mode_chip"]}</button>'
  return s.replace(chips.group(0), f'<div class="row" style="gap: 6px; overflow: hidden">{model}{mode}</div>')


def transcript_mobile(s, pid):
  tools = {'codex': ('3 herramientas · 42 s', ['commandExecution ×2', 'fileChange']), 'copilot': ('4 herramientas · 3 s', ['read ×3', 'execute'])}[pid]
  prose = {
    'codex': ('El test nuevo falla con fechas sin año: <code>parseDate(\'3 oct\')</code> devuelve <code>Invalid Date</code>. Lo corrijo en el parser.',
              ['<strong>Año implícito:</strong> si falta, usa el año en curso.', '<strong>Sin cambios de API:</strong> misma firma.']),
    'copilot': ('Hay un caso que falla: al cambiar la hora de verano, una programación de las 02:30 se salta un día.',
                ['<strong>Normalizar a UTC:</strong> el cálculo no depende de la zona.', '<strong>Un test por cambio de hora:</strong> marzo y octubre.']),
  }[pid]
  badges = ''.join(f'<span class="badge">{b}</span>' for b in tools[1])
  body = (f'<div class="row t-xs mono fg-3" style="gap: 6px"><svg class="ico ico-sm c-ok" viewBox="0 0 24 24" style="stroke-width: 2.4"><path d="m5 12 5 5 9-10"></path></svg>{tools[0]}</div>\n'
          f'<div class="row" style="gap: 6px">{badges}</div>\n'
          f'<p style="margin: 0">{prose[0]}</p>\n'
          f'<ul class="col" style="margin: 0; padding-left: 20px; gap: 6px">' + ''.join(f'<li>{i}</li>' for i in prose[1]) + '</ul>\n')
  rx = re.compile(r'<div class="row t-xs mono fg-3" style="gap: 6px"><svg class="ico ico-sm c-ok".*?(?=<div class="row t-sm" style="gap: 8px"><span class="spin-braille"></span><span class="shimmer")', re.S)
  assert rx.search(s)
  return rx.sub(lambda m: body, s, count=1)


def details_sheet(pid):
  """The phone's details panel as a Sheet: the agent, the chat's settings and both ids."""
  c = CHATS[pid]
  rows = [
    ('Agente', badge(pid)),
    ('Modelo', f'<span class="mono t-xs">{c["model"]}</span>'),
    ('Permisos', f'<span class="badge b-accent">{c["mode"]}</span>'),
    ('Directorio', '<span class="mono t-xs ellipsis">~/Escritorio/claude-wrapper</span>'),
  ]
  line = 'class="row" style="gap: 12px; min-height: 44px; border-top: 1px solid var(--line)"'
  out = ''.join(f'<div {line}><span class="t-sm fg-3" style="width: 92px">{k}</span><span class="grow row" style="min-width: 0">{v}</span></div>' for k, v in rows)
  out += (f'<div {line}><span class="t-sm fg-3" style="width: 92px">Id del chat</span><span class="mono t-xs grow">{c["id"]}</span>'
          f'<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Copiar id del chat">{ico("copy", "ico")}</button></div>'
          f'<div {line}><span class="t-sm fg-3" style="width: 92px">Id nativo</span><span class="mono t-xs fg-2 grow" style="overflow-wrap: anywhere">{c["native"]}</span>'
          f'<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Copiar id nativo">{ico("copy", "ico")}</button></div>')
  scrim = '<div style="position: absolute; inset: 0; z-index: 10; background: color-mix(in srgb, var(--bg) 60%, transparent)"></div>'
  return (f'{scrim}\n<div class="sheet" role="dialog" aria-label="Detalles del chat" style="z-index: 11; padding-bottom: 28px; display: flex; flex-direction: column; gap: 10px; max-height: 92%">\n'
          f'<div class="grab" style="margin-bottom: 0"></div>\n<h2 class="t-h2">Detalles del chat</h2>\n<div class="col" style="gap: 0">{out}</div>\n</div>')


# ---------------------------------------------------------------- the chats list
ROW_PLAN = {  # row index -> provider; the rest are Claude Code's. A terminal session is Claude's.
  1: 'codex',
  3: 'copilot',
}
ROW_TEXT = {  # the title and id a non-Claude row carries instead
  'codex': ('Cual es el estado actual del proyecto?', CHATS['codex']['list_title'], '391372', CHATS['codex']['id']),
  'copilot': ('Necesito que me ayudes a configurar claude-wrapper con pando en modo MCP', CHATS['copilot']['list_title'], '69b7ae', CHATS['copilot']['id']),
}


FIXED = re.compile(r'(<span(?: class="[^"]*")?) style="width: ')


def desktop_chats(s):
  s = s.replace('<span class="col grow" style="gap: 2px">', '<span class="col grow" style="gap: 2px; min-width: 0">')
  s = FIXED.sub(r'\1 style="flex-shrink: 0; width: ', s)
  s = sub(s, '<span style="width: 18px"></span><span class="grow">Chat</span>', '<span style="width: 18px"></span><span style="width: 20px"></span><span class="grow">Chat</span>')
  blocks = s.split('\n\n')
  idx = 0
  for n, b in enumerate(blocks):
    if not (b.startswith('<a href="DesktopChat.html" class="row') or b.startswith('<div class="row list-row sel"')):
      continue
    pid = ROW_PLAN.get(idx, 'claude-code')
    lines = b.split('\n')
    lines.insert(2, mark(pid))
    b = '\n'.join(lines)
    if pid != 'claude-code':
      old_t, new_t, old_id, new_id = ROW_TEXT[pid]
      b = sub(b, old_t, new_t)
      b = sub(b, old_id, new_id)
      b = re.sub(r'<span class="t-num t-sm" style="width: 84px; text-align: right">[^<]*</span>',
                 '<span class="t-xs fg-3" style="width: 84px; text-align: right">sin coste</span>', b)
    blocks[n] = b
    idx += 1
  assert idx >= 5, idx
  return '\n\n'.join(blocks)


def mobile_chats(s):
  lines = s.split('\n')
  idx = 0
  for n, ln in enumerate(lines):
    if not ln.startswith('<a href="MobileChat.html" class="row'):
      continue
    pid = ROW_PLAN.get(idx, 'claude-code')
    if pid != 'claude-code':
      old_t, new_t, old_id, new_id = ROW_TEXT[pid]
      ln = sub(ln, old_t, new_t)
      ln = ln.replace(old_id, new_id)
      ln = re.sub(r'(\d+%) · [\d,]+ US\$', r'\1 · sin coste', ln)
      ln = ln.replace(' · sin coste · sin coste', ' · sin coste')
    tail = re.search(r'(<span class="t-xs[^"]*"[^>]*>[^<]*</span>)</a>$', ln)
    assert tail, ln[-120:]
    ln = ln[:tail.start()] + f'<span class="col" style="align-items: flex-end; gap: 8px">{tail.group(1)}{mark(pid)}</span></a>'
    lines[n] = ln
    idx += 1
  assert idx >= 5, idx
  return '\n'.join(lines)


# ---------------------------------------------------------------- bringing the old screens into the shell
# The four screens were written before the generators, with their own copy of the shell and pixel radii.
# The first run lifts what is specific to each (the chat or the list, and the sidebar's live block) out of
# the old file, writes it into the shared shell of common.py and swaps the pixel radii for tokens; from
# then on the files carry a .prov-badge or .prov-mark and the script leaves them as they are.
TOKENS = (
  ('border-radius: 16px 16px 4px 16px', 'border-radius: var(--r-xl) var(--r-xl) var(--r-xs) var(--r-xl)'),
  ('border-radius: 14px', 'border-radius: var(--r-lg)'),
  ('border-radius: 16px', 'border-radius: var(--r-xl)'),
  ('border-radius: 24px', 'border-radius: var(--r-xl)'),
  ('border-radius: 8px', 'border-radius: var(--r)'),
  ('accent-color: #e0668f', 'accent-color: var(--accent)'),
)


def tokenise(s):
  for old, new in TOKENS:
    s = s.replace(old, new)
  return s


def live_block(old):
  m = re.search(r'<div class="col" style="gap: 4px">\n<div class="row" style="padding: 0 10px 4px"><span class="t-label grow">En directo.*?</div>\n(?=\n<div class="grow">)', old, re.S)
  assert m
  return m.group(0)


def lift_desktop(old, pattern):
  m = re.search(pattern, old, re.S)
  assert m, pattern
  return tokenise(m.group(1)), live_block(old)


def lift_mobile(old):
  m = re.search(r'<div class="app m-screen[^>]*>\n(.*)\n</div>\n(?:<script>t\(\)</script>\n)?</body>', old, re.S)
  assert m
  return tokenise(m.group(1))


CHAT_CRUMB = '<a href="DesktopChats.html" class="fg-2">Chats</a><span class="fg-3">/</span><span class="mono" style="font-weight: 500">{id}</span>'


# ---------------------------------------------------------------- run
if __name__ == '__main__':
  s = read('DesktopChat.html')
  if not done(s):
    main, live = lift_desktop(s, r'(<div class="row" style="flex: 1 1 auto; min-height: 0; align-items: stretch; gap: 0">.*?)\n\n<footer')
    main = desktop_chat_base(main)
    s = desktop('Chat', 'chats', CHAT_CRUMB.format(id=CHATS['claude-code']['id']), main, live=live, agents=3, running=3)
    write('DesktopChat.html', s)
  for pid, name in (('codex', 'DesktopChatCodex.html'), ('copilot', 'DesktopChatCopilot.html')):
    write(name, desktop_chat_for(s, pid))

  m = read('MobileChat.html')
  if not done(m):
    m = mobile('Chat', mobile_chat_base(lift_mobile(m)).replace('min-height: 40px; align-items: center"><textarea', 'min-height: var(--touch); align-items: center"><textarea'), style='font-size: 15px')
    write('MobileChat.html', m)
  for pid, name in (('codex', 'MobileChatCodex.html'), ('copilot', 'MobileChatCopilot.html')):
    write(name, mobile_chat_for(m, pid))
  mc = mobile_chat_for(m, 'codex')
  assert '\n</div>\n<script>' in mc
  write('MobileChatDetalles.html', mc.replace('\n</div>\n<script>', '\n' + details_sheet('codex') + '\n</div>\n<script>'))

  t = read('DesktopChats.html')
  if not done(t):
    main, live = lift_desktop(t, r'(<main class="page">.*?</main>)')
    write('DesktopChats.html', desktop('Chats', 'chats', '<span style="font-weight: 500">Chats</span>', desktop_chats(main), project='Todos los proyectos', live=live, agents=3, running=3))
  t = read('MobileChats.html')
  if not done(t):
    write('MobileChats.html', mobile('Chats', mobile_chats(lift_mobile(t))))
