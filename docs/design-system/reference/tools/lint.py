# Tokens only: no hex (but #fff, the text on the gradient), rgb(), hsl(), pixel radius or millisecond
# value in a screen. Usage: python3 lint.py [Screen ...]   (no names: every Desktop*, Mobile* and shell file)
import glob, os, re, sys

REF = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATTERNS = [r'#[0-9a-fA-F]{3,8}\b', r'rgba?\(', r'hsla?\(', r'radius:[^;"]*\d+px', r'\d+ms\b']

names = sys.argv[1:] or sorted(os.path.basename(f)[:-5] for f in glob.glob(os.path.join(REF, '*.html'))
                              if re.match(r'(Desktop|Mobile|Sidebar|TabBar|Topbar|StatusBar)', os.path.basename(f)))
bad = 0
for n in names:
  s = open(os.path.join(REF, n + '.html')).read()
  for pat in PATTERNS:
    for m in re.finditer(pat, s):
      if m.group(0).lower() == '#fff':
        continue
      bad += 1
      print(f'{n}: {m.group(0)}  …{s[max(0, m.start() - 50):m.end() + 10]}…'.replace('\n', ' '))
print(f'violations: {bad} in {len(names)} files')
sys.exit(1 if bad else 0)
