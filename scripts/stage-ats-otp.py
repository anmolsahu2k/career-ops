#!/usr/bin/env python3
"""Read one fresh ATS verification code from personal Gmail only.

This is not a mailbox sweep. It searches briefly after an active application
asks for a code, filters configured ATS sender domains, writes only the code
to the runner's short-lived handoff file, and never prints the code.
"""
import argparse
import base64
import html
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from google.auth.exceptions import RefreshError
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

MCP_DIR = Path("~/.gmail-mcp").expanduser()
KEYS = Path(os.environ.get("CAREER_OPS_GMAIL_OTP_KEYS") or MCP_DIR / "gcp-oauth.keys.json").expanduser()
CREDS = Path(os.environ.get("CAREER_OPS_GMAIL_OTP_CREDS") or MCP_DIR / "personal-credentials.json").expanduser()
# Google refresh tokens for OAuth clients left in Testing expire after 7 days.
TESTING_REFRESH_TOKEN_SECONDS = 7 * 24 * 60 * 60
OTP_HINT = re.compile(
    r"(?:verification|security|one[ -]?time|authentication)\s+code|8-character code|copy and paste this code|confirm you(?:['’]re| are) a human",
    re.I,
)
FALLBACK_DIGITS = re.compile(r"(?<!\d)([0-9](?:\s*[0-9]){5,7})(?!\d)")
FALLBACK_SPACED = re.compile(r"(?<![A-Za-z0-9])([A-Za-z0-9](?:\s+[A-Za-z0-9]){5,11})(?![A-Za-z0-9])")
CODE_PROMPTS = [
    r"copy and paste this code",
    r"8-character code",
    r"enter (?:the|this) (?:8-character )?code",
    r"(?:your\s+)?(?:verification|security|one[ -]?time|authentication)\s+code(?:\s+is)?",
]


def parse_authorized_at(value):
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    issued = datetime.fromisoformat(text)
    if issued.tzinfo is None:
        issued = issued.replace(tzinfo=timezone.utc)
    return issued.astimezone(timezone.utc)


def public_auth_status(now=None):
    if not CREDS.is_file():
        return {
            "ok": False,
            "expired": True,
            "error": "credentials_unreadable",
            "source": "missing",
            "age_seconds": 0,
            "expires_in_seconds": 0,
            "testing_refresh_days": 7,
        }
    try:
        raw = json.loads(CREDS.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {
            "ok": False,
            "expired": True,
            "error": "credentials_unreadable",
            "source": "unreadable",
            "age_seconds": 0,
            "expires_in_seconds": 0,
            "testing_refresh_days": 7,
        }
    issued = parse_authorized_at(raw.get("authorized_at"))
    source = "authorized_at"
    if issued is None:
        issued = datetime.fromtimestamp(CREDS.stat().st_mtime, tz=timezone.utc)
        source = "file_mtime"
    now = now or datetime.now(timezone.utc)
    age = max(0, (now - issued).total_seconds())
    remaining = TESTING_REFRESH_TOKEN_SECONDS - age
    expired = remaining <= 0
    return {
        "ok": not expired,
        "expired": expired,
        "error": "token_expired" if expired else None,
        "source": source,
        "age_seconds": int(age),
        "expires_in_seconds": 0 if expired else int(remaining),
        "testing_refresh_days": 7,
    }


def with_auth(status):
    auth = public_auth_status()
    payload = dict(status or {})
    payload["auth"] = {key: value for key, value in auth.items() if key != "ok"}
    if auth.get("expired") and not payload.get("error"):
        payload["ok"] = False
        payload["error"] = auth.get("error") or "token_expired"
    return payload


def emit_status(path, status, diagnose=False):
    public = with_auth(status)
    write_status(path, public)
    if diagnose:
        sys.stdout.write(json.dumps(public) + "\n")
    if public.get("error") == "token_expired":
        sys.stderr.write(
            "Gmail OTP refresh token expired after the 7-day Testing-app limit. "
            "Re-run python scripts/auth-gmail-otp.py\n"
        )
    return public


def credentials():
    keys = json.loads(KEYS.read_text())
    client = keys.get("installed", keys.get("web", {}))
    raw = json.loads(CREDS.read_text())
    return Credentials(
        token=raw["access_token"],
        refresh_token=raw["refresh_token"],
        token_uri=client.get("token_uri", "https://oauth2.googleapis.com/token"),
        client_id=client["client_id"],
        client_secret=client["client_secret"],
        scopes=str(raw.get("scope", "")).split(),
    )


def decode_body(data):
    encoded = data or ""
    encoded += "=" * (-len(encoded) % 4)
    return base64.urlsafe_b64decode(encoded).decode("utf-8", errors="replace")


def visible_text(value, mime="text/plain"):
    text = value or ""
    if mime == "text/html":
        text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    return re.sub(r"\s+", " ", re.sub(r"[\u00a0\u2000-\u200b\u200c\u200d\ufeff]", " ", text)).strip()


def part_text(part, service=None, message_id=None):
    mime = part.get("mimeType") or ""
    if mime not in ("text/plain", "text/html"):
        chunks = []
        for child in part.get("parts") or []:
            chunk = part_text(child, service, message_id)
            if chunk:
                chunks.append(chunk)
        return "\n".join(chunks)
    body = part.get("body") or {}
    raw = ""
    if body.get("data"):
        raw = decode_body(body.get("data"))
    elif service and message_id and body.get("attachmentId"):
        att = service.users().messages().attachments().get(
            userId="me", messageId=message_id, id=body["attachmentId"]
        ).execute()
        raw = decode_body(att.get("data") or "")
    return visible_text(raw, mime)


def payload_text(payload, service=None, message_id=None):
    return part_text(payload or {}, service, message_id)


def sender_domain(value):
    match = re.search(r"@([a-z0-9.-]+)", (value or "").lower())
    return match.group(1) if match else ""


def allowed_sender(value, domains):
    domain = sender_domain(value)
    return bool(domain and any(domain == item or domain.endswith("." + item) for item in domains))


def compact_code(value):
    code = re.sub(r"[\s\-]", "", value or "")
    if 6 <= len(code) <= 12 and re.fullmatch(r"[A-Za-z0-9]+", code):
        return code
    return ""


def finalize_code(code, text):
    if not code:
        return ""
    if re.search(r"8-character", text or "", re.I) and len(code) >= 8:
        return code[:8]
    return code


def redact_preview(text):
    return re.sub(r"[A-Za-z0-9]", "x", (text or "")[:300])


def code_from_rest(rest):
    rest = (rest or "").strip()
    contiguous = re.match(r"([A-Za-z0-9]{6,12})\b", rest)
    if contiguous:
        return contiguous.group(1)
    letters = []
    for token in rest.split():
        if re.fullmatch(r"[A-Za-z0-9]", token):
            letters.append(token)
            if len(letters) == 12:
                break
            continue
        break
    if 6 <= len(letters) <= 12:
        return "".join(letters)
    return ""


def match_code(text):
    for index, prompt in enumerate(CODE_PROMPTS):
        match = re.search(prompt + r"[^:]{0,160}:?\s+(.+)$", text or "", re.I)
        if not match:
            continue
        code = finalize_code(code_from_rest(match.group(1)), text)
        if code:
            return code, f"prompt_{index}"
    if OTP_HINT.search(text or ""):
        digits = FALLBACK_DIGITS.search(text)
        if digits:
            code = finalize_code(compact_code(digits.group(1)), text)
            if code:
                return code, "fallback_digits"
        spaced = FALLBACK_SPACED.search(text)
        if spaced:
            code = finalize_code(code_from_rest(spaced.group(1)), text)
            if code:
                return code, "fallback_spaced"
    window = re.search(
        r"(?:copy and paste this code|8-character code|security code|verification code|confirm you(?:['’]re| are) a human)(.{0,500})",
        text or "",
        re.I | re.S,
    )
    if window:
        letters = []
        for token in window.group(1).split():
            if re.fullmatch(r"[A-Za-z0-9]", token):
                letters.append(token)
                continue
            if letters:
                break
        if 6 <= len(letters) <= 12:
            code = finalize_code("".join(letters), text)
            if code:
                return code, "window_singles"
    return "", ""


def extract_code(value):
    text = visible_text(html.unescape(re.sub(r"<[^>]+>", " ", value or "")), "text/plain")
    code, _method = match_code(text)
    return code
    return ""


def list_query(domains):
    domain_query = " OR ".join(f"from:{domain}" for domain in domains)
    return f"newer_than:1d ({domain_query})"


def inspect_messages(service, not_before_ms, domains):
    query = list_query(domains)
    listed = service.users().messages().list(
        userId="me", q=query, maxResults=20, includeSpamTrash=True,
    ).execute().get("messages", []) or []
    hits = []
    chosen = ""
    chosen_meta = None
    for item in listed:
        msg = service.users().messages().get(userId="me", id=item["id"], format="full").execute()
        internal = int(msg.get("internalDate", "0"))
        headers = {h["name"].lower(): h["value"] for h in msg.get("payload", {}).get("headers", [])}
        domain = sender_domain(headers.get("from", ""))
        age_seconds = max(0, int((time.time() * 1000 - internal) / 1000))
        meta = {
            "from_domain": domain or "unknown",
            "age_seconds": age_seconds,
            "allowlisted": allowed_sender(headers.get("from", ""), domains),
            "too_old": internal < not_before_ms,
            "extracted": False,
            "code_length": 0,
            "used_attachment": any(
                (part.get("body") or {}).get("attachmentId")
                for part in _walk_parts(msg.get("payload") or {})
            ),
            "body_chars": 0,
        }
        if meta["too_old"] or not meta["allowlisted"]:
            hits.append(meta)
            continue
        body = payload_text(msg.get("payload") or {}, service, item["id"])
        meta["body_chars"] = len(body)
        combined = f'{headers.get("subject", "")}\n{body}'
        text = visible_text(html.unescape(re.sub(r"<[^>]+>", " ", combined)), "text/plain")
        code, method = match_code(text)
        meta["preview"] = redact_preview(text)
        meta["has_eight_character_phrase"] = bool(re.search(r"8-character", text, re.I))
        meta["extract_method"] = method or ""
        if code:
            meta["extracted"] = True
            meta["code_length"] = len(code)
            hits.append(meta)
            if not chosen:
                chosen = code
                chosen_meta = meta
            continue
        hits.append(meta)
    return {
        "query": query,
        "listed": len(listed),
        "hits": hits,
        "code": chosen,
        "selected": chosen_meta,
    }


def _walk_parts(part):
    yield part
    for child in part.get("parts") or []:
        yield from _walk_parts(child)


def write_code(path, code):
    out = Path(path).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        with out.open("x", encoding="utf-8") as handle:
            handle.write(code)
    except FileExistsError:
        out.unlink()
        with out.open("x", encoding="utf-8") as handle:
            handle.write(code)


def write_status(path, payload):
    if not path:
        return
    out = Path(path).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    public = {key: value for key, value in payload.items() if key != "code"}
    out.write_text(json.dumps(public), encoding="utf-8")


def public_result(result):
    selected = result.get("selected")
    return {
        "ok": bool(result.get("code")),
        "query": result.get("query"),
        "listed": result.get("listed", 0),
        "allowlisted": sum(1 for item in result.get("hits") or [] if item.get("allowlisted") and not item.get("too_old")),
        "extracted": bool(result.get("code")),
        "code_length": len(result.get("code") or ""),
        "from_domain": (selected or {}).get("from_domain"),
        "age_seconds": (selected or {}).get("age_seconds"),
        "hits": [
            {
                "from_domain": item.get("from_domain"),
                "age_seconds": item.get("age_seconds"),
                "allowlisted": item.get("allowlisted"),
                "too_old": item.get("too_old"),
                "extracted": item.get("extracted"),
                "code_length": item.get("code_length"),
                "body_chars": item.get("body_chars"),
                "used_attachment": item.get("used_attachment"),
                "extract_method": item.get("extract_method"),
                "has_eight_character_phrase": item.get("has_eight_character_phrase"),
                "preview": item.get("preview"),
            }
            for item in result.get("hits") or []
        ],
    }


def inspect_hinted_senders(service):
    """Diagnose-only: show From domains of recent verification-looking mail."""
    query = 'newer_than:1d (subject:("security code" OR "verification code" OR "one-time code") OR "8-character code")'
    listed = service.users().messages().list(
        userId="me", q=query, maxResults=10, includeSpamTrash=True,
    ).execute().get("messages", []) or []
    rows = []
    for item in listed:
        msg = service.users().messages().get(
            userId="me", id=item["id"], format="metadata",
            metadataHeaders=["From"],
        ).execute()
        headers = {h["name"].lower(): h["value"] for h in msg.get("payload", {}).get("headers", [])}
        internal = int(msg.get("internalDate", "0"))
        rows.append({
            "from_domain": sender_domain(headers.get("from", "")) or "unknown",
            "age_seconds": max(0, int((time.time() * 1000 - internal) / 1000)),
        })
    return {"query": query, "listed": len(listed), "from_domains": rows}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out")
    parser.add_argument("--not-before", type=int)
    parser.add_argument("--domains")
    parser.add_argument("--timeout-seconds", type=int, default=90)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--extract-from-stdin", action="store_true")
    parser.add_argument("--diagnose", action="store_true")
    parser.add_argument("--auth-status", action="store_true")
    parser.add_argument("--status-out")
    args = parser.parse_args()
    if args.extract_from_stdin:
        sys.stdout.write(extract_code(sys.stdin.read()) + "\n")
        return
    if args.auth_status:
        auth = public_auth_status()
        emit_status(args.status_out, {
            "ok": auth.get("ok") is True,
            "error": auth.get("error"),
            "listed": 0,
            "allowlisted": 0,
            "extracted": False,
        }, diagnose=True)
        raise SystemExit(0 if auth.get("ok") else 3)
    if args.not_before is None or not args.domains:
        raise SystemExit(2)
    if not args.diagnose and not args.out:
        raise SystemExit(2)
    domains = [d.strip().lower() for d in args.domains.split(",") if re.fullmatch(r"[a-z0-9.-]+", d.strip().lower())]
    if not domains or args.timeout_seconds < 1 or args.timeout_seconds > 300:
        raise SystemExit(2)
    auth = public_auth_status()
    if auth.get("expired"):
        emit_status(args.status_out, {
            "ok": False,
            "error": auth.get("error") or "token_expired",
            "listed": 0,
            "allowlisted": 0,
            "extracted": False,
        }, diagnose=args.diagnose)
        raise SystemExit(3)
    try:
        service = build("gmail", "v1", credentials=credentials(), cache_discovery=False)
    except Exception as error:
        emit_status(args.status_out, {
            "ok": False, "error": "credentials_unreadable", "listed": 0, "allowlisted": 0, "extracted": False,
        }, diagnose=args.diagnose)
        raise SystemExit(3) from error
    try:
        if args.diagnose or args.once:
            result = inspect_messages(service, args.not_before, domains)
            status = public_result(result)
            if args.diagnose:
                status["hinted_senders"] = inspect_hinted_senders(service)
            emit_status(args.status_out, status, diagnose=args.diagnose)
            if result.get("code") and args.out:
                write_code(args.out, result["code"])
            return
        deadline = time.monotonic() + args.timeout_seconds
        last = {"listed": 0, "hits": [], "code": "", "query": list_query(domains)}
        while time.monotonic() < deadline:
            last = inspect_messages(service, args.not_before, domains)
            if last.get("code"):
                emit_status(args.status_out, public_result(last))
                write_code(args.out, last["code"])
                return
            time.sleep(3)
        emit_status(args.status_out, public_result(last))
    except RefreshError:
        emit_status(args.status_out, {
            "ok": False,
            "error": "token_expired",
            "listed": 0,
            "allowlisted": 0,
            "extracted": False,
        }, diagnose=args.diagnose)
        raise SystemExit(3)


if __name__ == "__main__":
    main()
