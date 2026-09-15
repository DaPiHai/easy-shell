"""生成 easy-shell 应用图标：Linear 风格的近黑圆角方块 + 薰衣草蓝底 + ">" 提示符。

纯标准库写 PNG，不依赖 Pillow。输出 src-tauri/icons/icon.png (1024x1024)，
之后交给 `tauri icon` 生成各尺寸与 .ico。
"""

import os
import struct
import zlib

W = H = 1024

ACCENT = (94, 106, 210)  # #5e6ad2
FOREGROUND = (247, 248, 248)  # #f7f8f8

X0, Y0, X1, Y1 = 96, 96, 928, 928
RADIUS = 208
LINE_HALF = 46

AX, AY = 340, 306
BX, BY = 664, 512
CX, CY = 340, 718


def in_rounded_rect(px: int, py: int) -> bool:
    if px < X0 or px > X1 or py < Y0 or py > Y1:
        return False
    cx = min(max(px, X0 + RADIUS), X1 - RADIUS)
    cy = min(max(py, Y0 + RADIUS), Y1 - RADIUS)
    return (px - cx) ** 2 + (py - cy) ** 2 <= RADIUS * RADIUS


def seg_dist(px: int, py: int, ax: int, ay: int, bx: int, by: int) -> float:
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return ((px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2) ** 0.5


def build_rows() -> list[bytes]:
    rows = []
    for py in range(H):
        row = bytearray()
        for px in range(W):
            if not in_rounded_rect(px, py):
                row += b"\x00\x00\x00\x00"
                continue
            d1 = seg_dist(px, py, AX, AY, BX, BY)
            d2 = seg_dist(px, py, BX, BY, CX, CY)
            if min(d1, d2) <= LINE_HALF:
                row += bytes(FOREGROUND) + b"\xff"
            else:
                row += bytes(ACCENT) + b"\xff"
        rows.append(bytes(row))
    return rows


def chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def main() -> None:
    out_dir = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "icon.png")

    raw = b"".join(b"\x00" + r for r in build_rows())
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")

    with open(out_path, "wb") as f:
        f.write(png)
    print(f"wrote {out_path} ({len(png)} bytes)")


if __name__ == "__main__":
    main()
