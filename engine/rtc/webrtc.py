"""
Minimal in-memory WebRTC session representation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class ICECandidate:
    """Serialisable ICE candidate container."""

    candidate: str
    sdp_mid: Optional[str] = None
    sdp_mline_index: Optional[int] = None


@dataclass
class WebRTCSession:
    """
    Tracks the negotiate artefacts exchanged with the control UI.

    The webrtcsink element already embeds its own signaller; this class simply
    keeps the latest offer/answer/candidates so the REST layer can expose them
    for debugging when necessary.
    """

    offer: Optional[str] = None
    answer: Optional[str] = None
    ice_candidates: List[ICECandidate] = field(default_factory=list)

    def set_offer(self, offer_sdp: str) -> None:
        self.offer = offer_sdp

    def set_answer(self, answer_sdp: str) -> None:
        self.answer = answer_sdp

    def add_candidate(self, candidate: ICECandidate) -> None:
        self.ice_candidates.append(candidate)


__all__ = ["ICECandidate", "WebRTCSession"]
