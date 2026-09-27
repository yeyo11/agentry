import os, sys, tempfile
from PIL import Image
L = (os.environ.get('NS_LOOK') or os.path.join(tempfile.gettempdir(), 'ns-look')) + '/'
out, names = sys.argv[1], sys.argv[2:]
mob = names[0].startswith('Mobile')
w, h = (390, 844) if mob else (720, 512)
cols = 4 if mob else 2
rows = (len(names) + cols - 1) // cols
sheet = Image.new('RGB', (cols * (w + 8), rows * (h + 8)), (120, 120, 120))
for i, n in enumerate(names):
  im = Image.open(L + n + '.png').resize((w, h))
  sheet.paste(im, ((i % cols) * (w + 8), (i // cols) * (h + 8)))
sheet.save(L + out)
