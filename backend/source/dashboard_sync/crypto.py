from __future__ import annotations

import base64
import ctypes
import hashlib
import hmac
import json
import os
import secrets
from ctypes import wintypes

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .protocol import SCHEMA_VERSION, SyncEnvelope, canonical_json


def b64u(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def unb64u(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def generate_x25519_keypair() -> tuple[str, str]:
    private_key = X25519PrivateKey.generate()
    private_raw = private_key.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_raw = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return b64u(private_raw), b64u(public_raw)


def derive_wrap_key(private_key: str, peer_public_key: str, space_id: str) -> bytes:
    private = X25519PrivateKey.from_private_bytes(unb64u(private_key))
    peer = X25519PublicKey.from_public_bytes(unb64u(peer_public_key))
    shared = private.exchange(peer)
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=hashlib.sha256(space_id.encode("utf-8")).digest(),
        info=b"codex-token-share-key-envelope-v1",
    ).derive(shared)


def wrap_data_key(
    data_key: bytes,
    *,
    private_key: str,
    peer_public_key: str,
    space_id: str,
    target_device_id: str,
) -> dict[str, str]:
    key = derive_wrap_key(private_key, peer_public_key, space_id)
    nonce = secrets.token_bytes(12)
    aad = f"{space_id}:{target_device_id}".encode("utf-8")
    return {
        "nonce": b64u(nonce),
        "ciphertext": b64u(AESGCM(key).encrypt(nonce, data_key, aad)),
    }


def unwrap_data_key(
    envelope: dict[str, str],
    *,
    private_key: str,
    peer_public_key: str,
    space_id: str,
    target_device_id: str,
) -> bytes:
    key = derive_wrap_key(private_key, peer_public_key, space_id)
    aad = f"{space_id}:{target_device_id}".encode("utf-8")
    return AESGCM(key).decrypt(
        unb64u(envelope["nonce"]),
        unb64u(envelope["ciphertext"]),
        aad,
    )


def encrypt_event(
    data_key: bytes,
    *,
    space_id: str,
    source_event_id: str,
    payload: dict,
) -> SyncEnvelope:
    plaintext = canonical_json(payload)
    event_fingerprint = hmac.new(
        data_key,
        f"event:{source_event_id}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    value_fingerprint = hmac.new(
        data_key,
        b"value:" + plaintext,
        hashlib.sha256,
    ).hexdigest()
    nonce = secrets.token_bytes(12)
    aad = f"{space_id}:{event_fingerprint}:{SCHEMA_VERSION}".encode("utf-8")
    ciphertext = AESGCM(data_key).encrypt(nonce, plaintext, aad)
    return SyncEnvelope(
        event_fingerprint=event_fingerprint,
        value_fingerprint=value_fingerprint,
        event_at=int(payload["event_at"]),
        schema_version=SCHEMA_VERSION,
        nonce=b64u(nonce),
        ciphertext=b64u(ciphertext),
    )


def decrypt_event(data_key: bytes, *, space_id: str, envelope: SyncEnvelope) -> dict:
    aad = f"{space_id}:{envelope.event_fingerprint}:{envelope.schema_version}".encode("utf-8")
    plaintext = AESGCM(data_key).decrypt(
        unb64u(envelope.nonce),
        unb64u(envelope.ciphertext),
        aad,
    )
    return json.loads(plaintext.decode("utf-8"))


class _DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _blob(value: bytes) -> tuple[_DATA_BLOB, ctypes.Array]:
    buffer = ctypes.create_string_buffer(value)
    return _DATA_BLOB(len(value), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char))), buffer


def protect_secret(value: bytes, *, description: str = "CodexTokenDashboard") -> bytes:
    if os.name != "nt":
        raise OSError("DPAPI is available only on Windows")
    input_blob, input_buffer = _blob(value)
    output_blob = _DATA_BLOB()
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    crypt32.CryptProtectData.argtypes = [
        ctypes.POINTER(_DATA_BLOB),
        wintypes.LPCWSTR,
        ctypes.POINTER(_DATA_BLOB),
        wintypes.LPVOID,
        wintypes.LPVOID,
        wintypes.DWORD,
        ctypes.POINTER(_DATA_BLOB),
    ]
    crypt32.CryptProtectData.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [wintypes.HLOCAL]
    kernel32.LocalFree.restype = wintypes.HLOCAL
    if not crypt32.CryptProtectData(
        ctypes.byref(input_blob),
        description,
        None,
        None,
        None,
        0x1,
        ctypes.byref(output_blob),
    ):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(output_blob.pbData, output_blob.cbData)
    finally:
        kernel32.LocalFree(output_blob.pbData)
        del input_buffer


def unprotect_secret(value: bytes) -> bytes:
    if os.name != "nt":
        raise OSError("DPAPI is available only on Windows")
    input_blob, input_buffer = _blob(value)
    output_blob = _DATA_BLOB()
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    crypt32.CryptUnprotectData.argtypes = [
        ctypes.POINTER(_DATA_BLOB),
        ctypes.POINTER(wintypes.LPWSTR),
        ctypes.POINTER(_DATA_BLOB),
        wintypes.LPVOID,
        wintypes.LPVOID,
        wintypes.DWORD,
        ctypes.POINTER(_DATA_BLOB),
    ]
    crypt32.CryptUnprotectData.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [wintypes.HLOCAL]
    kernel32.LocalFree.restype = wintypes.HLOCAL
    if not crypt32.CryptUnprotectData(
        ctypes.byref(input_blob),
        None,
        None,
        None,
        None,
        0x1,
        ctypes.byref(output_blob),
    ):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(output_blob.pbData, output_blob.cbData)
    finally:
        kernel32.LocalFree(output_blob.pbData)
        del input_buffer
