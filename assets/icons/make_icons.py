"""Gera os ícones do PWA CupFellas a partir da taça PNG (assets/world-cup (1).png).
Roda uma vez localmente (não faz parte do app). Requer Pillow.

v2 (jun/2026): ícone de app com TAÇA MAIOR + halo dourado no fundo escuro, pra aparecer
nítido quando o Android recorta a versão maskable num círculo (antes a taça ficava
pequena e dark-on-dark, parecendo ícone vazio).
"""
from PIL import Image, ImageDraw, ImageFilter

BG = (11, 10, 7, 255)        # #0B0A07
GOLD = (240, 204, 77)
SRC = "../world-cup (1).png"


def load_trophy():
    im = Image.open(SRC).convert("RGBA")
    return im.crop(im.getbbox())  # recorta margem transparente


def branded_bg(size):
    """Fundo escuro com halo dourado suave atrás da taça (cara de ícone de app)."""
    canvas = Image.new("RGBA", (size, size), BG)
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(glow)
    r = int(size * 0.34)
    cx, cy = size // 2, int(size * 0.46)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GOLD + (95,))
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.13))
    canvas.alpha_composite(glow)
    return canvas


def place(trophy, size, height_ratio, bg=None, branded=False):
    """Centraliza a taça num canvas size×size, ocupando height_ratio da altura."""
    if branded:
        canvas = branded_bg(size)
    else:
        canvas = Image.new("RGBA", (size, size), bg if bg else (0, 0, 0, 0))
    tw, th = trophy.size
    target_h = int(size * height_ratio)
    target_w = max(1, int(tw * target_h / th))
    t = trophy.resize((target_w, target_h), Image.LANCZOS)
    ox = (size - target_w) // 2
    oy = (size - target_h) // 2
    canvas.alpha_composite(t, (ox, oy))
    return canvas


def save(img, path):
    img.convert("RGB").save(path) if path.endswith(".png") and "favicon" not in path else img.save(path)
    print("ok", path, img.size)


if __name__ == "__main__":
    tr = load_trophy()
    # favicons: fundo transparente (aba do navegador)
    save(place(tr, 32, 0.92), "favicon-32.png")
    save(place(tr, 48, 0.92), "favicon-48.png")
    # ícones de app: taça grande sobre fundo escuro + halo dourado
    save(place(tr, 192, 0.82, branded=True), "icon-192.png")
    save(place(tr, 512, 0.82, branded=True), "icon-512.png")
    # apple touch: iOS não curte transparência -> fundo escuro + halo
    save(place(tr, 180, 0.78, branded=True), "apple-touch-icon.png")
    # maskable: taça maior (0.64) dentro da safe zone; halo ajuda a aparecer no recorte
    save(place(tr, 192, 0.64, branded=True), "icon-maskable-192.png")
    save(place(tr, 512, 0.64, branded=True), "icon-maskable-512.png")
