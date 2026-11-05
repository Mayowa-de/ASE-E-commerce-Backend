import type { NextFunction, Request, Response } from "express"
import jwt from "jsonwebtoken"

export type AuthRole = "CUSTOMER" | "ADMIN"
export interface AuthClaims { sub: string; role: AuthRole; email: string }

declare global {
  namespace Express {
    interface Request { auth?: AuthClaims }
  }
}

function accessSecret() {
  const secret = process.env.JWT_ACCESS_SECRET
  if (!secret || secret.length < 32) throw new Error("JWT_ACCESS_SECRET must be configured with at least 32 characters")
  return secret
}

export function signAccessToken(claims: AuthClaims) {
  return jwt.sign(claims, accessSecret(), {
    issuer: process.env.JWT_ISSUER,
    expiresIn: (process.env.ACCESS_TOKEN_TTL ?? "15m") as jwt.SignOptions["expiresIn"],
    audience: "ase-storefront",
  })
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.ase_access as string | undefined
  if (!token) return res.status(401).json({ error: "Authentication required" })
  try {
    req.auth = jwt.verify(token, accessSecret(), {
      issuer: process.env.JWT_ISSUER,
      audience: "ase-storefront",
    }) as AuthClaims
    return next()
  } catch {
    return res.status(401).json({ error: "Session expired" })
  }
}

export function requireRole(...roles: AuthRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) return res.status(403).json({ error: "Forbidden" })
    next()
  }
}

export function assertConfiguredEnv() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required. Add the PostgreSQL connection string to .env")
  accessSecret()
}
