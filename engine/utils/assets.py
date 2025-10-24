"""
Asset discovery utilities.
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List

ROOT_DIR = Path(__file__).resolve().parents[2]
GLSL_DIR = ROOT_DIR / "glsl"
MP4_DIR = ROOT_DIR / "mp4"


def _read_glsl_assets() -> List[dict]:
    assets: List[dict] = []
    if not GLSL_DIR.exists():
        return assets
    for entry in sorted(GLSL_DIR.glob("*.glsl")):
        try:
            code = entry.read_text(encoding="utf-8")
        except OSError:
            continue
        assets.append(
            {
                "id": entry.name,
                "name": entry.stem,
                "code": code,
            }
        )
    return assets


def _read_mp4_assets() -> List[dict]:
    assets: List[dict] = []
    if not MP4_DIR.exists():
        return assets

    for category_dir in sorted(MP4_DIR.iterdir()):
        if category_dir.is_file() and category_dir.suffix.lower() == ".mp4":
            rel_path = category_dir.name
            assets.append(
                {
                    "id": rel_path,
                    "name": category_dir.stem,
                    "category": "",
                    "url": f"/stream/mp4/{rel_path}",
                }
            )
            continue

        if not category_dir.is_dir():
            continue

        category = category_dir.name
        for video in sorted(category_dir.glob("*.mp4")):
            rel_path = f"{category}/{video.name}"
            assets.append(
                {
                    "id": rel_path,
                    "name": video.stem,
                    "category": category,
                    "url": f"/stream/mp4/{rel_path}",
                }
            )
    return assets


def read_fallback_assets() -> Dict[str, List[dict]]:
    """
    Mirror the legacy Node.js control server behaviour by scanning ``glsl/`` and ``mp4/``.
    """

    return {
        "glsl": _read_glsl_assets(),
        "videos": _read_mp4_assets(),
        "overlays": [],
    }

