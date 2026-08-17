from pathlib import Path
from types import SimpleNamespace

import pytest

from sandbox_runtime.environment_manifest import (
    find_environment_manifest,
    load_environment_manifest,
)


def test_loads_versioned_service_manifest(tmp_path: Path):
    path = tmp_path / "environment.yaml"
    path.write_text(
        """
version: 1
services:
  postgres:
    enabled: true
    port: 55432
    database: app_test
  redis:
    enabled: true
  processes:
    - name: web
      command: npm run dev
      ports: [3000]
      snapshot_command: npm run checkpoint
"""
    )

    manifest = load_environment_manifest(path)

    assert manifest.services.postgres.enabled is True
    assert manifest.services.postgres.database == "app_test"
    assert manifest.services.redis.port == 6379
    assert manifest.services.processes[0].snapshot_command == "npm run checkpoint"


def test_rejects_unknown_fields_and_duplicate_process_names(tmp_path: Path):
    path = tmp_path / "environment.yaml"
    path.write_text(
        """
services:
  processes:
    - {name: api, command: one}
    - {name: api, command: two}
unexpected: true
"""
    )

    with pytest.raises(ValueError):
        load_environment_manifest(path)


def test_rejects_ports_claimed_by_multiple_services(tmp_path: Path):
    path = tmp_path / "environment.yaml"
    path.write_text(
        """
services:
  postgres: {enabled: true, port: 5432}
  processes:
    - {name: api, command: npm run dev, ports: [5432]}
"""
    )

    with pytest.raises(ValueError, match="claimed by both postgres and api"):
        load_environment_manifest(path)


def test_prefers_primary_repository_manifest(tmp_path: Path):
    primary = tmp_path / "primary"
    workspace = tmp_path / "workspace"
    (primary / ".openinspect").mkdir(parents=True)
    (workspace / ".openinspect").mkdir(parents=True)
    primary_manifest = primary / ".openinspect/environment.yaml"
    primary_manifest.write_text("version: 1\n")
    (workspace / ".openinspect/environment.yaml").write_text("version: 1\n")

    found = find_environment_manifest((SimpleNamespace(path=primary),), workspace)

    assert found == primary_manifest
