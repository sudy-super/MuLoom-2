"""
ISF program loader scaffolding.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List


@dataclass
class ISFUniform:
    name: str
    type: str
    default: float | List[float] | int | None = None
    minimum: float | int | None = None
    maximum: float | int | None = None


@dataclass
class ISFInput:
    name: str
    type: str
    description: str | None = None


@dataclass
class ISFProgram:
    path: Path
    passes: List[str] = field(default_factory=list)
    uniforms: Dict[str, ISFUniform] = field(default_factory=dict)
    inputs: Dict[str, ISFInput] = field(default_factory=dict)

    @classmethod
    def load(cls, file_or_dir: str | Path) -> "ISFProgram":
        """
        Load an ISF definition from disk.

        The current placeholder only validates the path and returns an empty
        program; real parsing will be implemented alongside the rendering code.
        """

        path = Path(file_or_dir)
        if not path.exists():
            raise FileNotFoundError(path)
        return cls(path=path)

