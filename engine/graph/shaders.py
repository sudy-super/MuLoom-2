"""
Shader chain helpers.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List


@dataclass
class ShaderUniform:
    name: str
    type: str
    default: float | List[float] | int = 0
    minimum: float | int | None = None
    maximum: float | int | None = None


@dataclass
class ShaderPass:
    fragment: str
    uniforms: Dict[str, ShaderUniform] = field(default_factory=dict)


class ShaderChain:
    """
    Represents a collection of GLSL passes that will be applied sequentially.
    """

    def __init__(self) -> None:
        self.passes: List[ShaderPass] = []

    def add_pass(self, shader_pass: ShaderPass) -> None:
        self.passes.append(shader_pass)

    def clear(self) -> None:
        self.passes.clear()

