import type { DatevStack } from "@haben/import";
import { and, eq, sql } from "drizzle-orm";
import { db, schema, type Tx } from "../../db/index.ts";
import { sha256Of, storeFile } from "../../storage.ts";
import { storeDatevBookings } from "./accountable-import.ts";

/*
 * Originale eines Datei-Umzugs (Export-ZIP von sevDesk, DATEV-Export von Papierkram) im Archiv ablegen, nur anhängend.
 * Liegt eine Datei schon im Archiv (gleiche Prüfsumme), verweist der Lauf auf sie.
 */

export async function existingFile(sha256: string): Promise<string | null> {
  const [row] = await db.select({ id: schema.archiveFiles.id }).from(schema.archiveFiles).where(eq(schema.archiveFiles.sha256, sha256));
  return row?.id ?? null;
}

/** Eine Datei unverändert unter „Sonstiges“ */
export async function storeOriginal(
  tx: Tx,
  file: { filename: string; bytes: Uint8Array; mimeType: string },
  year: number | null,
  note: string,
): Promise<string> {
  const sha256 = sha256Of(file.bytes);
  const known = await existingFile(sha256);
  if (known) return known;
  await storeFile(file.bytes);
  const [row] = await tx
    .insert(schema.archiveFiles)
    .values({ kind: "sonstiges", year, filename: file.filename.slice(0, 200), sha256, mimeType: file.mimeType, size: file.bytes.byteLength, note })
    .returning({ id: schema.archiveFiles.id });
  return row!.id;
}

/**
 * Ein Stapel als DATEV-Buchungsstapel mit seinen Zeilen. Gleiche Datei: die vorhandene. Anderer Stapel im selben Zeitraum:
 * null, nichts angelegt (wie addArchiveFile, nur ohne Abbruch des Laufs), sonst stünden die Buchungen doppelt im Abgleich.
 */
export async function storeStack(tx: Tx, { name, bytes, stack }: { name: string; bytes: Uint8Array; stack: DatevStack }, note: string): Promise<string | null> {
  const sha256 = sha256Of(bytes);
  const known = await existingFile(sha256);
  if (known) return known;
  const dates = stack.bookings.map((b) => b.date).sort();
  const from = dates[0];
  const to = dates.at(-1);
  if (!from || !to) return null;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('haben.archive.datev'))`);
  const [overlap] = await tx
    .select({ id: schema.archiveFiles.id })
    .from(schema.archiveFiles)
    .where(
      and(
        eq(schema.archiveFiles.kind, "datev"),
        sql`${schema.archiveFiles.meta} ->> 'dateFrom' <= ${to}`,
        sql`${schema.archiveFiles.meta} ->> 'dateTo' >= ${from}`,
      ),
    )
    .limit(1);
  if (overlap) return null;
  await storeFile(bytes);
  const [row] = await tx
    .insert(schema.archiveFiles)
    .values({
      kind: "datev",
      year: Number((stack.header.fiscalYearStart || from).slice(0, 4)),
      filename: (name.split("/").pop() ?? name).slice(0, 200),
      sha256,
      mimeType: "text/csv",
      size: bytes.byteLength,
      note,
      meta: { header: stack.header, dateFrom: from, dateTo: to, bookings: stack.bookings.length, warnings: stack.warnings },
    })
    .returning({ id: schema.archiveFiles.id });
  await storeDatevBookings(tx, row!.id, stack.bookings);
  return row!.id;
}
