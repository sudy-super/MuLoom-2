"""
Mixer building utilities.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List


@dataclass
class MixerLayer:
    source_id: str
    opacity: float = 1.0
    blend_mode: str = "screen"


class MixerBuilder:
    """
    Placeholder mixer factory.

    Subsequent iterations will materialise a GstBin containing `glvideomixer`
    and associated pads.
    """

    def __init__(self) -> None:
        self.layers: List[MixerLayer] = []

    def add_layer(self, layer: MixerLayer) -> None:
        self.layers.append(layer)

    def clear(self) -> None:
        self.layers.clear()

