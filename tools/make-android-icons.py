#!/usr/bin/env python3
"""从 public/icon-512.png 生成 TWA 工程需要的安卓启动图标（各密度 mipmap）。

用法：python3 tools/make-android-icons.py
产物：android-twa/app/src/main/res/mipmap-*/ic_launcher.png
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "public" / "icon-512.png"
TARGETS = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"找不到源图标：{SOURCE}")
    source = Image.open(SOURCE).convert("RGBA")
    for folder, size in TARGETS.items():
        target_dir = ROOT / "android-twa" / "app" / "src" / "main" / "res" / folder
        target_dir.mkdir(parents=True, exist_ok=True)
        source.resize((size, size), Image.LANCZOS).save(target_dir / "ic_launcher.png")
        print(f"已生成 {folder}/ic_launcher.png ({size}×{size})")


if __name__ == "__main__":
    main()
