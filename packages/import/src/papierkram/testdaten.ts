import { readFileSync } from "node:fs";
import { strToU8, zipSync, type Zippable } from "fflate";

/*
 * Baut für die Tests einen DATEV-Export von Papierkram nach. Die beiden Kopfzeilen (test-fixtures/papierkram/kopf.csv)
 * stammen Byte für Byte aus einem echten Export (Windows-1252, CRLF), nur der Erstellungszeitpunkt ist ersetzt. Die
 * Buchungen sind erfunden und stehen in den Spalten, die Papierkram füllt.
 */

const KOPF = new Uint8Array(readFileSync(new URL("../../test-fixtures/papierkram/kopf.csv", import.meta.url)));

export interface Zeile {
  betrag: string;
  seite: "S" | "H";
  konto: string;
  gegenkonto: string;
  bu?: string;
  /** TTMM wie im Export */
  datum: string;
  beleg: string;
  text?: string;
  guid?: string;
  kundennummer?: string;
  kontobezeichnung?: string;
  generalumkehr?: boolean;
}

const latin1 = (text: string) => new Uint8Array(Buffer.from(text, "latin1"));
const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;

/** Ein Stapel für ein Jahr mit den Spalten in der Reihenfolge der echten Spaltenzeile */
export function stapel(jahr: number, zeilen: Zeile[]): Uint8Array {
  const kopf = Buffer.from(KOPF).toString("latin1").replace("20260101;4;20260101;20261231", `${jahr}0101;4;${jahr}0101;${jahr}1231`);
  const spalten = kopf.split("\r\n")[1]!.split(";");
  const at = (name: string) => {
    // Umlaute und der Halbgeviertstrich stehen als Windows-1252-Bytes in der Zeile; verglichen wird mit „?“ an ihrer Stelle
    const index = spalten.findIndex((s) => s.replace(/[^\x20-\x7e]/g, "?").startsWith(name));
    if (index === -1) throw new Error(`Spalte ${name} fehlt`);
    return index;
  };
  const rows = zeilen.map((z) => {
    const f: string[] = spalten.map(() => "");
    f[at("Umsatz")] = z.betrag;
    f[at("Soll/Haben")] = quote(z.seite);
    f[at("Konto")] = z.konto;
    f[at("Gegenkonto")] = z.gegenkonto;
    f[at("BU-Schl")] = z.bu ? quote(z.bu) : "";
    f[at("Belegdatum")] = z.datum;
    f[at("Belegfeld 1")] = quote(z.beleg);
    f[at("Buchungstext")] = quote(z.text ?? "Position");
    f[at("Postensperre")] = "0";
    if (z.guid) f[at("Beleglink")] = quote(`BEDI "${z.guid}"`);
    const info = [["Belegnummer", z.beleg], ["Name", z.text ?? "Position"], ...(z.kundennummer ? [["Kundennummer", z.kundennummer]] : [])];
    info.forEach(([art, inhalt], i) => {
      f[at(`Beleginfo ? Art ${i + 1}`)] = quote(art!);
      f[at(`Beleginfo ? Inhalt ${i + 1}`)] = quote(inhalt!);
    });
    if (z.kontobezeichnung) {
      f[at("Zusatzinformation ? Art 1")] = quote("Kontobezeichnung");
      f[at("Zusatzinformation ? Inhalt 1")] = quote(z.kontobezeichnung);
    }
    if (z.generalumkehr) f[at("Generalumkehr")] = quote("1");
    return f.join(";");
  });
  return latin1(`${kopf}${rows.join("\r\n")}\r\n`);
}

export const pdf = (guid: string) => strToU8(`%PDF-1.4 ${guid}`);

/** ZIP „Belegbilder“: flach, document.xml und je GUID eine PDF; `ohne` lässt Dateien weg */
export function belegbilder(guids: string[], ohne: string[] = [], system = "Papierkram"): Uint8Array {
  const documents = guids.map((g) => `    <document guid="${g}">\n      <extension xsi:type="File" name="${g}.pdf" />\n    </document>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<archive xmlns="http://xml.datev.de/bedi/tps/document/v06.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="6.0" generatingSystem="${system}">
  <header><date>2026-01-01T12:00:00</date></header>
  <content>
${documents}
  </content>
</archive>`;
  const files: Zippable = { "document.xml": strToU8(xml) };
  for (const g of guids) if (!ohne.includes(g)) files[`${g}.pdf`] = pdf(g);
  return zipSync(files);
}

export const guid = (n: number) => `00000000-0000-5000-8000-${String(n).padStart(12, "0")}`;
