# SSH auto-reconnect verification

This report records a real [Pi coding agent](https://pi.dev/) session against a local OpenSSH server. The session used this package from source, dropped the SSH server so the extension observed a transport close, restored the server, and confirmed automatic reconnect without `/ssh-reconnect`.

All times below are in Asia/Shanghai (UTC+8). The raw driver summary is in [verification-ssh-reconnect.summary.json](./verification-ssh-reconnect.summary.json). The full RPC trace is at `/workspace/pi-ssh-remote-verify/logs/pi-rpc.jsonl` on the machine that ran the test.

## Result

Passed. Automatic reconnect happened 2.107 seconds after sshd was restored, which matches the test policy of a 2 second initial delay and no jitter. `/ssh-reconnect` still retried immediately. `/ssh-exit` did not start another reconnect.

## Environment

| Item | Value |
| --- | --- |
| Package | `@8yy6xg/pi-ssh-remote` 0.7.0, loaded from `/workspace/pi-ssh-remote/index.ts` |
| Pi CLI | `@earendil-works/pi-coding-agent` 1.6.1 (`pi --version`) |
| SSH server | OpenSSH_10.0p2, `127.0.0.1:22222` |
| Remote account | disposable `pisshverify`, key-only auth |
| Remote cwd | `/home/pisshverify/workspace` |
| Transport | OpenSSH multiplexed (explicit `--ssh-transport openssh`) |
| Test policy | `enabled: true`, `initialDelayMs: 2000`, `multiplier: 2`, `maxDelayMs: 30000`, `maxAttempts: 0`, `jitter: "none"` |

The driver isolated Pi state with `PI_CODING_AGENT_DIR=/workspace/pi-ssh-remote-verify/agent` and started:

```bash
pi --mode rpc --no-session --no-extensions --no-mcp --no-skills \
  --no-prompt-templates --no-themes --offline --approve \
  -e /workspace/pi-ssh-remote/index.ts \
  --ssh pi-ssh-verify:/home/pisshverify/workspace \
  --ssh-config /workspace/pi-ssh-remote-verify/sshd/ssh_config \
  --ssh-transport openssh
```

The first drop attempt that killed only the sshd master left forked session processes alive, so the ControlMaster stayed up. The successful run used `sudo fuser -k 22222/tcp` to stop the listener and every session child on that port.

## Timeline

1. **12:07:31.835** Notify: `SSH remote active: pi-ssh-verify:/home/pisshverify/workspace (unix/bash; OpenSSH/multiplexed)`. Footer: `SSH: Connected`. Initial connect took 904 ms after process start.
2. **12:07:31.860** RPC `bash` succeeded on the remote host:

   ```text
   pi-ssh-remote-verify-ok
   /home/pisshverify/workspace
   USER=pisshverify
   ```

3. **12:07:31.860** Stopped sshd on port 22222.
4. **12:07:31.937** Notify: `SSH connection lost: OpenSSH ControlMaster closed (255): Connection to 127.0.0.1 closed by remote host.. Reconnecting automatically.` Footer: `SSH: Reconnecting in 2s (#1)`.
5. **12:07:31.953** RPC `bash` failed closed:

   ```text
   SSH remote is unavailable: OpenSSH ControlMaster closed (255): Connection to 127.0.0.1 closed by remote host.
   ```

   No `/ssh-reconnect` was sent.
6. **12:07:31.954** Restored sshd. Port 22222 was listening again.
7. **12:07:33.937** Footer: `SSH: Reconnecting (#1)`. This is 2.000 seconds after the loss, matching the configured delay.
8. **12:07:34.051** Notify: `SSH remote active: ... (unix/bash; OpenSSH/multiplexed)` again. Footer: `SSH: Connected`. Automatic reconnect completed 2.107 seconds after sshd was restored.
9. **12:07:34.084** RPC `bash` succeeded again and read `pi-ssh-remote-verify-ok` from `/home/pisshverify/workspace`.
10. Dropped sshd a second time. Footer returned to `SSH: Reconnecting in 2s (#1)` at **12:07:34.156**. Restored sshd, then sent `/ssh-reconnect` at **12:07:34.177**. The session was connected again at **12:07:34.286**, 109 ms after the command, without waiting the 2 second automatic delay.
11. RPC `bash` printed `after-manual` from `/home/pisshverify/workspace`.
12. `/ssh-exit` at **12:07:34.301** notified `Local workspace active: /workspace/pi-ssh-remote-verify/local` and cleared the footer. No later automatic reconnect appeared in the following 5 seconds.

## Unit tests

```bash
cd /workspace/pi-ssh-remote
bun install
bun run build
bun run lint
bun run test:unit
```

The unit run on this tree was 159 passed, 5 skipped, 0 failed. Skipped tests are existing cases that need an optional Windows SSH host or similar external conditions.

## Notes

The live-test notify text ended with `host.. Reconnecting` because the transport error already ended in a period. The source now strips a trailing period before adding `. Reconnecting automatically.` That punctuation change was not re-run against live sshd.

Default production jitter is `full`, so the first automatic delay is a random value in `[0, initialDelayMs]`. This live run set `jitter` to `none` so the 2 second wait was measurable.

The disposable Unix account `pisshverify` and the helper tree `/workspace/pi-ssh-remote-verify` remain on the machine that ran the test. They are not part of the package.
