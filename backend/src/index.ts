import { loadEnv } from "./config/env.js"
import { createApp } from "./server/app.js"

const env = loadEnv()
const app = createApp(env)

const server = app.listen(env.PORT, env.HOST, () => {
  console.log(`manifest-backend listening on http://${env.HOST}:${env.PORT}`)
})

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}
