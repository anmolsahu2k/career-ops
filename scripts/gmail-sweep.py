#!/usr/bin/env python3
"""
gmail-sweep.py

Fetch emails from a Gmail account matching a mode-specific query, dump
as JSON for downstream LLM-as-judge processing.

Uses OAuth credentials already issued by @gongrzhe/server-gmail-autoauth-mcp
(stored in ~/.gmail-mcp/), so no additional auth setup needed.

Modes:
  personal-apps         Application confirmation emails (personal account)
  personal-rejections   Rejection emails matching common keyword set
  cmu-handshake         Handshake-sent confirmations (CMU account)

Usage:
  python3 scripts/gmail-sweep.py --mode personal-apps --account personal --since 2025-07-01
  python3 scripts/gmail-sweep.py --mode personal-rejections --account personal --since 2025-07-01
  python3 scripts/gmail-sweep.py --mode cmu-handshake --account cmu --since 2025-07-01

Output: data/gmail-sweeps/<mode>-<YYYY-MM-DD>.json
"""

import argparse
import base64
import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths
_DEFAULT_SWEEP_DIR = str(_paths.resolve_paths(__file__)["data_dir"] / "gmail-sweeps")

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

GMAIL_MCP_DIR = Path("~/.gmail-mcp").expanduser()
GCP_KEYS_PATH = GMAIL_MCP_DIR / "gcp-oauth.keys.json"
CRED_PATHS = {
    "personal": GMAIL_MCP_DIR / "personal-credentials.json",
    "cmu": GMAIL_MCP_DIR / "cmu-credentials.json",
}

QUERIES = {
    "personal-apps": (
        'after:{since} '
        '(subject:"thank you for applying" OR '
        'subject:"thanks for applying" OR '
        'subject:"application received" OR '
        'subject:"we received your application" OR '
        'subject:"your application has been received" OR '
        'subject:"we got your application" OR '
        'subject:"application submitted" OR '
        'subject:"application confirmation" OR '
        'subject:"we have received your application")'
    ),
    "personal-rejections": (
        'after:{since} '
        '"application" '
        '("unfortunately" OR '
        '"regret to inform" OR '
        '"moved forward with other candidates" OR '
        '"will not be moving forward" OR '
        '"decided not to move forward" OR '
        '"no longer being considered" OR '
        '"not selected" OR '
        '"not be progressing" OR '
        '"pursue other candidates")'
    ),
    "cmu-handshake": (
        'after:{since} '
        'from:joinhandshake.com '
        '(subject:"submitted" OR subject:"applied" OR subject:"application")'
    ),
}


def load_credentials(account: str) -> Credentials:
    keys = json.loads(GCP_KEYS_PATH.read_text())
    client = keys.get("installed", keys.get("web", {}))
    if not client:
        sys.exit(f"gcp-oauth.keys.json missing 'installed' or 'web' key")
    raw = json.loads(CRED_PATHS[account].read_text())
    return Credentials(
        token=raw["access_token"],
        refresh_token=raw["refresh_token"],
        token_uri=client.get("token_uri", "https://oauth2.googleapis.com/token"),
        client_id=client["client_id"],
        client_secret=client["client_secret"],
        scopes=raw.get("scope", "").split(),
    )


def extract_text(payload: dict, max_chars: int = 1500) -> str:
    def walk(part):
        mime = part.get("mimeType", "")
        body = part.get("body", {})
        if mime == "text/plain" and body.get("data"):
            return base64.urlsafe_b64decode(body["data"]).decode("utf-8", errors="replace")
        for sub in part.get("parts", []):
            got = walk(sub)
            if got:
                return got
        return None

    for mime_pref in ("text/plain", "text/html"):
        def walk_mime(part, target=mime_pref):
            if part.get("mimeType") == target and part.get("body", {}).get("data"):
                return base64.urlsafe_b64decode(part["body"]["data"]).decode("utf-8", errors="replace")
            for sub in part.get("parts", []):
                got = walk_mime(sub, target)
                if got:
                    return got
            return None

        text = walk_mime(payload)
        if text:
            if mime_pref == "text/html":
                import re
                text = re.sub(r"<[^>]+>", " ", text)
                text = re.sub(r"\s+", " ", text)
            return text.strip()[:max_chars]
    return ""


def fetch_messages(service, query: str, since: str, label: str) -> list[dict]:
    query = query.format(since=since.replace("-", "/"))
    print(f"[{label}] query: {query}", file=sys.stderr)
    out = []
    page_token = None
    while True:
        resp = service.users().messages().list(
            userId="me", q=query, maxResults=500, pageToken=page_token
        ).execute()
        ids = [m["id"] for m in resp.get("messages", [])]
        for mid in ids:
            msg = service.users().messages().get(userId="me", id=mid, format="full").execute()
            headers = {
                h["name"].lower(): h["value"]
                for h in msg.get("payload", {}).get("headers", [])
            }
            out.append({
                "msg_id": mid,
                "thread_id": msg.get("threadId"),
                "date": headers.get("date", ""),
                "from": headers.get("from", ""),
                "to": headers.get("to", ""),
                "subject": headers.get("subject", ""),
                "snippet": msg.get("snippet", ""),
                "body": extract_text(msg.get("payload", {})),
            })
        print(f"[{label}] fetched {len(out)} so far", file=sys.stderr)
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", required=True, choices=list(QUERIES.keys()))
    ap.add_argument("--account", required=True, choices=["personal", "cmu"])
    ap.add_argument("--since", required=True, help="YYYY-MM-DD")
    ap.add_argument("--out-dir", default=_DEFAULT_SWEEP_DIR)
    args = ap.parse_args()

    creds = load_credentials(args.account)
    service = build("gmail", "v1", credentials=creds)
    msgs = fetch_messages(service, QUERIES[args.mode], args.since, args.mode)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{args.mode}-{date.today().isoformat()}.json"
    out_path.write_text(json.dumps(msgs, indent=2))
    print(f"[done] {args.mode} ({args.account}): {len(msgs)} messages -> {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
