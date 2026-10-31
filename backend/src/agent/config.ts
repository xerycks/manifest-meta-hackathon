import Anthropic from "@anthropic-ai/sdk"

import type { Env } from "../config/env.js"
import { AnthropicProvider } from "./anthropic.js"
import { createDemoModel } from "./demo-model.js"
import type { ModelProvider } from "./provider.js"
import type { AgentLimits } from "./service.js"

/**
 * The configured model provider, or null when none is usable (no API key):
 * the agent endpoints then answer 503. The scripted demo model never runs in
 * production (configuration refuses it there).
 */
export function createModelProvider(env: Env): ModelProvider | null {
  if (env.AGENT_PROVIDER === "scripted") return env.NODE_ENV === "production" ? null : createDemoModel()
  if (!env.ANTHROPIC_API_KEY) return null
  return new AnthropicProvider(env.AGENT_MODEL, new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }))
}

export function agentLimits(env: Env): AgentLimits {
  return { maxSteps: env.AGENT_MAX_STEPS, runTimeoutMs: env.AGENT_RUN_TIMEOUT_MS }
}
