"""
Engine process entrypoint.

This module is intentionally light-weight for now: it resolves configuration,
initialises logging, and exposes a `run()` helper that future CLI wrappers or
Tauri hooks can invoke.  The actual GStreamer integration will be layered on
top of :mod:`engine.pipeline` in subsequent steps.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import signal
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

from . import EngineConfig
from .api.state import EngineState
from .api.server import create_app
from .runtime.gst_adapter import GStreamerPipelineAdapter
from .utils.logging import configure_logging

LOG = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(state: EngineState) -> AsyncIterator[None]:
    """
    Async lifespan context used by the FastAPI application.

    Keeping this helper here avoids circular imports once the pipeline module
    starts depending on shared state.
    """

    LOG.info("Engine lifespan starting")
    try:
        yield
    finally:
        LOG.info("Engine lifespan shutting down")


async def serve(config: EngineConfig, host: str = "127.0.0.1", port: int = 8080) -> None:
    """
    Run the control API inside an asyncio loop.

    Parameters
    ----------
    config:
        Top level engine configuration.
    host, port:
        Bind address for the FastAPI/uvicorn server.
    """

    import uvicorn

    engine_state = EngineState()
    gst_adapter = GStreamerPipelineAdapter(engine_state.pipeline, timeline=engine_state.timeline)
    configure_logging()

    @asynccontextmanager
    async def app_lifespan(_app) -> AsyncIterator[None]:
        try:
            gst_adapter.start()
        except Exception:  # pragma: no cover - defensive
            LOG.exception("Failed to start GStreamer adapter; continuing without it.")

        try:
            async with lifespan(engine_state):
                yield
        finally:
            try:
                gst_adapter.stop()
            except Exception:  # pragma: no cover - defensive
                LOG.exception("Failed to stop GStreamer adapter cleanly.")

    app = create_app(state=engine_state, config=config, lifespan=app_lifespan)
    server_config = uvicorn.Config(
        app=app,
        host=host,
        port=port,
        log_config=None,
        log_level="info",
        reload=False,
    )
    server = uvicorn.Server(config=server_config)

    stop_event = asyncio.Event()

    def _handle_signal(signum: int, frame: Optional[object]) -> None:
        LOG.info("Received signal %s, shutting down server...", signum)
        server.should_exit = True
        stop_event.set()

    for signame in ("SIGINT", "SIGTERM"):
        signal.signal(getattr(signal, signame), _handle_signal)

    await server.serve()
    await stop_event.wait()


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MuLoom render engine server")
    parser.add_argument("--profile", default="default", help="engine profile to load")
    parser.add_argument("--host", default="127.0.0.1", help="bind host for the API server")
    parser.add_argument("--port", type=int, default=8080, help="bind port for the API server")
    return parser.parse_args(argv)


def run(argv: Optional[list[str]] = None) -> None:
    args = parse_args(argv)
    config = EngineConfig(profile=args.profile)

    try:
        asyncio.run(serve(config=config, host=args.host, port=args.port))
    except KeyboardInterrupt:
        LOG.info("Engine interrupted by user.")


if __name__ == "__main__":
    run()
