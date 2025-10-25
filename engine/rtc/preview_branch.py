"""
Preview branch configuration for the WebRTC preview sink.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Optional


@dataclass
class PreviewBranch:
    """
    Parameters applied to the preview branch of the pipeline.

    The branch fans out from the main tee into a queue → gldownload →
    videoconvert → webrtcsink chain.  The dataclass exposes the properties that
    should be configured on the webrtcsink element.
    """

    sink_factory: str = "webrtcsink"
    signaller_uri: Optional[str] = "ws://127.0.0.1:8443"
    stun_server: Optional[str] = "stun://stun.l.google.com:19302"
    turn_server: Optional[str] = None
    latency_ms: int = 0
    extra_properties: Dict[str, object] = field(default_factory=dict)

    def iter_sink_properties(self) -> Dict[str, object]:
        """
        Return the flattened property map applied to the webrtcsink instance.
        """

        props: Dict[str, object] = dict(self.extra_properties)
        if self.signaller_uri:
            props["signaller::uri"] = self.signaller_uri
        if self.stun_server:
            props["stun-server"] = self.stun_server
        if self.turn_server:
            props["turn-server"] = self.turn_server
        props["latency"] = int(self.latency_ms)
        return props
