"""
Optional Essentia-based beat tracking placeholder.
"""

from __future__ import annotations


class EssentiaBeatTracker:
    def analyse_file(self, path: str) -> dict:
        # Placeholder: return static prediction.
        return {
            "bpm": 120.0,
            "confidence": 0.0,
            "beats": [],
        }

