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

/** MongoDB's own databases: never listed or selectable. */
export function isSystemDatabase(name: string): boolean {
  return name === "admin" || name === "local" || name === "config"
}

function identifier(label: string) {
  return z
    .string()
    .trim()
    .min(1, `Enter a ${label}`)
    .max(63, `The ${label} can be at most 63 characters`)
    .refine(hasNoControlChars, `The ${label} contains invalid characters`)
}

const hostSchema = z
  .string()
  .trim()
  .min(1, "Enter a host")
  .max(253)
  .refine(isHost, "Enter a host name or IP address without a scheme, port, or path")

const portSchema = z
  .number()
  .int()
  .min(1, "Enter a port from 1 to 65535")
  .max(65_535, "Enter a port from 1 to 65535")

export const postgresConfigSchema = z.strictObject({
  host: hostSchema,
  port: portSchema,
  database: identifier("database name"),
  username: identifier("username"),
  sslMode: z.enum(SSL_MODES),
})

export type PostgresConfig = z.infer<typeof postgresConfigSchema>

/** Characters MongoDB does not allow in database names. */
const MONGO_DATABASE_NAME = /^[^/\\. "$*<>:|?]+$/

function mongoDatabaseName(label: string) {
  return identifier(label).refine(
    (value) => MONGO_DATABASE_NAME.test(value),
    `The ${label} cannot contain spaces or any of / \\ . " $ * < > : | ?`,
  )
}

/** Blank means "not set". */
function optionalText(label: string, max: number) {
  return z
    .string()
    .trim()
    .max(max, `The ${label} can be at most ${max} characters`)
    .refine(hasNoControlChars, `The ${label} contains invalid characters`)
    .nullish()
    .transform((value) => value || null)
}

/** MongoDB settings entered field by field. Without a username, Manifest connects without signing in. */
export const mongoFieldsConfigSchema = z.strictObject({
  mode: z.literal("fields"),
  host: hostSchema,
  port: portSchema,
  /** Offered when the user may not list databases. */
  database: mongoDatabaseName("database name"),
  username: optionalText("username", 256),
  /** Where the user is defined; blank means "admin". */
  authSource: optionalText("authentication database", 63).refine(
    (value) => value === null || MONGO_DATABASE_NAME.test(value),
    "Enter a valid authentication database name",
  ),
  /** On means TLS with certificate verification. */
  tls: z.boolean(),
})

export type MongoFieldsConfig = z.infer<typeof mongoFieldsConfigSchema>

/**
 * What is stored and shown for a connection-string source: the hosts and
 * database only. The connection string itself is a sealed secret.
 */
export interface MongoUriSummary {
  mode: "uri"
  hosts: string[]
  srv: boolean
  /** The database in the connection string's path, if any. */
  database: string | null
}

export type MongoConfig = MongoFieldsConfig | MongoUriSummary

/** Connection-string mode carries no settings of its own: they come from the sealed string. */
export const mongoConfigInputSchema = z.discriminatedUnion("mode", [
  mongoFieldsConfigSchema,
  z.strictObject({ mode: z.literal("uri") }),
])

export type MongoConfigInput = z.infer<typeof mongoConfigInputSchema>

/** A saved or submitted source's engine with the settings that belong to it. */
export type SourceSettings =
  | { engine: "postgres"; config: PostgresConfig }
  | { engine: "mongodb"; config: MongoConfig }

const nameSchema = z.string().trim().min(1, "Enter a name").max(120)

/** An empty password means "none"; the value is never echoed in validation messages. */
const passwordSchema = z.string().max(1024, "The password is too long").optional()

/** A MongoDB connection string, sealed like a password and never echoed. */
const uriSchema = z
  .string()
  .trim()
  .max(4096, "The connection string is too long")
  .refine(
    (value) => /^mongodb(\+srv)?:\/\//.test(value),
    "Start the connection string with mongodb:// or mongodb+srv://",
  )
  .optional()

// While editing a saved source, omitted credentials reuse the saved ones.
const connectionIdSchema = z.uuid().optional()

function selection(noun: "schema" | "database", isSystem: (name: string) => boolean) {
  return z
    .array(
      z
        .string()
        .min(1)
        .max(63)
        .refine(hasNoControlChars, `${noun} names cannot contain control characters`)
        .refine((name) => !isSystem(name), `System ${noun}s cannot be selected`),
    )
    .min(1, `Select at least one ${noun}`)
    .max(100, `Select at most 100 ${noun}s`)
    .transform((names) => [...new Set(names)].sort())
}

/** For MongoDB sources the "schemas" are databases. */
const selectedSchemasSchema = selection("schema", isSystemSchema)
const selectedDatabasesSchema = selection("database", isSystemDatabase)

export const testConnectionSchema = z.discriminatedUnion("engine", [
  z.strictObject({
    engine: z.literal("postgres"),
    config: postgresConfigSchema,
    password: passwordSchema,
    connectionId: connectionIdSchema,
  }),
  z.strictObject({
    engine: z.literal("mongodb"),
    config: mongoConfigInputSchema,
    password: passwordSchema,
    uri: uriSchema,
    connectionId: connectionIdSchema,
  }),
])

export const createConnectionSchema = z.discriminatedUnion("engine", [
  z.strictObject({
    name: nameSchema,
    engine: z.literal("postgres"),
    config: postgresConfigSchema,
    password: passwordSchema,
    schemas: selectedSchemasSchema,
  }),
  z.strictObject({
    name: nameSchema,
    engine: z.literal("mongodb"),
    config: mongoConfigInputSchema,
    password: passwordSchema,
    uri: uriSchema,
    schemas: selectedDatabasesSchema,
  }),
])

/**
 * A source keeps its engine; settings for another engine are rejected by the
 * service, which also checks the selection against what the source offers.
 */
export const updateConnectionSchema = z
  .strictObject({
    name: nameSchema.optional(),
    config: z.union([postgresConfigSchema, mongoConfigInputSchema]).optional(),
    // Omitted keeps the saved password or connection string.
    password: passwordSchema,
    uri: uriSchema,
    schemas: z
      .array(
        z
          .string()
          .min(1)
          .max(63)
          .refine(hasNoControlChars, "Names cannot contain control characters"),
      )
      .min(1, "Select at least one schema or database")
      .max(100, "Select at most 100 schemas or databases")
      .transform((names) => [...new Set(names)].sort())
      .optional(),
  })
  .refine(
    (input) => Object.values(input).some((value) => value !== undefined),
    "Change at least one field",
  )

export type TestConnectionInput = z.infer<typeof testConnectionSchema>
export type CreateConnectionInput = z.infer<typeof createConnectionSchema>
export type UpdateConnectionInput = z.infer<typeof updateConnectionSchema>
