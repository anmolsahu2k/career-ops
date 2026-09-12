#!/usr/bin/env python3
"""Read one fresh ATS verification code from personal Gmail only.

This is not a mailbox sweep. It searches briefly after an active application
asks for a code, filters configured ATS sender domains, writes only the code
to the runner's short-lived handoff file, and prints nothing.
"""
import argparse
import base64
import html
import json
import re
import time
from pathlib import Path
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

MCP_DIR = Path("~/.gmail-mcp").expanduser()
KEYS, CREDS = MCP_DIR / "gcp-oauth.keys.json", MCP_DIR / "personal-credentials.json"
CODE = re.compile(
    r"(?:copy and paste this code[^:\r\n]{0,120}:|"
    r"(?:your\s+)?(?:verification|security|one[ -]?time|authentication)\s+code(?:\s+is)?\s*:?)"
    r"\s*([A-Za-z0-9]{6,12})\b",
    re.I,
)
FALLBACK = re.compile(r"(?<!\d)([0-9](?:\s*[0-9]){5,7})(?!\d)")

def credentials():
    keys = json.loads(KEYS.read_text()); client = keys.get("installed", keys.get("web", {})); raw = json.loads(CREDS.read_text())
    return Credentials(token=raw["access_token"], refresh_token=raw["refresh_token"], token_uri=client.get("token_uri", "https://oauth2.googleapis.com/token"), client_id=client["client_id"], client_secret=client["client_secret"], scopes=raw.get("scope", "").split())

def body_text(part):
    body = part.get("body", {})
    if part.get("mimeType") in ("text/plain", "text/html") and body.get("data"):
        encoded = body["data"]
        encoded += "=" * (-len(encoded) % 4)
        value = base64.urlsafe_b64decode(encoded).decode("utf-8", errors="replace")
        if part.get("mimeType") == "text/html":
            # Greenhouse renders each character of its security code in
            # separate markup. Match the visible text, not the raw tags.
            value = html.unescape(re.sub(r"<[^>]+>", " ", value))
            value = re.sub(r"\s+", " ", value)
        return value
    for child in part.get("parts", []):
        value = body_text(child)
        if value: return value
    return ""

def allowed_sender(value, domains):
    match = re.search(r"@([a-z0-9.-]+)", value.lower())
    return bool(match and any(match.group(1) == domain or match.group(1).endswith("." + domain) for domain in domains))

def find_code(service, not_before_ms, domains):
    query = 'newer_than:1d (subject:(code OR verify OR security OR authentication) OR "verification code" OR "security code")'
    for item in service.users().messages().list(userId="me", q=query, maxResults=20).execute().get("messages", []):
        msg = service.users().messages().get(userId="me", id=item["id"], format="full").execute()
        if int(msg.get("internalDate", "0")) < not_before_ms: continue
        headers = {h["name"].lower(): h["value"] for h in msg.get("payload", {}).get("headers", [])}
        if not allowed_sender(headers.get("from", ""), domains): continue
        value = f'{headers.get("subject", "")}\n{body_text(msg.get("payload", {}))}'
        match = CODE.search(value) or (FALLBACK.search(value) if re.search(r"(?:verification|security|one[ -]?time|authentication)\s+code", value, re.I) else None)
        if match: return re.sub(r"\s", "", match.group(1))
    return ""

def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--out", required=True); parser.add_argument("--not-before", required=True, type=int); parser.add_argument("--domains", required=True); parser.add_argument("--timeout-seconds", type=int, default=90)
    args = parser.parse_args(); domains = [d.strip().lower() for d in args.domains.split(",") if re.fullmatch(r"[a-z0-9.-]+", d.strip().lower())]
    if not domains or args.timeout_seconds < 1 or args.timeout_seconds > 180: raise SystemExit(2)
    service = build("gmail", "v1", credentials=credentials(), cache_discovery=False); deadline = time.monotonic() + args.timeout_seconds
    while time.monotonic() < deadline:
        code = find_code(service, args.not_before, domains)
        if code:
            out = Path(args.out).resolve(); out.parent.mkdir(parents=True, exist_ok=True)
            with out.open("x", encoding="utf-8") as handle: handle.write(code)
            return
        time.sleep(3)

if __name__ == "__main__": main()
