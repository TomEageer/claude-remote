#!/usr/bin/env python3
"""程序化生成应用图标：圆角方底 + 同心圆环（外圆 r=0.30，内圆 r=0.135，圆心居中）。

用法：python3 scripts/make-icon.py   （需要 Pillow）
输出：assets/icon_1024.png、build/icon.png（512）、src/icon.png（256）
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
# 底色和 Claude 官方图标在程序坞里看到的一样：从上到下由浅到深的橙红渐变（从程序坞截图量出来的，上 #e9724e、下 #ec5d35）
TOP = (233, 114, 78, 255)
BOTTOM = (236, 93, 53, 255)
LIGHT = (250, 249, 245, 255)


def mix(t: float):
    return tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(4))


def render(size: int, ss: int = 4) -> Image.Image:
    n = size * ss
    grad = Image.new('RGBA', (1, n))
    for y in range(n):
        grad.putpixel((0, y), mix(y / (n - 1)))
    grad = grad.resize((n, n))
    mask = Image.new('L', (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * 0.2225), fill=255)
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    c = n / 2
    R = n * 0.30
    d.ellipse([c - R, c - R, c + R, c + R], fill=LIGHT)
    # 圆环中间那个洞露出的是底色：按所在高度取渐变里对应的颜色
    r = n * 0.135
    hole = Image.new('L', (n, n), 0)
    ImageDraw.Draw(hole).ellipse([c - r, c - r, c + r, c + r], fill=255)
    img.paste(grad, (0, 0), hole)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == '__main__':
    big = render(1024)
    big.save(ROOT / 'assets' / 'icon_1024.png')
    big.resize((512, 512), Image.LANCZOS).save(ROOT / 'build' / 'icon.png')
    big.resize((256, 256), Image.LANCZOS).save(ROOT / 'src' / 'icon.png')
    print('icons written')
