import "dotenv/config"
import express from "express"
import helmet from "helmet"
import cors from "cors"
import rateLimit from "express-rate-limit"

const app = express()
const frontendOrigin = process.env.FRONTEND_ORIGIN
if (!frontendOrigin) throw new Error("FRONTEND_ORIGIN is required")

app.disable("x-powered-by")
app.use(helmet())
app.use(cors({ origin: frontendOrigin, credentials: true, methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "X-CSRF-Token", "Paystack-Signature", "X-Paystack-Signature"] }))
app.use(express.json({ limit: "1mb", verify: (req, _res, buffer) => {
  if ((req as express.Request).originalUrl.startsWith("/api/payments/paystack/webhook")) {
    ;(req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer)
  }
} }))
app.use((req, res, next) => {
  const origin = req.get("origin")
  if (origin && origin !== frontendOrigin) return res.status(403).json({ error: "Origin not allowed" })
  next()
})
app.get("/health", (_req, res) => res.json({ service: "gateway", status: "ok" }))

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false })
const paymentLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false })
const forward = (prefix: string, targetName: string, upstreamPrefix = "") => async (req: express.Request, res: express.Response) => {
  const target = process.env[targetName]
  if (!target) throw new Error(`${targetName} is required`)
  try {
    const suffix = req.originalUrl.slice(prefix.length)
    const headers = new Headers()
    for (const name of ["content-type", "cookie", "user-agent", "x-csrf-token", "paystack-signature", "x-paystack-signature"]) {
      const value = req.get(name)
      if (value) headers.set(name, value)
    }
    const hasBody = !["GET", "HEAD"].includes(req.method)
    const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody
    const isPaystackWebhook = req.originalUrl === "/api/payments/paystack/webhook"
    const upstream = await fetch(`${target}${upstreamPrefix}${suffix}`, {
      method: req.method,
      headers,
      body: hasBody && req.body !== undefined
        ? (isPaystackWebhook && rawBody ? new Uint8Array(rawBody) : JSON.stringify(req.body))
        : undefined,
      signal: AbortSignal.timeout(12_000),
    })
    res.status(upstream.status)
    const contentType = upstream.headers.get("content-type")
    if (contentType) res.setHeader("content-type", contentType)
    const setCookies = upstream.headers.getSetCookie()
    if (setCookies.length) res.setHeader("set-cookie", setCookies)
    const cacheControl = upstream.headers.get("cache-control")
    if (cacheControl) res.setHeader("cache-control", cacheControl)
    const responseBody = Buffer.from(await upstream.arrayBuffer())
    return res.end(responseBody)
  } catch {
    return res.status(502).json({ error: "Service temporarily unavailable" })
  }
}

app.use("/api/auth", authLimiter, forward("/api/auth", "AUTH_SERVICE_URL"))
app.use("/api/profile", forward("/api/profile", "AUTH_SERVICE_URL", "/profile"))
app.use("/api/products", forward("/api/products", "CATALOG_SERVICE_URL", "/api/products"))
app.use("/api/categories", forward("/api/categories", "CATALOG_SERVICE_URL", "/api/categories"))
app.use("/api/orders", forward("/api/orders", "COMMERCE_SERVICE_URL", "/api/orders"))
app.use("/api/payments/paystack/webhook", forward("/api/payments", "COMMERCE_SERVICE_URL", "/api/payments"))
app.use("/api/payments", paymentLimiter, forward("/api/payments", "COMMERCE_SERVICE_URL", "/api/payments"))
app.use("/api/admin", forward("/api/admin", "ADMIN_SERVICE_URL"))

const port = Number(process.env.GATEWAY_PORT)
app.listen(port, "0.0.0.0", () => console.log(`API gateway listening on configured port ${port}`))
