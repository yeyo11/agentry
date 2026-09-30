# Capture prototypes with headless Chrome in dark and light, as webp.
import os, subprocess, sys, tempfile
from PIL import Image

REF = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# A PNG of every capture is kept here too, to look at it and to build contact sheets (sheet.py).
LOOK = os.environ.get('NS_LOOK') or os.path.join(tempfile.gettempdir(), 'ns-look')
CHROME = os.environ.get('CHROME_BIN', '/usr/bin/google-chrome')
SIZES = {'Desktop': (1440, 1024, 1), 'Mobile': (390, 844, 2), 'DS': (1440, None, 1)}
# The shell pieces are captured at their own size
PIECES = {'Sidebar': (256, 1024, 2), 'TabBar': (390, 84, 2), 'Topbar': (1184, 52, 1), 'StatusBar': (1184, 444, 1),
          'Illustration': (240, 160, 2), 'Main': (1440, 1060, 1)}


def shoot(name, h=None):
  kind = 'Mobile' if name.startswith('Mobile') else ('DS' if name.startswith('DS') else 'Desktop')
  w, dh, scale = PIECES.get(name) or SIZES[kind]
  h = h or dh
  for theme in ('dark', 'light'):
    url = f'file://{REF}/{name}.html' + ('#light' if theme == 'light' else '')
    png = os.path.join(tempfile.gettempdir(), f'ns-{name}-{theme}.png')
    prof = tempfile.mkdtemp(prefix='ns-chrome-')
    subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
                    f'--user-data-dir={prof}', f'--window-size={w},{h}', f'--force-device-scale-factor={scale}',
                    '--virtual-time-budget=2500', f'--screenshot={png}', url],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    subprocess.run(['rm', '-rf', prof])
    im = Image.open(png).convert('RGB')
    im.save(f'{REF}/screenshots/{name}-{theme}.webp', 'WEBP', quality=90, method=6)
    im.save(os.path.join(LOOK, f'{name}-{theme}.png'))
    print('shot', name, theme, im.size)


if __name__ == '__main__':
  os.makedirs(LOOK, exist_ok=True)
  for a in sys.argv[1:]:
    if ':' in a:
      n, hh = a.split(':')
      shoot(n, int(hh))
    else:
      shoot(a)
