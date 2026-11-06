import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import express from "express"
import { z } from "zod"
import type { Prisma } from "@prisma/client"
import { prisma } from "../../../packages/database/src/client.js"
import { requireAuth } from "../../../packages/security/src/index.js"

const router = express.Router()
const checkoutSchema = z.object({
  items: z.array(z.object({
    productId: z.string().min(1),
    variantId: z.string().min(1),
    quantity: z.number().int().min(1).max(25),
  })).min(1).max(30),
  address: z.string().trim().min(5).max(500),
  deliveryState: z.string().trim().min(2).max(80),
})

const includeOrder = {
  items: { include: { product: { include: { category: true } }, variant: true } },
} as const

const publicStatus = (status: string) => ({
  PENDING: "Pending",
  CONFIRMED: "Confirmed",
  PROCESSING: "Processing",
  OUT_FOR_DELIVERY: "Out for Delivery",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
} as Record<string, string>)[status] ?? status

const toOrder = (order: any) => ({
  id: order.orderNumber,
  date: order.createdAt.toISOString(),
  status: publicStatus(order.status),
  paymentStatus: order.paymentStatus[0] + order.paymentStatus.slice(1).toLowerCase(),
  items: order.items.map((item: any) => ({
    product: { id: item.product.slug, name: item.productName, category: item.product.category.name, variants: [], description: "", featured: false, active: true, rating: 0, reviewCount: 0 },
    variant: { id: item.variant.slug, label: item.variantLabel, price: Number(item.unitPrice), stock: item.variant.stock },
    quantity: item.quantity,
  })),
  subtotal: Number(order.subtotal),
  deliveryFee: Number(order.deliveryFee),
  total: Number(order.total),
  address: order.address,
  paymentMethod: order.paymentMethod,
  deliveryState: order.deliveryState,
})

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status })
const paystackSecret = () => {
  const secret = process.env.PAYSTACK_SECRET_KEY
  if (!secret || !/^sk_(test|live)_/.test(secret)) return undefined
  if (process.env.NODE_ENV === "production" && secret.startsWith("sk_test_")) return undefined
  return secret
}
const amountInKobo = (amount: unknown) => Math.round(Number(amount) * 100)

async function createPaystackOrder(input: z.infer<typeof checkoutSchema>, userId: string, reference: string) {
  const deliveryFee = Number(process.env.DELIVERY_FEE_NGN ?? 0)
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const lines: { productId: string; variantId: string; productName: string; variantLabel: string; unitPrice: number; quantity: number }[] = []
    for (const item of input.items) {
      const product = await tx.product.findFirst({
        where: { slug: item.productId, active: true, comingSoon: false },
        include: { variants: { where: { slug: item.variantId } } },
      })
      const variant = product?.variants[0]
      if (!product || !variant) throw httpError(409, "One or more products are unavailable")

      const reserved = await tx.productVariant.updateMany({
        where: { id: variant.id, stock: { gte: item.quantity } },
        data: { stock: { decrement: item.quantity } },
      })
      if (!reserved.count) throw httpError(409, `${product.name} is out of stock`)
      lines.push({ productId: product.id, variantId: variant.id, productName: product.name, variantLabel: variant.label, unitPrice: Number(variant.price), quantity: item.quantity })
    }

    const subtotal = lines.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
    const orderNumber = `ASE-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(3).toString("hex").toUpperCase()}`
    return tx.order.create({
      data: {
        orderNumber,
        userId,
        address: input.address,
        deliveryState: input.deliveryState,
        paymentMethod: "Paystack",
        paymentReference: reference,
        subtotal,
        deliveryFee,
        total: subtotal + deliveryFee,
        items: { create: lines },
      },
      include: includeOrder,
    })
  })
}

async function failPendingOrder(orderId: string) {
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const changed = await tx.order.updateMany({
      where: { id: orderId, paymentMethod: "Paystack", paymentStatus: "PENDING", status: "PENDING" },
      data: { paymentStatus: "FAILED", status: "CANCELLED" },
    })
    if (!changed.count) return
    const items = await tx.orderItem.findMany({ where: { orderId }, select: { variantId: true, quantity: true } })
    for (const item of items) {
      await tx.productVariant.update({ where: { id: item.variantId }, data: { stock: { increment: item.quantity } } })
    }
  })
}

function isValidWebhookSignature(rawBody: Buffer, headers: express.Request["headers"]) {
  const modernHeader = headers["paystack-signature"]
  const modernSecret = process.env.PAYSTACK_WEBHOOK_SECRET
  if (typeof modernHeader === "string" && modernSecret) {
    let timestamp: number | undefined
    const signatures: string[] = []
    for (const part of modernHeader.split(",")) {
      const separator = part.indexOf("=")
      if (separator < 0) continue
      const name = part.slice(0, separator).trim()
      const value = part.slice(separator + 1).trim()
      if (name === "t") {
        if (timestamp !== undefined || !/^\d+$/.test(value)) return false
        timestamp = Number(value)
      } else if (name === "v1") {
        const colon = value.indexOf(":")
        if (colon > 0) signatures.push(value.slice(colon + 1))
      }
    }
    if (timestamp === undefined || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return false
    const expected = createHmac("sha512", modernSecret).update(`${timestamp}.`).update(rawBody).digest()
    if (signatures.some((signature) => /^[0-9a-f]{128}$/.test(signature) && timingSafeEqual(expected, Buffer.from(signature, "hex")))) return true
  }

  const legacy = headers["x-paystack-signature"]
  const secretKey = paystackSecret()
  if (typeof legacy !== "string" || !secretKey || !/^[0-9a-f]{128}$/.test(legacy)) return false
  const expected = createHmac("sha512", secretKey).update(rawBody).digest()
  return timingSafeEqual(expected, Buffer.from(legacy, "hex"))
}

type PaystackTransaction = {
  reference?: string
  status?: string
  amount?: number
  currency?: string
  customer?: { email?: string }
  metadata?: string | Record<string, unknown> | null
}

async function getVerifiedPaystackTransaction(reference: string): Promise<PaystackTransaction> {
  const secret = paystackSecret()
  if (!secret) throw httpError(503, "Paystack payments are not configured")
  const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  })
  const payload = await response.json().catch(() => null) as { status?: boolean; data?: PaystackTransaction } | null
  if (!response.ok || !payload?.status || !payload.data) throw httpError(502, "Unable to verify this payment with Paystack")
  return payload.data
}

async function verifyAndApplyPayment(reference: string, userId?: string) {
  const order = await prisma.order.findUnique({
    where: { paymentReference: reference },
    include: { ...includeOrder, user: { select: { id: true, email: true } } },
  })
  if (!order || (userId && order.userId !== userId)) throw httpError(404, "Payment order not found")
  if (order.paymentStatus === "PAID") return { order, paymentStatus: "Paid" as const }
  if (order.paymentStatus === "FAILED" || order.status === "CANCELLED") throw httpError(409, "This payment attempt has already been closed")

  const transaction = await getVerifiedPaystackTransaction(reference)
  if (transaction.reference !== reference) throw httpError(409, "Paystack returned a different payment reference")

  let metadata = transaction.metadata
  if (typeof metadata === "string") {
    try { metadata = JSON.parse(metadata) as Record<string, unknown> } catch { metadata = null }
  }
  if (metadata && typeof metadata === "object" && metadata.order_number && metadata.order_number !== order.orderNumber) {
    throw httpError(409, "Payment metadata does not match this order")
  }

  if (transaction.status === "success") {
    if (transaction.currency !== "NGN" || transaction.amount !== amountInKobo(order.total)) throw httpError(409, "Paid amount does not match the order total")
    if (transaction.customer?.email?.toLowerCase() !== order.user.email.toLowerCase()) throw httpError(409, "Payment customer does not match this order")
    const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.order.updateMany({
        where: { id: order.id, paymentMethod: "Paystack", paymentStatus: "PENDING", status: "PENDING" },
        data: { paymentStatus: "PAID", status: "CONFIRMED" },
      })
      return tx.order.findUnique({ where: { id: order.id }, include: includeOrder })
    })
    if (!updated || updated.paymentStatus !== "PAID") throw httpError(409, "This order is no longer payable")
    return { order: updated, paymentStatus: "Paid" as const }
  }

  if (transaction.status === "failed" || transaction.status === "abandoned") {
    await failPendingOrder(order.id)
    throw httpError(409, "Paystack did not complete the payment")
  }

  return { order, paymentStatus: "Pending" as const }
}

router.post("/paystack/webhook", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !isValidWebhookSignature(req.body, req.headers)) return res.sendStatus(401)
  let event: { event?: string; data?: { reference?: string } }
  try { event = JSON.parse(req.body.toString("utf8")) as typeof event } catch { return res.sendStatus(400) }
  if (event.event !== "charge.success" || !event.data?.reference) return res.sendStatus(200)

  try {
    const result = await verifyAndApplyPayment(event.data.reference)
    if (result.paymentStatus === "Pending") return res.sendStatus(500)
    return res.sendStatus(200)
  } catch (error) {
    const status = (error as Error & { status?: number }).status
    if (status === 404) return res.sendStatus(200)
    console.error("Paystack webhook processing failed", error)
    return res.sendStatus(500)
  }
})

router.use(express.json({ limit: "40kb" }))

router.post("/paystack/initialize", requireAuth, async (req, res) => {
  const secret = paystackSecret()
  if (!secret) return res.status(503).json({ error: "Paystack payments are not configured" })
  if (!process.env.FRONTEND_ORIGIN) return res.status(503).json({ error: "Payment callback URL is not configured" })
  const input = checkoutSchema.safeParse(req.body)
  if (!input.success) return res.status(400).json({ error: "Check your checkout details", details: input.error.flatten() })

  const user = await prisma.user.findUnique({ where: { id: req.auth!.sub }, select: { id: true, email: true, active: true } })
  if (!user?.active) return res.status(401).json({ error: "Account unavailable" })

  const reference = `ASE-${Date.now()}-${randomBytes(8).toString("hex")}`
  const order = await createPaystackOrder(input.data, user.id, reference)
  const amount = amountInKobo(order.total)
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    await failPendingOrder(order.id)
    return res.status(400).json({ error: "Order total is not a valid Paystack amount" })
  }

  try {
    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        email: user.email,
        amount: String(amount),
        currency: "NGN",
        reference,
        callback_url: new URL("/payment/callback", process.env.FRONTEND_ORIGIN).toString(),
        channels: ["card", "bank", "ussd", "bank_transfer"],
        metadata: { order_number: order.orderNumber },
      }),
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    })
    const payload = await response.json().catch(() => null) as { status?: boolean; message?: string; data?: { authorization_url?: string; reference?: string } } | null
    const authorizationUrl = payload?.data?.authorization_url
    const checkoutUrl = authorizationUrl ? new URL(authorizationUrl) : null
    if (!response.ok || !payload?.status || payload.data?.reference !== reference || checkoutUrl?.protocol !== "https:" || checkoutUrl.hostname !== "checkout.paystack.com") {
      await failPendingOrder(order.id)
      return res.status(502).json({ error: "Unable to start Paystack checkout" })
    }
    return res.status(201).json({ authorizationUrl: checkoutUrl.toString(), reference, orderNumber: order.orderNumber })
  } catch (error) {
    await failPendingOrder(order.id)
    console.error("Paystack initialization failed", error)
    return res.status(502).json({ error: "Unable to connect to Paystack. Please try again." })
  }
})

router.post("/paystack/verify", requireAuth, async (req, res, next) => {
  const input = z.object({ reference: z.string().min(8).max(100).regex(/^[A-Za-z0-9.=-]+$/) }).safeParse(req.body)
  if (!input.success) return res.status(400).json({ error: "A valid payment reference is required" })
  try {
    const result = await verifyAndApplyPayment(input.data.reference, req.auth!.sub)
    return res.json({ order: toOrder(result.order), paymentStatus: result.paymentStatus })
  } catch (error) {
    return next(error)
  }
})

export default router
