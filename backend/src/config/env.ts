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

    // Seals saved source credentials (Cycle 05). Without it, connection
    // endpoints answer 503; it is required in production when storage is on.
    CONNECTION_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters")
      .optional(),

    // Synthetic demo source built by `npm run db:demo-source` (local only).
    DEMO_SOURCE_DATABASE_URL: z.string().url().optional(),
    // Synthetic MongoDB demo database built by `npm run db:demo-mongo` (local only).
    DEMO_MONGO_URL: z
      .string()
      .regex(/^mongodb(\+srv)?:\/\//, "must start with mongodb:// or mongodb+srv://")
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

    // Agent runtime (Cycle 10). "anthropic" needs ANTHROPIC_API_KEY; "scripted"
    // is a labeled demo model for local walkthroughs without a key and is
    // refused in production. Without a usable provider the agent endpoints
    // answer 503 and everything else keeps working.
    AGENT_PROVIDER: z.enum(["anthropic", "scripted"]).default("anthropic"),
    AGENT_MODEL: z.string().trim().min(1).max(120).default("claude-opus-5-5"),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    AGENT_MAX_STEPS: z.coerce.number().int().min(1).max(50).default(12),
    AGENT_RUN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(1_800_000).default(300_000),
    // How long a question waits for the user's reply to a clarification (the
    // run's own time limit is paused meanwhile).
    AGENT_ANSWER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(1_800_000),

    // Scheduled routines (Cycle 16): the shortest time a schedule may leave
    // between runs, and how often each backend looks for routines that are due.
    ROUTINE_MIN_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1_440).default(5),
    ROUTINE_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(15_000),
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
    if (env.NODE_ENV === "production" && env.AGENT_PROVIDER === "scripted") {
      ctx.addIssue({
        code: "custom",
        path: ["AGENT_PROVIDER"],
        message: "the scripted demo model is not allowed in production",
      })
    }
    if (env.NODE_ENV === "production" && env.DATABASE_URL && !env.CONNECTION_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["CONNECTION_ENCRYPTION_KEY"],
        message: "CONNECTION_ENCRYPTION_KEY is required in production when storage is configured",
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
