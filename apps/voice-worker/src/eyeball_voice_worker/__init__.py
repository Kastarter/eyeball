"""Eyeball's persistent voice-session worker."""

from .app import create_app
from .config import WorkerConfig

__all__ = ["WorkerConfig", "create_app"]
__version__ = "0.1.0"
