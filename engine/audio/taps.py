"""
Audio tap helpers.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, List


@dataclass
class AudioTap:
    """
    Registry of audio callbacks used to fan-out PCM data to beat trackers
    and other consumers.
    """

    callbacks: List[Callable[[bytes], None]]

    def __init__(self) -> None:
        self.callbacks = []

    def register(self, callback: Callable[[bytes], None]) -> None:
        self.callbacks.append(callback)

    def unregister(self, callback: Callable[[bytes], None]) -> None:
        self.callbacks = [cb for cb in self.callbacks if cb != callback]

    def push(self, pcm: bytes) -> None:
        for callback in list(self.callbacks):
            callback(pcm)

