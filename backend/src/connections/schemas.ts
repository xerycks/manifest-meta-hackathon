import { isIPv6 } from "node:net"

import { z } from "zod"

export type Engine = "postgres" | "mongodb"
export type ConnectionStatus = "untested" | "connected" | "failed"

export const SSL_MODES = ["disable", "require", "verify-full"] as const

const hasNoControlChars = (value: string) => !/[\u0000-\u001f\u007f]/.test(value)

/** Host names and IP literals only, so a host can never smuggle a scheme, port, path, or socket. */
function isHost(value: string): boolean {
  return /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value) || isIPv6(value)
}

/** PostgreSQL reserves pg_* schemas; information_schema is the SQL-standard catalog. */
export function isSystemSchema(name: string): boolean {
  return name === "information_schema" || name.startsWith("pg_")
}

function identifier(label: string) {
  return z
    .string()
    .trim()
    .min(1, `Enter a ${label}`)
    .max(63, `The ${label} can be at most 63 characters`)
    .refine(hasNoControlChars, `The ${label} contains invalid characters`)
}

export const postgresConfigSchema = z.strictObject({
  host: z
    .string()
    .trim()
    .min(1, "Enter a host")
    .max(253)
    .refine(isHost, "Enter a host name or IP address without a scheme, port, or path"),
  port: z.number().int().min(1, "Enter a port from 1 to 65535").max(65_535, "Enter a port from 1 to 65535"),
  database: identifier("database name"),
  username: identifier("username"),
  sslMode: z.enum(SSL_MODES),
})

export type PostgresConfig = z.infer<typeof postgresConfigSchema>

const nameSchema = z.string().trim().min(1, "Enter a name").max(120)

/** An empty password means "none"; the value is never echoed in validation messages. */
const passwordSchema = z.string().max(1024, "The password is too long").optional()

const selectedSchemasSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(63)
      .refine(hasNoControlChars, "Schema names cannot contain control characters")
      .refine((name) => !isSystemSchema(name), "System schemas cannot be selected"),
  )
  .min(1, "Select at least one schema")
  .max(100, "Select at most 100 schemas")
  .transform((names) => [...new Set(names)].sort())

export const testConnectionSchema = z.strictObject({
  engine: z.literal("postgres"),
  config: postgresConfigSchema,
  password: passwordSchema,
  // While editing a saved source, an omitted password reuses the saved one.
  connectionId: z.uuid().optional(),
})

export const createConnectionSchema = z.strictObject({
  name: nameSchema,
  engine: z.literal("postgres"),
  config: postgresConfigSchema,
  password: passwordSchema,
  schemas: selectedSchemasSchema,
})

export const updateConnectionSchema = z
  .strictObject({
    name: nameSchema.optional(),
    config: postgresConfigSchema.optional(),
    // Omitted keeps the saved password.
    password: passwordSchema,
    schemas: selectedSchemasSchema.optional(),
  })
  .refine(
    (input) => Object.values(input).some((value) => value !== undefined),
    "Change at least one field",
  )

export type TestConnectionInput = z.infer<typeof testConnectionSchema>
export type CreateConnectionInput = z.infer<typeof createConnectionSchema>
export type UpdateConnectionInput = z.infer<typeof updateConnectionSchema>
