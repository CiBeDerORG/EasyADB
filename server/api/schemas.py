"""Stable request payload schemas extracted from the original M3 API."""
from typing import Literal
from pydantic import BaseModel


class Target(BaseModel):
    ip: str
    port: int


class PairTarget(Target):
    code: str


class PairExisting(BaseModel):
    port: int
    code: str
    selected_serial: str


class DeviceInput(Target):
    name: str
    group_name: str = ""



class RouteInput(BaseModel):
    route: str


class TempAddressInput(BaseModel):
    ip: str | None = None
    port: int | None = None


class UnlockInput(BaseModel):
    password: str | None = None  # None = keep existing; empty string = delete


class VideoProbeInput(BaseModel):
    profile: Literal['baseline', 'native'] = 'baseline'


class GroupInput(BaseModel):
    name: str
    ip_prefix: str | None = None


class GroupDiscoveryInput(BaseModel):
    url: str
    username: str = "easyadb"
    password: str = ""


