import assert from "node:assert/strict"
import test from "node:test"

import { listDatabases, mapMongoError } from "../../src/connections/adapters/mongodb.js"
import { inspectMongoUri, UnusableConnectionString } from "../../src/connections/adapters/mongodb-uri.js"
import {
  capabilitiesFor,
  MONGO_ALLOWED_STAGES,
  MONGO_FORBIDDEN_OPERATORS,
  MONGO_FORBIDDEN_STAGES,
} from "../../src/connections/capabilities.js"

test("a connection string is summarized as hosts and database, never credentials", () => {
  const plain = inspectMongoUri(
    "mongodb://reader:s%40cret@db-1.internal:27017,db-2.internal:27018/analytics?replicaSet=rs0&authSource=admin",
  )
  assert.deepEqual(plain, {
    mode: "uri",
    hosts: ["db-1.internal:27017", "db-2.internal:27018"],
    srv: false,
    database: "analytics",
  })
  assert.ok(!JSON.stringify(plain).includes("reader") && !JSON.stringify(plain).includes("cret"))

  assert.deepEqual(inspectMongoUri("mongodb+srv://u:p@cluster0.example.mongodb.net/?retryWrites=true"), {
    mode: "uri",
    hosts: ["cluster0.example.mongodb.net"],
    srv: true,
    database: null,
  })
})

test("connection strings that are malformed or reach beyond the source are refused without echoing them", () => {
  const cases: [string, RegExp][] = [
    ["mongodb://u:p@host:notaport/db", /cannot use this connection string/],
    ["mongodb://u:p@h/?authMechanism=SCRAM-SHA-1&tlsCAFile=/etc/hosts", /tlsCAFile/],
    ["mongodb://h/?tlsCertificateKeyFile=/etc/ssl/key.pem", /Manifest does not read files/],
    ["mongodb://h/?proxyHost=proxy.internal", /proxies/],
    ["mongodb://h/?authMechanism=MONGODB-AWS", /username and password/],
    ["mongodb+srv://h.example.net/?authMechanism=MONGODB-OIDC&authMechanismProperties=ENVIRONMENT:azure,TOKEN_RESOURCE:x", /username and password/],
    ["mongodb://u:p@h/bad.name", /not a valid database name/],
  ]
  for (const [uri, message] of cases) {
    assert.throws(
      () => inspectMongoUri(uri),
      (error: unknown) =>
        error instanceof UnusableConnectionString &&
        message.test(error.message) &&
        !error.message.includes("u:p"),
      uri,
    )
  }
})

test("driver failures map to the shared reasons with messages written here", () => {
  const network = (code: string, message: string) => {
    const cause = Object.assign(new Error(message), { name: "MongoNetworkError", cause: { code } })
    const servers = new Map([["db:27017", { error: cause }]])
    return Object.assign(new Error(message), {
      name: "MongoServerSelectionError",
      reason: { servers },
    })
  }
  const cases: [unknown, string][] = [
    [Object.assign(new Error("Authentication failed."), { name: "MongoServerError", code: 18 }), "auth_failed"],
    [network("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:1"), "host_unreachable"],
    [network("ENOTFOUND", "getaddrinfo ENOTFOUND db.invalid"), "host_unreachable"],
    [Object.assign(new Error("querySrv ENOTFOUND _mongodb._tcp.x"), { code: "ENOTFOUND" }), "host_unreachable"],
    [network("ECONNRESET", "Client network socket disconnected before secure TLS connection was established"), "tls_failed"],
    [Object.assign(new Error("Socket 'connect' timed out"), { name: "MongoServerSelectionError" }), "timeout"],
    [Object.assign(new Error("operation exceeded time limit"), { name: "MongoServerError", code: 50 }), "timeout"],
    [new Error("mongodb://user:hunter2@db/ something odd"), "unknown"],
  ]
  for (const [error, reason] of cases) {
    const mapped = mapMongoError(error)
    assert.equal(mapped.reason, reason, String(error))
    assert.ok(!mapped.message.includes("hunter2"))
  }
})

test("database listing falls back to the configured database when it is refused", async () => {
  const lister = (result: () => Promise<Record<string, unknown>>) => ({
    db: () => ({ command: result }),
  })
  const listed = await listDatabases(
    lister(async () => ({
      databases: [{ name: "shop" }, { name: "admin" }, { name: "events" }, { name: "local" }],
    })),
    "shop",
  )
  assert.deepEqual(listed, { names: ["events", "shop"], limited: false })

  const refused = lister(async () => {
    throw Object.assign(new Error("not authorized"), { name: "MongoServerError", code: 13 })
  })
  assert.deepEqual(await listDatabases(refused, "shop"), { names: ["shop"], limited: true })
  assert.deepEqual(await listDatabases(refused, "admin"), { names: [], limited: true })
  assert.deepEqual(await listDatabases(refused, null), { names: [], limited: true })

  const down = lister(async () => {
    throw Object.assign(new Error("connection closed"), { name: "MongoNetworkError" })
  })
  await assert.rejects(listDatabases(down, "shop"), /connection closed/)
})

test("capabilities route each engine to its own read-only operations", () => {
  const postgres = capabilitiesFor("postgres")
  assert.equal(postgres.queryLanguage, "sql")
  assert.deepEqual(postgres.operations, ["sql_select"])
  const mongo = capabilitiesFor("mongodb")
  assert.equal(mongo.queryLanguage, "mongodb")
  assert.deepEqual(mongo.operations, ["find", "aggregate"])
  assert.equal(mongo.readOnly, true)
  for (const stage of ["$out", "$merge"]) {
    assert.ok(!(MONGO_ALLOWED_STAGES as readonly string[]).includes(stage), stage)
    assert.ok((MONGO_FORBIDDEN_STAGES as readonly string[]).includes(stage), stage)
  }
  assert.deepEqual([...MONGO_FORBIDDEN_OPERATORS], ["$where", "$function", "$accumulator"])
  assert.match(mongo.summary, /No SQL/)
})
