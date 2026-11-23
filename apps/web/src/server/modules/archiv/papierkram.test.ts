import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { belegbilder, guid, stapel, type Zeile } from "../../../../../../packages/import/src/papierkram/testdaten.ts";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Lauf mit dem DATEV-Export von Papierkram: Buchungsstapel und Belegbilder eines Jahres. Eine Einnahme mit Automatik, eine
 * Ausgabe mit Schlüssel 401 und eine stornierte Einnahme, für SKR03 und SKR04 mit den Konten des jeweiligen Rahmens.
 */

type Kontenrahmen = "SKR03" | "SKR04";
const KONTEN: Record<Kontenrahmen, { erloes: string; aufwand: string; geld: string }> = {
  SKR03: { erloes: "8400", aufwand: "4930", geld: "1360" },
  SKR04: { erloes: "4400", aufwand: "6815", geld: "1460" },
};

function zeilen(kontenrahmen: Kontenrahmen): Zeile[] {
  const { erloes, aufwand, geld } = KONTEN[kontenrahmen];
  return [
    { betrag: "1190,00", seite: "H", konto: erloes, gegenkonto: geld, datum: "1604", beleg: "B-00002", guid: guid(2), text: "Provision April" },
    { betrag: "119,00", seite: "S", konto: aufwand, gegenkonto: geld, bu: "401", datum: "0501", beleg: "B-00001", guid: guid(1), text: "Büromaterial" },
    { betrag: "500,00", seite: "H", konto: erloes, gegenkonto: geld, datum: "1901", beleg: "B-00003", guid: guid(3) },
    { betrag: "500,00", seite: "S", konto: erloes, gegenkonto: geld, datum: "2501", beleg: "B-00003", guid: guid(3), generalumkehr: true },
    // Abschreibung zum Jahresende auf die Anschaffung B-00001, ohne Beleglink
    {
      betrag: "100,00",
      seite: "S",
      konto: kontenrahmen === "SKR03" ? "4855" : "6260",
      gegenkonto: kontenrahmen === "SKR03" ? "0480" : "0670",
      datum: "3112",
      beleg: "Ref-B-00001",
    },
  ];
}

const CSV = "EXTF_Buchungsstapel_Gesamt_vom_01_01_2026_bis_31_12_2026_test.csv";
const ZIP = "DATEV_Belegbilder_vom_01_01_2026_bis_31_12_2026_test.zip";

describe.skipIf(!testDatabaseUrl)("Papierkram: DATEV-Export übernehmen (Postgres)", () => {
  let pk: typeof import("./papierkram.ts");
  let lex: typeof import("./lexoffice.ts");
  let open: typeof import("./legacy-open.ts");
  let sql: postgres.Sql;
  const actor = "test-user";

  beforeAll(async () => {
    sql = await setupTestDb();
    pk = await import("./papierkram.ts");
    lex = await import("./lexoffice.ts");
    open = await import("./legacy-open.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  async function company(kontenrahmen: Kontenrahmen = "SKR03", versteuerung: "ist" | "soll" = "soll") {
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from datev_bookings`;
      await tx`delete from archive_files`;
    });
    await leeren(sql)`truncate lexoffice_voucher_files, lexoffice_vouchers, lexoffice_imports, contacts, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, kontenrahmen, versteuerung, rechtsform)
      values (1, 'Nordlicht', 'Hafenallee 3', '28217', 'Bremen', 'rechnung@example.com', '60/145/12345', 'HB', ${kontenrahmen}, ${versteuerung}, 'einzelunternehmen')`;
  }

  const files = (kontenrahmen: Kontenrahmen, ohne: string[] = []) => [
    { name: CSV, bytes: stapel(2026, zeilen(kontenrahmen)) },
    { name: ZIP, bytes: belegbilder([guid(1), guid(2), guid(3)], ohne) },
  ];

  async function run(upload: { name: string; bytes: Uint8Array }[]) {
    await pk.analysePapierkramExport(upload);
    const id = await pk.startPapierkramImport(actor, { wait: true });
    return (await pk.papierkramImportStatus(id))!;
  }

  beforeEach(() => company());

  it("analysiert, ohne etwas anzulegen, und lehnt Fremdes ab", async () => {
    const analysis = await pk.analysePapierkramExport(files("SKR03"));
    expect(analysis).toMatchObject({ years: [2026], bookings: 5, vouchers: 3, withFile: 3, missingFile: 0, cancelled: 1 });
    expect(analysis.stacks).toEqual([{ name: CSV, from: "2026-01-05", to: "2026-12-31", state: "neu" }]);
    const n = (await sql`select count(*)::int as n from lexoffice_vouchers`)[0]!.n;
    expect(n).toBe(0);
    await expect(pk.analysePapierkramExport([{ name: ZIP, bytes: belegbilder([guid(1)]) }])).rejects.toThrow(/Buchungsstapel/);
    await expect(pk.startPapierkramImport(actor)).rejects.toThrow("Zuerst den Export hochladen.");
  });

  it.each([
    ["SKR03", "soll"],
    ["SKR04", "ist"],
  ] as const)("übernimmt Belege mit Belegbild, Stapel und Storno (%s, %s)", async (kontenrahmen, versteuerung) => {
    await company(kontenrahmen, versteuerung);
    const result = await run(files(kontenrahmen));
    expect(result).toMatchObject({ status: "fertig", progress: { imported: 3, skipped: 0, files: 3 } });
    const rows = await sql`select lexoffice_id, type, direction, status, gross, tax, source,
        (select count(*)::int from lexoffice_voucher_files f where f.voucher_id = v.id) as files
      from lexoffice_vouchers v order by lexoffice_id`;
    expect(rows.map((r) => ({ ...r }))).toEqual([
      {
        lexoffice_id: "papierkram/B-00001",
        type: "purchaseinvoice",
        direction: "ausgabe",
        status: "unchecked",
        gross: 11900,
        tax: 1900,
        source: "papierkram",
        files: 1,
      },
      {
        lexoffice_id: "papierkram/B-00002",
        type: "salesinvoice",
        direction: "einnahme",
        status: "unchecked",
        gross: 119000,
        tax: 19000,
        source: "papierkram",
        files: 1,
      },
      {
        lexoffice_id: "papierkram/B-00003",
        type: "salesinvoice",
        direction: "einnahme",
        status: "voided",
        gross: 50000,
        tax: 7983,
        source: "papierkram",
        files: 1,
      },
    ]);
    const bookings = (await sql`select count(*)::int as bookings from datev_bookings`)[0]!.bookings;
    expect(bookings).toBe(5);

    // Abgleich: Belege aus dem Export statt „per API“, bei Ist bleibt die Zahlungshistorie offen
    const year = (await lex.reconciliation()).years.find((y) => y.year === 2026)!;
    expect(year.checks.find((c) => c.label === "Belege aus dem Papierkram-Export übernommen")?.detail).toBe("3 Belege, 3 mit Datei");
    expect(year.checks.some((c) => c.label === "Belege und Rechnungen per API abgerufen")).toBe(false);
    // Die Abschreibung (Ref-B-00001) findet den Beleg der Anschaffung
    expect(year.checks.find((c) => c.label === "Jede Buchung mit Belegnummer findet ihren Beleg")).toMatchObject({ ok: true });
    if (versteuerung === "ist") expect(year.vatIssue).toMatch(/Papierkram-Export ordnet Zahlungen keinem Beleg zu/);
    else expect(year.vatIssue ?? "").not.toMatch(/ordnet Zahlungen/);

    // Ohne Zahlungsstand keine offenen Posten
    expect(await open.openLegacyItems()).toEqual([]);
  });

  it("überspringt Bekanntes und hängt ein später geliefertes Belegbild an", async () => {
    const first = await run(files("SKR03", [guid(2)]));
    expect(first).toMatchObject({ status: "fertig", progress: { imported: 3, files: 2 }, papierkram: { missingFile: 1 } });
    expect(first.papierkram?.note).toMatch(/1 Beleg\(e\) ohne Belegbild/);
    const second = await run(files("SKR03"));
    expect(second).toMatchObject({ status: "fertig", progress: { imported: 0, skipped: 3, files: 1 } });
    expect(second.papierkram?.stacks[0]?.state).toBe("vorhanden");
    const n = (await sql`select count(*)::int as n from lexoffice_voucher_files`)[0]!.n;
    expect(n).toBe(3);
  });
});
