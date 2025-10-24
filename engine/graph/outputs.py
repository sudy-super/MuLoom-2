"""
Output factory placeholders.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict


@dataclass
class OutputHandle:
    id: str
    type: str
    params: Dict[str, str]


class OutputFactory:
    def create(self, output_id: str, output_type: str, **params: str) -> OutputHandle:
        return OutputHandle(id=output_id, type=output_type, params=params)

