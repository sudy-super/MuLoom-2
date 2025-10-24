"""
Codec capability declarations.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List


@dataclass
class Codec:
    name: str
    hardware_accelerated: bool = False
    description: str | None = None


class CodecCapabilities:
    def __init__(self) -> None:
        self.video: List[Codec] = []
        self.audio: List[Codec] = []

    def register_video(self, codec: Codec) -> None:
        self.video.append(codec)

    def register_audio(self, codec: Codec) -> None:
        self.audio.append(codec)

