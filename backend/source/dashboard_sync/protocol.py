from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

SCHEMA_VERSION = 1
ENGINE_VERSION = 6
PRICING_VERSION = "2026-10-09-sol-pricing-v7"
RETENTION_DAYS = 7
PAIRING_VERSION = 2


def canonical_json(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


@dataclass(frozen=True)
class SyncEnvelope:
    event_fingerprint: str
    value_fingerprint: str
    event_at: int
    schema_version: int
    nonce: str
    ciphertext: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "event_fingerprint": self.event_fingerprint,
            "value_fingerprint": self.value_fingerprint,
            "event_at": self.event_at,
            "schema_version": self.schema_version,
            "nonce": self.nonce,
            "ciphertext": self.ciphertext,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "SyncEnvelope":
        return cls(
            event_fingerprint=str(value["event_fingerprint"]),
            value_fingerprint=str(value["value_fingerprint"]),
            event_at=int(value["event_at"]),
            schema_version=int(value["schema_version"]),
            nonce=str(value["nonce"]),
            ciphertext=str(value["ciphertext"]),
        )


@dataclass(frozen=True)
class DeviceCredentials:
    endpoint: str
    space_id: str
    device_id: str
    role: str
    device_token: str
    private_key: str
    public_key: str
    data_key: str | None = None
    pairing_version: int = PAIRING_VERSION

    def as_dict(self) -> dict[str, str | None]:
        return {
            "endpoint": self.endpoint,
            "space_id": self.space_id,
            "device_id": self.device_id,
            "role": self.role,
            "device_token": self.device_token,
            "private_key": self.private_key,
            "public_key": self.public_key,
            "data_key": self.data_key,
            "pairing_version": self.pairing_version,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "DeviceCredentials":
        return cls(
            endpoint=str(value["endpoint"]),
            space_id=str(value["space_id"]),
            device_id=str(value["device_id"]),
            role=str(value["role"]),
            device_token=str(value["device_token"]),
            private_key=str(value["private_key"]),
            public_key=str(value["public_key"]),
            data_key=str(value["data_key"]) if value.get("data_key") else None,
            pairing_version=int(value.get("pairing_version", 1)),
        )


@dataclass(frozen=True)
class SyncStatus:
    configured: bool
    paired: bool
    role: str | None
    peer_online: bool
    peer_last_seen: int | None
    last_success: int | None
    queue_size: int
    last_error: str | None
    cadence_seconds: int
    auto_sync: bool
    pairing_code: str | None = None
    pairing_expires_at: int | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "configured": self.configured,
            "paired": self.paired,
            "role": self.role,
            "peer_online": self.peer_online,
            "peer_last_seen": self.peer_last_seen,
            "last_success": self.last_success,
            "queue_size": self.queue_size,
            "last_error": self.last_error,
            "cadence_seconds": self.cadence_seconds,
            "auto_sync": self.auto_sync,
            "pairing_code": self.pairing_code,
            "pairing_expires_at": self.pairing_expires_at,
        }
