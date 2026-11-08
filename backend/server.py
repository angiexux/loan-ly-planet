"""Loan-ly Planet API server (stdlib only).  python3 backend/server.py [--port 8770]

GET  /api/health
GET  /api/analysis[?book=<id>]        latest analysis.json, or the analysis of an uploaded book
POST /api/upload?name=book.xlsx       raw body or multipart/form-data; runs the pipeline -> {ok, errors[], warnings[], bookId, analysisUrl}
GET  /api/report.xlsx?week=<i>&book=<id>   IFRS 9 provision report
GET  /api/parameters.xlsx             editable IFRS 9 / climate parameter workbook
GET  /api/explain?loan=<id>&week=<i>[&book=<id>]   template explanation + recommendation for any loan and week
GET  /api/pdf                         [{kind,title,needsLoan}] list of PDF kinds
GET  /api/alert-notes                                       banker responses to alerts -> {notes: [...]}
POST /api/alert-notes  {loanId, week, author, response, actionPlan, status}   append a note -> {note}
GET  /api/pdf/<kind>?week=&book=&loan=&ids=a,b[&product=multi_peril]   PDF report (application/pdf, attachment)
POST /api/ask                         {text, week, book} -> {understood, query, answer, parser}
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
import threading
import time
import traceback
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pipeline
from loanly import alerts as alerts_mod
from loanly import alert_notes
from loanly import config as C
from loanly import ask as ask_mod
from loanly import loader, pdf_reports, report

ROOT = C.ROOT
LATEST = ROOT / "web" / "public" / "data" / "analysis.json"
UPLOADS = ROOT / "backend" / "cache" / "uploads"
BOOKS = ROOT / "backend" / "cache" / "books"
MAX_UPLOAD = 25 * 1024 * 1024
RUN_LOCK = threading.Lock()
_cache: dict = {}


class BadRequest(Exception):
    def __init__(self, msg, errors=None, status=400):
        super().__init__(msg)
        self.errors, self.status = errors or [msg], status


def analysis_path(book: str | None) -> Path:
    if not book:
        return LATEST
    if not book.isalnum():
        raise BadRequest("invalid book id")
    p = BOOKS / f"{book}.json"
    if not p.exists():
        raise BadRequest(f"unknown book id {book}", status=404)
    return p


def load_analysis(book: str | None) -> dict:
    p = analysis_path(book)
    if not p.exists():
        raise BadRequest("analysis.json not found: run `python3 backend/pipeline.py` first", status=404)
    key = (str(p), p.stat().st_mtime)
    if key not in _cache:
        for k in [k for k in _cache if k[0] == key[0]]:
            del _cache[k]                    # stale version of the same book
        _cache[key] = json.loads(p.read_text())
    return _cache[key]


def parse_week(a, raw):
    if raw in (None, "", "null"):
        return a["meta"]["asOfDefault"]
    try:
        w = int(raw)
    except (TypeError, ValueError):
        raise BadRequest("week must be an integer")
    if not 0 <= w < C.W:
        raise BadRequest(f"week must be 0..{C.W - 1}")
    return w


def parse_upload(headers, body: bytes, qs) -> tuple[str, bytes]:
    ctype = headers.get("Content-Type", "")
    if ctype.startswith("multipart/form-data"):
        msg = BytesParser(policy=email_policy).parsebytes(b"Content-Type: " + ctype.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + body)
        for part in msg.iter_parts():
            fn = part.get_filename()
            if fn:
                return fn, part.get_payload(decode=True)
        raise BadRequest("multipart body has no file part")
    name = (qs.get("name") or [""])[0]
    if not name:
        raise BadRequest("send ?name=file.xlsx with a raw body, or a multipart form with a file")
    return name, body


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "LoanlyPlanet/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[api] " + fmt % args + "\n")

    # -------------------------------------------------------------- helpers
    def _send(self, status, body: bytes, ctype="application/json", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status, obj):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode())

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _guard(self, fn):
        try:
            fn()
        except BadRequest as e:
            self._json(e.status, dict(ok=False, error=str(e), errors=e.errors))
        except Exception as e:  # noqa
            traceback.print_exc()
            self._json(500, dict(ok=False, error=f"server error: {e}", errors=[str(e)]))

    # -------------------------------------------------------------- routes
    def do_GET(self):
        self._guard(self._get)

    def do_POST(self):
        self._guard(self._post)

    def _get(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        book = (qs.get("book") or [None])[0]
        if u.path == "/api/health":
            return self._json(200, dict(ok=True, service="loanly-planet", latestAnalysis=LATEST.exists(), llm=ask_mod.enabled_llm(), books=len(list(BOOKS.glob("*.json"))) if BOOKS.exists() else 0))
        if u.path == "/api/analysis":
            p = analysis_path(book)
            if not p.exists():
                raise BadRequest("analysis.json not found: run `python3 backend/pipeline.py` first", status=404)
            return self._send(200, p.read_bytes())
        if u.path == "/api/alert-notes":
            return self._json(200, dict(ok=True, notes=alert_notes.load()))
        if u.path == "/api/pdf":
            return self._json(200, dict(kinds=pdf_reports.list_kinds()))
        if u.path.startswith("/api/pdf/"):
            kind = u.path[len("/api/pdf/"):]
            if kind not in pdf_reports.KIND_NAMES:
                raise BadRequest(f"unknown PDF kind {kind!r}; one of {', '.join(pdf_reports.KIND_NAMES)}")
            a = load_analysis(book)
            week = parse_week(a, (qs.get("week") or [None])[0])
            loan = (qs.get("loan") or [None])[0]
            ids = [x for x in ",".join(qs.get("ids") or []).split(",") if x.strip()] or None
            ids = [x.strip() for x in ids] if ids else None
            product = (qs.get("product") or [None])[0]
            try:
                data = pdf_reports.build_pdf(kind, a, week, loan, ids, product)
            except ValueError as e:
                raise BadRequest(str(e))
            who = loan or (ids[0] if ids and len(ids) == 1 else "portfolio")
            who = "".join(ch for ch in who if ch.isalnum() or ch in "-_")
            return self._send(200, data, "application/pdf", {"Content-Disposition": f'attachment; filename="loanly_{kind}_{who}_{a["meta"]["weeks"][week]}.pdf"'})
        if u.path == "/api/report.xlsx":
            a = load_analysis(book)
            try:
                week = int((qs.get("week") or [a["meta"]["asOfDefault"]])[0])
            except ValueError:
                raise BadRequest("week must be an integer")
            if not 0 <= week < C.W:
                raise BadRequest(f"week must be 0..{C.W - 1}")
            buf = io.BytesIO()
            report.write_report(a, buf, week)
            return self._send(200, buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                              {"Content-Disposition": f'attachment; filename="ifrs9_provision_report_week{week}.xlsx"'})
        if u.path == "/api/parameters.xlsx":
            buf = io.BytesIO()
            tmp = ROOT / "backend" / "cache" / "parameters_download.xlsx"
            C.export_parameters_xlsx(tmp)
            return self._send(200, tmp.read_bytes(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                              {"Content-Disposition": 'attachment; filename="ifrs9_parameters.xlsx"'})
        if u.path == "/api/explain":
            a = load_analysis(book)
            lid = (qs.get("loan") or [""])[0]
            L = next((l for l in a["loans"] if l["id"] == lid), None)
            if L is None:
                raise BadRequest(f"unknown loan {lid!r}", status=404)
            try:
                week = int((qs.get("week") or [a["meta"]["asOfDefault"]])[0])
            except ValueError:
                raise BadRequest("week must be an integer")
            if not 0 <= week < C.W:
                raise BadRequest(f"week must be 0..{C.W - 1}")
            return self._json(200, dict(ok=True, loanId=lid, week=week, explanation=alerts_mod.explain(L, week), recommendation=alerts_mod.recommend(L, week)))
        raise BadRequest(f"no such endpoint {u.path}", status=404)

    def _post(self):
        u = urlparse(self.path)
        if u.path == "/api/alert-notes":
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > 100_000:
                raise BadRequest("send a JSON body {loanId, week, author, response, actionPlan, status}")
            try:
                body = json.loads(self.rfile.read(n) or b"{}")
            except Exception:
                raise BadRequest("body must be a JSON object")
            try:
                note = alert_notes.add(body)
            except ValueError as e:
                raise BadRequest(str(e))
            return self._json(200, dict(ok=True, note=note))
        if u.path == "/api/ask":
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > 1_000_000:
                raise BadRequest("send a JSON body {text, week, book}")
            try:
                body = json.loads(self.rfile.read(n) or b"{}")
                assert isinstance(body, dict)
            except Exception:
                raise BadRequest("body must be a JSON object")
            text = body.get("text")
            if not isinstance(text, str) or not text.strip():
                raise BadRequest("text is required")
            if len(text) > 2000:
                raise BadRequest("text too long (2000 characters max)")
            book = body.get("book") or None
            a = load_analysis(book)
            week = parse_week(a, body.get("week"))
            try:
                res = ask_mod.ask(text, a, week)
            except ValueError as e:
                raise BadRequest(str(e))
            pdf = res["answer"].get("pdf")
            if pdf and book:
                res["answer"]["pdf"] = pdf + f"&book={book}"
            return self._json(200, res)
        if u.path != "/api/upload":
            raise BadRequest(f"no such endpoint {u.path}", status=404)
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            raise BadRequest("empty body")
        if n > MAX_UPLOAD:
            raise BadRequest("file too large (25 MB max)", status=413)
        body = self.rfile.read(n)
        name, data = parse_upload(self.headers, body, parse_qs(u.query))
        safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in Path(name).name)
        if Path(safe).suffix.lower() not in (".xlsx", ".xlsm", ".csv"):
            raise BadRequest("upload an .xlsx workbook or a .csv file")
        bid = hashlib.sha1(data).hexdigest()[:12]
        UPLOADS.mkdir(parents=True, exist_ok=True); BOOKS.mkdir(parents=True, exist_ok=True)
        path = UPLOADS / f"{bid}-{safe}"
        path.write_bytes(data)
        res = loader.load_book(path)
        if res.book is None:
            return self._json(400, dict(ok=False, error=(res.errors or ["could not read the file"])[0], errors=res.errors, warnings=res.warnings))
        out = BOOKS / f"{bid}.json"
        if not out.exists():
            t = time.time()
            with RUN_LOCK:
                pipeline.run(path, out, None, uploaded=True, log=lambda *_: None)
            sys.stderr.write(f"[api] pipeline for {safe} took {time.time() - t:.1f}s\n")
        return self._json(200, dict(ok=True, bookId=bid, errors=[], loans=len(res.book.loans), analysisUrl=f"/api/analysis?book={bid}", warnings=res.warnings))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Loan-ly Planet API on http://{args.host}:{args.port}  (latest analysis: {LATEST})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
