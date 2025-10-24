"""
Panic switch utility.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class PanicState:
    enabled: bool = False
    card: str = "black"


class PanicSwitch:
    """
    Manage the panic card state.

    Real GStreamer wiring will map this state to an input-selector and valve.
    """

    def __init__(self) -> None:
        self.state = PanicState()

    def trigger(self, card: str = "black") -> None:
        self.state.enabled = True
        self.state.card = card

    def release(self) -> None:
        self.state.enabled = False

