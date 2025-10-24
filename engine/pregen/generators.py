"""
Generative source registry placeholder.
"""

from __future__ import annotations

from typing import Callable, Dict


class GeneratorRegistry:
    def __init__(self) -> None:
        self._registry: Dict[str, Callable[..., str]] = {}

    def register(self, name: str, factory: Callable[..., str]) -> None:
        self._registry[name] = factory

    def create(self, name: str, **kwargs: str) -> str:
        factory = self._registry.get(name)
        if not factory:
            raise KeyError(f"Generator '{name}' not registered")
        return factory(**kwargs)

