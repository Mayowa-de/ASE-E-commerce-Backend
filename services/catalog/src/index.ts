import "dotenv/config"
import express from "express"
import cookieParser from "cookie-parser"
import helmet from "helmet"
import { z } from "zod"
import { prisma } from "../../../packages/database/src/client.js"
import { invalidatePrefix, getJson, setJson } from "../../../packages/cache/src/index.js"
import { assertConfiguredEnv, requireAuth, requireRole } from "../../../packages/security/src/index.js"

assertConfiguredEnv()
const app = express()
app.disable("x-powered-by")
app.use(helmet())
app.use(express.json({ limit: "50kb" }))
app.use(cookieParser())
app.get("/health", (_req, res) => res.json({ service: "catalog", status: "ok" }))

const productInclude = { category: { select: { name: true, slug: true } }, variants: { orderBy: { createdAt: "asc" as const } } }
const toProduct = (p: any) => ({ id: p.slug, name: p.name, category: p.category.name, categoryId: p.category.slug, description: p.description, featured: p.featured, active: p.active, comingSoon: p.comingSoon, rating: p.rating, reviewCount: p.reviewCount, images: [], variants: p.variants.map((v: any) => ({ id: v.slug, label: v.label, price: Number(v.price), stock: v.stock })) })
const productSchema = z.object({ slug: z.string().regex(/^[a-z0-9-]+$/).max(120), name: z.string().trim().min(1).max(160), description: z.string().max(10000), categorySlug: z.string().min(1), featured: z.boolean().default(false), active: z.boolean().default(true), comingSoon: z.boolean().default(false), variants: z.array(z.object({ slug: z.string().regex(/^[a-z0-9-]+$/), label: z.string().min(1).max(80), price: z.number().nonnegative(), stock: z.number().int().nonnegative() })).default([]) })

app.get("/api/products", async (_req, res, next) => {
  try {
    const cached = await getJson<unknown[]>("catalog:products:v1")
    if (cached) return res.json({ products: cached })
    const rows = await prisma.product.findMany({ where: { active: true }, include: productInclude, orderBy: [{ featured: "desc" }, { name: "asc" }] })
    const products = rows.map(toProduct)
    await setJson("catalog:products:v1", products, 60)
    return res.json({ products })
  } catch (err) { next(err) }
})
app.get("/api/products/:slug", async (req, res, next) => {
  try {
    const key = `catalog:product:${req.params.slug}`
    const cached = await getJson<unknown>(key)
    if (cached) return res.json({ product: cached })
    const row = await prisma.product.findFirst({ where: { slug: req.params.slug, active: true }, include: productInclude })
    if (!row) return res.status(404).json({ error: "Product not found" })
    const product = toProduct(row)
    await setJson(key, product, 60)
    return res.json({ product })
  } catch (err) { next(err) }
})
app.get("/api/categories", async (_req, res, next) => {
  try {
    const categories = await prisma.category.findMany({ where: { active: true }, orderBy: { displayOrder: "asc" }, select: { slug: true, name: true, description: true, imageUrl: true, displayOrder: true } })
    return res.json({ categories })
  } catch (err) { next(err) }
})

app.post("/api/products", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
  try {
    const parsed = productSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: "Invalid product", details: parsed.error.flatten() })
    const { categorySlug, variants, ...data } = parsed.data
    const category = await prisma.category.findUnique({ where: { slug: categorySlug } })
    if (!category) return res.status(400).json({ error: "Category not found" })
    const row = await prisma.product.create({ data: { ...data, categoryId: category.id, variants: { create: variants } }, include: productInclude })
    await invalidatePrefix("catalog:")
    return res.status(201).json({ product: toProduct(row) })
  } catch (err) { next(err) }
})
app.patch("/api/products/:slug", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
  try {
    const parsed = productSchema.partial().safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: "Invalid product", details: parsed.error.flatten() })
    const { categorySlug, variants, ...data } = parsed.data
    const category = categorySlug ? await prisma.category.findUnique({ where: { slug: categorySlug } }) : null
    if (categorySlug && !category) return res.status(400).json({ error: "Category not found" })
    const productSlug = String(req.params.slug)
    const row = await prisma.$transaction(async (tx) => {
      const product = await tx.product.update({ where: { slug: productSlug }, data: { ...data, ...(category ? { categoryId: category.id } : {}) } })
      if (variants) {
        const variantSlugs = variants.map((variant) => variant.slug)
        for (const variant of variants) {
          await tx.productVariant.upsert({
            where: { productId_slug: { productId: product.id, slug: variant.slug } },
            create: { ...variant, productId: product.id },
            update: { label: variant.label, price: variant.price, stock: variant.stock },
          })
        }
        const removedVariants = await tx.productVariant.findMany({ where: { productId: product.id, slug: { notIn: variantSlugs } }, select: { id: true } })
        for (const removed of removedVariants) {
          const orderHistoryCount = await tx.orderItem.count({ where: { variantId: removed.id } })
          if (orderHistoryCount > 0) throw Object.assign(new Error("This variant has order history. Set its stock to zero instead of removing it."), { status: 409 })
          await tx.productVariant.delete({ where: { id: removed.id } })
        }
      }
      return tx.product.findUniqueOrThrow({ where: { id: product.id }, include: productInclude })
    })
    await invalidatePrefix("catalog:")
    return res.json({ product: toProduct(row) })
  } catch (err) { next(err) }
})
app.delete("/api/products/:slug", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
  try {
    await prisma.product.update({ where: { slug: String(req.params.slug) }, data: { active: false } })
    await invalidatePrefix("catalog:")
    return res.status(204).end()
  } catch (err) { next(err) }
})

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const error = err as Error & { status?: number }
  if (error.status === 409) return res.status(409).json({ error: error.message })
  console.error("catalog service error", err)
  res.status(500).json({ error: "Unable to complete the request" })
})
const port = Number(process.env.CATALOG_SERVICE_PORT)
app.listen(port, "127.0.0.1", () => console.log(`Catalog service listening on configured port ${port}`))
