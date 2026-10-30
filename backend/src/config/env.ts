import { z } from "zod"

const booleanString = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1")

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production", "local"]).default("local"),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(0).max(65_535).default(3001),
    CORS_ORIGINS: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    DATABASE_URL: z.string().url().optional(),
    CONNECTION_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters")
      .optional(),

    // Browser sessions (Cycle 04). Required in production when storage is on;
    // locally an ephemeral secret is generated and sessions reset on restart.
    SESSION_SECRET: z.string().min(32, "must be at least 32 characters").optional(),
    APP_ORIGIN: z.string().url().default("http://localhost:5173"),

    // Google sign-in (identity only; file access arrives in a later cycle).
    // Client id/secret must be set together. Never expose the secret to the frontend.
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    GOOGLE_REDIRECT_URI: z.string().url().optional(),

    // Local development sign-in. Forced off in production regardless of value.
    ALLOW_DEV_LOGIN: booleanString.default(false),
  })
  .superRefine((env, ctx) => {
    if (Boolean(env.GOOGLE_CLIENT_ID) !== Boolean(env.GOOGLE_CLIENT_SECRET)) {
      ctx.addIssue({
        code: "custom",
        path: ["GOOGLE_CLIENT_ID"],
        message: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together",
      })
    }
    if (env.NODE_ENV === "production" && env.DATABASE_URL && !env.SESSION_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["SESSION_SECRET"],
        message: "SESSION_SECRET is required in production when storage is configured",
      })
    }
  })

export type Env = z.infer<typeof envSchema> & { devLoginEnabled: boolean; googleEnabled: boolean }

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ")
    throw new Error(`Invalid environment configuration — ${issues}`)
  }
  const env = parsed.data
  return {
    ...env,
    devLoginEnabled: env.ALLOW_DEV_LOGIN && env.NODE_ENV !== "production",
    googleEnabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  }
}
