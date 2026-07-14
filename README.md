# opencode-session-start

OpenCode plugin that runs `bun run dev:start` once per session in each plugin/directory-instance activation when the
session directory's `package.json` defines that script. Projects without the script are left untouched.

The lookup uses the session's exact directory; it does not walk up to a parent `package.json`. `dev:start` must
terminate promptly. Use it to start or signal long-running work through a supervisor or background manager rather than
running a foreground dev server, which would keep the first prompt waiting indefinitely.

For example, Rift Command delegates its long-running dev server to a user service, so its launcher returns promptly:

```json
{
  "scripts": {
    "dev:start": "systemctl --user start app-name.service"
  }
}
```

## Lifecycle and session behavior

OpenCode resolves this npm package's `main` entry (`./src/index.ts`) and asks Bun to import it dynamically. This plugin
exports an `id`. With tuple configuration, OpenCode passes the tuple's object to the plugin's
`server(input, options)` function.

Plugin initialization happens once per OpenCode directory instance. This plugin's session and startup tracking uses
in-memory `Set` and `Map` state, so it is local to that instance and process and lasts only until the instance is
disposed or the process exits. Separate OpenCode processes can therefore start the same project independently.

For each session:

- Every newly created session starts `dev:start` once, including root, forked, child, and subagent sessions.
- Existing or resumed root and child sessions do not emit `session.created`. Their first user message during the current
  plugin/directory-instance activation starts and awaits `dev:start`.
- Creating a session without sending a message still starts the command. Output injection, if enabled, waits for that
  session's first user message.
- Later messages in the same activation neither rerun startup nor receive its output again.
- Different session IDs are tracked independently.

OpenCode dispatches `session.created` hooks without awaiting them. The plugin immediately records the resulting startup
promise. OpenCode awaits `chat.message` hooks before persisting the user message, so an immediate first message awaits
the same run and can receive the synthetic output part without starting a duplicate. Startup failure does not fail the
first prompt.

Passive viewing or loading of an existing session cannot trigger startup: an OpenCode server plugin receives neither a
`session.created` event nor a `chat.message` hook merely because a session is opened. Startup occurs when that existing
session's first message is sent. Switching away from and back to a session in the same backend instance does not rerun
startup. After the plugin instance or backend restarts, in-memory tracking is empty, so the first message sent to an
existing session runs startup again. Multiple OpenCode processes maintain independent state and may each run startup
for the same session.

## Install

The commands below add this package's npm identifier as a string entry while preserving other entries in the `plugin`
array.

Install globally:

```bash
opencode plugin opencode-session-start --global
```

This writes the global configuration at `~/.config/opencode/opencode.json` or
`~/.config/opencode/opencode.jsonc`.

Install for the project from the target project's directory:

```bash
opencode plugin opencode-session-start
```

This writes configuration under `.opencode` in the project worktree. It reuses an existing `opencode.json` or
`opencode.jsonc` there, preferring JSON if both exist, and otherwise creates `opencode.json`.

No build or `bun install` step is required to install or load this package.

## Manual configuration

Add the package identifier to the appropriate global or project `plugin` array. OpenCode also reads project configuration from a
root-level `opencode.json` or `opencode.jsonc`. Keep every existing plugin entry:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    // Existing plugin entries remain here.
    "opencode-session-start",
  ],
}
```

The CLI also adds a string entry. To set options, replace only this plugin's string with a tuple:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    // Existing plugin entries remain here.
    [
      "opencode-session-start",
      {
        "enabled": true,
        "verbosity": "normal",
        "injectOutput": false,
      },
    ],
  ],
}
```

Options:

- `enabled`: enables startup behavior. Default: `true`.
- `verbosity`: `silent` writes no OpenCode logs, `normal` logs completion and errors, and `debug` also logs skipped
  projects and command startup. Allowed values: `silent`, `normal`, or `debug`. Default: `normal`.
- `injectOutput`: appends a synthetic text part containing the exit code and captured stdout/stderr to the first user
  message that consumes startup output. It does not create another message or model turn. Default: `false`.

The first message associated with startup waits for `dev:start` whether output injection is enabled or disabled. Output
is captured in memory, so launcher commands should keep stdout and stderr concise.

## Validate configuration

Run validation from the project whose effective configuration you want to inspect:

```bash
opencode --pure debug config
```

This skips external plugin loading and checks configuration schema and resolution without plugin bootstrap side
effects. To resolve and load plugins as well, run:

```bash
opencode debug config
```

The second command can trigger plugin bootstrap side effects. Inspect its output and OpenCode logs rather than relying
only on a successful exit code, because some plugin load failures may be skipped.

## Restart requirements

Fully restart the OpenCode backend after changing configuration or options, adding or removing the plugin, updating the
checkout, or editing its TypeScript source. There is no filesystem watcher that reliably reloads these changes. Opening
a new tab or session is not sufficient.

## Update safely

Update the package version in the relevant plugin entry without adding another entry. Validate the effective
configuration, then fully restart the OpenCode backend.

## Remove safely

There is no remove command in the inspected OpenCode version. Remove this plugin's string or tuple from the relevant
`plugin` array without removing other entries, validate the configuration, and fully restart the OpenCode backend.

## Development

Install development dependencies and run the existing checks:

```bash
bun install
bun run typecheck
bun run check
bun test
```

This package intentionally exposes its TypeScript source, so development does not require a build step. After source
changes, fully restart the OpenCode backend before testing the plugin.
