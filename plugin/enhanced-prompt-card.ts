// Enhanced Prompt Card — two reminders appended to the current user message of a
// top-level turn, in the request copy only.
//
// first ("每轮首次注入") lands on the first model call of a user turn.
// step  ("每步注入")     lands on every model call of that turn, first included.
//
// The plugin only intercepts and assembles. It adds no text of its own: an empty
// part means no content, and when no part applies `event.messages` is untouched.
//
// Nothing is persisted: the overlay is appended to a cloned copy of the user
// message in `event.messages`, never to the stored prompt, never as a second user
// message, and never after assistant/tool output.
//
// Failure policy: fail open. Any unexpected error means "no injection".

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const CONFIG_PATH = join(homedir(), ".config/opencode/enhanced-prompt-card.json")
const MODELS_CACHE_PATH = join(homedir(), ".config/opencode/enhanced-prompt-card-models.json")
const MODELS_SOURCE_PATH = join(homedir(), ".cache/opencode/models.json")
const OPENCODE_CONFIG_PATH = join(homedir(), ".config/opencode/opencode.json")

const SESSION_TTL_MS = 60_000
const TURN_TTL_MS = 10 * 60_000

const LEGACY_MARKERS = ["[本轮提醒]", "[本轮意图]"]

// OpenCode projects a compaction summary into a plain `role: "user"` message
// whose content starts with this tag. It is not a prompt and carries its own ID,
// so it must never be overlaid or mistaken for a new turn.
const CHECKPOINT_PREFIX = "<conversation-checkpoint>"

type Part = {
  enabled: boolean
  agents: string[]
  text: string
}

type FirstPart = Part & { models: string[] }

type Config = {
  enabled: boolean
  first: FirstPart
  step: Part
  logging: { enabled: boolean; path: string }
}

type TurnState = {
  messageID: string
  firstPending: boolean
  ts: number
  model: string
}

const turns = new Map<string, TurnState>()
const sessionCache = new Map<string, { main: boolean; agent: string; ts: number }>()

let configCache: Config = emptyConfig()
let configMtime = -1

// No built-in content. The config file is the only source: a missing or broken
// file means "inject nothing", never a silent fallback to hardcoded text.
function emptyConfig(): Config {
  return {
    enabled: false,
    first: { enabled: false, agents: [], models: [], text: "" },
    step: { enabled: false, agents: [], text: "" },
    logging: { enabled: false, path: "" },
  }
}

function normalizeAgents(value: any): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const agent = String(item || "").trim().slice(0, 100)
    if (!agent || out.includes(agent)) continue
    out.push(agent)
    if (out.length >= 50) break
  }
  return out
}

function normalizeModels(value: any): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const model = String(item || "").trim().slice(0, 150)
    if (!model || out.includes(model)) continue
    out.push(model)
    if (out.length >= 50) break
  }
  return out
}

function normalizePart(raw: any, withModels = false): Part {
  const part: Part = { enabled: false, agents: [], text: "" }
  if (!raw || typeof raw !== "object") return part
  part.enabled = raw.enabled === true
  part.agents = normalizeAgents(raw.agents)
  part.text = typeof raw.text === "string" ? raw.text.trim() : ""
  if (withModels) (part as FirstPart).models = normalizeModels(raw.models)
  return part
}

function normalizeConfig(raw: any): Config {
  const cfg = emptyConfig()
  if (!raw || typeof raw !== "object") return cfg
  cfg.enabled = raw.enabled === true
  cfg.first = normalizePart(raw.first, true) as FirstPart
  cfg.step = normalizePart(raw.step)
  if (raw.logging && typeof raw.logging === "object") {
    cfg.logging.enabled = raw.logging.enabled === true
    cfg.logging.path = typeof raw.logging.path === "string" ? raw.logging.path : ""
  }
  return cfg
}

function loadConfig(): Config {
  try {
    const stat = statSync(CONFIG_PATH)
    if (stat.mtimeMs !== configMtime) {
      configCache = normalizeConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")))
      configMtime = stat.mtimeMs
    }
    return configCache
  } catch {
    // Missing or unreadable file: nothing to inject.
    configCache = emptyConfig()
    configMtime = -1
    return configCache
  }
}

// Write a compact catalog for the panel's model picker. OpenCode keeps the full
// catalog in a multi-megabyte cache, which is too large for the panel's file
// read limit; the plugin narrows it to the models enabled in opencode.json.
function syncModelCatalog(): void {
  try {
    const catalog = JSON.parse(readFileSync(MODELS_SOURCE_PATH, "utf8"))
    const config = JSON.parse(readFileSync(OPENCODE_CONFIG_PATH, "utf8"))
    const providers = Object.keys(config?.providers || {})
    if (!providers.length) return
    const models: Array<{ id: string; name: string; provider: string; providerName: string }> = []
    for (const provider of providers) {
      const entry = catalog?.[provider]
      const configured = config?.providers?.[provider]?.models
      if (!configured || typeof configured !== "object") continue
      for (const key of Object.keys(configured)) {
        const meta = entry?.models?.[key] || configured[key] || {}
        models.push({
          id: `${provider}/${key}`,
          name: String(meta?.name || key),
          provider,
          providerName: String(entry?.name || provider),
        })
      }
    }
    if (!models.length) return
    models.sort(
      (a, b) => a.providerName.localeCompare(b.providerName) || a.id.localeCompare(b.id),
    )
    writeFileSync(
      MODELS_CACHE_PATH,
      JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), models }) + "\n",
    )
  } catch {
    // The panel simply shows no options when the catalog cannot be built.
  }
}

function expandPath(path: string): string {
  const value = String(path || "")
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value
}

function logEvent(event: Record<string, unknown>): void {
  const cfg = loadConfig()
  if (!cfg.logging.enabled) return
  try {
    const path = expandPath(cfg.logging.path)
    if (!path) return
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(event) + "\n")
  } catch {
    // Diagnostics must never break a turn.
  }
}

function roleOf(message: any): string {
  return String(message?.role || message?.type || "")
}

function contentText(message: any): string {
  const content = message?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((part: any) => part && part.type === "text")
      .map((part: any) => String(part.text || ""))
      .join("\n")
  }
  return String(message?.text || "")
}

function isSynthetic(message: any): boolean {
  if (message?.synthetic === true) return true
  if (String(message?.type || "") === "synthetic") return true
  const text = contentText(message).trimStart()
  return text.startsWith("<system-reminder>") || text.startsWith(CHECKPOINT_PREFIX)
}

function isInjectedPart(part: any, snippets: string[]): boolean {
  const text = String(part?.text || "")
  if (!text) return false
  for (const marker of LEGACY_MARKERS) {
    if (text.includes(marker)) return true
  }
  const trimmed = text.trim()
  if (!trimmed) return false
  for (const snippet of snippets) {
    if (trimmed === snippet || trimmed.endsWith("\n" + snippet)) return true
  }
  if (snippets.length === 2 && trimmed === snippets[0] + "\n" + snippets[1]) return true
  return false
}

// Remove reminders left at the tail of a message by a previous run of this hook
// (retries and hot reloads can hand back an already overlaid copy). Nothing else
// is stripped.
function stripInjectedText(text: string, snippets: string[]): string {
  let out = String(text || "")
  for (const marker of LEGACY_MARKERS) {
    const index = out.indexOf("\n\n" + marker)
    if (index >= 0) out = out.slice(0, index)
  }
  const ordered = snippets.filter(Boolean).slice().sort((a, b) => b.length - a.length)
  for (let i = 0; i < 4; i++) {
    const trimmed = out.replace(/\s+$/, "")
    const hit = ordered.find((snippet) => trimmed.endsWith(snippet))
    if (!hit) break
    out = trimmed.slice(0, trimmed.length - hit.length).replace(/\s+$/, "")
  }
  return out
}

function withOverlay(message: any, overlay: string, snippets: string[]): any {
  const copy = { ...message }
  const content = message?.content

  if (Array.isArray(content)) {
    const parts = content.filter((part: any) => !isInjectedPart(part, snippets))
    const hasText = parts.some(
      (part: any) => part && part.type === "text" && String(part.text || "").trim(),
    )
    // Some projected messages carry text in `text` instead of a text part.
    if (!hasText && typeof message?.text === "string" && message.text.trim()) {
      parts.push({ type: "text", text: stripInjectedText(message.text, snippets) })
    }
    parts.push({ type: "text", text: overlay })
    copy.content = parts
    return copy
  }

  if (typeof content === "string") {
    copy.content = stripInjectedText(content, snippets) + "\n\n" + overlay
    return copy
  }

  if (typeof message?.text === "string") {
    copy.text = stripInjectedText(message.text, snippets) + "\n\n" + overlay
    return copy
  }

  copy.content = [{ type: "text", text: overlay }]
  return copy
}

function findCurrentUserIndex(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (roleOf(messages[i]) === "user") return i
  }
  return -1
}

function partText(part: Part, agent: string): string {
  if (!part.enabled) return ""
  if (!agent || !part.agents.includes(agent)) return ""
  return part.text.trim()
}

function modelMatches(part: FirstPart, model: string): boolean {
  if (!part.models.length) return true
  if (!model) return false
  const value = model.toLowerCase()
  return part.models.some((item) => {
    const wanted = item.toLowerCase()
    if (!wanted) return false
    if (value === wanted) return true
    // A bare model id may be configured without the provider prefix.
    if (!wanted.includes("/")) {
      const tail = value.includes("/") ? value.slice(value.indexOf("/") + 1) : value
      return tail === wanted
    }
    return false
  })
}

async function resolveModel(ctx: any, sessionID: string, event: any): Promise<string> {
  const candidates: any[] = []
  if (event?.model !== undefined) candidates.push(event.model)
  if (event?.modelID || event?.providerID) candidates.push(event)
  try {
    candidates.push(await ctx.session.get({ sessionID }))
  } catch {
    // Model is optional; first just will not match a configured list.
  }
  for (const item of candidates) {
    if (!item) continue
    if (typeof item === "string") {
      const text = item.trim()
      if (text) return text
      continue
    }
    const nested = item.model && typeof item.model === "object" ? item.model : null
    const provider = String(
      item.providerID || nested?.providerID || item.provider?.id || item.provider || "",
    ).trim()
    const model = String(
      nested?.modelID || nested?.id || item.modelID || (provider && typeof item.id === "string" ? item.id : ""),
    ).trim()
    if (provider && model) return `${provider}/${model}`
    if (model) return model
  }
  return ""
}

async function resolveSession(
  ctx: any,
  sessionID: string,
  hintAgent: string,
): Promise<{ main: boolean; agent: string } | null> {
  const now = Date.now()
  const cached = sessionCache.get(sessionID)
  if (cached && now - cached.ts < SESSION_TTL_MS) {
    return { main: cached.main, agent: hintAgent || cached.agent }
  }
  let info: any = null
  try {
    info = await ctx.session.get({ sessionID })
  } catch {
    return null
  }
  if (!info) return null
  const agent = String(info.agent || hintAgent || "")
  const main = !info.parentID
  sessionCache.set(sessionID, { main, agent, ts: now })
  return { main, agent: hintAgent || agent }
}

async function onPrompt(ctx: any, event: any): Promise<void> {
  try {
    const cfg = loadConfig()
    if (!cfg.enabled) return

    const sessionID = String(
      event?.sessionID || event?.session?.id || event?.message?.sessionID || "",
    )
    const messageID = String(event?.messageID || event?.message?.id || "")
    if (!sessionID) return

    const session = await resolveSession(ctx, sessionID, "")
    if (!session || !session.main) return

    const agent = session.agent
    const hasFirst = !!partText(cfg.first, agent)
    const hasStep = !!partText(cfg.step, agent)
    if (!hasFirst && !hasStep) return

    // A new prompt starts a new turn; the first model call of that turn carries
    // the "first" reminder once.
    const model = await resolveModel(ctx, sessionID, event)
    turns.set(sessionID, { messageID, firstPending: true, ts: Date.now(), model })
  } catch {
    // Never block the prompt.
  }
}

async function onContext(ctx: any, event: any): Promise<void> {
  try {
    const cfg = loadConfig()
    if (!cfg.enabled) return

    const sessionID = String(event?.sessionID || "")
    const messages = Array.isArray(event?.messages) ? event.messages : null
    if (!sessionID || !messages || messages.length === 0) return

    const session = await resolveSession(ctx, sessionID, String(event?.agent || ""))
    if (!session || !session.main) return
    const agent = session.agent

    const last = messages[messages.length - 1]
    // Plan mode appends a synthetic <system-reminder> as a user message after the
    // assistant reply. It is not a new user turn; never overlaid.
    if (isSynthetic(last)) return

    const userIndex = findCurrentUserIndex(messages)
    if (userIndex < 0) return

    // A compaction checkpoint is projected as a plain user message with its own
    // ID. Skip it entirely: injecting here reads as a brand-new question and
    // breaks the continuity of the turn being compacted.
    if (isSynthetic(messages[userIndex])) return

    const currentID = String(messages[userIndex]?.id || "")
    const state = turns.get(sessionID)

    // The only user message allowed to receive reminders is the one the prompt
    // hook registered for this turn. A different ID means a compaction summary
    // (whatever format the model produced) or a prompt this process never saw:
    // stay out of it instead of mistaking it for a new question.
    if (!state || !state.messageID || !currentID || state.messageID !== currentID) return

    const firstPending = state.firstPending && Date.now() - state.ts <= TURN_TTL_MS
    const firstAllowed = !!partText(cfg.first, agent) && modelMatches(cfg.first, state.model)
    const isFirst = firstPending && firstAllowed

    // The first call of a turn is spent even when the model does not match:
    // a mid-turn model switch must not make first appear on a later call.
    if (firstPending && !firstAllowed) {
      turns.set(sessionID, { ...state, firstPending: false, ts: Date.now() })
    }

    const firstText = partText(cfg.first, agent)
    const stepText = partText(cfg.step, agent)
    const segments: string[] = []
    if (isFirst && firstText) segments.push(firstText)
    if (stepText) segments.push(stepText)

    // The plugin only assembles what the config gives it. Nothing to say means
    // no touch at all: no clone, no marker, no empty line.
    if (segments.length === 0) return

    const overlay = segments.join("\n")
    const snippets = [firstText, stepText].filter(Boolean)
    let error: string | null = null

    try {
      const next = messages.slice()
      next[userIndex] = withOverlay(messages[userIndex], overlay, snippets)
      event.messages = next

      // Consume the first flag only after the request copy was accepted, so a
      // retry after a failed injection can still carry it.
      if (isFirst) {
        turns.set(sessionID, {
          messageID: currentID || state?.messageID || "",
          firstPending: false,
          ts: Date.now(),
          model: state.model,
        })
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }

    if (isFirst) {
      logEvent({
        ts: new Date().toISOString(),
        sessionID,
        agent,
        injectedFirst: !!firstText && !error,
        injectedStep: !!stepText && !error,
        error,
      })
    }
  } catch {
    // Fail open.
  }
}

export default {
  id: "enhanced-prompt-card",
  async setup(ctx: any) {
    syncModelCatalog()
    await ctx.session.hook("prompt", (event: any) => onPrompt(ctx, event))
    await ctx.session.hook("context", (event: any) => onContext(ctx, event))
  },
}
