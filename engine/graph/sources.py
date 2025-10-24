"""
Video/audio source factories.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict


@dataclass
class SourceHandle:
    id: str
    type: str
    params: Dict[str, str]


class SourceFactory:
    """
    Placeholder that will return GstElement handles in the future.
    """

    def create(self, source_id: str, source_type: str, **params: str) -> SourceHandle:
        return SourceHandle(id=source_id, type=source_type, params=params)

