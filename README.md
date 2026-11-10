# raspberry-pi-connect-mcp

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent (Claude Code, Claude Desktop, or any MCP client)
shell access to your Raspberry Pi devices through the [Raspberry Pi Connect](https://connect.raspberrypi.com) web remote shell.

Raspberry Pi Connect has no public API for its remote shell, so this server drives the web UI with a headless Chrome:
it opens the device's remote-shell page, hooks the xterm.js terminal, types commands and reads the output back.
No SSH, port forwarding, VPN or public IP is needed. If the Pi shows up in Connect, the agent can use it.

> Unofficial project. Not affiliated with or endorsed by Raspberry Pi Ltd.

## Features
- Lists every device on your Connect account with online status and whether remote shell / screen sharing is allowed
- Runs a command and returns its **output and exit code**, using unique begin/end markers per call
- **Persistent sessions** per device: cwd, env vars and background jobs survive between calls
- Interactive programs: send raw keys (Ctrl-C, arrows, Enter) and read the screen
- Device allow-list (`RPI_CONNECT_ALLOW`) to limit which Pis the agent may use
- Fleet-friendly: one agent can work across many devices in parallel

## Requirements
- Node.js 18+
- A Raspberry Pi Connect account, with **remote shell** enabled on the devices you want to use
- Chrome for Testing (installed below; no sudo needed)

## Setup
```bash
git clone https://github.com/kritzerenkrieg/raspberry-pi-connect-mcp.git
cd raspberry-pi-connect-mcp
npm install
npx @puppeteer/browsers install chrome@stable --path ~/.cache/rpi-connect-mcp
npm run login        # a Chrome window opens: sign in by hand; it closes by itself once the device list loads
```
`npm run login` saves the session cookies to `~/.config/rpi-connect-mcp/session.json` (mode 600).
**Treat that file like a password.** Connect cookies are session-only, so run `npm run login` again when the tools report that the session expired.

Register the server with your MCP client. For Claude Code:
```bash
claude mcp add rpi-connect -- node /absolute/path/to/raspberry-pi-connect-mcp/src/server.js
```
Other clients (Claude Desktop, etc.):
```json
{
  "mcpServers": {
    "rpi-connect": {
      "command": "node",
      "args": ["/absolute/path/to/raspberry-pi-connect-mcp/src/server.js"],
      "env": { "RPI_CONNECT_ALLOW": "lab-pi,kiosk" }
    }
  }
}
```

## Tools
| Tool | What it does |
|---|---|
| `list_devices` | Devices on the account: id, name, client version, last seen, online, remote shell / screen sharing allowed |
| `run_command(device, command, timeout_sec=60)` | Run a bash command line; returns `{ device, exitCode, output }`. If it is still running at the timeout, returns `timedOut: true` and the partial output |
| `send_keys(device, keys)` | Send raw keystrokes (`\n`, `\t`, `\x03` Ctrl-C, `\x04` Ctrl-D, `\x1b[A` Up…); returns the screen |
| `read_screen(device, lines=0)` | Current terminal screen plus a little scrollback |
| `close_session(device)` | Close the shell session for a device |

`device` can be the exact name, a unique substring of the name, or the device UUID.
The first call to a device takes about 10 to 30 s while Connect sets up the WebRTC relay. Later calls reuse the session.

## Configuration
| Env var | Purpose |
|---|---|
| `RPI_CONNECT_ALLOW` | Comma-separated name substrings. Only matching devices can be used |
| `RPI_CONNECT_HEADED=1` | Show the browser window (debugging) |
| `RPI_CONNECT_CHROME` | Path to a Chrome binary |
| `RPI_CONNECT_SESSION` | Path to the saved session file |
| `RPI_CONNECT_PROFILE` | Chrome profile dir used by `login` |

## Tips
- Commands that prompt for input (sudo password, editors, `[Y/n]`) will time out in `run_command`. Use `send_keys` / `read_screen` for those, or pass `-y` style flags.
- For long jobs, start them with `nohup … &` and poll a log file instead of holding the call open.
- Large outputs go through the terminal. Pipe them through `head`, `tail` or `grep` to keep them small.

## Security
This hands an AI agent a real shell on your devices, with the privileges of the Connect user (often passwordless sudo).
- Use `RPI_CONNECT_ALLOW` to limit which devices the agent can use, and keep your MCP client's per-call approval prompts on
- Keep `session.json` private; anyone holding it can use your Connect account until the session expires
- The server does not try to evade bot detection. If Cloudflare challenges the session, sign in again by hand

## Development
`scripts/probe.js [url]` dumps the structure of a Connect page. `scripts/probe-shell.js <device>` inspects how the remote shell renders without typing anything.
Both are useful when Connect's UI changes and the selectors in `src/connect.js` need updating.

## License
MIT
