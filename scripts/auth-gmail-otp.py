#!/usr/bin/env python3
"""Authorize the narrow Gmail access used by the ATS OTP reader.

This intentionally requests Gmail read-only access.  The general Gmail MCP
package requests modify and settings scopes, which are unnecessary for the
application runner's one-purpose verification-code lookup.
"""

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow


SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
MCP_DIR = Path("~/.gmail-mcp").expanduser()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--credentials",
        default=str(MCP_DIR / "personal-credentials.json"),
        help="Destination for the user OAuth token",
    )
    args = parser.parse_args()

    oauth_path = MCP_DIR / "gcp-oauth.keys.json"
    destination = Path(args.credentials).expanduser().resolve()
    if not oauth_path.is_file():
        raise SystemExit(f"OAuth client file not found: {oauth_path}")

    flow = InstalledAppFlow.from_client_secrets_file(str(oauth_path), SCOPES)
    credentials = flow.run_local_server(
        host="127.0.0.1",
        port=3000,
        authorization_prompt_message="Opening Google authorization in your browser...",
        success_message="Gmail OTP access authorized. You may close this tab.",
        open_browser=True,
        access_type="offline",
        prompt="consent",
    )
    if not credentials.refresh_token:
        raise SystemExit("Google did not return an offline refresh token")

    payload = {
        "access_token": credentials.token,
        "refresh_token": credentials.refresh_token,
        "scope": " ".join(credentials.scopes or SCOPES),
        "token_uri": credentials.token_uri,
        "expiry": credentials.expiry.isoformat() if credentials.expiry else None,
        "authorized_at": datetime.now(timezone.utc).isoformat(),
    }
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    with temporary.open("x", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"))
    os.chmod(temporary, 0o600)
    os.replace(temporary, destination)
    os.chmod(destination, 0o600)


if __name__ == "__main__":
    main()
