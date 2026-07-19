"""Container entry point."""

from __future__ import annotations

import uvicorn

from .app import create_app
from .config import WorkerConfig


def main() -> None:
    config = WorkerConfig.from_env()
    uvicorn.run(
        create_app(config=config),
        host=config.host,
        port=config.port,
        lifespan="on",
        access_log=False,
    )


if __name__ == "__main__":
    main()
