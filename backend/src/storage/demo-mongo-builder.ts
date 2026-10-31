import { Decimal128, Double, Int32, ObjectId, type Db, type Document } from "mongodb"

/** The database the MongoDB demo builder writes to; nothing else is touched. */
export const DEMO_MONGO_DATABASE = "manifest_demo"
/** The only collections (and view) the builder drops and recreates. */
export const DEMO_MONGO_COLLECTIONS = ["sessions", "web_events", "product_reviews"] as const
const DEMO_MONGO_VIEW = "product_ratings"

export interface DemoMongoSummary {
  sessions: number
  webEvents: number
  productReviews: number
}

const SESSIONS = 2_500
const REVIEWS = 1_200
const DAY_MS = 86_400_000
const INSERT_BATCH = 1_000
/** Customer ids 1..800 and product ids 1..31 match shop.customers and shop.products in the PostgreSQL demo source. */
const CUSTOMERS = 800
/** List prices of shop.products ids 1..31, in USD. */
const PRODUCT_PRICES = [
  16.5, 14, 38, 18.5, 15, 15.5, 41, 12.5, 13, 11, 12, 24, 10.5, 9.5, 34, 26, 189, 72, 39, 449, 6.5, 42,
  16, 28, 22, 35, 29, 24, 149, 45, 39,
]

/** Deterministic pseudo-random numbers in [0, 1), so every build produces the same documents. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function pick<T>(next: () => number, values: readonly T[]): T {
  return values[Math.floor(next() * values.length)] as T
}

/** A stable id: the timestamp, then a counter (instead of the machine and process bytes). */
function objectId(at: Date, counter: number): ObjectId {
  const seconds = Math.floor(at.getTime() / 1000).toString(16).padStart(8, "0")
  return new ObjectId(seconds + counter.toString(16).padStart(16, "0"))
}

const productId = (next: () => number) => 1 + Math.floor(next() * PRODUCT_PRICES.length)
const price = (id: number) => PRODUCT_PRICES[id - 1] ?? 10

const DEVICES = [
  { type: "mobile", os: "iOS", browser: "Safari" },
  { type: "mobile", os: "Android", browser: "Chrome" },
  { type: "desktop", os: "Windows", browser: "Chrome" },
  { type: "desktop", os: "macOS", browser: "Safari" },
  { type: "desktop", os: "Windows", browser: "Edge" },
  { type: "desktop", os: "Linux", browser: "Firefox" },
  { type: "tablet", os: "iOS", browser: "Safari" },
] as const
const CAMPAIGNS = [
  { source: "google", medium: "cpc", campaign: "brand-search" },
  { source: "newsletter", medium: "email", campaign: "monthly-roast" },
  { source: "instagram", medium: "social", campaign: "matcha-launch" },
  { source: "partner-blog", medium: "referral", campaign: "brew-guide" },
] as const
const SEARCHES = ["decaf", "matcha", "grinder", "gift", "earl grey", "espresso", "kettle", "subscription"]
const REVIEW_TITLES = {
  high: ["Fantastic", "Our new favourite", "Worth every penny", "Great gift", "Smooth and fresh"],
  low: ["Disappointed", "Arrived damaged", "Not as described", "Too bitter for me", "Stopped working"],
}

interface Session {
  id: string
  customerId: number | null
  startedAt: Date
}

function buildSessions(now: number): { documents: Document[]; sessions: Session[] } {
  const next = random(8)
  const documents: Document[] = []
  const sessions: Session[] = []
  for (let index = 1; index <= SESSIONS; index += 1) {
    const id = `S${String(index).padStart(6, "0")}`
    // Spread over the last 90 days, busier towards today.
    const startedAt = new Date(now - Math.pow(next(), 1.4) * 90 * DAY_MS)
    const signedIn = next() < 0.65
    const customerId = signedIn ? 1 + Math.floor(next() * CUSTOMERS) : null
    const pageViews = 1 + Math.floor(Math.pow(next(), 2) * 24)
    const document: Document = {
      _id: id,
      started_at: startedAt,
      device: { ...pick(next, DEVICES) },
      landing_page: pick(next, ["/", "/collections/coffee", "/collections/tea", `/products/${productId(next)}`]),
      page_views: new Int32(pageViews),
      converted: next() < 0.08 + (signedIn ? 0.06 : 0),
      // The geo lookup sometimes fails, which the tracker records as null.
      country: next() < 0.05 ? null : pick(next, ["US", "US", "US", "GB", "CA", "DE", "AU", "FR"]),
    }
    // Anonymous visitors have no customer_id at all.
    if (customerId !== null) document.customer_id = new Int32(customerId)
    // Sessions still open have no end yet.
    if (next() > 0.03) document.ended_at = new Date(startedAt.getTime() + pageViews * 40_000)
    if (next() < 0.4) document.utm = { ...pick(next, CAMPAIGNS) }
    documents.push(document)
    sessions.push({ id, customerId, startedAt })
  }
  return { documents, sessions }
}

function cart(next: () => number): Document {
  const items = Array.from({ length: 1 + Math.floor(Math.pow(next(), 2) * 4) }, () => {
    const id = productId(next)
    return {
      product_id: new Int32(id),
      quantity: new Int32(1 + Math.floor(Math.pow(next(), 3) * 3)),
      unit_price: Decimal128.fromString(price(id).toFixed(2)),
    }
  })
  const value = items.reduce(
    (sum, item) => sum + Number(item.unit_price.toString()) * item.quantity.value,
    0,
  )
  return { items, value: new Double(Math.round(value * 100) / 100) }
}

function buildEvents(sessions: Session[], now: number): Document[] {
  const next = random(21)
  const events: Document[] = []
  for (const session of sessions) {
    const count = 2 + Math.floor(next() * 9)
    for (let step = 0; step < count; step += 1) {
      const at = new Date(Math.min(now, session.startedAt.getTime() + step * 35_000))
      const roll = next()
      const type =
        roll < 0.45 ? "page_view"
        : roll < 0.7 ? "product_view"
        : roll < 0.8 ? "search"
        : roll < 0.9 ? "add_to_cart"
        : roll < 0.96 ? "checkout_started"
        : "purchase"
      const event: Document = {
        _id: objectId(at, events.length + 1),
        session_id: session.id,
        type,
        at,
        page: type === "search" ? "/search" : `/products/${productId(next)}`,
        referrer: step === 0 ? pick(next, ["https://www.google.com/", "https://instagram.com/", null]) : null,
        // The legacy tracker (first 30 days) sent a numeric version; the current one sends a string.
        tracker_version: at.getTime() < now - 60 * DAY_MS ? new Int32(3) : "4.2.1",
      }
      if (session.customerId !== null) event.customer_id = new Int32(session.customerId)
      if (type === "product_view") event.product_id = new Int32(productId(next))
      if (type === "search") {
        event.search = { query: pick(next, SEARCHES), results: new Int32(Math.floor(next() * 18)) }
      }
      if (type === "add_to_cart" || type === "checkout_started" || type === "purchase") {
        event.cart = cart(next)
      }
      events.push(event)
    }
  }
  return events
}

function buildReviews(now: number): Document[] {
  const next = random(34)
  const reviews: Document[] = []
  for (let index = 1; index <= REVIEWS; index += 1) {
    const createdAt = new Date(now - next() * 400 * DAY_MS)
    const rating = Math.min(5, Math.max(1, Math.round(4.3 + (next() - 0.6) * 4)))
    // Reviews imported from the old shop kept their rating as text and have no vote count.
    const legacy = index % 10 === 0
    const review: Document = {
      _id: objectId(createdAt, index),
      product_id: new Int32(productId(next)),
      customer_id: new Int32(1 + Math.floor(next() * CUSTOMERS)),
      rating: legacy ? String(rating) : new Int32(rating),
      title: pick(next, rating >= 4 ? REVIEW_TITLES.high : REVIEW_TITLES.low),
      body: rating >= 4 ? "Would buy again." : "Expected better for the price.",
      created_at: createdAt,
      verified_purchase: next() < 0.8,
      source: legacy ? "legacy_import" : pick(next, ["web", "web", "app"]),
      tags: Array.from({ length: Math.floor(next() * 3) }, () =>
        pick(next, ["fresh", "gift", "value", "strong", "packaging", "shipping"]),
      ),
    }
    if (!legacy) review.helpful_votes = new Int32(Math.floor(Math.pow(next(), 3) * 40))
    if (next() < 0.2) {
      review.photos = Array.from({ length: 1 + Math.floor(next() * 3) }, (_, photo) => ({
        url: `https://img.example.com/reviews/${index}-${photo + 1}.jpg`,
        width: new Int32(1200),
        height: new Int32(pick(next, [900, 1200, 1600])),
      }))
    }
    if (rating <= 2 && next() < 0.7) {
      review.response = {
        agent: pick(next, ["Maya (support)", "Jonas (support)", "Priya (support)"]),
        responded_at: new Date(createdAt.getTime() + (1 + next() * 3) * DAY_MS),
        text: "Sorry about this. We have sent a replacement.",
      }
    }
    reviews.push(review)
  }
  return reviews
}

/** Descriptions only (no constraints), so Manifest can show them like source comments. */
const VALIDATORS: Record<(typeof DEMO_MONGO_COLLECTIONS)[number], Document> = {
  sessions: {
    $jsonSchema: {
      description: "One document per storefront visit (synthetic demo data).",
      properties: {
        customer_id: { description: "shop.customers.id when the visitor was signed in; absent for anonymous visits." },
        ended_at: { description: "Absent while the session is still open." },
        utm: { description: "Campaign parameters from the landing URL, when there were any." },
      },
    },
  },
  web_events: {
    $jsonSchema: {
      description: "Clickstream events from the storefront tracker (synthetic demo data).",
      properties: {
        session_id: { description: "sessions._id" },
        tracker_version: { description: "The legacy tracker sent a number; the current one sends a string." },
        cart: {
          properties: { value: { description: "Cart total in USD at the time of the event." } },
        },
      },
    },
  },
  product_reviews: {
    $jsonSchema: {
      description: "Product reviews written by customers (synthetic demo data).",
      properties: {
        product_id: { description: "shop.products.id" },
        rating: { description: "1 to 5 stars. Imported legacy reviews store it as text." },
      },
    },
  },
}

async function insertAll(db: Db, name: string, documents: Document[]): Promise<void> {
  for (let start = 0; start < documents.length; start += INSERT_BATCH) {
    await db.collection(name).insertMany(documents.slice(start, start + INSERT_BATCH), { ordered: false })
  }
}

/**
 * Drops and rebuilds the synthetic sessions, web_events, and product_reviews
 * collections (and the product_ratings view) in the given database. Dates are
 * relative to now; ids match the PostgreSQL demo source's customers and products.
 */
export async function buildDemoMongo(db: Db, now = Date.now()): Promise<DemoMongoSummary> {
  for (const name of [DEMO_MONGO_VIEW, ...DEMO_MONGO_COLLECTIONS]) {
    await db.collection(name).drop().catch(() => {})
  }
  for (const name of DEMO_MONGO_COLLECTIONS) {
    await db.createCollection(name, { validator: VALIDATORS[name] })
  }
  const { documents: sessions, sessions: index } = buildSessions(now)
  const events = buildEvents(index, now)
  const reviews = buildReviews(now)
  await insertAll(db, "sessions", sessions)
  await insertAll(db, "web_events", events)
  await insertAll(db, "product_reviews", reviews)
  await db.createCollection(DEMO_MONGO_VIEW, {
    viewOn: "product_reviews",
    pipeline: [
      { $match: { rating: { $type: "int" } } },
      { $group: { _id: "$product_id", average_rating: { $avg: "$rating" }, reviews: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ],
  })
  return { sessions: sessions.length, webEvents: events.length, productReviews: reviews.length }
}
