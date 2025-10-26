"""
Global timeline service for deterministic transport control.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Callable, Dict, Optional

LOG = logging.getLogger(__name__)

MonotonicCallable = Callable[[], int]


class TimelineError(RuntimeError):
    """Base class for timeline related errors."""


class RevisionMismatch(TimelineError):
    """Raised when an operation is applied against an unexpected revision."""


class InvalidCommand(TimelineError):
    """Raised when an unsupported command is requested."""


@dataclass(frozen=True, slots=True)
class TransportSnapshot:
    """
    Immutable snapshot of the transport state.
    """

    rev: int
    playing: bool
    rate: float
    pos_us: int
    t0_us: int

    def to_dict(self) -> dict:
        return {
            "rev": int(self.rev),
            "playing": bool(self.playing),
            "rate": float(self.rate),
            "pos_us": int(self.pos_us),
            "t0_us": int(self.t0_us),
        }

    def position_at(self, mono_now_us: Optional[int] = None) -> int:
        """
        Compute the expected position (microseconds) at ``mono_now_us``.
        """

        if mono_now_us is None:
            mono_now_us = time.monotonic_ns() // 1000
        if not self.playing:
            return max(0, int(self.pos_us))
        delta = max(0, int(mono_now_us) - int(self.t0_us))
        increment = int(round(delta * float(self.rate)))
        return max(0, int(self.pos_us) + increment)


class TimelineTransport:
    """
    Deterministic transport controller backed by a monotonic clock.
    """

    def __init__(
        self,
        *,
        initial_position_us: int = 0,
        initial_rate: float = 1.0,
        monotonic: Optional[MonotonicCallable] = None,
    ) -> None:
        self._lock = threading.RLock()
        self._rev = 0
        self._playing = False
        self._rate = max(0.0, float(initial_rate))
        self._pos_us = max(0, int(initial_position_us))
        self._monotonic: MonotonicCallable = (
            monotonic if monotonic is not None else lambda: time.monotonic_ns() // 1000
        )
        self._t0_us = self._monotonic()

        self._observer_counter = 0
        self._observers: Dict[int, Callable[[TransportSnapshot], None]] = {}

    # ------------------------------------------------------------------ helpers

    def _snapshot_locked(self) -> TransportSnapshot:
        return TransportSnapshot(
            rev=self._rev,
            playing=self._playing,
            rate=self._rate,
            pos_us=self._pos_us,
            t0_us=self._t0_us,
        )

    def _position_now_locked(self, now_us: Optional[int] = None) -> int:
        if now_us is None:
            now_us = self._monotonic()
        if not self._playing:
            return self._pos_us
        delta = max(0, int(now_us) - int(self._t0_us))
        increment = int(round(delta * self._rate))
        return max(0, int(self._pos_us) + increment)

    def _check_revision(self, expected_rev: Optional[int]) -> None:
        if expected_rev is None:
            return
        if int(expected_rev) != self._rev:
            raise RevisionMismatch(f"expected rev {expected_rev}, current {self._rev}")

    def _commit_locked(self, *, pos_us: int, t0_us: int, playing: bool, rate: float) -> TransportSnapshot:
        self._rev += 1
        self._pos_us = max(0, int(pos_us))
        self._t0_us = max(0, int(t0_us))
        self._playing = bool(playing)
        self._rate = max(0.0, float(rate))
        return self._snapshot_locked()

    def _notify(self, snapshot: TransportSnapshot) -> None:
        observers: Dict[int, Callable[[TransportSnapshot], None]]
        with self._lock:
            observers = dict(self._observers)
        if not observers:
            return
        for token, callback in observers.items():
            try:
                callback(snapshot)
            except Exception:  # pragma: no cover - observer failures should not kill the timeline
                LOG.exception("Timeline observer %s failed.", token)

    # ------------------------------------------------------------------ public API

    def subscribe(self, callback: Callable[[TransportSnapshot], None]) -> int:
        if not callable(callback):
            raise TypeError("callback must be callable")
        with self._lock:
            self._observer_counter += 1
            token = self._observer_counter
            self._observers[token] = callback
            snapshot = self._snapshot_locked()
        # Deliver the current snapshot outside the lock
        try:
            callback(snapshot)
        except Exception:  # pragma: no cover - defensive
            LOG.exception("Timeline observer %s failed during initial snapshot.", token)
        return token

    def unsubscribe(self, token: int) -> None:
        with self._lock:
            self._observers.pop(token, None)

    def snapshot(self) -> TransportSnapshot:
        with self._lock:
            return self._snapshot_locked()

    def play(self, *, expected_rev: Optional[int] = None) -> TransportSnapshot:
        with self._lock:
            self._check_revision(expected_rev)
            now_us = self._monotonic()
            current_pos = self._position_now_locked(now_us)
            snapshot = self._commit_locked(
                pos_us=current_pos,
                t0_us=now_us,
                playing=True,
                rate=self._rate,
            )
        self._notify(snapshot)
        return snapshot

    def pause(self, *, expected_rev: Optional[int] = None) -> TransportSnapshot:
        with self._lock:
            self._check_revision(expected_rev)
            now_us = self._monotonic()
            current_pos = self._position_now_locked(now_us)
            snapshot = self._commit_locked(
                pos_us=current_pos,
                t0_us=now_us,
                playing=False,
                rate=self._rate,
            )
        self._notify(snapshot)
        return snapshot

    def seek(
        self,
        position_us: int,
        *,
        expected_rev: Optional[int] = None,
    ) -> TransportSnapshot:
        position_us = max(0, int(position_us))
        with self._lock:
            self._check_revision(expected_rev)
            now_us = self._monotonic()
            snapshot = self._commit_locked(
                pos_us=position_us,
                t0_us=now_us,
                playing=self._playing,
                rate=self._rate,
            )
        self._notify(snapshot)
        return snapshot

    def set_rate(self, rate: float, *, expected_rev: Optional[int] = None) -> TransportSnapshot:
        rate = max(0.0, float(rate))
        with self._lock:
            self._check_revision(expected_rev)
            now_us = self._monotonic()
            current_pos = self._position_now_locked(now_us)
            snapshot = self._commit_locked(
                pos_us=current_pos,
                t0_us=now_us,
                playing=self._playing,
                rate=rate,
            )
        self._notify(snapshot)
        return snapshot

    def apply(
        self,
        op: str,
        *,
        expected_rev: Optional[int] = None,
        position_us: Optional[int] = None,
        rate: Optional[float] = None,
    ) -> TransportSnapshot:
        command = str(op or "").strip().lower()
        if command == "play":
            return self.play(expected_rev=expected_rev)
        if command == "pause":
            return self.pause(expected_rev=expected_rev)
        if command == "seek":
            if position_us is None:
                raise InvalidCommand("seek requires position_us")
            return self.seek(position_us, expected_rev=expected_rev)
        if command in {"set_rate", "rate", "speed"}:
            if rate is None:
                raise InvalidCommand("set_rate requires rate")
            return self.set_rate(rate, expected_rev=expected_rev)
        raise InvalidCommand(f"Unsupported timeline op '{op}'")

    # Convenience helpers -------------------------------------------------------

    def now_position_us(self) -> int:
        with self._lock:
            return int(self._position_now_locked())
