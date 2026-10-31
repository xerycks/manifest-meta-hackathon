import { z } from "zod"

import type { WorkspaceSettingsRepository } from "./repository.js"

/** The workspace setting that holds its IANA time zone, e.g. "Europe/Berlin". */
export const TIME_ZONE_SETTING = "timezone"
export const DEFAULT_TIME_ZONE = "UTC"

/** Whether Intl knows the name as a time zone (IANA names and their aliases). */
export function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name })
    return true
  } catch {
    return false
  }
}

export const timeZoneSchema = z
  .string()
  .trim()
  .min(1, "Choose a time zone")
  .max(64)
  .refine(isTimeZone, "Use an IANA time zone name, such as Europe/Berlin or America/New_York")

/** The workspace's time zone, UTC until an owner or admin sets one. */
export async function workspaceTimeZone(
  settings: WorkspaceSettingsRepository,
  workspaceId: string,
): Promise<string> {
  const stored = await settings.get(workspaceId, TIME_ZONE_SETTING)
  const parsed = timeZoneSchema.safeParse(stored?.value)
  return parsed.success ? parsed.data : DEFAULT_TIME_ZONE
}
