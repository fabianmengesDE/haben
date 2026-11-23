import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { readPapierkramExport } from "./leser.ts";
import { belegbilder, guid, pdf, stapel, type Zeile } from "./testdaten.ts";
import type { PkExport, PkUpload } from "./types.ts";

/*
 * DATEV-Export von Papierkram: Buchungsstapel und Belegbilder je Jahr. Kleinunternehmer bis Ende 2025, danach
 * Regelbesteuerung, wie im echten Bestand, nach dem der Aufbau gebaut ist (siehe belege.ts).
 */

const options = { kontenrahmen: "SKR03" as const, kleinunternehmerAm: (date: string) => date < "2026-01-01" };

function read(uploads: PkUpload[]): PkExport {
  const result = readPapierkramExport(uploads, options);
  if (!result.ok) throw new Error(result.reason);
  return result.export;
}

const csv = (jahr: number, zeilen: Zeile[]): PkUpload => ({
  name: `EXTF_Buchungsstapel_Gesamt_vom_01_01_${jahr}_bis_31_12_${jahr}_test.csv`,
  bytes: stapel(jahr, zeilen),
});
const zip = (jahr: number, guids: string[], ohne: string[] = []): PkUpload => ({
  name: `DATEV_Belegbilder_vom_01_01_${jahr}_bis_31_12_${jahr}_test.zip`,
  bytes: belegbilder(guids, ohne),
});
const beleg = (data: PkExport, number: string) => {
  const found = data.vouchers.find((v) => v.number === number);
  if (!found) throw new Error(`Beleg ${number} fehlt`);
  return found;
};

describe("Belege aus dem Buchungsstapel", () => {
  it("führt Rechnungspositionen zu einem Beleg mit Belegbild zusammen", () => {
    const data = read([
      csv(2022, [
        { betrag: "55,00", seite: "H", konto: "8195", gegenkonto: "1800", datum: "1212", beleg: "R-00001", guid: guid(1), kundennummer: "K-00002" },
        { betrag: "5,49", seite: "H", konto: "8195", gegenkonto: "1800", datum: "1212", beleg: "R-00001", guid: guid(1), kundennummer: "K-00002" },
      ]),
      zip(2022, [guid(1)]),
    ]);
    expect(data.vouchers).toHaveLength(1);
    expect(beleg(data, "R-00001")).toMatchObject({
      kind: "rechnung",
      direction: "einnahme",
      date: "2022-12-12",
      gross: 6049,
      tax: 0,
      partnerNumber: "K-00002",
      storno: null,
      file: { guid: guid(1), bytes: pdf(guid(1)) },
    });
  });

  it("bucht als Kleinunternehmer keine Vorsteuer, auch auf dem Automatikkonto Wareneingang", () => {
    const data = read([
      csv(2022, [
        { betrag: "32,00", seite: "S", konto: "3400", gegenkonto: "1890", datum: "1711", beleg: "B-00013", kontobezeichnung: "Wareneingang 19% Vorsteuer" },
      ]),
    ]);
    expect(beleg(data, "B-00013")).toMatchObject({ direction: "ausgabe", gross: 3200, tax: 0, net: 3200, rate: 0 });
  });

  it("rechnet nach der Kleinunternehmerzeit Steuer aus Schlüssel 401 und aus der Automatik in der Kontobezeichnung", () => {
    const data = read([
      csv(2026, [
        { betrag: "119,00", seite: "S", konto: "4930", gegenkonto: "1890", bu: "401", datum: "0501", beleg: "B-00001" },
        { betrag: "1190,00", seite: "H", konto: "8519", gegenkonto: "1800", datum: "1604", beleg: "B-00002", kontobezeichnung: "Provisionserlöse 19% USt" },
        { betrag: "49,98", seite: "S", konto: "4945", gegenkonto: "1890", bu: "490", datum: "0801", beleg: "B-00003" },
      ]),
    ]);
    expect(beleg(data, "B-00001")).toMatchObject({ direction: "ausgabe", gross: 11900, tax: 1900, net: 10000, rate: 1900 });
    expect(beleg(data, "B-00002")).toMatchObject({ direction: "einnahme", gross: 119000, tax: 19000, rate: 1900 });
    expect(beleg(data, "B-00003")).toMatchObject({ gross: 4998, tax: 0 });
  });

  it("weist bei § 13b (Schlüssel 506) keine Steuer am Beleg aus", () => {
    const data = read([csv(2026, [{ betrag: "77,35", seite: "S", konto: "4930", gegenkonto: "1890", bu: "506", datum: "1806", beleg: "B-00373" }])]);
    expect(beleg(data, "B-00373")).toMatchObject({ gross: 7735, tax: 0 });
  });

  it("erkennt ein Storno mit Generalumkehr und behält den Betrag des Originals", () => {
    const data = read([
      csv(2026, [
        { betrag: "1670,08", seite: "H", konto: "8514", gegenkonto: "1800", datum: "1901", beleg: "B-00345" },
        { betrag: "1670,08", seite: "S", konto: "8514", gegenkonto: "1890", datum: "2501", beleg: "B-00345", generalumkehr: true },
      ]),
    ]);
    expect(beleg(data, "B-00345")).toMatchObject({ direction: "einnahme", gross: 167008, storno: "storniert", date: "2026-01-19", cancelledOn: "2026-01-25" });
  });

  it("verbindet Original und Storno über den Jahreswechsel und meldet ein Storno ohne Original", () => {
    const original = csv(2025, [{ betrag: "110,00", seite: "S", konto: "4900", gegenkonto: "1890", bu: "490", datum: "0405", beleg: "B-00335" }]);
    const storno = csv(2026, [
      { betrag: "110,00", seite: "H", konto: "4900", gegenkonto: "1800", bu: "490", datum: "0405", beleg: "B-00335", generalumkehr: true },
    ]);
    expect(beleg(read([original, storno]), "B-00335")).toMatchObject({ direction: "ausgabe", gross: 11000, storno: "storniert", date: "2025-05-04" });
    const allein = read([storno]);
    expect(beleg(allein, "B-00335")).toMatchObject({ direction: "ausgabe", gross: 11000, storno: "nur-storno" });
    expect(allein.hints).toContain("Beleg B-00335: nur das Storno ist hochgeladen, das Original fehlt (anderes Jahr?).");
  });

  it("zählt einen Privatanteil nicht zum gezahlten Betrag", () => {
    const data = read([
      csv(2026, [
        { betrag: "10,00", seite: "S", konto: "4920", gegenkonto: "1890", bu: "401", datum: "0705", beleg: "B-00377" },
        { betrag: "5,00", seite: "H", konto: "8922", gegenkonto: "4920", datum: "0705", beleg: "B-00377" },
      ]),
    ]);
    const telefon = beleg(data, "B-00377");
    expect(telefon).toMatchObject({ direction: "ausgabe", gross: 1000, tax: 160 });
    expect(telefon.lines.map((l) => l.kind)).toEqual(["geld", "intern"]);
  });

  it("hängt die Abschreibung (Ref-) an die Anschaffung", () => {
    const data = read([
      csv(2026, [
        { betrag: "662,60", seite: "S", konto: "0490", gegenkonto: "1890", bu: "401", datum: "2107", beleg: "B-00381" },
        { betrag: "556,81", seite: "S", konto: "4830", gegenkonto: "0490", datum: "3112", beleg: "Ref-B-00381" },
      ]),
    ]);
    const anschaffung = beleg(data, "B-00381");
    expect(anschaffung).toMatchObject({ direction: "ausgabe", gross: 66260, tax: 10579 });
    expect(anschaffung.depreciation).toHaveLength(1);
    expect(data.vouchers).toHaveLength(1);
  });
});

describe("Dateien des Exports", () => {
  const eine = [{ betrag: "5,49", seite: "S" as const, konto: "4910", gegenkonto: "1890", bu: "490", datum: "0509", beleg: "B-00026", guid: guid(26) }];

  it("meldet fehlende Belegbilder je Jahr und Dateien ohne Buchung", () => {
    const ohneZip = read([csv(2022, eine)]);
    expect(ohneZip.hints).toContain("2022: 1 Belegbilder fehlen; lade die ZIP „Belegbilder“ für dieses Jahr hoch.");
    const mitFremder = read([csv(2022, eine), zip(2022, [guid(26), guid(99)])]);
    expect(mitFremder.orphanFiles.map((f) => f.guid)).toEqual([guid(99)]);
    expect(beleg(mitFremder, "B-00026").file?.guid).toBe(guid(26));
  });

  it("lehnt Stapel aus einem anderen Programm, eine fremde ZIP und überlappende Zeiträume ab", () => {
    const fremd = new TextDecoder("latin1").decode(stapel(2022, eine)).replace('"PK";"Papierkram.de"', '"SD";"sevDesk"');
    const fremderStapel = { name: "EXTF_fremd.csv", bytes: new Uint8Array(Buffer.from(fremd, "latin1")) };
    expect(readPapierkramExport([fremderStapel], options)).toMatchObject({ ok: false, reason: expect.stringContaining("nicht aus Papierkram") });
    const sevdeskZip = { name: "DATEV_Belegbilder.zip", bytes: belegbilder([guid(1)], [], "sevDesk") };
    expect(readPapierkramExport([csv(2022, eine), sevdeskZip], options)).toMatchObject({ ok: false, reason: expect.stringContaining("nicht von Papierkram") });
    const ohneXml = { name: "andere.zip", bytes: zipSync({ "a.pdf": strToU8("%PDF") }) };
    expect(readPapierkramExport([csv(2022, eine), ohneXml], options)).toMatchObject({ ok: false, reason: expect.stringContaining("document.xml fehlt") });
    expect(readPapierkramExport([csv(2022, eine), csv(2022, eine)], options)).toMatchObject({ ok: false, reason: expect.stringContaining("überschneiden") });
    expect(readPapierkramExport([zip(2022, [guid(1)])], options)).toMatchObject({ ok: false, reason: expect.stringContaining("Buchungsstapel") });
  });
});
