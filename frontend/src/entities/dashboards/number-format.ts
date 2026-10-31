import type { Cell } from "../queries/types.ts"
import type { NumberConfig } from "./types.ts"

/**
 * An exact decimal: units × 10^-scale. int8 and numeric values arrive as
 * strings of any length, so they are formatted from their digits, never
 * through a float.
 */
export interface Decimal {
  units: bigint
  scale: number
}

// Four-digit exponents cover MongoDB's Decimal128 (up to E+6144) and add at most 9,999 digits.
const NUMBER_TEXT = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,4}))?$/

const pow10 = (places: number) => 10n ** BigInt(places)

/** The exact value of a number or numeric string, or null for anything else (NaN and Infinity included). */
export function parseDecimal(cell: Cell): Decimal | null {
  let text = ""
  if (typeof cell === "number" && Number.isFinite(cell)) text = String(cell)
  else if (typeof cell === "string") text = cell.trim()
  const match = NUMBER_TEXT.exec(text)
  if (!match) return null
  const [, sign, whole = "", fraction = "", exponent = "0"] = match
  if (!whole && !fraction) return null
  const units = BigInt(`${whole}${fraction}`)
  const scale = fraction.length - Number(exponent)
  const value = scale >= 0 ? { units, scale } : { units: units * pow10(-scale), scale: 0 }
  return sign === "-" ? { ...value, units: -value.units } : value
}

/** Rounds half away from zero to `decimals` places, or pads to them. */
export function roundDecimal(value: Decimal, decimals: number): Decimal {
  if (value.scale <= decimals) return { units: value.units * pow10(decimals - value.scale), scale: decimals }
  const divisor = pow10(value.scale - decimals)
  const magnitude = value.units < 0n ? -value.units : value.units
  const quotient = magnitude / divisor + ((magnitude % divisor) * 2n >= divisor ? 1n : 0n)
  return { units: value.units < 0n ? -quotient : quotient, scale: decimals }
}

/** value × 10^places, exactly. */
export function shiftDecimal(value: Decimal, places: number): Decimal {
  const scale = value.scale - places
  return scale >= 0 ? { units: value.units, scale } : { units: value.units * pow10(-scale), scale: 0 }
}

export function subtractDecimal(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale)
  return { units: a.units * pow10(scale - a.scale) - b.units * pow10(scale - b.scale), scale }
}

/** (value − base) / |base| as a percentage rounded to one place, or null when base is zero. */
export function percentChange(value: Decimal, base: Decimal): Decimal | null {
  if (base.units === 0n) return null
  const scale = Math.max(value.scale, base.scale)
  const delta = subtractDecimal(value, base)
  const numerator = delta.units * pow10(scale - delta.scale) * 1_000n
  const denominator = (base.units < 0n ? -base.units : base.units) * pow10(scale - base.scale)
  const magnitude = numerator < 0n ? -numerator : numerator
  const tenths = magnitude / denominator + ((magnitude % denominator) * 2n >= denominator ? 1n : 0n)
  return { units: numerator < 0n ? -tenths : tenths, scale: 1 }
}

/** Every digit, grouped by thousands, without a sign: "1,234,567.890". Linear, so long numerics stay fast. */
function groupedDigits(value: Decimal): string {
  const digits = (value.units < 0n ? -value.units : value.units).toString().padStart(value.scale + 1, "0")
  const integer = digits.slice(0, digits.length - value.scale)
  const head = integer.length % 3 || 3
  const groups = [integer.slice(0, head)]
  for (let index = head; index < integer.length; index += 3) groups.push(integer.slice(index, index + 3))
  const whole = groups.join(",")
  const fraction = digits.slice(digits.length - value.scale)
  return fraction ? `${whole}.${fraction}` : whole
}

const AMOUNT_PARTS = new Set(["integer", "group", "decimal", "fraction"])

/** The text around an amount in a currency as en-US writes it, e.g. "-$" or "CHF ". */
function currencyAffixes(currency: string, negative: boolean): { prefix: string; suffix: string } {
  try {
    const parts = new Intl.NumberFormat("en-US", { style: "currency", currency }).formatToParts(
      negative ? -1 : 1,
    )
    const first = parts.findIndex((part) => AMOUNT_PARTS.has(part.type))
    const last = parts.findLastIndex((part) => AMOUNT_PARTS.has(part.type))
    const text = (from: number, to: number) =>
      parts
        .slice(from, to)
        .map((part) => part.value)
        .join("")
    return { prefix: text(0, first), suffix: text(last + 1, parts.length) }
  } catch {
    return { prefix: `${negative ? "-" : ""}${currency} `, suffix: "" }
  }
}

export type NumberStyle = Pick<NumberConfig, "format" | "decimals" | "currency">

/**
 * A value as a number panel writes it: percent values (ratios) times 100,
 * rounded only when decimals are set, grouped by thousands, with the
 * currency's symbol. `signed` adds "+" to positive values (for differences).
 */
export function formatDecimal(value: Decimal, style: NumberStyle, signed = false): string {
  let shown = style.format === "percent" ? shiftDecimal(value, 2) : value
  if (style.decimals !== null) shown = roundDecimal(shown, style.decimals)
  const negative = shown.units < 0n
  const plus = signed && shown.units > 0n ? "+" : ""
  const digits = groupedDigits(shown)
  if (style.format === "currency") {
    const { prefix, suffix } = currencyAffixes(style.currency ?? "USD", negative)
    return `${plus}${prefix}${digits}${suffix}`
  }
  const sign = negative ? "-" : plus
  return style.format === "percent" ? `${sign}${digits}%` : `${sign}${digits}`
}

export interface NumberDelta {
  /** value − comparison, written like the value with its sign. */
  text: string
  direction: "up" | "down" | "flat"
  /** The relative change ("+12.3%"); none for percent values or a zero comparison. */
  change: string | null
}

export type NumberDisplay =
  | { kind: "value"; text: string; exact: string; delta: NumberDelta | null }
  /** NULL or a missing field. */
  | { kind: "empty"; message: string }
  | { kind: "invalid"; message: string }

/** What a number panel shows for its value and optional comparison cell. */
export function describeNumber(
  value: Cell,
  comparison: Cell | undefined,
  config: NumberConfig,
): NumberDisplay {
  if (value === null || typeof value === "object") {
    return {
      kind: "empty",
      message: `No value: “${config.valueColumn}” is ${value === null ? "NULL" : "missing"}.`,
    }
  }
  const exact = parseDecimal(value)
  if (!exact) {
    const text = String(value)
    const shown = !text.trim() ? "empty" : text.length > 60 ? `${text.slice(0, 60)}…` : text
    return { kind: "invalid", message: `“${config.valueColumn}” is ${shown}, not a number.` }
  }
  const text = formatDecimal(exact, config)
  const base = comparison === undefined ? null : parseDecimal(comparison)
  let delta: NumberDelta | null = null
  if (base) {
    const difference = subtractDecimal(exact, base)
    const change = config.format === "percent" ? null : percentChange(exact, base)
    delta = {
      text: formatDecimal(difference, config, true),
      direction: difference.units > 0n ? "up" : difference.units < 0n ? "down" : "flat",
      change: change
        ? `${formatDecimal(change, { format: "number", decimals: 1, currency: null }, true)}%`
        : null,
    }
  }
  return { kind: "value", text, exact: String(value), delta }
}
