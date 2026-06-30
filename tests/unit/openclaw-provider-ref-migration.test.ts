import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  new URL("../../prisma/migrations/000009_openclaw_provider_ref_privacy/migration.sql", import.meta.url),
  "utf8",
);

describe("openclaw provider ref privacy migration", () => {
  it("aborts before schema changes instead of silently deleting existing provider refs", () => {
    const guardIndex = migrationSql.indexOf('IF EXISTS (SELECT 1 FROM "UserProviderRef"');
    const firstSchemaChangeIndex = migrationSql.indexOf('ALTER TABLE "UserProviderRef"');

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(migrationSql).toContain("RAISE EXCEPTION");
    expect(firstSchemaChangeIndex).toBeGreaterThan(guardIndex);
    expect(migrationSql).not.toContain('DELETE FROM "UserProviderRef"');
  });
});
