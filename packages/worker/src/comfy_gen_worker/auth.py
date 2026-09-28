"""The settings pages' login: the setup password, then a signed, stateless session cookie."""

from __future__ import annotations

import hashlib
import hmac

COOKIE = "cg_session"
SESSION_S = 30 * 24 * 3600


def password_ok(given: str, expected: str | None) -> bool:
    if not expected:
        return False  # no SETUP_PASSWORD configured: nobody gets in
    return hmac.compare_digest(given.encode(), expected.encode())


def make_session(cookie_key: str, now: float) -> str:
    expires = str(int(now + SESSION_S))
    mac = hmac.new(bytes.fromhex(cookie_key), expires.encode(), hashlib.sha256).hexdigest()
    return f"{expires}.{mac}"


def session_ok(value: str | None, cookie_key: str, now: float) -> bool:
    if not value or "." not in value:
        return False
    expires, mac = value.split(".", 1)
    good = hmac.new(bytes.fromhex(cookie_key), expires.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(mac, good) and expires.isdigit() and int(expires) > now


def cookie_header(value: str, max_age: int = SESSION_S) -> str:
    return f"{COOKIE}={value}; Path=/; Max-Age={max_age}; HttpOnly; Secure; SameSite=Strict"


def read_cookie(header: str | None) -> str | None:
    for part in (header or "").split(";"):
        name, _, value = part.strip().partition("=")
        if name == COOKIE:
            return value
    return None
