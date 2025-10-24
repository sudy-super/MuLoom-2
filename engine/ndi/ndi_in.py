"""
NDI input placeholder.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict


@dataclass
class NDIInput:
    source_name: str
    params: Dict[str, str] = field(default_factory=dict)

    def to_gst_args(self) -> Dict[str, str]:
        return {"source-name": self.source_name, **self.params}

