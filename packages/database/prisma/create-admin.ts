import "dotenv/config"
import bcrypt from "bcryptjs"
import { prisma } from "../src/client.js"

const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase()
const password = process.env.INITIAL_ADMIN_PASSWORD
const name = process.env.INITIAL_ADMIN_NAME?.trim() || "Store Administrator"

if (!email || !password || password.length < 12) {
  throw new Error("Set INITIAL_ADMIN_EMAIL and a 12+ character INITIAL_ADMIN_PASSWORD in .env before running npm run admin:create")
}

const passwordHash = await bcrypt.hash(password, 12)
await prisma.user.upsert({ where: { email }, create: { name, email, passwordHash, role: "ADMIN" }, update: { name, passwordHash, role: "ADMIN", active: true } })
console.log(`Admin account provisioned for ${email}`)
await prisma.$disconnect()
