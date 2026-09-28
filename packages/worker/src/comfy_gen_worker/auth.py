"""The settings pages' session: a signed, stateless cookie.

There is no password. Logging in means pasting a Cloudflare API token that can see this Worker
(app._login), which only the account's owner can make; setup needs that token anyway. So the
cookie lasts a year, and a new browser logs in with a fresh token from the same link.
"""

from __future__ import annotations

import hashlib
import hmac

COOKIE = "cg_session"
SESSION_S = 365 * 24 * 3600


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
