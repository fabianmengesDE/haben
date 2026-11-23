import { type Kontenrahmen, LEGACY_PAYMENT_TYPES, legacyNeutralSums, legacyVatByMonth, type Versteuerung } from "@haben/core";
import { datevYearSums } from "@haben/import";
import { paymentHistoryIssue, unclearFrom } from "../auswertungen/index.ts";
import type { LegacyPayment, LegacySource } from "../../db/schema.ts";
import { fileCheck, fileCounts, legacyFileStatus, OPEN_FILE_STATUSES } from "./dateistand.ts";
import { bookingsCheckDetail } from "./datev-abgleich.ts";
import { fastbillPartlyCanceledChecks, fastbillWaitingChecks } from "./fastbill-abgleich.ts";
import type { AbgleichArchiv, AbgleichBelege, ReconciliationCheck } from "./lexoffice.ts";
import { exportIstCheck, sevdeskExportIstIssue, sevdeskExportYear, voucherSourceChecks, withoutExportImage } from "./sevdesk-export-abgleich.ts";
import { accountingTypeChecks, ACCOUNTING_TYPE_VAT_ISSUE, unclearAccountingTypes } from "./sevdesk-kontoart.ts";
import { vatFieldsOf } from "./sevdesk-steuerarten.ts";

/** Was der Abgleich eines Jahres braucht: die eingeordneten Belege, was sonst im Archiv liegt, Kontenrahmen und Versteuerung */
export type AbgleichDaten = AbgleichBelege & AbgleichArchiv & { kontenrahmen: Kontenrahmen; versteuerung: Versteuerung };
type Beleg = AbgleichBelege["classified"][number];

/**
 * Zahlungen, die bei Ist-Versteuerung als Entgelt zählen, mit dem Vorzeichen des Belegs (Gutschriften mindern die Umsätze).
 * Eine Zuordnung über 0 € ist keine Zahlung (#472).
 */
export function legacyPayments(v: { source: LegacySource; gross: number; status: string; payment: LegacyPayment | null }) {
  if (paymentHistoryIssue(v)) return [];
  return (v.payment?.items ?? [])
    .filter((p) => LEGACY_PAYMENT_TYPES.has(p.type) && p.date && p.amount !== 0)
    .map((p) => ({ date: p.date, amount: Math.sign(v.gross) * Math.abs(p.amount) }));
}

// Ohne Einzelzahlungen können selbst bereits vollständig bezahlte sevDesk-Rechnungen mehrere Monate betreffen.
// Gesperrt ist jedes Jahr, in das eine solche Zahlung fallen kann: bis zum Ausgleich, ohne Ausgleichsdatum alle.
function paymentIssueOf(year: number, { versteuerung, businessRows }: AbgleichDaten) {
  if (versteuerung !== "ist") return null;
  if (businessRows.some((v) => v.direction === "einnahme" && unclearFrom(v, String(year)))) {
    return "sevDesk-Zahlungshistorie unvollständig: Der Ist-Monatsabgleich ist bis zur Klärung der Einzelzahlungen gesperrt.";
  }
  return null;
}
const unclearAccountsIn = (year: number, { versteuerung, businessRows }: AbgleichDaten) =>
  unclearAccountingTypes(businessRows, year, (v) => (versteuerung === "ist" ? legacyPayments(v) : []));
const exportIstIssueOf = (year: number, { versteuerung, classified }: AbgleichDaten) => sevdeskExportIstIssue(versteuerung, classified, year);
const vatIssueOf = (year: number, d: AbgleichDaten) =>
  [paymentIssueOf(year, d), unclearAccountsIn(year, d) ? ACCOUNTING_TYPE_VAT_ISSUE : null, exportIstIssueOf(year, d)].filter(Boolean).join(" ") || null;

/** Ein Geschäftsjahr im Abgleich: Summen, Umsatzsteuer je Monat, Dateistand und was bis zur Kündigung fehlt */
export function abgleichJahr(year: number, d: AbgleichDaten) {
  const vouchers = d.businessRows.filter((v) => v.date.startsWith(`${year}-`));
  // Alle Belege des Jahres, auch neutrale: Auch ein Körperschaftsteuerbescheid braucht seine Datei
  const yearRows = d.classified.filter((v) => v.date.startsWith(`${year}-`));
  const summen = jahresSummen(year, d, vouchers, yearRows);
  // Dateistand (#345): bestätigt dateilose Belege zählen getrennt und blockieren nicht. Ein Exportbeleg ohne Belegbild
  // braucht keine Datei; er steht mit eigener Zahl im Abgleich (#1106)
  const fileStatuses = yearRows.filter((v) => !withoutExportImage(v)).map((v) => legacyFileStatus(v.fileState, Number(v.files), v.ohneBeleg));
  const withoutFile = fileStatuses.filter((f) => OPEN_FILE_STATUSES.has(f) && f !== "anhang_fehlt").length;
  const sevdeskExport = sevdeskExportYear(yearRows);
  const unchecked = vouchers.filter((v) => v.status === "unchecked").length;
  const bookings = d.bookingRows.get(year);
  const vatIssue = vatIssueOf(year, d);
  const vat = vatIssue ? [] : jahresUmsatzsteuer(year, d);
  const checks = jahresPruefungen(year, d, { vouchers, yearRows, fileStatuses, sevdeskExport });
  return {
    year,
    einnahmen: summen.einnahmen,
    ausgaben: summen.ausgaben,
    /** Weder Einnahme noch Ausgabe, je Art: zum Vergleich sichtbar statt still weggelassen */
    neutral: legacyNeutralSums(
      d.figures.flatMap((v) => (v.neutral && v.date.startsWith(`${year}-`) ? [{ kind: v.neutral, direction: v.direction, gross: v.gross }] : [])),
    ),
    /** "datev": keine Belege per API, die Summen stammen aus dem Buchungsstapel; "gemischt": Belege und BB-Stapel */
    sumsFrom: summen.sumsFrom,
    /** Belege aus der Export-ZIP von sevDesk je Zustand; null ohne solche Belege */
    sevdeskExport,
    withoutFile,
    files: fileCounts(fileStatuses),
    unchecked,
    bookings: bookings ? { total: bookings.total, unmatched: bookings.unmatched, withoutNumber: bookings.withoutNumber } : null,
    vat,
    vatIssue,
    taxTypes: steuerartenDerEinnahmen(vouchers),
    lastInvoiceNumber: letzteRechnungsnummer(vouchers, yearRows),
    checks,
    ready: checks.every((c) => c.ok),
  };
}

/** Einnahmen und Ausgaben des Jahres: aus den Belegen, ohne Belege per API aus dem Buchungsstapel, im Mischjahr aus beidem */
function jahresSummen(year: number, d: AbgleichDaten, vouchers: Beleg[], yearRows: Beleg[]) {
  const yearDatev = d.datevRows.filter((b) => b.date.startsWith(`${year}-`));
  // Accountable legt in den Belegen nur Ausgaben ab; die Erlöse stehen ausschließlich im
  // Buchungsstapel. Ohne diese Ausnahme blieben die Einnahmen bei 0, obwohl die Buchung da ist.
  const yearEinnahmeBelege = vouchers.some((v) => v.direction === "einnahme" && v.date.startsWith(`${year}-`));
  const fromDatev = (vouchers.length === 0 || !yearEinnahmeBelege) && yearDatev.length > 0 ? datevYearSums(yearDatev, d.kontenrahmen) : null;
  // Mischjahr (Wechsel unter dem Jahr): Belege aus Lexoffice oder sevDesk, dazu der Teil aus dem Stapel von BuchhaltungsButler
  // oder aus der Export-ZIP von sevDesk
  const sevApiYear = yearRows.some((v) => v.source === "sevdesk");
  const bbDatev = yearDatev.filter((b) => b.fileId !== null && (d.bbFileIds.has(b.fileId) || (!sevApiYear && d.sevExportFileIds.has(b.fileId))));
  const bbPart = !fromDatev && bbDatev.length > 0 ? datevYearSums(bbDatev, d.kontenrahmen) : null;
  const sum = (direction: "einnahme" | "ausgabe") => {
    const pick = (sums: NonNullable<typeof fromDatev>) => (direction === "einnahme" ? sums.einnahmen : sums.ausgaben);
    if (fromDatev) {
      const { net, tax } = pick(fromDatev);
      return { count: 0, net, tax, gross: net + tax };
    }
    const rows = vouchers.filter((v) => v.direction === direction);
    const bb = bbPart ? pick(bbPart) : { net: 0, tax: 0 };
    return {
      count: rows.length,
      net: rows.reduce((s, r) => s + r.net, 0) + bb.net,
      tax: rows.reduce((s, r) => s + r.tax, 0) + bb.tax,
      gross: rows.reduce((s, r) => s + r.gross, 0) + bb.net + bb.tax,
    };
  };
  return {
    einnahmen: sum("einnahme"),
    ausgaben: sum("ausgabe"),
    sumsFrom: fromDatev ? ("datev" as const) : bbPart ? ("gemischt" as const) : ("belege" as const),
  };
}

/**
 * Umsatzsteuer je Monat des Jahres. Bei Ist-Versteuerung gehen alle Belege ein, denn eine Zahlung im Jahr kann zu einem
 * Beleg aus einem anderen Jahr gehören; Einnahmen zählen nach den Zahlungen aus dem Zahlungsstatus, Vorsteuer und
 * Sonderfälle wie § 13b nach Belegdatum (siehe `legacyVatByMonth`). Sonst zählen die Belege des Jahres nach Belegdatum.
 */
function jahresUmsatzsteuer(year: number, { businessRows, versteuerung, taxSets }: AbgleichDaten) {
  return legacyVatByMonth(
    businessRows
      .filter((v) => (versteuerung === "ist" ? true : v.date.startsWith(`${year}-`)))
      .map((v) => ({
        direction: v.direction,
        date: v.date,
        net: v.net,
        tax: v.tax,
        gross: v.gross,
        taxes: v.taxes,
        payments: legacyPayments(v),
        taxType: v.taxType,
        taxSubType: v.taxSubType,
        vatFields: vatFieldsOf(v.taxSetId, taxSets, v.taxType),
      })),
    versteuerung,
  ).filter((m) => m.month.startsWith(`${year}-`));
}

/** Einnahmen je Steuerart, damit Sonderfälle (EU, Drittland, § 13b) beim Vergleich auffallen */
function steuerartenDerEinnahmen(vouchers: Beleg[]) {
  const taxTypes = new Map<string, number>();
  for (const v of vouchers) {
    if (v.direction !== "einnahme") continue;
    const key = [v.taxType ?? "net", v.taxSubType].filter(Boolean).join("/");
    taxTypes.set(key, (taxTypes.get(key) ?? 0) + 1);
  }
  return [...taxTypes].map(([taxType, count]) => ({ taxType, count })).sort((a, b) => b.count - a.count);
}

/** Die letzte Rechnungsnummer des Jahres */
function letzteRechnungsnummer(vouchers: Beleg[], yearRows: Beleg[]) {
  // Auch die Rechnungen aus BuchhaltungsButler: Der Nummernkreis läuft in Haben weiter (§ 14 Abs. 4 Satz 1 Nr. 4 UStG)
  const invoices = [...vouchers, ...yearRows.filter((v) => v.source === "buchhaltungsbutler" && !v.bbNeutral)]
    // Stornorechnung und Abschlagsrechnung von sevDesk belegen denselben Nummernkreis wie die Rechnungen (#472)
    .filter(
      (v) =>
        v.number &&
        (v.type === "invoice" ||
          (v.source === "sevdesk" && (v.type === "downpaymentinvoice" || (v.type === "creditnote" && v.lexofficeId.startsWith("invoice/"))))),
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number, "de", { numeric: true }));
  return invoices.at(-1)?.number ?? null;
}

/** Was für das Jahr vor der Kündigung des alten Programms vorliegen muss */
function jahresPruefungen(
  year: number,
  d: AbgleichDaten,
  {
    vouchers,
    yearRows,
    fileStatuses,
    sevdeskExport,
  }: { vouchers: Beleg[]; yearRows: Beleg[]; fileStatuses: ReturnType<typeof legacyFileStatus>[]; sevdeskExport: ReturnType<typeof sevdeskExportYear> },
): ReconciliationCheck[] {
  const withoutReceipt = d.voucherRows.filter((v) => v.ohneBeleg && v.date.startsWith(`${year}-`)).length;
  const bookings = d.bookingRows.get(year);
  const kinds = (kind: string) => d.files.filter((f) => f.year === year && f.kind === kind).length;
  const elster = kinds("elster") + d.vatProtocols.filter((p) => p.year === year).length;
  // Accountable exportiert keinen IDEA-Export. Den trotzdem zu verlangen, macht "vollständig"
  // strukturell unerreichbar — der Punkt entfällt bei dieser Herkunft.
  const nurAccountable = d.voucherRows.length > 0 && d.voucherRows.every((v) => v.source === "accountable");
  return [
    ...(paymentIssueOf(year, d) ? [{ ok: false, label: "Zahlungshistorie vollständig", detail: paymentIssueOf(year, d)! }] : []),
    ...(exportIstIssueOf(year, d) ? [exportIstCheck(sevdeskExport?.label ?? "sevDesk-Export")] : []),
    ...accountingTypeChecks(unclearAccountsIn(year, d)),
    ...fastbillWaitingChecks(d.fastbillWaiting.get(year)),
    ...fastbillPartlyCanceledChecks(d.fastbillPartlyCanceled.get(year)),
    ...voucherSourceChecks({ sevdeskExport, apiVouchers: vouchers.length, yearRows, withoutReceipt }),
    fileCheck(fileStatuses),
    {
      ok: Boolean(bookings && bookings.total > 0),
      label: "DATEV-Buchungsstapel übernommen",
      detail: bookings ? `${bookings.total} Buchungen` : "fehlt",
    },
    {
      ok: Boolean(bookings) && bookings!.unmatched === 0,
      // Buchungen ohne Belegnummer (Umbuchungen, Privates) brauchen nicht immer einen Beleg; sie stehen nur im Hinweis.
      // Ein Belegfeld ohne Ziffer ist keine Nummer, sondern etwa der Name eines Zahlungsdienstleisters (#1355).
      label: "Jede Buchung mit Belegnummer findet ihren Beleg",
      detail: bookings ? bookingsCheckDetail(bookings) : "–",
    },
    ...(nurAccountable ? [] : [{ ok: kinds("idea") > 0, label: "IDEA-Export archiviert", detail: kinds("idea") > 0 ? "liegt vor" : "fehlt" }]),
    {
      ok: elster > 0,
      label: "ELSTER-Protokolle archiviert",
      detail: elster > 0 ? `${elster} Dateien` : "fehlen",
    },
    {
      ok: kinds("kontoauszug") > 0,
      label: "Kontoauszüge archiviert",
      detail: kinds("kontoauszug") > 0 ? `${kinds("kontoauszug")} Dateien` : "fehlen",
    },
  ];
}
