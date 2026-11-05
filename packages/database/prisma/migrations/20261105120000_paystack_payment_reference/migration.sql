ALTER TABLE "orders" ADD COLUMN "payment_reference" VARCHAR(100);

CREATE UNIQUE INDEX "orders_payment_reference_key" ON "orders"("payment_reference");
