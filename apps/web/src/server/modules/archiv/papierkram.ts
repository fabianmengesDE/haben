import { readPapierkramExport, type PkExport } from "@haben/import";
import { and, desc, eq, sql } from "drizzle-orm";
import { withActor } from "../../db/actor.ts";
import { db, schema } from "../../db/index.ts";
import type { LexofficeImportProgress, PapierkramProgress } from "../../db/schema.ts";
import { isUniqueViolation, UserError } from "../../errors.ts";
import { sha256Of } from "../../storage.ts";
import { kleinunternehmerHistory, loadCompany } from "../stammdaten/index.ts";
import { latestAccountableImport } from "./accountable.ts";
import { latestFastbillImport } from "./fastbill.ts";
import { finish, latestImport, progressMessage, STALE_MS } from "./lexoffice.ts";
import { runPapierkramImport } from "./papierkram-lauf.ts";
import { latestSevdeskImport } from "./sevdesk.ts";
import { latestSevdeskExportImport } from "./sevdesk-export.ts";

/*
 * Umzug aus Papierkram mit dem DATEV-Export (Seite „DATEV Export“): je Jahr der Buchungsstapel (CSV) und die
 * Belegbilder (ZIP), beides für Eingangs- und Ausgangsrechnungen. Der Upload wird gelesen und analysiert, übernommen wird
 * erst auf Knopfdruck, nach dem Muster des sevDesk-Exports. Den Inhalt liest readPapierkramExport in @haben/import, den
 * Lauf beschreibt papierkram-lauf.ts. Die API von Papierkram liefert keine Einnahmebelege; deshalb ist der Export die Quelle.
 */

export class PapierkramError extends UserError {}

/** Wie beim Archiv: Größere Exporte teilt man in kürzere Zeiträume */
export const MAX_PAPIERKRAM_UPLOAD_SIZE = 100 * 1024 * 1024;

const SOURCE = "papierkram" as const;
const HINT_LIMIT = 50;

export interface StagedPapierkramExport {
  files: { name: string; bytes: Uint8Array }[];
  export: PkExport;
  analysis: PapierkramProgress;
}

// Nur im Speicher: Ein Upload legt nichts an, erst der Lauf. Ein neuer Upload ersetzt den vorigen.
let staged: StagedPapierkramExport | null = null;
export const stagedPapierkramExport = () => staged;

const running = new Set<string>();
const cancelled = new Set<string>();

/** Je Stapel: schon im Archiv, Zeitraum von einem anderen Stapel belegt, oder neu */
async function stackStates(exp: PkExport): Promise<PapierkramProgress["stacks"]> {
  const result: PapierkramProgress["stacks"] = [];
  for (const { name, bytes, stack } of exp.stacks) {
    const dates = stack.bookings.map((b) => b.date).sort();
    const from = dates[0] ?? stack.header.dateFrom ?? "";
    const to = dates.at(-1) ?? stack.header.dateTo ?? "";
    const [same] = await db
      .select({ id: schema.archiveFiles.id })
      .from(schema.archiveFiles)
      .where(eq(schema.archiveFiles.sha256, sha256Of(bytes)));
    if (same) {
      result.push({ name, from, to, state: "vorhanden" });
      continue;
    }
    const [other] = await db
      .select({ filename: schema.archiveFiles.filename })
      .from(schema.archiveFiles)
      .where(
        and(
          eq(schema.archiveFiles.kind, "datev"),
          sql`${schema.archiveFiles.meta} ->> 'dateFrom' <= ${to}`,
          sql`${schema.archiveFiles.meta} ->> 'dateTo' >= ${from}`,
        ),
      )
      .limit(1);
    result.push(other ? { name, from, to, state: "zeitraum", other: other.filename } : { name, from, to, state: "neu" });
  }
  return result;
}

async function analysisOf(files: StagedPapierkramExport["files"], exp: PkExport): Promise<PapierkramProgress> {
  const v = exp.vouchers;
  return {
    files: files.map((f) => f.name),
    size: files.reduce((sum, f) => sum + f.bytes.byteLength, 0),
    years: [...new Set(v.map((x) => Number(x.date.slice(0, 4))))].sort(),
    bookings: exp.stacks.reduce((sum, s) => sum + s.stack.bookings.length, 0),
    vouchers: v.length,
    withFile: v.filter((x) => x.file !== null).length,
    missingFile: v.filter((x) => x.guid !== null && x.file === null).length,
    cancelled: v.filter((x) => x.storno === "storniert").length,
    stacks: await stackStates(exp),
    hints: exp.hints.slice(0, HINT_LIMIT),
    hintCount: exp.hints.length,
  };
}

/**
 * Liest die hochgeladenen Dateien und legt sie zum Starten in den Speicher. Wirft PapierkramError mit dem Grund, wenn sie
 * nicht der DATEV-Export von Papierkram sind; dann ist nichts angelegt.
 */
export async function analysePapierkramExport(files: { name: string; bytes: Uint8Array }[]): Promise<PapierkramProgress> {
  // Ein abgelehnter Upload darf den vorigen nicht startbar lassen: „Übernehmen“ nähme sonst die falschen Dateien
  staged = null;
  if (files.length === 0 || files.every((f) => f.bytes.byteLength === 0)) throw new PapierkramError("Die Dateien sind leer.");
  if (files.reduce((sum, f) => sum + f.bytes.byteLength, 0) > MAX_PAPIERKRAM_UPLOAD_SIZE) {
    throw new PapierkramError("Die Dateien sind zusammen größer als 100 MB. Lade die Jahre einzeln hoch.");
  }
  const { kontenrahmen } = await loadCompany();
  const result = readPapierkramExport(files, { kontenrahmen, kleinunternehmerAm: await kleinunternehmerHistory() });
  if (!result.ok) throw new PapierkramError(result.reason);
  if (result.export.vouchers.length === 0) throw new PapierkramError("Der Export enthält keine Belege.");
  const analysis = await analysisOf(files, result.export);
  staged = { files, export: result.export, analysis };
  return analysis;
}

export type PapierkramRun = typeof schema.lexofficeImports.$inferSelect & { papierkram: PapierkramProgress | null };

const runOf = (row: typeof schema.lexofficeImports.$inferSelect): PapierkramRun => ({ ...row, papierkram: row.progress.papierkram ?? null });

/** Letzter Lauf; ein hängengebliebener (Server neu gestartet) gilt als abgebrochen. */
export async function latestPapierkramImport(): Promise<PapierkramRun | null> {
  const [row] = await db
    .select()
    .from(schema.lexofficeImports)
    .where(eq(schema.lexofficeImports.source, SOURCE))
    .orderBy(desc(schema.lexofficeImports.startedAt))
    .limit(1);
  if (!row) return null;
  if (row.status === "laeuft" && !running.has(row.id) && Date.now() - row.updatedAt.getTime() > STALE_MS) {
    const [updated] = await db
      .update(schema.lexofficeImports)
      .set({ status: "abgebrochen", error: "Der Lauf wurde unterbrochen. Lade den Export erneut hoch.", finishedAt: new Date() })
      .where(and(eq(schema.lexofficeImports.id, row.id), eq(schema.lexofficeImports.status, "laeuft")))
      .returning();
    return runOf(updated ?? row);
  }
  return runOf(row);
}

export async function papierkramImportStatus(id: string): Promise<PapierkramRun | null> {
  const [row] = await db
    .select()
    .from(schema.lexofficeImports)
    .where(and(eq(schema.lexofficeImports.id, id), eq(schema.lexofficeImports.source, SOURCE)));
  return row ? runOf(row) : null;
}

/** Startet den Lauf für den hochgeladenen Export im Hintergrund; ein zweiter Lauf überspringt, was schon liegt. */
export async function startPapierkramImport(actor: string, options: { wait?: boolean } = {}): Promise<string> {
  const upload = staged;
  if (!upload) throw new PapierkramError("Zuerst den Export hochladen.");
  // Der eindeutige Index gilt über alle Quellen: verwaiste Läufe anderer Quellen als abgebrochen markieren
  await latestImport();
  await latestSevdeskImport();
  await latestFastbillImport();
  await latestAccountableImport();
  await latestSevdeskExportImport();
  await latestPapierkramImport();
  const progress: LexofficeImportProgress = {
    phase: "belege",
    contacts: 0,
    contactsLinked: 0,
    listed: upload.export.vouchers.length,
    imported: 0,
    skipped: 0,
    files: 0,
    failed: [],
    papierkram: { ...upload.analysis },
  };
  const [row] = await withActor(actor, (tx) =>
    tx.insert(schema.lexofficeImports).values({ source: SOURCE, progress }).returning({ id: schema.lexofficeImports.id }),
  ).catch((error: unknown) => {
    if (isUniqueViolation(error, "lexoffice_imports_one_running")) throw new PapierkramError("Ein Abruf läuft bereits.");
    throw error;
  });
  const id = row!.id;
  running.add(id);
  cancelled.delete(id);
  // Eine Transaktion je Lauf: Scheitert er, ist nichts angelegt, und ein neuer Lauf nimmt alles mit
  const job = withActor(actor, (tx) => runPapierkramImport(tx, id, upload, progress, () => cancelled.has(id)))
    .then(() => finish(id, progress, "fertig", null))
    .catch((error: unknown) => {
      const stopped = cancelled.has(id);
      return finish(id, progress, stopped ? "abgebrochen" : "fehler", stopped ? "Abgebrochen." : progressMessage(error));
    })
    .catch((error: unknown) => console.error("Papierkram-Export: Abschluss nicht gespeichert", error))
    .finally(() => {
      running.delete(id);
      cancelled.delete(id);
    });
  if (options.wait) await job;
  return id;
}

export function cancelPapierkramImport(id: string): boolean {
  if (!running.has(id)) return false;
  cancelled.add(id);
  return true;
}
