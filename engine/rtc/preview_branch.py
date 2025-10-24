"""
Preview branch configuration placeholder.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict


@dataclass
class PreviewBranch:
    """
    Describes the parameters needed to build the preview branch of the pipeline.
    """

    encoder: str = "vtenc_h264"
    encoder_params: Dict[str, str] = field(default_factory=lambda: {"realtime": "true"})
    payloader: str = "rtph264pay"
    webrtcbin_name: str = "preview-webrtcbin"

