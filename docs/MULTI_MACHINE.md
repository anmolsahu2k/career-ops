# Use Career-Ops on Windows and macOS

## Keep personal workspace data private

The current GitHub `origin` (`anmolsahu2k/career-ops`) is a **public fork**. It syncs tracked code, but the ignore rules keep the CV, profile, portal list, tracker, reports, resumes, and other personal workspace files out of Git. Do not force-add those files to this public remote.

GitHub ties a fork's visibility to its upstream network, so a public fork cannot be made private by itself. To sync personal workspace files through GitHub, create a **new standalone private repository**, not a fork. See [GitHub's fork visibility rules](https://docs.github.com/en/pull-requests/reference/forks).

After the blank private repository exists, run this from the Windows checkout, replacing the placeholder with its HTTPS or SSH URL:

```bash
git remote rename origin public-fork
git remote add origin <PRIVATE_REPOSITORY_URL>
git push --set-upstream origin codex/model-agnostic-runtime
```

Before tracking personal files, update `.gitignore` in the private copy to include the workspace files you want synced. Keep credentials and machine runtime state local. Verify the destination before staging or pushing personal files:

```bash
git remote get-url origin
git status --short --ignored
```

The URL must name your private repository. Once that private copy is ready, clone it on the MacBook so both computers use the same private remote and branch.

## Install on the MacBook

Install Node.js (Homebrew is one option), then clone the private repository:

```bash
brew install node
git clone <PRIVATE_REPOSITORY_URL> career-ops
cd career-ops
npm ci
npx playwright install chromium
```

Python adapters are optional. If you use them, install Python 3 and put their packages in a virtual environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -U -r requirements-discovery.txt
```

Open the folder in Codex. `.codex/config.example.toml` is a portable template; copy it to the ignored `.codex/config.toml` on each computer when you need the Playwright MCP. Credentials, `.env`, `.mcp.json`, and `config/runtime.local.yml` are machine-local and should be configured separately on Windows and macOS.

For runtime commands that write reports or tracker rows, copy `config/runtime.example.yml` to the ignored `config/runtime.local.yml` on each computer. Set `writer_host` to the exact output of:

```bash
node -p "require('node:os').hostname()"
```

Only one computer should write to the funnel at a time. Pull before using either computer, then push before switching to the other.

## Day-to-day sync

Before starting work on a machine:

```bash
git pull --ff-only
git status --short
```

After changes are ready to share:

```bash
git add -A
git diff --cached
git commit -m "Describe the change"
git push
```

Do not edit the same workspace from both computers at once. Git syncs committed files; ignored files and local credentials do not travel with a clone.

## Code-only setup before the private repository is ready

The current public fork's active branch can be cloned with:

```bash
git clone --branch codex/model-agnostic-runtime https://github.com/anmolsahu2k/career-ops.git career-ops
cd career-ops
npm ci
npx playwright install chromium
```

That public checkout does not contain the local personal files required for personalized evaluations. Keep the CV and application history off the public remote.
