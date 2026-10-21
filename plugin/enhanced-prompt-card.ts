// Enhanced Prompt Card — one persisted discipline reminder plus one temporary
// first-turn reminder, top-level turns only.
//
// step  ("每步注入")   is appended to the canonical user input by the prompt
// hook, so it is stored in history and every model call of the turn sees it.
// first ("每轮首次注入") is appended to the request copy only, on the turn's
// first model call; it is never persisted.
//
// Nothing else is touched: tool results, subagent messages and compaction
// checkpoints are left alone. An empty part means no content.
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

// Write a compact catalog for the panel's model picker. Prefer the runtime
// provider list (the same source OpenCode's own model picker uses); fall back
// to the models enabled in opencode.json when the runtime API is unavailable.
async function syncModelCatalog(ctx: any): Promise<void> {
  try {
    const runtime = await fetchRuntimeModels(ctx)
    if (runtime) {
      const names = await providerNames(ctx)
      const models = modelsFromRuntime(runtime, names)
      if (models.length) {
        writeModels(models, "runtime")
        return
      }
    }
  } catch {
    // Fall through to the config file.
  }
  try {
    const catalog = JSON.parse(readFileSync(MODELS_SOURCE_PATH, "utf8"))
    const config = JSON.parse(readFileSync(OPENCODE_CONFIG_PATH, "utf8"))
    const providers = Object.keys(config?.providers || {})
    if (!providers.length) return
    const models: ModelEntry[] = []
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
    writeModels(models, "config")
  } catch {
    // The panel simply shows no options when the catalog cannot be built.
  }
}

async function fetchRuntimeModels(ctx: any): Promise<any[] | null> {
  try {
    const result = await ctx?.model?.list?.()
    const body = result?.data ?? result
    if (Array.isArray(body) && body.length) return body
  } catch {
    // Fall back to the config file.
  }
  return null
}

async function providerNames(ctx: any): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  try {
    const result = await ctx?.provider?.list?.()
    const body = result?.data ?? result
    if (Array.isArray(body)) {
      for (const provider of body) {
        names.set(String(provider?.id || ""), String(provider?.name || provider?.id || ""))
      }
    }
  } catch {
    // Provider names are cosmetic.
  }
  return names
}

type ModelEntry = { id: string; name: string; provider: string; providerName: string }

function modelsFromRuntime(list: any[], names: Map<string, string>): ModelEntry[] {
  const seen = new Set<string>()
  const models: ModelEntry[] = []
  for (const item of list) {
    if (item?.enabled === false) continue
    const providerID = String(item?.providerID || item?.provider?.id || "")
    const modelID = String(item?.modelID || item?.id || "")
    if (!providerID || !modelID) continue
    const id = `${providerID}/${modelID}`
    if (seen.has(id)) continue
    seen.add(id)
    models.push({
      id,
      name: String(item?.name || modelID),
      provider: providerID,
      providerName: names.get(providerID) || providerID,
    })
  }
  return models
}

function writeModels(models: ModelEntry[], source: "runtime" | "config"): void {
  models.sort((a, b) => a.providerName.localeCompare(b.providerName) || a.id.localeCompare(b.id))
  writeFileSync(
    MODELS_CACHE_PATH,
    JSON.stringify({ version: 1, source, generatedAt: new Date().toISOString(), models }) + "\n",
  )
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

// Append the first reminder to the request copy while keeping the persisted
// step text intact. Only a previous first append is removed; the user's own
// text and the stored step reminder are never dropped.
function withFirst(message: any, firstText: string): any {
  const copy = { ...message }
  const content = message?.content

  const stripTail = (text: string): string => {
    const value = String(text || "")
    const trimmed = value.replace(/\s+$/, "")
    if (trimmed === firstText) return ""
    if (trimmed.endsWith("\n" + firstText)) {
      return trimmed.slice(0, trimmed.length - firstText.length).replace(/\s+$/, "")
    }
    return value
  }

  if (Array.isArray(content)) {
    const parts = content.filter(
      (part: any) => !(part?.type === "text" && String(part?.text || "").trim() === firstText),
    )
    const last = parts[parts.length - 1]
    if (last?.type === "text" && typeof last.text === "string") {
      const stripped = stripTail(last.text)
      if (stripped !== last.text) parts[parts.length - 1] = { ...last, text: stripped }
    }
    parts.push({ type: "text", text: firstText })
    copy.content = parts
    return copy
  }

  if (typeof content === "string") {
    const base = stripTail(content)
    copy.content = base ? `${base}\n\n${firstText}` : firstText
    return copy
  }

  if (typeof message?.text === "string") {
    const base = stripTail(message.text)
    copy.text = base ? `${base}\n\n${firstText}` : firstText
    return copy
  }

  copy.content = [{ type: "text", text: firstText }]
  return copy
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

function modelFromEvent(event: any): string {
  const value = event?.model
  if (typeof value === "string") {
    const text = value.trim()
    if (text) return text
  }
  if (value && typeof value === "object") {
    const provider = String(value.providerID || value.provider?.id || value.provider || "").trim()
    const model = String(value.modelID || value.id || "").trim()
    if (provider && model) return `${provider}/${model}`
    if (model) return model
  }
  const provider = String(event?.providerID || "").trim()
  const model = String(event?.modelID || "").trim()
  if (provider && model) return `${provider}/${model}`
  if (model) return model
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

    const session = await resolveSession(ctx, sessionID, String(event?.agent || ""))
    if (!session || !session.main) return

    const agent = session.agent
    const firstText = partText(cfg.first, agent)
    const stepText = partText(cfg.step, agent)
    if (!firstText && !stepText) return

    const prompt = event?.prompt
    const synthetic =
      event?.synthetic === true ||
      prompt?.synthetic === true ||
      event?.message?.synthetic === true ||
      String(event?.type || "") === "synthetic"
    if (synthetic) return

    // Step is persisted into the canonical user input by this prompt hook, so
    // every later model call sees it in history without touching tool results.
    let persistedStep = false
    let persistReason = "no-prompt-text"
    if (stepText) {
      if (prompt && typeof prompt.text === "string") {
        const base = prompt.text.replace(/\s+$/, "")
        if (base.endsWith(stepText)) {
          persistReason = "already-present"
        } else {
          prompt.text = base ? `${base}\n\n${stepText}` : stepText
          persistedStep = true
          persistReason = "appended"
        }
      }
    } else {
      persistReason = "no-step"
    }

    if (firstText && messageID) {
      turns.set(sessionID, { messageID, firstPending: true, ts: Date.now() })
    }

    logEvent({
      ts: new Date().toISOString(),
      kind: "prompt",
      sessionID,
      agent,
      messageID,
      persistedStep,
      persistReason,
      injectedFirst: false,
      injectedStep: persistedStep,
      error: null,
    })
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

    const state = turns.get(sessionID)
    if (!state || !state.firstPending) return
    if (Date.now() - state.ts > TURN_TTL_MS) {
      turns.set(sessionID, { ...state, firstPending: false })
      return
    }

    // Anchor by the prompt hook's message ID, never by "the last user message".
    // Plan reminders, checkpoints and subagent messages can trail the prompt and
    // must not change where first is applied.
    const anchorIndex = messages.findIndex(
      (message: any) => String(message?.id || "") === state.messageID,
    )
    if (anchorIndex < 0) return

    const anchor = messages[anchorIndex]
    if (roleOf(anchor) !== "user" || isSynthetic(anchor)) return

    const firstText = partText(cfg.first, agent)
    if (!firstText) {
      turns.set(sessionID, { ...state, firstPending: false })
      return
    }

    // First belongs to the turn's first model call. Retries and repeated
    // assemblies before any assistant step keep it; once this turn has an
    // assistant message, first is spent. Subagent sessions never reach here.
    const assistantAfter = messages
      .slice(anchorIndex + 1)
      .some((message: any) => roleOf(message) === "assistant")
    if (assistantAfter) {
      turns.set(sessionID, { ...state, firstPending: false })
      return
    }

    let model = modelFromEvent(event)
    if (cfg.first.models.length && (!model || !modelMatches(cfg.first, model))) {
      logEvent({
        ts: new Date().toISOString(),
        kind: "first",
        sessionID,
        agent,
        messageID: state.messageID,
        model,
        injectedFirst: false,
        injectedStep: false,
        reason: model ? "model-mismatch" : "no-model",
        error: null,
      })
      return
    }

    let error: string | null = null
    try {
      const next = messages.slice()
      next[anchorIndex] = withFirst(anchor, firstText)
      event.messages = next
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }

    logEvent({
      ts: new Date().toISOString(),
      kind: "first",
      sessionID,
      agent,
      messageID: state.messageID,
      model,
      injectedFirst: !error,
      injectedStep: false,
      reason: error ? "write-error" : "injected",
      error,
    })
  } catch {
    // Fail open.
  }
}

export default {
  id: "enhanced-prompt-card",
  async setup(ctx: any) {
    await syncModelCatalog(ctx)
    await ctx.session.hook("prompt", (event: any) => onPrompt(ctx, event))
    await ctx.session.hook("context", (event: any) => onContext(ctx, event))
  },
}
