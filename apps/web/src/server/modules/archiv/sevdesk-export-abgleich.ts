import { sql } from "drizzle-orm";
import type { SevExportVoucher } from "@haben/import";
import type { LegacySource } from "../../db/schema.ts";
import type { ReconciliationCheck } from "./lexoffice.ts";

/*
 * Abgleich je Jahr für Belege aus der Export-ZIP von sevDesk (#1106) und aus dem DATEV-Export von Papierkram. Beide liegen nur
 * zum Nachschlagen im Archiv. Ein Exportbeleg steht in einem von drei Zuständen:
 *
 * - mit Datei: Beleglink und Belegbild im Export (oder aus einem späteren Upload nachgetragen);
 * - Datei fehlt: Eintrag in document.xml, aber keine Datei im Export. Ein Fehler, wie ein Beleg aus der API ohne Datei;
 * - ohne Belegbild im Export: Kein Eintrag in document.xml, auch wenn ein Beleglink vorliegt.
 *
 * Der vierte Zustand, Buchungen ohne Beleg (Zahlung, Privat, Umbuchung), steht wie bei den anderen Quellen bei den
 * Buchungen des Stapels („ohne Belegnummer“, datevWithoutReceipt).
 *
 * Bei Ist-Versteuerung wird ein Exportjahr nicht vollständig: Der Export ordnet Zahlungen keinem Beleg zu, die
 * Umsatzsteuer je Monat lässt sich daraus nicht ableiten. Bei Soll zählt das Belegdatum.
 */

export interface ExportVoucherRow {
  source: LegacySource;
  files: number;
  ohneBelegbild: boolean;
}

/** Datei-Umzüge mit Belegen nur zum Nachschlagen, mit dem Namen ihres Exports und des Programms */
const EXPORT_SOURCES: Partial<Record<LegacySource, { label: string; product: string }>> = {
  "sevdesk-export": { label: "sevDesk-Export", product: "sevDesk" },
  papierkram: { label: "Papierkram-Export", product: "Papierkram" },
};
const isExportSource = (source: string) => source in EXPORT_SOURCES;

export interface SevdeskExportYear {
  /** Name des Exports, aus dem die Belege des Jahres stammen */
  label: string;
  withFile: number;
  missingFile: number;
  withoutImage: number;
}

const istIssue = ({ label, product }: { label: string; product: string }) =>
  `Ist-Versteuerung: Der ${label} ordnet Zahlungen keinem Beleg zu, die Umsatzsteuer je Monat lässt sich daraus nicht ableiten. Das Jahr bleibt unvollständig; vergleiche die Voranmeldungen in ${product}.`;
export const SEVDESK_EXPORT_IST_ISSUE = istIssue(EXPORT_SOURCES["sevdesk-export"]!);

/** Belege mit Belegdaten, aber ohne Belegbild im Export: brauchen keine Datei */
export const withoutExportImage = (v: ExportVoucherRow) => isExportSource(v.source) && v.ohneBelegbild && Number(v.files) === 0;

export const sevdeskExportNeedsFile = (v: SevExportVoucher) => v.document !== null || v.documentUnclear === true;

export function ohneSevdeskExportBelegbildSql(alias: string) {
  const v = sql.identifier(alias);
  // Alte sevDesk-Exporte setzten dateiFehlt auch ohne XML-Eintrag. In diesem Fall ist fileName ausdrücklich JSON-null.
  // Papierkram: ohneBelegbild heißt Buchung ohne Beleglink (papierkram-lauf.ts)
  return sql<boolean>`coalesce((${v}.source = 'sevdesk-export' and (
    ${v}.raw->'ohneBelegbild' = 'true'::jsonb
    or (${v}.raw->'dateiFehlt' = 'true'::jsonb and ${v}.raw->'fileName' = 'null'::jsonb
        and ${v}.raw->'documentUnclear' is distinct from 'true'::jsonb)
  )) or (${v}.source = 'papierkram' and ${v}.raw->'ohneBelegbild' = 'true'::jsonb), false)`;
}

/** Bei Ist in jedem Jahr mit Exportbelegen, auch im Mischjahr mit Belegen aus Lexoffice */
export const SEVDESK_EXPORT_IST_CHECK: ReconciliationCheck = {
  ok: false,
  label: "Zahlungshistorie vollständig",
  detail: "Der sevDesk-Export ordnet Zahlungen keinem Beleg zu",
};

/** Dieselbe Prüfung je Export; der Text nennt den Export des Jahres */
export const exportIstCheck = (label: string): ReconciliationCheck => ({
  ...SEVDESK_EXPORT_IST_CHECK,
  detail: `Der ${label} ordnet Zahlungen keinem Beleg zu`,
});

/** Zahlen der Exportbelege eines Jahres; null, wenn das Jahr keine hat */
export function sevdeskExportYear(yearRows: ExportVoucherRow[]): SevdeskExportYear | null {
  const rows = yearRows.filter((v) => isExportSource(v.source));
  if (rows.length === 0) return null;
  const withFile = rows.filter((v) => Number(v.files) > 0).length;
  const withoutImage = rows.filter(withoutExportImage).length;
  return { label: EXPORT_SOURCES[rows[0]!.source]!.label, withFile, withoutImage, missingFile: rows.length - withFile - withoutImage };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Ersetzt „Belege und Rechnungen per API abgerufen“ in einem Jahr nur aus dem Export */
export function sevdeskExportChecks(year: SevdeskExportYear): ReconciliationCheck[] {
  const total = year.withFile + year.missingFile + year.withoutImage;
  return [
    {
      ok: true,
      label: `Belege aus dem ${year.label} übernommen`,
      detail: [
        plural(total, "Beleg", "Belege"),
        `${year.withFile} mit Datei`,
        year.withoutImage > 0 ? `${year.withoutImage} ohne Belegbild im Export` : "",
        year.missingFile > 0 ? `${plural(year.missingFile, "Datei fehlt", "Dateien fehlen")} im Export` : "",
      ]
        .filter(Boolean)
        .join(", "),
    },
  ];
}

/** Bei Ist: Hat das Jahr Belege aus dem Export, hängen Zahlungen an keinem Beleg; die Umsatzsteuer je Monat fehlt */
export function sevdeskExportIstIssue(versteuerung: string, rows: readonly { source: string; date: string }[], year: number): string | null {
  if (versteuerung !== "ist") return null;
  const row = rows.find((v) => isExportSource(v.source) && v.date.startsWith(`${year}-`));
  return row ? istIssue(EXPORT_SOURCES[row.source as LegacySource]!) : null;
}

/** Woher die Belege eines Jahres kommen: nur aus der Export-ZIP deren Prüfungen, sonst die Prüfung auf Belege per API */
export function voucherSourceChecks(input: {
  sevdeskExport: SevdeskExportYear | null;
  apiVouchers: number;
  yearRows: readonly { source: string; ohneBeleg: boolean }[];
  withoutReceipt: number;
}): ReconciliationCheck[] {
  const { sevdeskExport, apiVouchers, yearRows, withoutReceipt } = input;
  if (sevdeskExport && apiVouchers === 0) return sevdeskExportChecks(sevdeskExport);
  return [
    {
      ok: apiVouchers > 0 || yearRows.some((v) => v.source === "buchhaltungsbutler"),
      label: "Belege und Rechnungen per API abgerufen",
      detail: [
        `${yearRows.filter((v) => !v.ohneBeleg).length} Belege`,
        withoutReceipt > 0 ? `${withoutReceipt} ${withoutReceipt === 1 ? "Buchung" : "Buchungen"} ohne Beleg` : "",
      ]
        .filter(Boolean)
        .join(", "),
    },
  ];
}
