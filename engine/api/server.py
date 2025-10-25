"""
FastAPI control surface for the MuLoom engine.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from pathlib import Path
from typing import Callable, Dict, Optional

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
import yaml

from .. import EngineConfig
from ..pipeline import OutputConfig, OutputType, SourceType, VideoSourceConfig
from ..utils.assets import MP4_DIR, ROOT_DIR, read_fallback_assets
from . import schemas
from .state import EngineState

CONFIG_DIR = Path(__file__).resolve().parent.parent / "configs"
PROFILES_PATH = CONFIG_DIR / "profiles.yaml"


LOG = logging.getLogger(__name__)


class RealtimeManager:
    """
    Manage WebSocket clients and broadcast state changes.
    """

    def __init__(
        self,
        state: EngineState,
        assets_loader: Callable[[], Dict[str, list]],
        on_mix_change: Callable[[], None],
    ) -> None:
        self.state = state
        self.assets_loader = assets_loader
        self.on_mix_change = on_mix_change
        self._clients: Dict[WebSocket, str] = {}
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> bool:
        await websocket.accept()
        async with self._lock:
            self._clients[websocket] = "unknown"

        try:
            await websocket.send_json(
                {
                    "type": "init",
                    "payload": {
                        "state": self.state.snapshot(),
                        "assets": self.assets_loader(),
                    },
                }
            )
        except WebSocketDisconnect:
            LOG.debug("WebSocket disconnected during init payload dispatch")
            await self.disconnect(websocket)
            return False
        except Exception as exc:  # pragma: no cover
            LOG.warning("Failed to send init payload: %s", exc)
            await self.disconnect(websocket)
            return False

        return True

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._clients.pop(websocket, None)

    async def broadcast(self, message: dict, *, exclude: Optional[WebSocket] = None) -> None:
        dead_clients = []
        async with self._lock:
            clients = list(self._clients.keys())

        for client in clients:
            if exclude is not None and client is exclude:
                continue
            try:
                await client.send_json(message)
            except Exception:
                dead_clients.append(client)

        if dead_clients:
            async with self._lock:
                for client in dead_clients:
                    self._clients.pop(client, None)

    async def broadcast_mix_state(self, *, exclude: Optional[WebSocket] = None) -> None:
        await self.broadcast(
            {"type": "mix-state", "payload": self.state.mix.to_dict()},
            exclude=exclude,
        )

    async def broadcast_control_settings(self, *, exclude: Optional[WebSocket] = None) -> None:
        await self.broadcast(
            {"type": "control-settings", "payload": self.state.control_settings.to_dict()},
            exclude=exclude,
        )

    async def broadcast_viewer_status(self, *, exclude: Optional[WebSocket] = None) -> None:
        await self.broadcast(
            {"type": "viewer-status", "payload": self.state.viewer_status.to_dict()},
            exclude=exclude,
        )

    async def handle_message(self, websocket: WebSocket, message: dict) -> None:
        message_type = message.get("type")

        if message_type == "register":
            role = message.get("role", "unknown")
            async with self._lock:
                self._clients[websocket] = role
            return

        if message_type == "update-fallback-layers":
            self.state.fallback_layers = message.get("payload") or []
            await self.broadcast(
                {"type": "fallback-layers", "payload": self.state.fallback_layers},
                exclude=websocket,
            )
            return

        if message_type == "update-control-settings":
            payload = message.get("payload") or {}
            self.state.control_settings.update(payload)
            await self.broadcast_control_settings(exclude=websocket)
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

        if message_type in {
            "start-visualization",
            "stop-visualization",
            "regenerate-shader",
            "set-audio-sensitivity",
        }:
            await self.broadcast(message, exclude=websocket)
            return

        if message_type == "viewer-status":
            payload = message.get("payload") or {}
            self.state.viewer_status.update(payload)
            await self.broadcast_viewer_status(exclude=websocket)
            return

        if message_type == "code-progress":
            await self.broadcast(message, exclude=websocket)
            return

        if message_type == "deck-media-state":
            payload = message.get("payload") or {}
            deck = payload.get("deck")
            state_payload = payload.get("state") or {}
            if deck:
                did_change, revision = self.state.update_deck_media_state(deck, state_payload)
                state = self.state.deck_media_states.get(deck)
                if state:
                    message_payload = {
                        "type": "deck-media-state",
                        "payload": {
                            "deck": deck,
                            "state": state.to_dict(),
                            "revision": revision,
                        },
                    }
                    if did_change:
                        await self.broadcast(message_payload)
                    else:
                        await websocket.send_json(message_payload)
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
                    exclude=websocket,
                )
            return


def create_app(
    *,
    state: Optional[EngineState] = None,
    config: Optional[EngineConfig] = None,
    lifespan: Optional[Callable[..., object]] = None,
) -> FastAPI:
    engine_state = state or EngineState()

    def refresh_mixer_layers() -> None:
        engine_state.rebuild_mixer_layers()

    realtime = RealtimeManager(
        engine_state,
        assets_loader=read_fallback_assets,
        on_mix_change=refresh_mixer_layers,
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
        if not await realtime.connect(websocket):
            return
        try:
            while True:
                message = await websocket.receive_json()
                await realtime.handle_message(websocket, message)
        except WebSocketDisconnect:
            await realtime.disconnect(websocket)

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
