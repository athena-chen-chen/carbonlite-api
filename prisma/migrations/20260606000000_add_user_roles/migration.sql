CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'USER');

ALTER TABLE "User"
  ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'USER';

UPDATE "User"
SET "role" = 'ADMIN'
WHERE LOWER("email") = 'carbonliteai@gmail.com';
