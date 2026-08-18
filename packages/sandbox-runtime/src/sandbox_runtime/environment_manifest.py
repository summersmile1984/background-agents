"""Validation for the repository-owned development environment manifest."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Literal, Self

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MANIFEST_RELATIVE_PATH = Path(".openinspect/environment.yaml")
MAX_MANIFEST_BYTES = 256 * 1024
Port = Annotated[int, Field(ge=1, le=65535)]


class StrictManifestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PostgresService(StrictManifestModel):
    enabled: bool = False
    port: Port = 5432
    database: str = "openinspect"
    user: str = "openinspect"

    @field_validator("database", "user")
    @classmethod
    def validate_identifier(cls, value: str) -> str:
        if not value or not value.replace("_", "").isalnum():
            raise ValueError("must contain only letters, numbers, and underscores")
        return value


class RedisService(StrictManifestModel):
    enabled: bool = False
    port: Port = 6379


class ProcessService(StrictManifestModel):
    name: str
    command: str
    cwd: str = "."
    env: dict[str, str] = Field(default_factory=dict)
    ports: list[Port] = Field(default_factory=list)
    ready_timeout_seconds: float = Field(default=60.0, gt=0, le=600)
    snapshot_command: str | None = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        if not value or any(
            character not in "-_abcdefghijklmnopqrstuvwxyz0123456789" for character in value
        ):
            raise ValueError("must use lowercase letters, numbers, hyphens, or underscores")
        return value


class ServiceManifest(StrictManifestModel):
    postgres: PostgresService = Field(default_factory=PostgresService)
    redis: RedisService = Field(default_factory=RedisService)
    processes: list[ProcessService] = Field(default_factory=list)

    @field_validator("processes")
    @classmethod
    def validate_unique_names(cls, value: list[ProcessService]) -> list[ProcessService]:
        names = [process.name for process in value]
        if len(names) != len(set(names)):
            raise ValueError("process service names must be unique")
        return value

    @model_validator(mode="after")
    def validate_unique_ports(self) -> Self:
        claimed: dict[int, str] = {}
        services: list[tuple[str, list[int]]] = []
        if self.postgres.enabled:
            services.append(("postgres", [self.postgres.port]))
        if self.redis.enabled:
            services.append(("redis", [self.redis.port]))
        services.extend((service.name, service.ports) for service in self.processes)
        for name, ports in services:
            for port in ports:
                previous = claimed.get(port)
                if previous:
                    raise ValueError(f"port {port} is claimed by both {previous} and {name}")
                claimed[port] = name
        return self


class EnvironmentManifest(StrictManifestModel):
    version: Literal[1] = 1
    services: ServiceManifest = Field(default_factory=ServiceManifest)


def find_environment_manifest(repositories: tuple[object, ...], workdir: Path) -> Path | None:
    """Prefer the primary repository, then a workspace-level manifest."""
    candidates: list[Path] = []
    if repositories:
        primary_path = getattr(repositories[0], "path", None)
        if isinstance(primary_path, Path):
            candidates.append(primary_path / MANIFEST_RELATIVE_PATH)
    candidates.append(workdir / MANIFEST_RELATIVE_PATH)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def load_environment_manifest(path: Path) -> EnvironmentManifest:
    if path.stat().st_size > MAX_MANIFEST_BYTES:
        raise ValueError(f"environment manifest exceeds {MAX_MANIFEST_BYTES} bytes")
    loaded = yaml.safe_load(path.read_text())
    if loaded is None:
        loaded = {}
    if not isinstance(loaded, dict):
        raise ValueError("environment manifest must contain a YAML object")
    return EnvironmentManifest.model_validate(loaded)
