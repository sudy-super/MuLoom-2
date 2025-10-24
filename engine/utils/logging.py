"""
Logging helpers for the MuLoom engine.

Centralising log configuration keeps the rest of the modules focused on their
domain logic and makes it easier to swap logging backends later.
"""

from __future__ import annotations

import logging
import sys
from typing import Optional

DEFAULT_FORMAT = "[%(asctime)s] %(levelname)-8s %(name)s: %(message)s"


def configure_logging(level: int = logging.INFO, format: Optional[str] = None) -> None:
    """
    Ensure the root logger is configured exactly once.
    """

    if logging.getLogger().handlers:
        # Respect any user provided configuration.
        return

    logging.basicConfig(
        level=level,
        format=format or DEFAULT_FORMAT,
        handlers=[logging.StreamHandler(sys.stdout)],
    )

