import type { Plugin, PluginModule, PluginOptions } from "@opencode-ai/plugin"

export type SessionStartOptions = {
  enabled?: boolean
  verbosity?: "silent" | "normal" | "debug"
  injectOutput?: boolean
}

const server: Plugin = async ({ client, directory }, rawOptions: PluginOptions = {}) => {
  const options = rawOptions as SessionStartOptions
  const enabled = options.enabled !== false
  const verbosity = ["silent", "normal", "debug"].includes(options.verbosity ?? "")
    ? (options.verbosity ?? "normal")
    : "normal"
  const injectOutput = options.injectOutput === true
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

  const start = async (directory: string) => {
    try {
      const packageFile = Bun.file(`${directory}/package.json`)
      if (!(await packageFile.exists())) {
        log("debug", `No package.json in ${directory}`, directory)
        return
      }

      const packageJson = (await packageFile.json()) as { scripts?: Record<string, unknown> }
      if (typeof packageJson.scripts?.["dev:start"] !== "string") {
        log("debug", `No dev:start script in ${directory}`, directory)
        return
      }

      log("debug", `Running bun run dev:start in ${directory}`, directory)
      const process = Bun.spawn(["bun", "run", "dev:start"], {
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
      const summary = `bun run dev:start exited with code ${exitCode}`

      if (exitCode === 0) log("info", summary, directory)
      else log("error", `${summary}${output ? `: ${output}` : ""}`, directory)

      return `[opencode-session-start] ${summary}${output ? `\n${output}` : ""}`
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log("error", `Failed to run bun run dev:start: ${message}`, directory)
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
      if (!injectOutput || !startupOutput) return
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
