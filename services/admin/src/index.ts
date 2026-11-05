import "dotenv/config"
import express from "express"
import cookieParser from "cookie-parser"
import helmet from "helmet"
import { z } from "zod"
import { prisma } from "../../../packages/database/src/client.js"
import { assertConfiguredEnv, requireAuth, requireRole } from "../../../packages/security/src/index.js"

assertConfiguredEnv()
const app = express()
app.disable("x-powered-by")
app.use(helmet())
app.use(express.json({ limit: "30kb" }))
app.use(cookieParser())
app.get("/health", (_req, res) => res.json({ service: "admin", status: "ok" }))
app.use(requireAuth, requireRole("ADMIN"))

app.get("/dashboard", async (_req, res, next) => {
  try {
    const [totalOrders, paidRevenue, pendingOrders, activeProducts, lowStockVariants, deliveredOrders, recentOrders, customerCount] = await Promise.all([
      prisma.order.count(),
      prisma.order.aggregate({ where: { paymentStatus: "PAID" }, _sum: { total: true } }),
      prisma.order.count({ where: { status: { in: ["PENDING", "CONFIRMED"] } } }),
      prisma.product.count({ where: { active: true, comingSoon: false } }),
      prisma.productVariant.count({ where: { stock: { lt: Number(process.env.LOW_STOCK_THRESHOLD ?? 5) }, product: { active: true } } }),
      prisma.order.count({ where: { status: "DELIVERED" } }),
      prisma.order.findMany({ take: 8, orderBy: { createdAt: "desc" }, include: { user: { select: { name: true } }, items: { select: { id: true } } } }),
      prisma.user.count({ where: { role: "CUSTOMER", active: true } }),
    ])
    return res.json({ totalOrders, revenue: Number(paidRevenue._sum.total ?? 0), pendingOrders, activeProducts, lowStockVariants, deliveredOrders, customerCount, recentOrders: recentOrders.map((order) => ({ id: order.orderNumber, customerName: order.user.name, itemCount: order.items.length, total: Number(order.total), status: order.status, createdAt: order.createdAt })) })
  } catch (err) { next(err) }
})
app.get("/customers", async (_req, res, next) => {
  try {
    const customers = await prisma.user.findMany({ where: { role: "CUSTOMER" }, select: { id: true, name: true, email: true, phone: true, createdAt: true, _count: { select: { orders: true } } }, orderBy: { createdAt: "desc" } })
    return res.json({ customers: customers.map(({ _count, ...user }) => ({ ...user, orderCount: _count.orders })) })
  } catch (err) { next(err) }
})
app.get("/orders", async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({ take: 100, orderBy: { createdAt: "desc" }, include: { user: { select: { name: true, email: true } }, _count: { select: { items: true } } } })
    return res.json({ orders: orders.map(({ user, _count, ...order }) => ({ ...order, total: Number(order.total), customer: user, itemCount: _count.items })) })
  } catch (err) { next(err) }
})
app.patch("/orders/:id/status", async (req, res, next) => {
  try {
    const parsed = z.object({ status: z.enum(["PENDING", "CONFIRMED", "PROCESSING", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"]) }).safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: "Invalid order status" })
    const order = await prisma.order.update({ where: { id: req.params.id }, data: { status: parsed.data.status } })
    return res.json({ order: { ...order, total: Number(order.total) } })
  } catch (err) { next(err) }
})

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("admin service error", err)
  res.status(500).json({ error: "Unable to complete the request" })
})
const port = Number(process.env.ADMIN_SERVICE_PORT)
app.listen(port, "127.0.0.1", () => console.log(`Admin service listening on configured port ${port}`))
