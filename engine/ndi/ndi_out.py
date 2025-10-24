"""
NDI output placeholder.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict


@dataclass
class NDIOutput:
    publish_name: str
    params: Dict[str, str] = field(default_factory=dict)

    def to_gst_args(self) -> Dict[str, str]:
        return {"ndi-name": self.publish_name, **self.params}

