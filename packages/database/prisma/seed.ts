import "dotenv/config"
import { prisma } from "../src/client.js"

const categories = [
  { slug: "candles", name: "Candles", description: "Candles for prayer and worship.", displayOrder: 1 },
  { slug: "bibles", name: "Bibles", description: "Bibles in available editions.", displayOrder: 2 },
  { slug: "oils", name: "Oils", description: "Oils for worship and prayer.", displayOrder: 3 },
  { slug: "perfumes", name: "Perfumes", description: "Fragrances for worship and personal use.", displayOrder: 4 },
  { slug: "spiritual-items", name: "Spiritual Items", description: "Spiritual items currently available from the store.", displayOrder: 5 },
]

const products: { slug: string; name: string; category: string; description: string; featured: boolean; comingSoon?: boolean; active?: boolean; variants: [string, string, number][] }[] = [
  { slug: "candles", name: "Candles", category: "candles", description: "Quality candles for prayer and worship.", featured: true, variants: [["small", "Small", 700], ["medium", "Medium", 900]] },
  { slug: "st-michael", name: "St. Michael", category: "spiritual-items", description: "St. Michael spiritual item.", featured: false, variants: [["solo", "Solo", 1700]] },
  { slug: "divine-grace", name: "Divine Grace", category: "spiritual-items", description: "Divine Grace spiritual item.", featured: false, variants: [["solo", "Solo", 1700]] },
  { slug: "onola", name: "Onola", category: "spiritual-items", description: "Onola spiritual item.", featured: false, variants: [["solo", "Solo", 2000]] },
  { slug: "back-to-sender", name: "Back to Sender", category: "spiritual-items", description: "Back to Sender spiritual item.", featured: false, variants: [["solo", "Solo", 2000]] },
  { slug: "miss-paris", name: "Miss Paris", category: "perfumes", description: "Miss Paris fragrance.", featured: true, variants: [["solo", "Solo", 1700], ["big", "Big", 4000]] },
  { slug: "amure", name: "Amure", category: "perfumes", description: "Amure fragrance.", featured: false, variants: [["standard", "Standard", 800]] },
  { slug: "cross-wewe", name: "Cross Wewe", category: "spiritual-items", description: "Cross Wewe is not available yet.", featured: false, comingSoon: true, active: false, variants: [] },
  { slug: "bible", name: "Bible", category: "bibles", description: "Bibles in available editions.", featured: true, variants: [["small", "Small", 6000], ["medium", "Medium", 9000]] },
  { slug: "papa-perfume", name: "Papa Perfume", category: "perfumes", description: "Papa Perfume fragrance.", featured: false, variants: [["standard", "Standard", 2000]] },
  { slug: "goya-oil", name: "Goya Oil", category: "oils", description: "Goya Oil.", featured: true, variants: [["standard", "Standard", 1000]] },
] as const

async function main() {
  for (const category of categories) await prisma.category.upsert({ where: { slug: category.slug }, create: category, update: { name: category.name, description: category.description, displayOrder: category.displayOrder } })
  for (const source of products) {
    const category = await prisma.category.findUniqueOrThrow({ where: { slug: source.category } })
    const { variants, category: _category, ...data } = source
    const product = await prisma.product.upsert({ where: { slug: source.slug }, create: { ...data, categoryId: category.id, variants: { create: variants.map(([slug, label, price]) => ({ slug, label, price, stock: 25 })) } }, update: { name: data.name, description: data.description, categoryId: category.id, featured: data.featured, active: data.active ?? true, comingSoon: data.comingSoon ?? false } })
    for (const [slug, label, price] of variants) await prisma.productVariant.upsert({ where: { productId_slug: { productId: product.id, slug } }, create: { productId: product.id, slug, label, price, stock: 25 }, update: { label, price } })
  }
  console.log("Catalogue seed complete")
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => prisma.$disconnect())
