"""
Placeholder WebRTC session management.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class ICECandidate:
    candidate: str
    sdp_mid: Optional[str] = None
    sdp_mline_index: Optional[int] = None


@dataclass
class WebRTCSession:
    """In-memory representation of a WebRTC session."""

    offer: Optional[str] = None
    answer: Optional[str] = None
    ice_candidates: List[ICECandidate] = field(default_factory=list)

    def set_offer(self, offer_sdp: str) -> None:
        self.offer = offer_sdp

    def set_answer(self, answer_sdp: str) -> None:
        self.answer = answer_sdp

    def add_candidate(self, candidate: ICECandidate) -> None:
        self.ice_candidates.append(candidate)

