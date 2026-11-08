"""Banker responses to alerts: an append-only JSON list shared by all users (backend/cache/alert_notes.json)."""
from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / "cache" / "alert_notes.json"
STATUSES = ("open", "in_progress", "done")
LOCK = threading.Lock()


def validate(body) -> dict:
    """Return a clean note dict or raise ValueError(message)."""
    if not isinstance(body, dict):
        raise ValueError("body must be a JSON object")
    def text(key, limit, required=False):
        v = body.get(key, "")
        if v is None:
            v = ""
        if not isinstance(v, str):
            raise ValueError(f"{key} must be text")
        v = v.strip()
        if required and not v:
            raise ValueError(f"{key} is required")
        if len(v) > limit:
            raise ValueError(f"{key} too long ({limit} characters max)")
        return v
    week = body.get("week")
    if isinstance(week, bool) or not isinstance(week, int) or week < 0:
        raise ValueError("week must be a non-negative integer")
    status = body.get("status", "open")
    if status not in STATUSES:
        raise ValueError(f"status must be one of {', '.join(STATUSES)}")
    note = dict(loanId=text("loanId", 20, True), week=week, author=text("author", 60), response=text("response", 2000), actionPlan=text("actionPlan", 2000), status=status)
    if not note["response"] and not note["actionPlan"]:
        raise ValueError("write a response or an action plan")
    return note


def load(path: Path | None = None) -> list:
    p = path or PATH
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def add(body, path: Path | None = None) -> dict:
    """Validate, stamp (id + ISO time), append and write atomically."""
    p = path or PATH
    note = validate(body)
    note = dict(id=uuid.uuid4().hex[:12], at=datetime.now(timezone.utc).isoformat(timespec="seconds"), **note)
    with LOCK:
        notes = load(p)
        notes.append(note)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(notes, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, p)
    return note
