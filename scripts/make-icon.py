#!/usr/bin/env python3
"""程序化生成应用图标：圆角方底 + 同心圆环（外圆 r=0.30，内圆 r=0.135，圆心居中）。

用法：python3 scripts/make-icon.py   （需要 Pillow）
输出：assets/icon_1024.png、build/icon.png（512）、src/icon.png（256）
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ACCENT = (201, 100, 66, 255)
LIGHT = (250, 249, 245, 255)


def render(size: int, ss: int = 4) -> Image.Image:
    n = size * ss
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * 0.2225), fill=ACCENT)
    c = n / 2
    for r, col in ((0.30, LIGHT), (0.135, ACCENT)):
        R = n * r
        d.ellipse([c - R, c - R, c + R, c + R], fill=col)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == '__main__':
    big = render(1024)
    big.save(ROOT / 'assets' / 'icon_1024.png')
    big.resize((512, 512), Image.LANCZOS).save(ROOT / 'build' / 'icon.png')
    big.resize((256, 256), Image.LANCZOS).save(ROOT / 'src' / 'icon.png')
    print('icons written')
