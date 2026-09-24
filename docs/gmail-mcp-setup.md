# Gmail MCP Setup

Setup for the two Gmail MCP servers that back the gmail-sweep reconciliation ([modes/gmail-sweep.md](../modes/gmail-sweep.md)). Paths and key names only; no secret values.

## The two servers

| Server | Account | Credentials file |
|---|---|---|
| `gmail-personal` | anmolsahu2k@gmail.com (most external ATS applications) | `~/.gmail-mcp/personal-credentials.json` |
| `gmail-cmu` | anmolsah@andrew.cmu.edu (Handshake) | `~/.gmail-mcp/cmu-credentials.json` |

Both share one OAuth client: `~/.gmail-mcp/gcp-oauth.keys.json` (Desktop-type, created in a Cloud Console project, External + Testing status, both emails added as test users).

Claude Code registrations are not automatically available to Codex. In the ChatGPT desktop app, check **Settings > MCP servers**; in a Codex session, use `/mcp`. The repository does not store Gmail MCP configuration because account access and OAuth authorization are user-scoped.

## First-time setup

1. Create the shared OAuth client in Google Cloud Console (Desktop app type), enable the Gmail API, add both email addresses as test users, and download the client to `~/.gmail-mcp/gcp-oauth.keys.json`. Do this once; the same client is reused for both accounts.

2. For the application runner's personal-Gmail OTP lookup, use the repository's
   least-privilege helper. It requests `gmail.readonly`, not the broader modify
   and settings scopes requested by the general Gmail MCP package:

   ```bash
   python scripts/auth-gmail-otp.py
   ```

   To connect the full Gmail MCP servers for sweep or draft workflows, run the
   package auth flow once per account. This writes each account's
   `*-credentials.json` with the broader scopes required by that server:

   ```bash
   GMAIL_CREDENTIALS_PATH=~/.gmail-mcp/personal-credentials.json \
     npx -y @gongrzhe/server-gmail-autoauth-mcp auth

   GMAIL_CREDENTIALS_PATH=~/.gmail-mcp/cmu-credentials.json \
     npx -y @gongrzhe/server-gmail-autoauth-mcp auth
   ```

   Each opens a browser consent screen; sign in with the matching account. The shared `gcp-oauth.keys.json` is not re-downloaded between the two runs.

3. Lock down permissions on the credential directory:

   ```bash
   chmod 600 ~/.gmail-mcp/*.json && chmod 700 ~/.gmail-mcp
   ```

## Token expiry (re-auth every 7 days)

Because the GCP app is in Testing status, the OAuth refresh tokens expire every 7 days. The OTP reader now fails closed on that expiry instead of treating Gmail as empty: `scripts/stage-ats-otp.py --auth-status` and live reads report `token_expired`, and the apply UI chip turns broken. Re-run only the `auth` step for the affected account (the command from step 2). No Cloud Console changes are needed; the shared client stays as is.

To drop the 7-day cutoff, publish the same OAuth client to **In production** in Google Cloud Console (APIs & Services → OAuth consent screen). Production refresh tokens no longer expire every 7 days. They still end if you revoke access, change the Google password, or leave the token unused for 6 months. `gmail.readonly` is a sensitive scope, so an unverified production app shows a warning screen and stays capped at 100 users, which is enough for this personal desktop client.

## Codex connection

The direct Python sweep uses the credential files above and does not require an MCP-aware session. Gmail draft staging does require the `gmail-personal` MCP to be connected to Codex separately. Add both STDIO servers through **Settings > MCP servers**, using `npx -y @gongrzhe/server-gmail-autoauth-mcp` and the matching `GMAIL_CREDENTIALS_PATH` for each account. Keep OAuth tokens outside the repository and disable or require approval for send/delete tools.

## Notes

- The MCP tools become available after restarting the Codex host, under the `gmail-personal` / `gmail-cmu` namespaces.
- Batch sweep work bypasses the MCP layer and calls the Gmail API directly via `google-api-python-client` using these same OAuth tokens (faster, no session restart). See [scripts/gmail-sweep.py](../scripts/gmail-sweep.py).
