import "dotenv/config"
import express from "express"
import cookieParser from "cookie-parser"
import helmet from "helmet"
import bcrypt from "bcryptjs"
import { createHash, randomBytes } from "node:crypto"
import { z } from "zod"
import { prisma } from "../../../packages/database/src/client.js"
import { assertConfiguredEnv, requireAuth, signAccessToken } from "../../../packages/security/src/index.js"

assertConfiguredEnv()
const app = express()
app.disable("x-powered-by")
app.use(helmet())
app.use(express.json({ limit: "20kb" }))
app.use(cookieParser())
app.get("/health", (_req, res) => res.json({ service: "auth", status: "ok" }))

const credentialsSchema = z.object({ email: z.email().max(254), password: z.string().min(8).max(128) })
const registerSchema = credentialsSchema.extend({ name: z.string().trim().min(1).max(120), phone: z.string().trim().min(5).max(32) })
const profileSchema = z.object({ name: z.string().trim().min(1).max(120), phone: z.string().trim().max(32).nullable() })
const cookieSecure = process.env.COOKIE_SECURE === "true"
const sameSite = (process.env.COOKIE_SAME_SITE ?? "lax") as "lax" | "strict" | "none"
const accessCookie = { httpOnly: true, secure: cookieSecure, sameSite, path: "/", maxAge: 15 * 60 * 1000 } as const
const refreshCookie = { ...accessCookie, path: "/api/auth", maxAge: Number(process.env.REFRESH_TOKEN_DAYS ?? 7) * 24 * 60 * 60 * 1000 } as const
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex")
const userView = (user: { id: string; name: string; email: string; phone: string | null; role: "ADMIN" | "CUSTOMER" }) => ({ id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role })

async function establishSession(user: { id: string; email: string; role: "ADMIN" | "CUSTOMER"; name: string; phone: string | null }, res: express.Response) {
  const rawRefreshToken = randomBytes(48).toString("base64url")
  const refreshDays = Number(process.env.REFRESH_TOKEN_DAYS ?? 7)
  await prisma.refreshSession.create({ data: { userId: user.id, tokenHash: hashToken(rawRefreshToken), expiresAt: new Date(Date.now() + refreshDays * 86_400_000) } })
  res.cookie("ase_access", signAccessToken({ sub: user.id, email: user.email, role: user.role }), accessCookie)
  res.cookie("ase_refresh", rawRefreshToken, refreshCookie)
  return userView(user)
}

async function authenticate(req: express.Request, res: express.Response, role: "ADMIN" | "CUSTOMER") {
  const input = credentialsSchema.safeParse(req.body)
  if (!input.success) { res.status(400).json({ error: "Enter a valid email and password" }); return }
  const email = input.data.email.toLowerCase().trim()
  const user = await prisma.user.findUnique({ where: { email } })
  const matches = user ? await bcrypt.compare(input.data.password, user.passwordHash) : false
  if (!user || !matches || !user.active || user.role !== role) { res.status(401).json({ error: "Invalid email or password" }); return }
  res.json({ user: await establishSession(user, res) })
}

app.post("/register", async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: "Check the registration details" })
    const email = parsed.data.email.toLowerCase().trim()
    if (await prisma.user.findUnique({ where: { email } })) return res.status(409).json({ error: "An account with this email already exists" })
    const user = await prisma.user.create({ data: { name: parsed.data.name, email, phone: parsed.data.phone, passwordHash: await bcrypt.hash(parsed.data.password, 12), role: "CUSTOMER" } })
    return res.status(201).json({ user: await establishSession(user, res) })
  } catch (err) { next(err) }
})
app.post("/login", (req, res, next) => { void authenticate(req, res, "CUSTOMER").catch(next) })
app.post("/admin/login", (req, res, next) => { void authenticate(req, res, "ADMIN").catch(next) })

app.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.auth!.sub } })
    if (!user || !user.active) return res.status(401).json({ error: "Account unavailable" })
    return res.json({ user: userView(user) })
  } catch (err) { next(err) }
})

app.post("/refresh", async (req, res, next) => {
  try {
    const token = req.cookies?.ase_refresh as string | undefined
    if (!token) return res.status(401).json({ error: "Session expired" })
    const session = await prisma.refreshSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } })
    if (!session || session.revokedAt || session.expiresAt <= new Date() || !session.user.active) return res.status(401).json({ error: "Session expired" })
    await prisma.refreshSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } })
    return res.json({ user: await establishSession(session.user, res) })
  } catch (err) { next(err) }
})

app.post("/logout", requireAuth, async (req, res, next) => {
  try {
    const token = req.cookies?.ase_refresh as string | undefined
    if (token) await prisma.refreshSession.updateMany({ where: { tokenHash: hashToken(token), userId: req.auth!.sub, revokedAt: null }, data: { revokedAt: new Date() } })
    res.clearCookie("ase_access", { httpOnly: true, secure: cookieSecure, sameSite, path: "/" })
    res.clearCookie("ase_refresh", { httpOnly: true, secure: cookieSecure, sameSite, path: "/api/auth" })
    return res.status(204).end()
  } catch (err) { next(err) }
})

app.get("/profile", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.auth!.sub }, select: { id: true, name: true, email: true, phone: true, role: true, createdAt: true } })
    if (!user) return res.status(404).json({ error: "User not found" })
    return res.json({ user })
  } catch (err) { next(err) }
})
app.put("/profile", requireAuth, async (req, res, next) => {
  try {
    const parsed = profileSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: "Check the profile details" })
    const user = await prisma.user.update({ where: { id: req.auth!.sub }, data: parsed.data, select: { id: true, name: true, email: true, phone: true, role: true, createdAt: true } })
    return res.json({ user })
  } catch (err) { next(err) }
})

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("auth service error", err)
  res.status(500).json({ error: "Unable to complete the request" })
})

const port = Number(process.env.AUTH_SERVICE_PORT)
app.listen(port, "127.0.0.1", () => console.log(`Auth service listening on configured port ${port}`))
