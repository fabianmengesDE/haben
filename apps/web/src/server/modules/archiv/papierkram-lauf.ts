import { pkArchiveVoucher, type PkVoucher } from "@haben/import";
import { eq } from "drizzle-orm";
import { schema, type Tx } from "../../db/index.ts";
import type { LexofficeImportProgress, PapierkramProgress } from "../../db/schema.ts";
import { sniff } from "../../storage.ts";
import { storeOriginal, storeStack } from "./export-ablage.ts";
import { attachVoucherFiles, storeLegacyVoucher } from "./legacy-store.ts";
import { progressMessage } from "./lexoffice.ts";
import type { StagedPapierkramExport } from "./papierkram.ts";

/*
 * Der Lauf mit dem DATEV-Export von Papierkram, in einer Transaktion. Alles nur anhängend:
 *
 * 1. Jede ZIP „Belegbilder“ als Original unter „Sonstiges“, jeder Buchungsstapel als DATEV-Buchungsstapel mit seinen
 *    Zeilen in datev_bookings. Liegt eine Datei schon im Archiv (gleiche Prüfsumme), bleibt es dabei; belegt ein anderer
 *    Stapel den Zeitraum schon, legt der Lauf den Stapel nicht an (export-ablage.ts).
 * 2. Je Beleg ein Archivbeleg (lexoffice_vouchers, Quelle papierkram, Schlüssel die Belegnummer) mit dem Belegbild.
 *    Ein zweiter Lauf überspringt Bekanntes und hängt höchstens ein fehlendes Belegbild an, etwa wenn die ZIP eines
 *    Jahres später kommt.
 *
 * Offene Posten legt der Lauf nicht an: Der Export kennt keine Zahlungen. Summen und Umsatzsteuer der Jahre kommen aus dem
 * Buchungsstapel (ARCHIVE_ONLY_SOURCES in lexoffice.ts).
 */

export async function runPapierkramImport(
  tx: Tx,
  importId: string,
  upload: StagedPapierkramExport,
  progress: LexofficeImportProgress,
  cancelled: () => boolean,
) {
  let lastSave = 0;
  const save = async (force = false) => {
    if (!force && Date.now() - lastSave < 1000) return;
    lastSave = Date.now();
    await tx.update(schema.lexofficeImports).set({ progress, updatedAt: new Date() }).where(eq(schema.lexofficeImports.id, importId));
  };
  const result = progress.papierkram!;
  const run = importId.slice(0, 8);

  // 1. Originale
  const stackNames = new Set(upload.export.stacks.map((s) => s.name));
  result.archivedFileIds = [];
  for (const file of upload.files.filter((f) => !stackNames.has(f.name))) {
    const year = Number(/(\d{4})/.exec(file.name)?.[1]) || null;
    result.archivedFileIds.push(
      await storeOriginal(tx, { filename: file.name, bytes: file.bytes, mimeType: "application/zip" }, year, `Papierkram-Export „Belegbilder“, Lauf ${run}`),
    );
  }
  result.stackFileIds = [];
  for (const stack of upload.export.stacks) {
    const id = await storeStack(tx, stack, `Aus dem Papierkram-Export, Lauf ${run}`);
    if (id) result.stackFileIds.push(id);
  }
  await save(true);

  // 2. Belege
  for (const voucher of upload.export.vouchers) {
    if (cancelled()) throw new Error("Abgebrochen.");
    try {
      const outcome = await storeVoucher(tx, importId, voucher);
      if (outcome.created) progress.imported += 1;
      else progress.skipped += 1;
      progress.files += outcome.files;
    } catch (error) {
      progress.failed.push({ lexofficeId: `papierkram/${voucher.number}`, number: voucher.number, message: progressMessage(error) });
    }
    await save();
  }
  result.note = noteFor(result);
  await save(true);
}

function noteFor(r: PapierkramProgress): string {
  return [
    r.stacks.some((s) => s.state === "vorhanden") ? "Ein Buchungsstapel lag schon im Archiv; seine Buchungen sind nicht doppelt angelegt." : "",
    ...r.stacks
      .filter((s) => s.state === "zeitraum")
      .map((s) => `${s.name} nicht angelegt: Der Zeitraum ${s.from} bis ${s.to} liegt schon mit ${s.other} im Archiv.`),
    r.missingFile > 0 ? `${r.missingFile} Beleg(e) ohne Belegbild: Lade die ZIP „Belegbilder“ dieser Jahre nach, ein neuer Lauf hängt sie an.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Was zum Nachweis am Beleg steht: die Zeilen des Stapels und die Datei im Export */
function rawOf(voucher: PkVoucher) {
  const row = ({ stack, booking }: { stack: string; booking: PkVoucher["lines"][number]["booking"] }) => ({
    stack,
    row: booking.row,
    account: booking.account,
    contraAccount: booking.contraAccount,
    side: booking.side,
    buKey: booking.buKey,
    amount: booking.amount,
    date: booking.date,
    text: booking.text,
  });
  return {
    guid: voucher.guid,
    kind: voucher.kind,
    partnerNumber: voucher.partnerNumber,
    storno: voucher.storno,
    cancelledOn: voucher.cancelledOn,
    lines: voucher.lines.map((l) => ({ ...row(l), lineKind: l.kind, accountName: l.accountName, generalumkehr: l.storno, rate: l.rate })),
    depreciation: voucher.depreciation.map(row),
    fileName: voucher.file?.fileName ?? null,
    archive: voucher.file?.archive ?? null,
    dateiFehlt: voucher.guid !== null && voucher.file === null,
    ohneBelegbild: voucher.guid === null,
  };
}

async function storeVoucher(tx: Tx, importId: string, voucher: PkVoucher): Promise<{ created: boolean; files: number }> {
  const archive = pkArchiveVoucher(voucher);
  const files = voucher.file
    ? [
        {
          role: "pdf" as const,
          sourceFileId: voucher.file.guid,
          filename: voucher.file.fileName,
          mimeType: sniff(voucher.file.bytes)?.mimeType ?? "application/octet-stream",
          bytes: voucher.file.bytes,
        },
      ]
    : [];
  const stored = await storeLegacyVoucher(
    tx,
    {
      lexofficeId: archive.externalId,
      source: "papierkram",
      importId,
      type: archive.type,
      direction: archive.direction,
      number: archive.number,
      date: archive.date,
      status: archive.status,
      contactName: voucher.contactName,
      currency: "EUR",
      net: archive.net,
      tax: archive.tax,
      gross: archive.gross,
      taxes: [{ rate: archive.rate, net: archive.net, tax: archive.tax }],
      categories: [],
      payment: null,
      remark: archive.remark,
      raw: rawOf(voucher),
    },
    files,
  );
  if (stored) return { created: true, files: stored.files };
  // Schon da: höchstens das Belegbild nachtragen
  const [row] = await tx
    .select({ id: schema.lexofficeVouchers.id })
    .from(schema.lexofficeVouchers)
    .where(eq(schema.lexofficeVouchers.lexofficeId, archive.externalId));
  return { created: false, files: row ? await attachVoucherFiles(tx, row.id, files) : 0 };
}
