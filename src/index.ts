import type { Plugin, PluginModule, PluginOptions } from "@opencode-ai/plugin"

export type SessionStartOptions = {
  enabled?: boolean
  verbosity?: "silent" | "normal" | "debug"
  injectOutputToAgentSession?: boolean
  /** package.json script to run. Default: "dev:start". */
  script?: string
  /** Package runner used to run the script. Default: "bun". */
  runner?: string
  /** Full command override. When set, no package.json script lookup happens. */
  command?: string[]
  /** Show a user-visible TUI toast. Default: "error". */
  toastOutputInTui?: "never" | "error" | "always"
}

const server: Plugin = async ({ client, directory }, rawOptions: PluginOptions = {}) => {
  const options = rawOptions as SessionStartOptions
  const enabled = options.enabled !== false
  const verbosity = ["silent", "normal", "debug"].includes(options.verbosity ?? "")
    ? (options.verbosity ?? "normal")
    : "normal"
  const injectOutputToAgentSession = options.injectOutputToAgentSession === true
  const script = typeof options.script === "string" && options.script ? options.script : "dev:start"
  const runner = typeof options.runner === "string" && options.runner ? options.runner : "bun"
  const commandOverride =
    Array.isArray(options.command) && options.command.length > 0
      ? options.command.filter((entry): entry is string => typeof entry === "string")
      : undefined
  const command = commandOverride ?? [runner, "run", script]
  const label = command.join(" ")
  const toastMode = ["never", "error", "always"].includes(options.toastOutputInTui ?? "")
    ? (options.toastOutputInTui ?? "error")
    : "error"
  const started = new Set<string>()
  const startupBySession = new Map<string, Promise<string | undefined>>()

  const log = (level: "debug" | "info" | "error", message: string, directory: string) => {
    if (verbosity === "silent" || (level === "debug" && verbosity !== "debug")) return
    try {
      void client.app
        .log({
          body: { service: "opencode-session-start", level, message },
          query: { directory },
        })
        .catch(() => {})
    } catch {}
  }

  const toast = (message: string, variant: "success" | "error", directory: string) => {
    if (toastMode === "never" || (toastMode === "error" && variant !== "error")) return
    try {
      void client.tui
        .showToast({
          body: { title: "session-start", message, variant },
          query: { directory },
        })
        .catch(() => {})
    } catch {}
  }

  const start = async (directory: string) => {
    try {
      if (!commandOverride) {
        const packageFile = Bun.file(`${directory}/package.json`)
        if (!(await packageFile.exists())) {
          log("debug", `No package.json in ${directory}`, directory)
          return
        }

        const packageJson = (await packageFile.json()) as { scripts?: Record<string, unknown> }
        if (typeof packageJson.scripts?.[script] !== "string") {
          log("debug", `No ${script} script in ${directory}`, directory)
          return
        }
      }

      log("debug", `Running ${label} in ${directory}`, directory)
      const process = Bun.spawn(command, {
        cwd: directory,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ])
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")
      const summary = `${label} exited with code ${exitCode}`

      if (exitCode === 0) {
        log("info", summary, directory)
        toast(summary, "success", directory)
      } else {
        log("error", `${summary}${output ? `: ${output}` : ""}`, directory)
        toast(`${summary}${output ? `\n${output}` : ""}`, "error", directory)
      }

      return `[opencode-session-start] ${summary}${output ? `\n${output}` : ""}`
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log("error", `Failed to run ${label}: ${message}`, directory)
      toast(`Failed to run ${label}: ${message}`, "error", directory)
      return undefined
    }
  }

  const ensureStarted = (sessionID: string, sessionDirectory: string) => {
    const existing = startupBySession.get(sessionID)
    if (existing) return existing
    if (!enabled || started.has(sessionID)) return

    started.add(sessionID)
    const startup = start(sessionDirectory)
    startupBySession.set(sessionID, startup)
    return startup
  }

  return {
    event: async ({ event }) => {
      if (event.type !== "session.created") return

      const session = event.properties.info
      ensureStarted(session.id, session.directory)
    },
    "chat.message": async ({ sessionID }, output) => {
      const startup = ensureStarted(sessionID, directory)
      if (!startup) return

      const startupOutput = await startup
      if (startupBySession.get(sessionID) !== startup) return
      startupBySession.delete(sessionID)
      if (!injectOutputToAgentSession || !startupOutput) return
      output.parts.push({
        id: `prt_${crypto.randomUUID()}`,
        sessionID,
        messageID: output.message.id,
        type: "text",
        synthetic: true,
        text: startupOutput,
      })
    },
  }
}

export default {
  id: "opencode-session-start",
  server,
} satisfies PluginModule
