"""GStreamer helper placeholders."""

from __future__ import annotations

from typing import Any, Callable


def on_pad_added(element: Any, callback: Callable[[Any], None]) -> None:
    """Register a pad-added callback placeholder."""
    return None


def add_probe(pad: Any, probe_type: str, callback: Callable[[Any], None]) -> None:
    """Placeholder for probe installation."""
    return None

