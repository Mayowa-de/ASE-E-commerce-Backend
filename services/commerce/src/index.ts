import "dotenv/config"
import express from "express"
import cookieParser from "cookie-parser"
import helmet from "helmet"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { prisma } from "../../../packages/database/src/client.js"
import { assertConfiguredEnv, requireAuth } from "../../../packages/security/src/index.js"
import paystackRoutes from "./payments.js"

assertConfiguredEnv()
const app = express()
app.disable("x-powered-by")
app.use(helmet())
app.use(cookieParser())
app.use("/api/payments", paystackRoutes)
app.use(express.json({ limit: "40kb" }))
app.get("/health", (_req, res) => res.json({ service: "commerce", status: "ok" }))
const orderSchema = z.object({ items: z.array(z.object({ productId: z.string().min(1), variantId: z.string().min(1), quantity: z.number().int().min(1).max(25) })).min(1).max(30), address: z.string().trim().min(5).max(500), deliveryState: z.string().trim().min(2).max(80), paymentMethod: z.enum(["Cash on Delivery", "Bank Transfer"]) })
const publicStatus = (status: string) => ({ PENDING: "Pending", CONFIRMED: "Confirmed", PROCESSING: "Processing", OUT_FOR_DELIVERY: "Out for Delivery", DELIVERED: "Delivered", CANCELLED: "Cancelled" } as Record<string, string>)[status] ?? status
const toOrder = (order: any) => ({ id: order.orderNumber, date: order.createdAt.toISOString(), status: publicStatus(order.status), paymentStatus: order.paymentStatus[0] + order.paymentStatus.slice(1).toLowerCase(), items: order.items.map((item: any) => ({ product: { id: item.product.slug, name: item.productName, category: item.product.category.name, variants: [], description: "", featured: false, active: true, rating: 0, reviewCount: 0 }, variant: { id: item.variant.slug, label: item.variantLabel, price: Number(item.unitPrice), stock: item.variant.stock }, quantity: item.quantity })), subtotal: Number(order.subtotal), deliveryFee: Number(order.deliveryFee), total: Number(order.total), address: order.address, paymentMethod: order.paymentMethod, deliveryState: order.deliveryState })

app.get("/api/orders", requireAuth, async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({ where: { userId: req.auth!.sub }, include: { items: { include: { product: { include: { category: true } }, variant: true } } }, orderBy: { createdAt: "desc" } })
    return res.json({ orders: orders.map(toOrder) })
  } catch (err) { next(err) }
})
app.get("/api/orders/:orderNumber", requireAuth, async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({ where: { orderNumber: String(req.params.orderNumber) }, include: { items: { include: { product: { include: { category: true } }, variant: true } } } })
    if (!order || (order.userId !== req.auth!.sub && req.auth!.role !== "ADMIN")) return res.status(404).json({ error: "Order not found" })
    return res.json({ order: toOrder(order) })
  } catch (err) { next(err) }
})
app.post("/api/orders", requireAuth, async (req, res, next) => {
  try {
    const parsed = orderSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: "Check your order details", details: parsed.error.flatten() })
    const deliveryFee = Number(process.env.DELIVERY_FEE_NGN ?? 0)
    const order = await prisma.$transaction(async (tx) => {
      const lines: { productId: string; variantId: string; productSlug: string; productName: string; variantSlug: string; variantLabel: string; unitPrice: number; quantity: number }[] = []
      for (const input of parsed.data.items) {
        const product = await tx.product.findFirst({ where: { slug: input.productId, active: true, comingSoon: false }, include: { category: true, variants: { where: { slug: input.variantId } } } })
        const variant = product?.variants[0]
        if (!product || !variant) throw Object.assign(new Error("One or more products are unavailable"), { status: 409 })
        const stockUpdate = await tx.productVariant.updateMany({ where: { id: variant.id, stock: { gte: input.quantity } }, data: { stock: { decrement: input.quantity } } })
        if (!stockUpdate.count) throw Object.assign(new Error(`${product.name} is out of stock`), { status: 409 })
        lines.push({ productId: product.id, variantId: variant.id, productSlug: product.slug, productName: product.name, variantSlug: variant.slug, variantLabel: variant.label, unitPrice: Number(variant.price), quantity: input.quantity })
      }
      const subtotal = lines.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
      const orderNumber = `ASE-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 6).toUpperCase()}`
      return tx.order.create({ data: { orderNumber, userId: req.auth!.sub, address: parsed.data.address, deliveryState: parsed.data.deliveryState, paymentMethod: parsed.data.paymentMethod, subtotal, deliveryFee, total: subtotal + deliveryFee, items: { create: lines.map(({ productName, variantLabel, unitPrice, quantity, productId, variantId }) => ({ productId, variantId, productName, variantLabel, unitPrice, quantity })) } }, include: { items: { include: { product: { include: { category: true } }, variant: true } } } })
    })
    return res.status(201).json({ order: toOrder(order) })
  } catch (err) { next(err) }
})

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const error = err as Error & { status?: number }
  if (error.status && error.status >= 400 && error.status < 600) return res.status(error.status).json({ error: error.message })
  console.error("commerce service error", err)
  return res.status(500).json({ error: "Unable to complete the request" })
})
const port = Number(process.env.COMMERCE_SERVICE_PORT)
app.listen(port, "127.0.0.1", () => console.log(`Commerce service listening on configured port ${port}`))
