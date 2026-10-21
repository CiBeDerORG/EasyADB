"""Ordering metadata for explicitly requested live sessions, not resource slots."""
from dataclasses import dataclass, field
from threading import Event
from typing import Callable


@dataclass(eq=False)
class LiveRequestScope:
    owner: object = field(repr=False)
    next_sequence: int = 0
    high_water: dict = field(default_factory=dict)
    latest: dict = field(default_factory=dict)


@dataclass(eq=False)
class LiveRequest:
    device_id: str
    sequence: int
    scope: LiveRequestScope = field(repr=False)
    on_replaced: Callable[[], None] | None = field(repr=False)
    on_changed: Callable[[], None] | None = field(repr=False)
    replaced: Event = field(default_factory=Event, init=False, repr=False)
    cancelled: Event = field(default_factory=Event, init=False, repr=False)
    stream: object = field(default=None, init=False, repr=False)
