# Adeola Spiritual Enterprises API

The backend is organized as five independently runnable services behind an API gateway. Auth, catalogue, commerce, and admin each own their HTTP routes and business logic. They currently share one PostgreSQL database through Prisma for straightforward local development; service boundaries can later move to separate databases without changing the storefront API.

## Local setup

1. Create a PostgreSQL database in pgAdmin and set `DATABASE_URL` in this folder's `.env` file. Use `postgresql://postgres:YOUR_PASSWORD@localhost:5432/YOUR_DATABASE?schema=public` as the format; replace the user, password, port, and database name with the values from your pgAdmin server. Percent-encode reserved characters in the password. Keep credentials in `.env`; do not commit it.
2. Set `JWT_ACCESS_SECRET` to a random value at least 32 characters long. Set `INITIAL_ADMIN_NAME`, `INITIAL_ADMIN_EMAIL`, and `INITIAL_ADMIN_PASSWORD` for the first administrator.
3. Start Redis with `docker compose up -d redis`, or set `REDIS_URL` to an existing Redis instance.
4. Run `npm install`, then `npm run db:generate`, `npm run db:status`, `npm run db:migrate`, and `npm run db:seed`.
5. Run `npm run admin:create` to provision the administrator, then `npm run dev` to start all services.
6. In the frontend `.env`, set `VITE_API_BASE_URL=http://localhost:4100/api`. Start the frontend separately with `npm run dev` from the frontend folder.

The services listen on ports 4100–4104, configured in `.env`. The Vite frontend defaults to port 8443 in this project, so the API gateway allows `http://localhost:8443`. Adjust `FRONTEND_ORIGIN` if Vite uses a different port.

## API surface

- `POST /api/auth/register`, `/login`, `/admin/login`, `/refresh`, `/logout`; `GET /api/auth/me`
- `GET /api/products`, `GET /api/products/:id`, and `GET /api/categories`
- `GET /api/profile`, `PUT /api/profile`
- `GET /api/orders`, `POST /api/orders`, and `GET /api/orders/:orderNumber`
- `POST /api/payments/paystack/initialize`, `POST /api/payments/paystack/verify`, and `POST /api/payments/paystack/webhook`

Paystack uses `PAYSTACK_SECRET_KEY` and, when enabled for the account, `PAYSTACK_WEBHOOK_SECRET`. Keep both server-only in this backend's `.env`; never add them to the storefront `.env` or any `VITE_*` variable. The callback verifies the transaction against Paystack before marking an order paid. Configure the webhook URL in the Paystack dashboard as `https://<your-api-domain>/api/payments/paystack/webhook`.

### Production Paystack configuration

- Deploy the storefront and API behind HTTPS. Set the storefront `VITE_API_BASE_URL` to `https://<your-api-domain>/api` and backend `FRONTEND_ORIGIN` to the exact storefront origin.
- Set backend `PAYSTACK_SECRET_KEY` to the live `sk_live_...` key from Paystack. Production mode rejects a test key.
- Set `PAYSTACK_WEBHOOK_SECRET` to the signing secret generated in Paystack Dashboard → Developers → API configuration. Add `https://<your-api-domain>/api/payments/paystack/webhook` as the webhook URL and enable `charge.success`.
- Set backend cookies to `COOKIE_SECURE=true`. Use `COOKIE_SAME_SITE=lax` when the storefront and API are same-site; use `none` only when they are on different sites, with HTTPS enabled.
- Apply the database migration to the production database with `npm run db:migrate` before enabling checkout.
- Admin-only `GET /api/admin/dashboard`, `/customers`, `/orders`; `PATCH /api/admin/orders/:id/status`

Access and rotating refresh tokens are HTTP-only cookies. Passwords use bcrypt hashing. Admin accounts are provisioned by the backend command and cannot be created through customer registration. Helmet and gateway origin/rate-limit controls are enabled. Redis caches public catalogue reads; cache outages fall back to PostgreSQL.

## Database status

The initial Prisma migration and seed catalogue are checked in. Migration, seed, and admin provisioning require your PostgreSQL URL and credentials, which are not in the project yet. Payment processing, password reset delivery, and persisted customer address book are not configured; checkout currently records cash-on-delivery or bank-transfer orders.
