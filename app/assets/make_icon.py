"""Draw the JDebate icon (two speech bubbles) as icon.png and icon.ico. Needs Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw

HERE = Path(__file__).parent
S = 1024
k = S / 64

def sc(points):
    return [(x * k, y * k) for x, y in points]

img = Image.new("RGBA", (S, S))
d = ImageDraw.Draw(img)
d.rounded_rectangle((0, 0, S - 1, S - 1), radius=int(13 * k), fill="#2b2f8f")
# Back bubble (right), light.
d.rounded_rectangle(sc([(26, 26), (56, 46)]), radius=int(4 * k), fill="#b9bdf5")
d.polygon(sc([(42, 45), (49, 45), (49, 52)]), fill="#b9bdf5")
# Front bubble (left), white, with a gap ring so they read as two.
d.rounded_rectangle(sc([(6, 14), (42, 38)]), radius=int(5 * k), fill="#2b2f8f")
d.rounded_rectangle(sc([(8, 16), (40, 36)]), radius=int(4 * k), fill="#ffffff")
d.polygon(sc([(15, 35), (22, 35), (15, 42)]), fill="#ffffff")

img.resize((512, 512), Image.Resampling.LANCZOS).save(HERE / "icon.png")
img.save(HERE / "icon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
