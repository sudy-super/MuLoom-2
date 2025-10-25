"""
FastAPI control surface for the MuLoom engine.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import re
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Set

import httpx

from fastapi import (
    FastAPI,
    HTTPException,
    Path as PathParam,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask
import yaml

from .. import EngineConfig
from ..pipeline import OutputConfig, OutputType, SourceType, VideoSourceConfig
from ..utils.assets import MP4_DIR, ROOT_DIR, read_fallback_assets
from . import schemas
from .state import DeckLoadError, DeckManager, EngineState

CONFIG_DIR = Path(__file__).resolve().parent.parent / "configs"
PROFILES_PATH = CONFIG_DIR / "profiles.yaml"


LOG = logging.getLogger(__name__)


@dataclass
class OutboundMessage:
    payload: Dict[str, Any]
    require_ack: bool = False
    command_id: Optional[str] = None
    allow_drop: bool = False
    is_retry: bool = False
    retries: int = 0


@dataclass
class PendingAck:
    message: OutboundMessage
    deadline: float
    retries: int = 0


class RealtimeSession:
    """Track per-connection state and orchestrate send/receive loops."""

    def __init__(self, manager: "RealtimeManager", websocket: WebSocket, *, queue_size: int) -> None:
        self.manager = manager
        self.websocket = websocket
        self.session_id = uuid.uuid4().hex
        self.client_id = self.session_id
        self.deck_id = "default"
        self.client_role = "unknown"
        self.client_info: Dict[str, Any] = {}
        self.send_queue: asyncio.Queue[OutboundMessage] = asyncio.Queue(maxsize=queue_size)
        self.pending_acks: Dict[str, PendingAck] = {}
        self.last_pong = time.monotonic()
        self._stop_event = asyncio.Event()
        self._closing = False
        self.supports_ack = False
        self.legacy_client = False
        self.logger = LOG.getChild(f"ws.{self.session_id[:8]}")

    @property
    def is_stopped(self) -> bool:
        return self._stop_event.is_set()

    async def run(self) -> None:
        try:
            await self.websocket.accept()
        except Exception:  # pragma: no cover - defensive
            self.logger.exception("Failed to accept WebSocket connection")
            return

        initial_message: Optional[Dict[str, Any]] = None
        legacy_mode = False
        try:
            first_message = await asyncio.wait_for(
                self.websocket.receive_json(), timeout=self.manager.hello_timeout
            )
        except asyncio.TimeoutError:
            legacy_mode = True
            first_message = None
            self.logger.info("No hello frame received; falling back to legacy handshake")
        except WebSocketDisconnect:
            return
        except Exception as exc:  # pragma: no cover - guard against malformed frames
            legacy_mode = True
            first_message = None
            self.logger.warning("Invalid hello payload (%s); using legacy compatibility", exc)

        if not legacy_mode and isinstance(first_message, dict):
            if str(first_message.get("type") or "").lower() == "hello":
                hello = first_message
            else:
                legacy_mode = True
                initial_message = first_message
                hello = {"type": "hello"}
                self.logger.info("Received %s before hello; treating as legacy client", first_message.get("type"))
        elif not legacy_mode:
            legacy_mode = True
            hello = {"type": "hello"}
        else:
            hello = {"type": "hello"}

        try:
            accepted = await self.manager.initialise_session(self, hello, legacy=legacy_mode)
        except asyncio.CancelledError:
            raise
        except Exception:
            self.logger.exception("Failed to initialise realtime session")
            await self.close(code=1011, reason="init failure")
            return
        if not accepted:
            await self.close(code=1002, reason="handshake rejected")
            return

        self.legacy_client = legacy_mode

        if initial_message:
            try:
                await self.manager.handle_message(self, initial_message)
            except Exception:  # pragma: no cover - defensive: legacy path only
                self.logger.exception("Failed to process initial legacy message")

        try:
            async with asyncio.TaskGroup() as task_group:
                task_group.create_task(self._recv_loop())
                task_group.create_task(self._send_loop())
                task_group.create_task(self._keepalive_loop())
                if self.supports_ack and self.manager.ack_timeout > 0:
                    task_group.create_task(self._monitor_pending_acks())
        except asyncio.CancelledError:
            raise
        except WebSocketDisconnect:
            self.logger.debug("WebSocket client disconnected (%s)", self.client_id)
        except Exception:  # pragma: no cover - defensive
            self.logger.exception("Realtime session crashed")
        finally:
            await self.manager.finalise_session(self)
            await self.close(code=1000)

    async def close(self, code: int = 1000, reason: Optional[str] = None) -> None:
        if self._closing:
            return
        self._closing = True
        self._stop_event.set()
        with contextlib.suppress(RuntimeError, WebSocketDisconnect):
            await self.websocket.close(code=code, reason=reason)

    async def send(
        self,
        payload: Dict[str, Any],
        *,
        require_ack: bool = False,
        command_id: Optional[str] = None,
        allow_drop: bool = False,
    ) -> None:
        if self.is_stopped:
            return

        prepared = dict(payload)
        need_ack = require_ack and self.supports_ack
        ack_id = command_id
        if need_ack:
            ack_id = ack_id or prepared.get("commandId")
            if not ack_id:
                ack_id = uuid.uuid4().hex
                prepared["commandId"] = ack_id

        message = OutboundMessage(
            payload=prepared,
            require_ack=need_ack,
            command_id=ack_id,
            allow_drop=allow_drop,
        )

        if allow_drop:
            try:
                self.send_queue.put_nowait(message)
                return
            except asyncio.QueueFull:
                self.logger.debug(
                    "Dropping %s message due to backpressure",
                    prepared.get("type"),
                )
                return

        await self.send_queue.put(message)

    def _acknowledge(self, message: Dict[str, Any]) -> bool:
        ack_id = message.get("commandId") or message.get("ack") or message.get("ackId")
        if ack_id is None:
            return False
        key = str(ack_id)
        if not self.supports_ack:
            return False
        if key in self.pending_acks:
            self.pending_acks.pop(key, None)
            return True
        return False

    async def _recv_loop(self) -> None:
        try:
            while not self.is_stopped:
                try:
                    message = await self.websocket.receive_json()
                except asyncio.CancelledError:
                    raise
                except WebSocketDisconnect:
                    self._stop_event.set()
                    break
                except Exception:  # pragma: no cover - safety net
                    self.logger.exception("Failed to receive message")
                    self._stop_event.set()
                    break

                if not isinstance(message, dict):
                    continue

                msg_type = str(message.get("type") or "").lower()
                if msg_type == "pong":
                    self.last_pong = time.monotonic()
                    continue
                if msg_type == "ping":
                    await self.send({"type": "pong", "ts": time.time()})
                    continue
                if msg_type == "ack" or message.get("ack"):
                    if self._acknowledge(message):
                        continue

                try:
                    await self.manager.handle_message(self, message)
                except asyncio.CancelledError:
                    raise
                except WebSocketDisconnect:
                    self._stop_event.set()
                    break
                except Exception:  # pragma: no cover - guard rails
                    self.logger.exception("Unhandled error while processing message")
        finally:
            self._stop_event.set()

    async def _send_loop(self) -> None:
        try:
            while not self.is_stopped:
                try:
                    outbound = await asyncio.wait_for(self.send_queue.get(), timeout=0.5)
                except asyncio.TimeoutError:
                    continue

                try:
                    await self.websocket.send_json(outbound.payload)
                except asyncio.CancelledError:
                    raise
                except WebSocketDisconnect:
                    self._stop_event.set()
                    break
                except RuntimeError as exc:
                    message = str(exc)
                    if "close message has been sent" in message:
                        self.logger.debug("Send after close ignored: %s", message)
                    else:
                        self.logger.exception("Failed to send message", exc_info=exc)
                    self._stop_event.set()
                    break
                except Exception:  # pragma: no cover - defensive
                    self.logger.exception("Failed to send message")
                    self._stop_event.set()
                    break
                finally:
                    self.send_queue.task_done()

                if outbound.require_ack and outbound.command_id:
                    key = str(outbound.command_id)
                    now = time.monotonic()
                    pending = self.pending_acks.get(key)
                    if pending and outbound.is_retry:
                        pending.deadline = now + self.manager.ack_timeout
                        pending.retries = outbound.retries
                        pending.message = outbound
                    else:
                        self.pending_acks[key] = PendingAck(
                            message=outbound,
                            deadline=now + self.manager.ack_timeout,
                            retries=outbound.retries,
                        )
        finally:
            self._stop_event.set()

    async def _keepalive_loop(self) -> None:
        if self.manager.ping_interval <= 0:
            return
        try:
            while not self.is_stopped:
                await asyncio.sleep(self.manager.ping_interval)
                if self.is_stopped:
                    break
                await self.send({"type": "ping", "ts": time.time()})
                if (time.monotonic() - self.last_pong) > self.manager.pong_timeout:
                    self.logger.warning("Ping timeout; closing realtime session")
                    await self.close(code=1011, reason="ping timeout")
                    break
        finally:
            self._stop_event.set()

    async def _monitor_pending_acks(self) -> None:
        if not self.supports_ack or self.manager.ack_timeout <= 0:
            return
        try:
            while not self.is_stopped:
                await asyncio.sleep(self.manager.ack_timeout / 2)
                now = time.monotonic()
                for command_id, pending in list(self.pending_acks.items()):
                    if now < pending.deadline:
                        continue
                    if pending.retries >= self.manager.max_ack_retries:
                        self.logger.warning(
                            "Ack timeout for %s; closing connection", command_id
                        )
                        await self.close(code=1011, reason="ack timeout")
                        return
                    pending.retries += 1
                    retry_message = OutboundMessage(
                        payload=dict(pending.message.payload),
                        require_ack=True,
                        command_id=command_id,
                        allow_drop=False,
                        is_retry=True,
                        retries=pending.retries,
                    )
                    pending.message = retry_message
                    pending.deadline = now + self.manager.ack_timeout
                    if self.is_stopped:
                        return
                    await self.send_queue.put(retry_message)
        finally:
            self._stop_event.set()


class RealtimeManager:
    """Manage realtime WebSocket sessions with RCU-backed deck swaps."""

    def __init__(
        self,
        state: EngineState,
        assets_loader: Callable[[], Dict[str, list]],
        on_mix_change: Callable[[], None],
        *,
        deck_manager: DeckManager,
        queue_size: int = 256,
        ping_interval: float = 30.0,
        pong_timeout: float = 60.0,
        ack_timeout: float = 5.0,
        max_ack_retries: int = 3,
        hello_timeout: float = 5.0,
    ) -> None:
        self.state = state
        self.assets_loader = assets_loader
        self.on_mix_change = on_mix_change
        self.deck_manager = deck_manager
        self.queue_size = max(1, int(queue_size))
        self.ping_interval = max(0.0, float(ping_interval))
        self.pong_timeout = max(self.ping_interval, float(pong_timeout))
        self.ack_timeout = max(0.0, float(ack_timeout))
        self.max_ack_retries = max(0, int(max_ack_retries))
        self.hello_timeout = max(0.1, float(hello_timeout))

        self._sessions: Dict[str, RealtimeSession] = {}
        self._deck_sessions: Dict[str, Set[RealtimeSession]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def run(self, websocket: WebSocket) -> None:
        session = RealtimeSession(self, websocket, queue_size=self.queue_size)
        await session.run()

    async def initialise_session(
        self, session: RealtimeSession, hello: Dict[str, Any], *, legacy: bool = False
    ) -> bool:
        deck_id = str(hello.get("deckId") or "default")
        session.deck_id = deck_id
        session.client_id = str(hello.get("clientId") or session.session_id)

        client_info = hello.get("clientInfo")
        if isinstance(client_info, dict):
            session.client_info = dict(client_info)
            role = client_info.get("role")
            if isinstance(role, str):
                session.client_role = role

        role_override = hello.get("role")
        if isinstance(role_override, str):
            session.client_role = role_override

        features = hello.get("features")
        supports_ack = False
        if isinstance(features, (list, tuple, set)):
            supports_ack = any(str(item).lower() == "ack" for item in features)
        elif isinstance(features, dict):
            supports_ack = bool(features.get("ack") or features.get("acks"))
        elif features is not None:
            supports_ack = bool(features)

        if not supports_ack:
            supports_ack = bool(
                hello.get("supportsAck")
                or hello.get("requireAck")
                or hello.get("acks")
                or hello.get("ack")
            )

        session.supports_ack = supports_ack and not legacy

        await self._register(session)
        await self._send_initial_snapshot(session)
        LOG.info(
            "Realtime client connected deck=%s session=%s role=%s supports_ack=%s legacy=%s",
            deck_id,
            session.session_id,
            session.client_role,
            session.supports_ack,
            legacy,
        )
        return True

    async def finalise_session(self, session: RealtimeSession) -> None:
        await self._unregister(session)
        LOG.info("Realtime client disconnected session=%s", session.session_id)

    async def _register(self, session: RealtimeSession) -> None:
        async with self._lock:
            self._sessions[session.session_id] = session
            self._deck_sessions[session.deck_id].add(session)

    async def _unregister(self, session: RealtimeSession) -> None:
        async with self._lock:
            self._sessions.pop(session.session_id, None)
            deck_sessions = self._deck_sessions.get(session.deck_id)
            if deck_sessions and session in deck_sessions:
                deck_sessions.remove(session)
                if not deck_sessions:
                    self._deck_sessions.pop(session.deck_id, None)

    async def _send_initial_snapshot(self, session: RealtimeSession) -> None:
        try:
            assets = await asyncio.to_thread(self.assets_loader)
        except Exception:  # pragma: no cover - assets loading is best-effort
            LOG.exception("Failed to load fallback assets for init payload")
            assets = {}
        payload = {
            "type": "init",
            "deckId": session.deck_id,
            "payload": {
                "state": self.state.snapshot(),
                "assets": assets,
            },
        }
        await session.send(payload)

    async def broadcast(
        self,
        message: Dict[str, Any],
        *,
        exclude: Optional[RealtimeSession] = None,
        deck_id: Optional[str] = None,
        require_ack: bool = False,
        allow_drop: bool = False,
    ) -> None:
        async with self._lock:
            if deck_id is None:
                targets = list(self._sessions.values())
            else:
                targets = list(self._deck_sessions.get(deck_id, set()))

        if exclude is not None:
            targets = [session for session in targets if session is not exclude]

        if not targets:
            return

        await asyncio.gather(
            *[
                target.send(dict(message), require_ack=require_ack, allow_drop=allow_drop)
                for target in targets
            ],
            return_exceptions=True,
        )

    async def broadcast_mix_state(self, *, exclude: Optional[RealtimeSession] = None) -> None:
        await self.broadcast(
            {"type": "mix-state", "payload": self.state.mix.to_dict()},
            exclude=exclude,
            allow_drop=True,
        )

    async def broadcast_control_settings(self, *, exclude: Optional[RealtimeSession] = None) -> None:
        await self.broadcast(
            {"type": "control-settings", "payload": self.state.control_settings.to_dict()},
            exclude=exclude,
        )

    async def broadcast_viewer_status(self, *, exclude: Optional[RealtimeSession] = None) -> None:
        await self.broadcast(
            {"type": "viewer-status", "payload": self.state.viewer_status.to_dict()},
            exclude=exclude,
            allow_drop=True,
        )

    async def handle_message(self, session: RealtimeSession, message: Dict[str, Any]) -> None:
        message_type = message.get("type")
        if not isinstance(message_type, str):
            return

        if message_type == "register":
            role = message.get("role")
            if isinstance(role, str):
                session.client_role = role
            return

        if message_type == "update-fallback-layers":
            self.state.fallback_layers = message.get("payload") or []
            await self.broadcast(
                {"type": "fallback-layers", "payload": self.state.fallback_layers},
                exclude=session,
            )
            return

        if message_type == "update-control-settings":
            payload = message.get("payload") or {}
            self.state.control_settings.update(payload)
            await self.broadcast_control_settings(exclude=session)
            return

        if message_type == "update-mix-deck":
            payload = message.get("payload") or {}
            deck = payload.get("deck")
            data = payload.get("data") or {}
            if deck and self.state.apply_deck_update(deck, data):
                self.on_mix_change()
                await self.broadcast_mix_state()
            return

        if message_type in {"update-crossfader", "updateCrossfader"}:
            payload = message.get("payload") or {}
            if self.state.apply_crossfader_update(payload):
                self.on_mix_change()
                await self.broadcast_mix_state()
            return

        if message_type == "loadDeck":
            await self._handle_load_deck(session, message)
            return

        if message_type in {
            "start-visualization",
            "stop-visualization",
            "regenerate-shader",
            "set-audio-sensitivity",
        }:
            await self.broadcast(message, exclude=session)
            return

        if message_type == "viewer-status":
            payload = message.get("payload") or {}
            self.state.viewer_status.update(payload)
            await self.broadcast_viewer_status(exclude=session)
            return

        if message_type == "code-progress":
            await self.broadcast(message, exclude=session, allow_drop=True)
            return

        if message_type == "deck-media-state":
            if session.client_role != "controller":
                LOG.warning(
                    "Ignoring deck-media-state from non-controller session=%s role=%s",
                    session.session_id,
                    session.client_role,
                )
                return
            payload = message.get("payload") or {}
            deck = payload.get("deck")
            state_payload = payload.get("state") or {}
            command_id = str(message.get("commandId") or state_payload.get("commandId") or uuid.uuid4().hex)
            if deck:
                did_change, revision = self.state.update_deck_media_state(deck, state_payload)
                state = self.state.deck_media_states.get(deck)
                if state:
                    state.last_command_id = command_id
                    message_payload = {
                        "type": "deck-media-state",
                        "payload": {
                            "deck": deck,
                            "state": state.to_dict(),
                            "revision": revision,
                            "commandId": command_id,
                        },
                    }
                    if did_change:
                        await session.send(
                            message_payload,
                            require_ack=True,
                            command_id=command_id,
                        )
                        await self.broadcast(message_payload, exclude=session)
                    else:
                        await session.send(
                            message_payload,
                            require_ack=True,
                            command_id=command_id,
                        )
            return

        if message_type == "rtc-signal":
            rtc_type = str(message.get("rtc") or "").lower()
            if rtc_type in {"offer", "answer", "ice-candidate", "request-offer"}:
                await self.broadcast(
                    {
                        "type": "rtc-signal",
                        "rtc": rtc_type,
                        "payload": message.get("payload"),
                    },
                    exclude=session,
                )
            return

    async def _handle_load_deck(self, session: RealtimeSession, message: Dict[str, Any]) -> None:
        deck_id = str(message.get("deckId") or session.deck_id or "default")
        command_id = message.get("commandId")
        payload = message.get("payload") or {}
        src = payload.get("src")

        if not src:
            await session.send(
                {
                    "type": "error",
                    "deckId": deck_id,
                    "commandId": command_id,
                    "payload": {
                        "code": "E_INVALID_REQUEST",
                        "message": "loadDeck requires payload.src",
                    },
                }
            )
            return

        deck_state = self.state.deck_media_states.get(deck_id)
        if deck_state and deck_state.apply_request({"isLoading": True}):
            await self._broadcast_deck_state(deck_id, exclude=None)

        issued_command_id = str(command_id or uuid.uuid4().hex)

        try:
            handle, _ = await self.deck_manager.load(
                deck_id,
                src,
                issued_command_id,
                self._build_deck_instance,
            )
        except DeckLoadError as exc:
            if deck_state and deck_state.apply_request({"isLoading": False, "error": True}):
                await self._broadcast_deck_state(deck_id, exclude=None)
            current = await self.deck_manager.current(deck_id)
            await session.send(
                {
                    "type": "error",
                    "deckId": deck_id,
                    "epoch": current.epoch if current else None,
                    "commandId": issued_command_id,
                    "payload": {
                        "code": "E_DECK_LOAD",
                        "message": str(exc),
                    },
                }
            )
            return

        if deck_state:
            deck_state.apply_request({"intent": "source", "src": src})
            deck_state.apply_request({"isLoading": False, "error": False})
            revision = handle.metadata.get("revision")
            if revision is not None:
                try:
                    deck_state.last_load_revision = int(revision)
                except (TypeError, ValueError):
                    pass
            await self._broadcast_deck_state(deck_id, exclude=None)

        response = {
            "type": "deckReady",
            "deckId": deck_id,
            "epoch": handle.epoch,
            "commandId": issued_command_id,
            "payload": handle.metadata,
        }
        await session.send(response, require_ack=True, command_id=issued_command_id)
        await self.broadcast(response, exclude=session, allow_drop=False)

    async def _broadcast_deck_state(
        self, deck_id: str, *, exclude: Optional[RealtimeSession] = None
    ) -> None:
        state = self.state.deck_media_states.get(deck_id)
        if not state:
            return
        payload = {
            "type": "deck-media-state",
            "payload": {
                "deck": deck_id,
                "state": state.to_dict(),
                "revision": state.version,
                "commandId": state.last_command_id,
            },
        }
        await self.broadcast(payload, exclude=exclude)

    async def _build_deck_instance(
        self, deck_id: str, src: Optional[str], epoch: int
    ) -> Dict[str, Any]:
        def _commit() -> Dict[str, Any]:
            revision = self.state.pipeline.set_deck_source(deck_id, src)
            return {
                "src": src,
                "epoch": epoch,
                "revision": revision,
            }

        return await asyncio.to_thread(_commit)


def create_app(
    *,
    state: Optional[EngineState] = None,
    config: Optional[EngineConfig] = None,
    lifespan: Optional[Callable[..., object]] = None,
) -> FastAPI:
    engine_state = state or EngineState()

    def refresh_mixer_layers() -> None:
        engine_state.rebuild_mixer_layers()

    deck_manager = DeckManager()

    realtime = RealtimeManager(
        engine_state,
        assets_loader=read_fallback_assets,
        on_mix_change=refresh_mixer_layers,
        deck_manager=deck_manager,
    )

    app = FastAPI(title="MuLoom Engine API", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.mount(
        "/assets/mp4",
        StaticFiles(directory=str(MP4_DIR), check_dir=False),
        name="mp4-assets",
    )

    @app.websocket("/realtime")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        await realtime.run(websocket)

    @app.get("/healthz")
    async def healthz() -> dict:
        return {"status": "ok", "profile": engine_state.active_profile}

    @app.get("/profiles")
    async def list_profiles() -> dict:
        try:
            with PROFILES_PATH.open("r", encoding="utf-8") as handle:
                profiles = yaml.safe_load(handle) or {}
        except FileNotFoundError:
            profiles = {}
        return {"profiles": profiles}

    @app.get("/assets", response_model=schemas.AssetCollection)
    async def list_assets() -> schemas.AssetCollection:
        return schemas.AssetCollection(**read_fallback_assets())

    @app.get("/api/fallback-assets", response_model=schemas.AssetCollection)
    async def list_fallback_assets() -> schemas.AssetCollection:
        return schemas.AssetCollection(**read_fallback_assets())

    @app.get("/proxy/media")
    async def proxy_media(url: str) -> Response:
        try:
            target = httpx.URL(url)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid url") from None

        if target.scheme not in {"http", "https"}:
            raise HTTPException(status_code=400, detail="Unsupported scheme")

        timeout = httpx.Timeout(30.0, connect=10.0)
        headers = {"User-Agent": "MuLoomProxy/1.0"}

        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            try:
                upstream = await client.stream("GET", target, headers=headers)
            except httpx.HTTPError as exc:  # pragma: no cover
                raise HTTPException(status_code=502, detail=f"Upstream fetch failed: {exc}") from exc

            if upstream.status_code >= 400:
                detail = f"Upstream returned {upstream.status_code}"
                raise HTTPException(status_code=upstream.status_code, detail=detail)

            content_type = upstream.headers.get("content-type", "application/octet-stream")
            content_length = upstream.headers.get("content-length")

            async def upstream_iterator():
                async for chunk in upstream.aiter_bytes():
                    yield chunk

            response_headers = {"Content-Type": content_type}
            if content_length is not None:
                response_headers["Content-Length"] = content_length

            background = BackgroundTask(upstream.aclose)
            return StreamingResponse(upstream_iterator(), headers=response_headers, background=background)

    @app.get("/api/state")
    async def get_full_state() -> dict:
        return {
            "state": engine_state.snapshot(),
            "assets": read_fallback_assets(),
        }

    @app.get("/mix", response_model=schemas.MixStateModel)
    async def get_mix() -> schemas.MixStateModel:
        snapshot = engine_state.mix.to_dict()
        decks = {
            key: schemas.DeckModel(
                type=data["type"],
                asset_id=data.get("assetId"),
                opacity=data["opacity"],
                enabled=data["enabled"],
            )
            for key, data in snapshot["decks"].items()
        }
        return schemas.MixStateModel(
            crossfaderAB=snapshot["crossfaderAB"],
            crossfaderAC=snapshot["crossfaderAC"],
            crossfaderBD=snapshot["crossfaderBD"],
            crossfaderCD=snapshot["crossfaderCD"],
            decks=decks,
        )

    @app.post("/mix/decks/{deck_id}")
    async def update_deck(
        payload: schemas.DeckModel,
        deck_id: str = PathParam(..., regex="^[abcd]$"),
    ) -> dict:
        deck_payload = payload.model_dump(by_alias=True)
        if not engine_state.apply_deck_update(deck_id, deck_payload):
            raise HTTPException(status_code=404, detail=f"Deck '{deck_id}' not found")
        refresh_mixer_layers()
        await realtime.broadcast_mix_state()
        return {"ok": True}

    @app.post("/crossfader")
    async def update_crossfader(payload: schemas.MixStateModel) -> dict:
        engine_state.mix.crossfader_ab = payload.crossfaderAB
        engine_state.mix.crossfader_ac = payload.crossfaderAC
        engine_state.mix.crossfader_bd = payload.crossfaderBD
        engine_state.mix.crossfader_cd = payload.crossfaderCD
        refresh_mixer_layers()
        await realtime.broadcast_mix_state()
        return {"ok": True}

    @app.post("/ndi/in")
    async def attach_ndi_input(payload: schemas.NDIInputRequest) -> dict:
        engine_state.pipeline.add_video_source(
            config=VideoSourceConfig(id=payload.sourceName, type=SourceType.NDI)
        )
        return {"ok": True}

    @app.post("/ndi/out")
    async def attach_ndi_output(payload: schemas.NDIOutputRequest) -> dict:
        engine_state.pipeline.add_output(
            config=OutputConfig(id=payload.publishName, type=OutputType.NDI)
        )
        return {"ok": True}

    @app.post("/prerender")
    async def enqueue_prerender(payload: schemas.PrerenderRequest) -> dict:
        return {"ok": True, "job": payload.dict()}

    @app.get("/control-settings", response_model=schemas.ControlSettingsModel)
    async def get_control_settings() -> schemas.ControlSettingsModel:
        return schemas.ControlSettingsModel(**engine_state.control_settings.to_dict())

    @app.post("/control-settings")
    async def update_control_settings(payload: schemas.ControlSettingsModel) -> dict:
        engine_state.control_settings.update(payload.model_dump())
        await realtime.broadcast_control_settings()
        return {"ok": True}

    @app.get("/viewer-status", response_model=schemas.ViewerStatusModel)
    async def get_viewer_status() -> schemas.ViewerStatusModel:
        return schemas.ViewerStatusModel(**engine_state.viewer_status.to_dict())

    @app.post("/viewer-status")
    async def update_viewer_status(payload: schemas.ViewerStatusModel) -> dict:
        engine_state.viewer_status.update(payload.model_dump())
        await realtime.broadcast_viewer_status()
        return {"ok": True}

    range_regex = re.compile(r"bytes=(\d*)-(\d*)$")

    @app.get("/stream/mp4/{requested_path:path}", response_class=StreamingResponse)
    async def stream_mp4(request: Request, requested_path: str) -> Response:
        trimmed = requested_path.strip()
        if not trimmed:
            raise HTTPException(status_code=404, detail="Video not found")

        normalized = os.path.normpath(trimmed).lstrip("/\\")
        if ".." in normalized.split(os.sep):
            raise HTTPException(status_code=400, detail="Invalid video path")

        absolute_path = (MP4_DIR / normalized).resolve()
        try:
            mp4_root = MP4_DIR.resolve(strict=False)
        except FileNotFoundError:
            mp4_root = MP4_DIR
        if not str(absolute_path).startswith(str(mp4_root)):
            raise HTTPException(status_code=400, detail="Invalid video path")

        if not absolute_path.exists() or not absolute_path.is_file():
            raise HTTPException(status_code=404, detail="Video not found")

        file_size = absolute_path.stat().st_size
        range_header = request.headers.get("range")

        if not range_header:
            return StreamingResponse(
                _file_iterator(absolute_path),
                media_type="video/mp4",
                headers={
                    "Content-Length": str(file_size),
                    "Accept-Ranges": "bytes",
                },
            )

        match = range_regex.match(range_header)
        if not match:
            return Response(
                status_code=416,
                headers={"Content-Range": f"bytes */{file_size}"},
            )

        start_str, end_str = match.groups()
        if start_str == "" and end_str:
            try:
                suffix_length = int(end_str)
            except ValueError:
                return Response(
                    status_code=416,
                    headers={"Content-Range": f"bytes */{file_size}"},
                )
            if suffix_length <= 0:
                return Response(
                    status_code=416,
                    headers={"Content-Range": f"bytes */{file_size}"},
                )
            end = file_size - 1
            start = max(0, file_size - suffix_length)
        else:
            try:
                start = int(start_str or 0)
                end = int(end_str or file_size - 1)
            except ValueError:
                return Response(
                    status_code=416,
                    headers={"Content-Range": f"bytes */{file_size}"},
                )
            if start < 0 or end < start:
                return Response(
                    status_code=416,
                    headers={"Content-Range": f"bytes */{file_size}"},
                )
            end = min(end, file_size - 1)

        if start >= file_size:
            return Response(
                status_code=416,
                headers={"Content-Range": f"bytes */{file_size}"},
            )

        chunk_size = end - start + 1
        headers = {
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(chunk_size),
            "Content-Type": "video/mp4",
        }

        return StreamingResponse(
            _file_iterator(absolute_path, start=start, length=chunk_size),
            status_code=206,
            headers=headers,
            media_type="video/mp4",
        )

    return app


def _file_iterator(path: Path, *, start: int = 0, length: Optional[int] = None, chunk_size: int = 1 << 20):
    with path.open("rb") as handle:
        handle.seek(start)
        remaining = length
        while True:
            if remaining is not None and remaining <= 0:
                break
            read_size = chunk_size if remaining is None else min(chunk_size, remaining)
            data = handle.read(read_size)
            if not data:
                break
            yield data
            if remaining is not None:
                remaining -= len(data)
