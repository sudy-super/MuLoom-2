"""
Beat tracking scaffolding using aubio.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable


@dataclass
class BeatEstimate:
    bpm: float
    phase: float
    onset: bool


class BeatTracker:
    """
    Simplified interface mimicking the future aubio-powered implementation.
    """

    def __init__(self, sample_rate: int = 48_000, hop: int = 512) -> None:
        self.sample_rate = sample_rate
        self.hop = hop
        self._last_estimate = BeatEstimate(bpm=120.0, phase=0.0, onset=False)

    def connect(self, audio_src_pad: str) -> None:
        # Placeholder: real implementation will hook into Gst pad.
        self.audio_pad = audio_src_pad

    def on_sample(self, pcm: Iterable[float]) -> None:
        # Placeholder algorithm: mark onset when magnitude exceeds threshold.
        samples = list(pcm)
        if not samples:
            return
        magnitude = sum(abs(sample) for sample in samples) / len(samples)
        onset = magnitude > 0.5
        self._last_estimate = BeatEstimate(
            bpm=self._last_estimate.bpm,
            phase=(self._last_estimate.phase + 0.01) % 1.0,
            onset=onset,
        )

    def result(self) -> Dict[str, float | bool]:
        return {
            "bpm": self._last_estimate.bpm,
            "phase": self._last_estimate.phase,
            "onset": self._last_estimate.onset,
        }
