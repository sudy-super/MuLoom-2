"""
Simplified pipeline orchestration for the MuLoom engine.

The original implementation attempted to materialise the entire GStreamer
graph inside this module.  That made the backend difficult to reason about,
hard to test without native dependencies, and painful to extend.  The
refactored pipeline keeps track of *intent* only — which sources should feed
each deck, which outputs are active, and how the mix is layered.  Actual media
execution will be provided by dedicated adapters that can subscribe to this
state.

This approach keeps the control API responsive even when the multimedia stack
is not available, dramatically reducing the amount of defensive code we need
in the Python layer while preserving the data the UI expects.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from .graph import ShaderChain
from .graph.mixers import MixerLayer
from .graph.shaders import ShaderPass
from .rtc import PreviewBranch

LOG = logging.getLogger(__name__)

DEFAULT_DECK_KEYS: Tuple[str, ...] = ("a", "b", "c", "d")


class SourceType(str, Enum):
    """Supported upstream media types."""

    FILE = "file"
    NDI = "ndi"
    CAMERA = "camera"
    GENERATOR = "generator"


class OutputType(str, Enum):
    """Supported downstream consumers."""

    SCREEN = "screen"
    NDI = "ndi"
    FILE = "file"
    WEBRTC = "webrtc"


class DeckRuntimeState(str, Enum):
    """Lifecycle state for a deck's live branch."""

    IDLE = "IDLE"
    LOADING = "LOADING"
    READY = "READY"
    LIVE = "LIVE"
    ERROR = "ERROR"


@dataclass
class VideoSourceConfig:
    """Declarative description of a media source."""

    id: str
    type: SourceType
    uri: Optional[str] = None
    params: Dict[str, str] = field(default_factory=dict)


@dataclass
class OutputConfig:
    """Declarative description of a pipeline sink."""

    id: str
    type: OutputType
    params: Dict[str, str] = field(default_factory=dict)


@dataclass
class PipelineGraph:
    """Serialisable snapshot of the intended media graph."""

    video_sources: List[VideoSourceConfig] = field(default_factory=list)
    outputs: List[OutputConfig] = field(default_factory=list)
    shaders: List[str] = field(default_factory=list)


class Pipeline:
    """
    Lightweight representation of the MuLoom render pipeline.

    The class stores enough state for the control surface and automated tests
    to interact with.  Media backends can watch this state, diff changes, and
    realise them using GStreamer, AVFoundation, or any other runtime without
    forcing those dependencies on the core backend.
    """

    def __init__(self) -> None:
        self.graph = PipelineGraph()
        self.preview_branch = PreviewBranch()
        self.shader_chain = ShaderChain()
        self._lock = threading.RLock()

        self._is_running = False
        self._last_error: Optional[str] = None
        self._mixer_layers: List[MixerLayer] = []
        self._deck_sources: Dict[str, str] = {}
        self._deck_revisions: Dict[str, int] = {}
        self._deck_pending_requests: Dict[str, Tuple[Optional[str], int]] = {}
        self._revision = 0
        self._observers: Dict[int, Callable[["Pipeline", str, Dict[str, object]], None]] = {}
        self._observer_counter = 0

    # ------------------------------------------------------------------ helpers

    @property
    def is_running(self) -> bool:
        return self._is_running

    def source_id_for_deck(self, deck_key: str) -> str:
        return f"deck_{self._sanitize(deck_key)}"

    @staticmethod
    def _sanitize(value: str) -> str:
        cleaned = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in value)
        return cleaned or "source"

    def _resolve_deck_keys(self) -> List[str]:
        seen: Dict[str, bool] = {}
        result: List[str] = []
        for key in DEFAULT_DECK_KEYS:
            if key not in seen:
                seen[key] = True
                result.append(key)
        for key in sorted(self._deck_sources):
            if key not in seen:
                seen[key] = True
                result.append(key)
        return result

    def _next_deck_revision(self, deck_key: str) -> int:
        revision = self._deck_revisions.get(deck_key, 0) + 1
        self._deck_revisions[deck_key] = revision
        return revision

    def subscribe(
        self, callback: Callable[["Pipeline", str, Dict[str, object]], None]
    ) -> int:
        with self._lock:
            self._observer_counter += 1
            token = self._observer_counter
            self._observers[token] = callback
            return token

    def unsubscribe(self, token: int) -> None:
        with self._lock:
            self._observers.pop(token, None)

    def revision_number(self) -> int:
        with self._lock:
            return self._revision

    def _increment_revision_locked(self) -> int:
        self._revision += 1
        return self._revision

    def _notify(self, event: str, payload: Optional[Dict[str, object]] = None) -> None:
        with self._lock:
            observers = list(self._observers.items())
        if not observers:
            return
        base_payload = payload.copy() if payload else {}
        for token, callback in observers:
            try:
                callback(self, event, dict(base_payload))
            except Exception:  # pragma: no cover - observer errors should not bubble
                LOG.exception("Pipeline observer %s failed during '%s' notification.", token, event)

    def _upsert_video_source_config(self, config: VideoSourceConfig) -> None:
        for index, existing in enumerate(self.graph.video_sources):
            if existing.id == config.id:
                self.graph.video_sources[index] = config
                break
        else:
            self.graph.video_sources.append(config)

    @staticmethod
    def _resolve_uri(candidate: Optional[str]) -> Optional[str]:
        if candidate is None:
            return None
        trimmed = str(candidate).strip()
        if not trimmed:
            return None
        if "://" in trimmed or trimmed.startswith("file:"):
            return trimmed
        path = Path(trimmed).expanduser()
        try:
            resolved = path.resolve(strict=True)
        except FileNotFoundError:
            LOG.debug("Deck source '%s' does not exist on disk.", trimmed)
            return None
        except RuntimeError:
            LOG.debug("Failed to resolve path '%s' for URI coercion.", trimmed, exc_info=True)
            return None
        return resolved.as_uri()

    # ------------------------------------------------------------------ mutators

    def start(self) -> None:
        with self._lock:
            self._is_running = True
            self._last_error = None
            revision = self._increment_revision_locked()
        self._notify("state-changed", {"running": True, "revision": revision})

    def stop(self) -> None:
        with self._lock:
            self._is_running = False
            revision = self._increment_revision_locked()
        self._notify("state-changed", {"running": False, "revision": revision})

    def add_video_source(self, config: VideoSourceConfig) -> None:
        with self._lock:
            self._upsert_video_source_config(config)
            revision = self._increment_revision_locked()
            config_payload = {
                "id": config.id,
                "type": config.type.value,
                "uri": config.uri,
                "params": dict(config.params),
            }
        self._notify(
            "video-source-updated",
            {"revision": revision, "source_id": config.id, "config": config_payload},
        )

    def remove_video_source(self, source_id: str) -> None:
        with self._lock:
            self.graph.video_sources = [
                source for source in self.graph.video_sources if source.id != source_id
            ]
            revision = self._increment_revision_locked()
        self._notify("video-source-removed", {"revision": revision, "source_id": source_id})

    def add_output(self, config: OutputConfig) -> None:
        with self._lock:
            self.graph.outputs.append(config)
            revision = self._increment_revision_locked()
            config_payload = {
                "id": config.id,
                "type": config.type.value,
                "params": dict(config.params),
            }
        self._notify(
            "output-added",
            {"revision": revision, "output_id": config.id, "config": config_payload},
        )

    def remove_output(self, output_id: str) -> None:
        with self._lock:
            self.graph.outputs = [output for output in self.graph.outputs if output.id != output_id]
            revision = self._increment_revision_locked()
        self._notify("output-removed", {"revision": revision, "output_id": output_id})

    def set_shaders(self, shader_sources: List[str]) -> None:
        with self._lock:
            self.graph.shaders = list(shader_sources)
            self.shader_chain.clear()
            for fragment in shader_sources:
                self.shader_chain.add_pass(ShaderPass(fragment=fragment))
            revision = self._increment_revision_locked()
        self._notify(
            "shaders-updated",
            {"revision": revision, "count": len(shader_sources)},
        )

    def set_mixer_layers(self, layers: Sequence[MixerLayer]) -> None:
        with self._lock:
            self._mixer_layers = list(layers)
            revision = self._increment_revision_locked()
        self._notify("mixer-updated", {"revision": revision, "layers": len(self._mixer_layers)})

    def set_deck_source(self, deck_key: str, uri: Optional[str]) -> int:
        with self._lock:
            source_id = self.source_id_for_deck(deck_key)
            resolved_uri = self._resolve_uri(uri)
            removed = resolved_uri is None

            if removed:
                self._deck_sources.pop(deck_key, None)
                self.graph.video_sources = [
                    source for source in self.graph.video_sources if source.id != source_id
                ]
            else:
                self._deck_sources[deck_key] = resolved_uri
                config = VideoSourceConfig(id=source_id, type=SourceType.FILE, uri=resolved_uri)
                self._upsert_video_source_config(config)

            revision = self._next_deck_revision(deck_key)
            self._deck_pending_requests[deck_key] = (resolved_uri, revision)
            overall_revision = self._increment_revision_locked()
        self._notify(
            "deck-source-updated",
            {
                "revision": overall_revision,
                "deck": deck_key,
                "source_revision": revision,
                "uri": resolved_uri,
                "removed": removed,
            },
        )
        return revision

    # ------------------------------------------------------------------ queries

    def describe(self) -> Dict[str, object]:
        with self._lock:
            deck_snapshot: Dict[str, dict] = {}
            for key in self._resolve_deck_keys():
                requested_uri = self._deck_sources.get(key)
                pending_uri, pending_revision = self._deck_pending_requests.get(key, (None, None))
                deck_snapshot[key] = {
                    "state": DeckRuntimeState.READY.value if requested_uri else DeckRuntimeState.IDLE.value,
                    "activeRevision": self._deck_revisions.get(key, 0),
                    "pendingRevision": pending_revision,
                    "currentUri": requested_uri,
                    "requestedUri": pending_uri if pending_uri is not None else requested_uri,
                    "lastError": None,
                }

            video_sources = [
                {
                    "id": source.id,
                    "type": source.type.value,
                    "uri": source.uri,
                    "params": dict(source.params),
                }
                for source in self.graph.video_sources
            ]
            outputs = [
                {
                    "id": output.id,
                    "type": output.type.value,
                    "params": dict(output.params),
                }
                for output in self.graph.outputs
            ]
            shader_passes = [
                {
                    "fragment": shader_pass.fragment,
                    "uniforms": {
                        name: {
                            "name": uniform.name,
                            "type": uniform.type,
                            "default": uniform.default,
                            "minimum": uniform.minimum,
                            "maximum": uniform.maximum,
                        }
                        for name, uniform in shader_pass.uniforms.items()
                    },
                }
                for shader_pass in self.shader_chain.passes
            ]
            mixer_layers = [
                {
                    "source_id": layer.source_id,
                    "opacity": layer.opacity,
                    "blend_mode": layer.blend_mode,
                }
                for layer in self._mixer_layers
            ]

            return {
                "running": self._is_running,
                "video_sources": video_sources,
                "outputs": outputs,
                "shader_passes": shader_passes,
                "mixer_layers": mixer_layers,
                "last_error": self._last_error,
                "revision": self._revision,
                "decks": deck_snapshot,
            }
