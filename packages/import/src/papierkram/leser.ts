import { isDatevFile, parseDatevBuchungsstapel } from "../datev.ts";
import { parseDocumentXml } from "../sevdesk/export/document-xml.ts";
import { baseName, DEFAULT_LIMITS, unzipLimited, type Budget } from "../sevdesk/export/entpacken.ts";
import { buildVouchers } from "./belege.ts";
import type { PkExportOptions, PkExportResult, PkFile, PkStack, PkUpload } from "./types.ts";

/*
 * Liest den DATEV-Export von Papierkram (Auswertungen › DATEV Export), ohne Datenbank. Je Zeitraum gibt es zwei Dateien:
 * - „Buchungsstapel“: `EXTF_Buchungsstapel_Gesamt_vom_<von>_bis_<bis>_<Konto>.csv`, Windows-1252, Herkunft „PK“ und
 *   „Papierkram.de“ im Kopf. Den Kontenrahmen lässt Papierkram dort leer.
 * - „Belegbilder“: `DATEV_Belegbilder_vom_<von>_bis_<bis>_<Konto>.zip`, flach mit `document.xml` (DATEV-XML-Schnittstelle,
 *   `generatingSystem="Papierkram"`) und je Beleg `<GUID>.pdf`. Die GUID steht im Beleglink der Buchung (`BEDI "<GUID>"`).
 * Mehrere Jahre dürfen zusammen kommen; ein Beleg kann über den Jahreswechsel gehen (Storno im Folgejahr).
 */

const PAPIERKRAM = /"(PK|Papierkram\.de)"/;

function firstLine(bytes: Uint8Array): string {
  const end = bytes.indexOf(0x0a);
  return new TextDecoder("latin1").decode(bytes.subarray(0, end === -1 ? Math.min(bytes.length, 2000) : end));
}

function readStack(name: string, bytes: Uint8Array, options: PkExportOptions, hints: string[]): PkStack | string {
  if (!PAPIERKRAM.test(firstLine(bytes))) return `${name}: Der Buchungsstapel stammt nicht aus Papierkram (Herkunft im Kopf fehlt).`;
  let stack: PkStack["stack"];
  try {
    stack = parseDatevBuchungsstapel(bytes);
  } catch (error) {
    return `${name}: ${error instanceof Error ? error.message : String(error)}`;
  }
  hints.push(...stack.warnings.map((w) => `${name}: ${w}`));
  const fromHeader = stack.header.kontenrahmen === "SKR03" || stack.header.kontenrahmen === "SKR04" ? stack.header.kontenrahmen : null;
  return { name, bytes, stack, kontenrahmen: fromHeader ?? options.kontenrahmen };
}

function readImages(name: string, bytes: Uint8Array, budget: Budget, files: Map<string, PkFile>, hints: string[]): string | null {
  const unzipped = unzipLimited(bytes, budget, () => true);
  if (!unzipped.ok) return `${name}: ${unzipped.reason}`;
  const xml = Object.keys(unzipped.files).find((path) => baseName(path).toLowerCase() === "document.xml");
  if (!xml) return `${name}: document.xml fehlt; das ist keine ZIP „Belegbilder“ aus Papierkram.`;
  const parsed = parseDocumentXml(unzipped.files[xml]!, name, "Papierkram");
  if (!parsed.ok) return parsed.reason;
  hints.push(...parsed.hints);
  for (const document of parsed.documents) {
    const path = Object.keys(unzipped.files).find((p) => baseName(p) === document.fileName);
    if (!path) {
      hints.push(`${name}: Datei ${document.fileName} steht in document.xml, fehlt aber in der ZIP.`);
      continue;
    }
    if (!files.has(document.guid)) files.set(document.guid, { guid: document.guid, fileName: document.fileName, archive: name, bytes: unzipped.files[path]! });
  }
  return null;
}

/** Zwei Stapel mit überlappendem Zeitraum würden Belege doppelt zählen */
function overlap(stacks: PkStack[]): string | null {
  const ranges = stacks
    .map((s) => ({ name: s.name, from: s.stack.header.dateFrom ?? "", to: s.stack.header.dateTo ?? "" }))
    .sort((a, b) => a.from.localeCompare(b.from));
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i]!.from !== "" && ranges[i]!.from <= ranges[i - 1]!.to) return `${ranges[i - 1]!.name} und ${ranges[i]!.name} überschneiden sich im Zeitraum.`;
  }
  return null;
}

export function readPapierkramExport(uploads: PkUpload[], options: PkExportOptions): PkExportResult {
  const budget: Budget = { limits: DEFAULT_LIMITS, entries: 0, bytes: 0 };
  const hints: string[] = [];
  const stacks: PkStack[] = [];
  const files = new Map<string, PkFile>();
  for (const { name, bytes } of uploads) {
    if (isDatevFile(bytes)) {
      const stack = readStack(name, bytes, options, hints);
      if (typeof stack === "string") return { ok: false, reason: stack };
      stacks.push(stack);
    } else {
      const error = readImages(name, bytes, budget, files, hints);
      if (error) return { ok: false, reason: error };
    }
  }
  if (stacks.length === 0) return { ok: false, reason: "Es fehlt der Buchungsstapel (EXTF_Buchungsstapel_….csv) aus Papierkram." };
  const clash = overlap(stacks);
  if (clash) return { ok: false, reason: clash };
  const { vouchers, orphanFiles } = buildVouchers(stacks, files, options, hints);
  return { ok: true, export: { stacks, vouchers, orphanFiles, hints } };
}
