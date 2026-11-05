import { Redis } from "ioredis"

const redisUrl = process.env.REDIS_URL
if (!redisUrl) throw new Error("REDIS_URL is required")

export const redis = new Redis(redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  retryStrategy: (attempt: number) => Math.min(attempt * 250, 2000),
})

export async function getJson<T>(key: string): Promise<T | null> {
  try {
    if (redis.status === "wait") await redis.connect()
    const value = await redis.get(key)
    return value ? JSON.parse(value) as T : null
  } catch { return null }
}

export async function setJson(key: string, value: unknown, ttlSeconds: number) {
  try {
    if (redis.status === "wait") await redis.connect()
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds)
  } catch { /* Cache outages do not make catalog reads unavailable. */ }
}

export async function invalidatePrefix(prefix: string) {
  try {
    if (redis.status === "wait") await redis.connect()
    const keys = await redis.keys(`${prefix}*`)
    if (keys.length) await redis.del(...keys)
  } catch { /* Cache will expire naturally. */ }
}
