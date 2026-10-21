# Murmur

Self-hosted multiplayer Claude Code. A team runs one **hub**. Each person runs a **node** on their own machine, which drives their own locally logged-in `claude` CLI, with one git worktree per lane. Everyone sees every agent's live output, and the team shares a task board, plans, messages, memory, live diffs, conflict detection, tool approvals and takeover.

## Requirements

Node ≥ 24 (TypeScript runs directly, no build step), git ≥ 2.38, and `claude` logged in on each node machine.

```sh
npm install
npm test
```

## Setup (macOS, Windows, Linux)

Every person does this once, on their own computer.

**1. Install Node.js 24 or newer and git.**

| OS | Command |
|---|---|
| macOS | `brew install node git` (or the installer from [nodejs.org](https://nodejs.org)) |
| Windows | `winget install OpenJS.NodeJS Git.Git`, then open a new terminal |
| Ubuntu/Debian | `curl -fsSL https://deb.nodesource.com/setup_24.x \| sudo -E bash - && sudo apt install -y nodejs git` |
| Fedora | `sudo dnf install nodejs git` (check `node -v` is 24+) |

**2. Install at least one agent CLI and log in to it.** Do this in the same terminal you will run Murmur from:
- Claude Code: `npm install -g @anthropic-ai/claude-code`, then run `claude` once to log in.
- Codex: `npm install -g @openai/codex`, then `codex login`.
- Gemini: `npm install -g @google/gemini-cli`, then run `gemini` once to log in.
- opencode, aider, or anything else also works (see "Add agent" below).

**3. Get Murmur and start it:**

```sh
git clone https://github.com/<you>/<repo>.git murmur
cd murmur
npm install
npm start
```

Your browser opens on Murmur. If it doesn't, open `http://127.0.0.1:7441` yourself.

**4. If you host, let friends reach you.** The first time, allow Node through the firewall prompt (Windows Defender or macOS). On Linux with ufw, run `sudo ufw allow 7440/tcp`. Friends who are not on your Wi-Fi need [Tailscale](https://tailscale.com); see "Run it online safely" below.

## Quick start (rooms: no account, no GitHub)

Your browser opens on `http://127.0.0.1:7441`.

- **Start a room:** type your name, pick the project folder, click **Start room**, then **Copy invite link** and send it to your friend.
- **Join a room:** paste the link, pick where the files should go, click **Join room**. The files download once. After that only changed files move.

In the room:
- **Left:** agents and the live file tree. A dot shows who just edited a file.
- **Middle:** the Hive. Humans and agents talk here.
- **Right:** the open file, updating live with the changed lines highlighted.

**+ Add** starts an agent on *your* computer with *your* CLI login: `claude`, `codex`, `gemini`, `opencode`, `aider`, or a custom command. A custom command gets the prompt one of three ways:
- on stdin, if the command has no placeholder;
- as a file path, where you write `{promptfile}`;
- as an argument, where you write `{prompt}`. On Windows this becomes "read the prompt file" instead, because `cmd.exe` limits length and quoting. For **Claude** and **Codex** you also pick the **model** and **effort**, both when you add the agent and later from the small menus on its row. A change applies from the agent's next turn.
- **Claude** models: the aliases (`fable`, `opus`, `sonnet`, `haiku`, always the newest), pinned ids such as `claude-opus-5-5`, or any id you type in. Efforts are `low`, `medium`, `high`, `xhigh` and `max`.
- **Codex** models: the list your account can use, read from `~/.codex/models_cache.json` (run `codex` once to fill it). Each model shows the effort levels it supports. If your `~/.codex/config.toml` default model is not in that list, Murmur warns you.

Write `@Name` to wake an agent; `@all` wakes every agent. Agents coordinate in plain text, so this works with any CLI:
- `PLAN:` says what the agent is doing.
- `CLAIM: path` reserves files so other agents steer around them.
- `@Other: …` messages another agent, possibly on a friend's computer. Back-and-forth pauses after the room's agent reply limit (default 4; the host sets it when starting the room and can change it or pick ∞ Unlimited in the room header) until a human mentions an agent again.

Every save in the folder (yours, your friend's, any agent's) reaches every computer within about a second, so you can run the project locally at any time. When two people edit the same file at once, the hub does a 3-way merge. If the same lines clash, it inserts git-style conflict markers and posts a note in the Hive. `.git`, `node_modules`, `.env`, keys and anything in `.gitignore` are never shared.

**Networking:** the host's computer runs the room on port 7440. Friends must be able to reach it, either on the same Wi-Fi or over [Tailscale](https://tailscale.com).

**Never shared, in either direction:** `.git`, `.murmur`, secrets (`.env*`, `*.pem`, `*.key`, `id_rsa*`), and agent CLI config (`.claude/`, `.codex/`, `.gemini/`, `.opencode/`, `.mcp.json`, `opencode.json`, `.aider.conf.yml`). That last group can hold hooks or permission rules that run commands, so a friend cannot plant them on your computer.

### Run it online safely

1. Install [Tailscale](https://tailscale.com/download) on every computer.
2. Sign in to the same tailnet on all of them, or [share the host machine](https://tailscale.com/kb/1084/sharing) with your friends' accounts.
3. Start Murmur and create the room. The invite link uses the host's Tailscale address (`100.x.y.z`) automatically. To force another address, set `MURMUR_PUBLIC_HOST` before `npm start`.

Room traffic, including all code, is encrypted twice:
- by Murmur, with AES-256-GCM. Each connection gets a fresh key derived from the room key, and the room key itself is never sent over the network;
- by Tailscale (WireGuard).

The room key lives in the invite link, after the `#`, so even opening the link in a browser does not send it anywhere. **The invite link is the secret.** Anyone who has it can edit the files and talk to your agents, so share it only with people you trust.

Never port-forward 7440 to the public internet. To keep the room on your tailnet only, set `MURMUR_HOST=<your 100.x address>`. The hub drops a connection that does not finish its handshake within 10 seconds. It also refuses an address for 10 minutes after 10 wrong links.

**Agent safety:** a friend's message can make your agent edit files in the shared folder. By default agents get **no shell**: Claude runs with `--disallowedTools=Bash`, Gemini with `--approval-mode auto_edit`, OpenCode with bash denied, Aider without shell suggestions, so they cannot run tests, scripts or installs on your computer. Codex cannot drop its shell, so it stays in its `workspace-write` sandbox (commands only inside the folder, no network). Turn on **full access** per agent (Add agent checkbox, or the *no shell* button on your agent) to let it run like your own terminal session with no permission prompts. That includes code friends synced and anything a room-mate asks it via @mention, so only do it in rooms you trust. Custom commands run exactly as typed.

Settings: `MURMUR_UI_PORT` (7441), `MURMUR_PORT` (7440), `MURMUR_HOST` (0.0.0.0), `MURMUR_HOME` (~/.murmur), `MURMUR_NO_OPEN=1`.

## Classic mode (accounts + git remote)

`npm run classic` runs the original hub/node design described below. It runs on macOS and Linux only.

### Classic quick start

Everyone runs the same command on their own computer (needs Node 24+, git, and Claude Code logged in):

```sh
npm install
npm start
```

- **First person (hosts the team):** press Enter at the question. Your browser opens; pick a name and password, then click **Connect this computer**. Create a workspace with your repository's URL and click **Set up on your computer** (Murmur finds your clone or downloads one). Click **Invite people** and send the link.
- **Teammates:** run `npm start` and paste the invite link at the question (or `npm start -- <invite link>`). The browser opens on the invite; pick a name and password, click **Connect this computer**, then **Set up on your computer** in the workspace.

After that, everything is in the browser: start a session, others click **Join**, and each person's agent gets its own lane. Agents message each other (a message wakes the other agent as its next turn), read each other's lanes and changes, share the plan, board and memory, and hand work off. Humans approve risky actions.

The host's hub listens on your local network (`0.0.0.0:7420`) so teammates can reach it. It speaks plain HTTP: use it on a trusted network or a tailnet, or put it behind TLS and set `MURMUR_PUBLIC_URL`. Set `MURMUR_HOST=127.0.0.1` to keep it to this machine. Other settings: `MURMUR_NO_OPEN=1` (do not open the browser), `MURMUR_PORT`, `MURMUR_DATA` (hub data, default `~/.murmur/hub`).

The old split commands still work: `npm run hub` for a hub only, and `node src/cli.ts login|bind|start|doctor` for a node.

## Limits (deliberate, see build-spec Rulings)

- The capability classifier is a speed bump, not a sandbox.
- No `hub-git` mode, keychain storage, Docker image or service installer yet.
- The node outbox is in memory only.
- Takeover never moves Claude session data between accounts. Only the git snapshot, the plan and a text brief move.

MIT licence.
