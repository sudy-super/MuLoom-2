"""
Shared engine state container.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import logging
from typing import Dict, List
import time

from ..graph.mixers import MixerLayer
from ..pipeline import Pipeline

ALLOWED_DECK_TYPES = {"shader", "video", "generative"}
DECK_KEYS = ("a", "b", "c", "d")

LOG = logging.getLogger(__name__)


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


@dataclass
class DeckState:
    type: str | None = None
    asset_id: str | None = None
    opacity: float = 0.0
    enabled: bool = False

    def to_dict(self) -> dict:
        return {
            "type": self.type,
            "assetId": self.asset_id,
            "opacity": clamp01(self.opacity),
            "enabled": bool(self.enabled),
        }

    def apply(self, payload: dict) -> None:
        if "type" in payload:
            candidate = payload.get("type")
            candidate_str = str(candidate) if candidate is not None else None
            self.type = candidate_str if candidate_str in ALLOWED_DECK_TYPES else None
        if "assetId" in payload or "asset_id" in payload:
            self.asset_id = payload.get("assetId")
            if "asset_id" in payload:
                self.asset_id = payload.get("asset_id")
        if "opacity" in payload:
            value = payload.get("opacity")
            try:
                numeric = float(value if value is not None else 0.0)
            except (TypeError, ValueError):
                numeric = 0.0
            self.opacity = clamp01(numeric)
        if "enabled" in payload:
            self.enabled = bool(payload.get("enabled"))

        if self.type == "generative":
            self.asset_id = None
        elif not self.type or not self.asset_id:
            self.type = None
            self.asset_id = None


@dataclass
class MixState:
    crossfader_ab: float = 0.5
    crossfader_ac: float = 0.5
    crossfader_bd: float = 0.5
    crossfader_cd: float = 0.5
    decks: Dict[str, DeckState] = field(
        default_factory=lambda: {key: DeckState() for key in DECK_KEYS}
    )

    def to_dict(self) -> dict:
        return {
            "crossfaderAB": clamp01(self.crossfader_ab),
            "crossfaderAC": clamp01(self.crossfader_ac),
            "crossfaderBD": clamp01(self.crossfader_bd),
            "crossfaderCD": clamp01(self.crossfader_cd),
            "decks": {key: deck.to_dict() for key, deck in self.decks.items()},
        }


@dataclass
class ControlSettings:
    model_provider: str = "gemini"
    audio_input_mode: str = "file"
    prompt: str = ""

    def to_dict(self) -> dict:
        return {
            "modelProvider": self.model_provider,
            "audioInputMode": self.audio_input_mode,
            "prompt": self.prompt,
        }

    def update(self, payload: dict) -> None:
        if "modelProvider" in payload:
            self.model_provider = str(payload.get("modelProvider") or "gemini")
        if "audioInputMode" in payload:
            mode = str(payload.get("audioInputMode") or "file")
            self.audio_input_mode = mode if mode in {"file", "microphone"} else "file"
        if "prompt" in payload:
            self.prompt = str(payload.get("prompt") or "")


@dataclass
class ViewerStatus:
    is_running: bool = False
    is_generating: bool = False
    error: str = ""
    audio_sensitivity: float = 1.0

    def to_dict(self) -> dict:
        return {
            "isRunning": bool(self.is_running),
            "isGenerating": bool(self.is_generating),
            "error": self.error,
            "audioSensitivity": max(0.0, float(self.audio_sensitivity)),
        }

    def update(self, payload: dict) -> None:
        if "isRunning" in payload:
            self.is_running = bool(payload.get("isRunning"))
        if "isGenerating" in payload:
            self.is_generating = bool(payload.get("isGenerating"))
        if "error" in payload:
            self.error = str(payload.get("error") or "")
        if "audioSensitivity" in payload:
            value = payload.get("audioSensitivity")
            try:
                numeric = float(value if value is not None else 0.0)
            except (TypeError, ValueError):
                numeric = 0.0
            self.audio_sensitivity = max(0.0, numeric)


@dataclass
class DeckMediaState:
    """
    Represents the authoritative transport state for a single deck timeline.
    """

    src: str | None = None
    is_playing: bool = False
    base_position: float = 0.0
    play_rate: float = 1.0
    updated_at: float = field(default_factory=lambda: time.time())
    version: int = 0
    is_loading: bool = False
    error: bool = False
    duration: float | None = None
    _updated_at_monotonic: float = field(default_factory=time.monotonic, repr=False)

    def _normalise_src(self, value) -> str | None:
        if isinstance(value, str):
            candidate = value.strip()
            return candidate or None
        if value is None:
            return None
        return self.src

    def _current_position(self, monotonic_now: float | None = None) -> float:
        current_monotonic = time.monotonic() if monotonic_now is None else monotonic_now
        elapsed = max(0.0, current_monotonic - self._updated_at_monotonic)
        if not self.is_playing:
            return max(0.0, float(self.base_position))
        return max(0.0, float(self.base_position) + elapsed * float(self.play_rate))

    def _bump_version(self, monotonic_now: float | None = None) -> None:
        self.version += 1
        self.updated_at = time.time()
        self._updated_at_monotonic = time.monotonic() if monotonic_now is None else monotonic_now

    def _apply_direct_fields(self, payload: dict, monotonic_now: float | None = None) -> bool:
        changed = False
        if "isLoading" in payload:
            next_value = bool(payload.get("isLoading"))
            if self.is_loading != next_value:
                self.is_loading = next_value
                changed = True
        if "error" in payload:
            next_value = bool(payload.get("error"))
            if self.error != next_value:
                self.error = next_value
                changed = True
        if "src" in payload:
            next_src = self._normalise_src(payload.get("src"))
            if next_src != self.src:
                self.src = next_src
                changed = True
        if "duration" in payload:
            duration_value = payload.get("duration")
            try:
                next_duration = float(duration_value if duration_value is not None else 0.0)
                if next_duration <= 0:
                    next_duration = None
            except (TypeError, ValueError):
                next_duration = None
            if self.duration != next_duration:
                self.duration = next_duration
                changed = True

        return changed

    def apply_request(self, payload: dict | None) -> bool:
        if not payload:
            return False

        monotonic_now = time.monotonic()
        intent = str(payload.get("intent") or "").lower()
        changed = False

        def resolve_position() -> float:
            return self._current_position(monotonic_now)

        if intent in {"toggle", "play", "pause"}:
            target: bool
            if intent == "toggle":
                if "isPlaying" in payload:
                    target = bool(payload.get("isPlaying"))
                else:
                    target = not self.is_playing
            else:
                target = intent == "play"

            if self.is_playing != target:
                self.base_position = resolve_position()
                self.is_playing = target
                changed = True

        elif intent in {"seek", "scrub"}:
            raw_value = payload.get("position", payload.get("value"))
            if raw_value is not None:
                try:
                    target_position = max(0.0, float(raw_value))
                except (TypeError, ValueError):
                    target_position = self.base_position
                if abs(self.base_position - target_position) > 1e-3:
                    self.base_position = target_position
                    changed = True
            if "resume" in payload:
                resume_playback = bool(payload.get("resume"))
                if self.is_playing != resume_playback:
                    if resume_playback:
                        self.base_position = resolve_position()
                    self.is_playing = resume_playback
                    changed = True
            elif changed:
                # default behaviour: pause after seek unless explicitly requested
                if self.is_playing:
                    self.is_playing = False
                    changed = True

        elif intent in {"rate", "speed"}:
            raw_rate = payload.get("value")
            if raw_rate is not None:
                try:
                    next_rate = max(0.0, float(raw_rate))
                except (TypeError, ValueError):
                    next_rate = self.play_rate
                if abs(next_rate - self.play_rate) > 1e-6:
                    current_position = resolve_position()
                    self.base_position = current_position
                    self.play_rate = next_rate
                    changed = True

        elif intent in {"source", "src"}:
            target_src = self._normalise_src(payload.get("src") or payload.get("value"))
            if target_src != self.src:
                self.src = target_src
                changed = True

        elif intent == "state":
            nested_payload = payload.get("value")
            if isinstance(nested_payload, dict):
                changed = self.apply_request(nested_payload) or changed

        else:
            # Backwards compatibility: allow direct field updates without intent.
            direct_updates = {k: payload.get(k) for k in ("isPlaying", "basePosition", "playRate")}
            if direct_updates.get("isPlaying") is not None:
                target_playing = bool(direct_updates["isPlaying"])
                if self.is_playing != target_playing:
                    self.base_position = resolve_position()
                    self.is_playing = target_playing
                    changed = True
            if direct_updates.get("basePosition") is not None:
                try:
                    target_position = max(0.0, float(direct_updates["basePosition"]))
                except (TypeError, ValueError):
                    target_position = self.base_position
                if abs(self.base_position - target_position) > 1e-3:
                    self.base_position = target_position
                    changed = True
            if direct_updates.get("playRate") is not None:
                try:
                    target_rate = max(0.0, float(direct_updates["playRate"]))
                except (TypeError, ValueError):
                    target_rate = self.play_rate
                if abs(self.play_rate - target_rate) > 1e-6:
                    current_position = resolve_position()
                    self.base_position = current_position
                    self.play_rate = target_rate
                    changed = True

        direct_changed = self._apply_direct_fields(payload, monotonic_now=monotonic_now)
        changed = changed or direct_changed

        if changed:
            self._bump_version(monotonic_now=monotonic_now)

        return changed

    def to_dict(self) -> dict:
        monotonic_now = time.monotonic()
        current_position = self._current_position(monotonic_now)
        return {
            "src": self.src,
            "isPlaying": bool(self.is_playing),
            "basePosition": max(0.0, float(self.base_position)),
            "position": max(0.0, float(current_position)),
            "playRate": max(0.0, float(self.play_rate)),
            "updatedAt": float(self.updated_at),
            "version": int(self.version),
            "isLoading": bool(self.is_loading),
            "error": bool(self.error),
            "duration": self.duration,
        }


@dataclass
class EngineState:
    """
    Aggregated state shared between the API and the pipeline orchestrator.
    """

    pipeline: Pipeline = field(default_factory=Pipeline)
    mix: MixState = field(default_factory=MixState)
    panic: bool = False
    panic_card: str = "black"
    active_profile: str = "default"
    control_settings: ControlSettings = field(default_factory=ControlSettings)
    viewer_status: ViewerStatus = field(default_factory=ViewerStatus)
    fallback_layers: list = field(default_factory=list)
    deck_media_states: Dict[str, DeckMediaState] = field(
        default_factory=lambda: {key: DeckMediaState() for key in DECK_KEYS}
    )

    def snapshot(self) -> dict:
        return {
            "fallbackLayers": list(self.fallback_layers),
            "controlSettings": self.control_settings.to_dict(),
            "viewerStatus": self.viewer_status.to_dict(),
            "mixState": self.mix.to_dict(),
            "deckMediaStates": {
                key: state.to_dict() for key, state in self.deck_media_states.items()
            },
        }

    def rebuild_mixer_layers(self) -> None:
        layers: List[MixerLayer] = []
        for key, deck in self.mix.decks.items():
            if not deck.enabled or deck.type != "video" or not deck.asset_id:
                continue
            source_id = self.pipeline.source_id_for_deck(key)
            layers.append(MixerLayer(source_id=source_id, opacity=clamp01(deck.opacity)))
        self.pipeline.set_mixer_layers(layers)

    def apply_deck_update(self, deck_key: str, payload: dict) -> bool:
        deck = self.mix.decks.get(deck_key)
        if not deck:
            return False
        deck.apply(payload or {})
        return True

    def apply_crossfader_update(self, payload: dict) -> bool:
        if not payload:
            return False
        target = str(payload.get("target") or "").lower()
        try:
            value = clamp01(float(payload.get("value") or 0.0))
        except (TypeError, ValueError):
            return False
        field_map = {
            "main": "crossfader_ab",
            "ab": "crossfader_ab",
            "ac": "crossfader_ac",
            "bd": "crossfader_bd",
            "cd": "crossfader_cd",
        }
        field_name = field_map.get(target)
        if not field_name:
            return False
        setattr(self.mix, field_name, value)
        return True

    def update_deck_media_state(self, deck_key: str, payload: dict) -> bool:
        state = self.deck_media_states.get(deck_key)
        if not state:
            return False
        previous_src = state.src
        changed = state.apply_request(payload or {})
        if changed and previous_src != state.src:
            try:
                self.pipeline.set_deck_source(deck_key, state.src)
            except Exception:  # pragma: no cover - defensive
                LOG.exception("Failed to update pipeline source for deck '%s'", deck_key)
        return changed

    def mixer_layers(self) -> Dict[str, MixerLayer]:
        layers = {}
        for key, deck in self.mix.decks.items():
            layers[key] = MixerLayer(
                source_id=self.pipeline.source_id_for_deck(key), opacity=deck.opacity
            )
        return layers
