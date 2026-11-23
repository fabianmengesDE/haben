import { AUTOMATIC, datevAccountKind, shortAccount, type DatevBooking } from "../datev.ts";
import type { PkExportOptions, PkFile, PkLine, PkStack, PkVoucher } from "./types.ts";

/*
 * Belege aus den Buchungsstapeln von Papierkram (Export „Buchungsstapel“, Eingangs- und Ausgangsrechnungen).
 * Aufbau nach echten Exporten 2022, 2025 und 2026 (Papierkram, Version vom November 2026):
 *
 * - Jede Zeile bucht ein Sachkonto (Konto) gegen das Geldtransitkonto der DATEV-Einstellungen (Gegenkonto, Vorgabe
 *   1800 für Einnahmen und 1890 für Ausgaben), solange einem Bankkonto kein eigenes Buchungskonto zugeordnet ist.
 *   Zahlungen schreibt Papierkram nicht. Ein Beleg ist eine Belegnummer (Belegfeld 1), über alle Jahre.
 * - Privatanteile stehen als Zeile Erlös gegen Aufwand im selben Beleg (8922 gegen 4920, 8902 gegen 4980); sie bewegen
 *   kein Geld.
 * - Ein Storno ist eine Zeile mit Generalumkehr und umgekehrtem Soll/Haben. Am Geld gemessen hebt sie das Original auf;
 *   die API nennt solche Belege `canceled` oder `deleted`. Original und Storno können in verschiedenen Jahren liegen.
 * - Abschreibungen zum Jahresende tragen `Ref-<Belegnummer>` und keinen Beleglink.
 * - Steuerschlüssel: 401 ist Vorsteuer 19 % (DATEV-Steuerschlüsseltabelle, dreistellige Schlüssel neben 9), 506 steht nur
 *   an Leistungen nach § 13b UStG, 490 an Belegen ohne Vorsteuer. Ohne Schlüssel gilt die Automatik des Kontos; Papierkram
 *   nennt sie in der Kontobezeichnung („Provisionserlöse 19% USt“, „Wareneingang 19% Vorsteuer“).
 * - In Jahren als Kleinunternehmer bucht Papierkram Wareneingang trotzdem auf das Automatikkonto 3400 ohne Schlüssel. Die
 *   API nennt für dieselben Belege „Keine Vorsteuer“. Deshalb trägt an solchen Tagen kein Beleg Steuer.
 */

const BEDI = /^BEDI\s+"([^"]+)"\s*$/i;
/** Steuersatz in Prozent je BU-Schlüssel; 506 (§ 13b) hebt sich als Vor- und Umsatzsteuer auf und bleibt außen vor */
const BU_RATES: Record<string, number> = { "2": 7, "3": 19, "8": 7, "9": 19, "401": 19 };
const NO_TAX_KEYS = new Set(["40", "490", "506"]);
const NAMED_RATE = /(\d{1,2})\s*%\s*(USt|Vorsteuer|VSt)\b/i;

/** Wert eines Paars „<prefix> – Art n“ / „<prefix> – Inhalt n“ (Papierkram schreibt einen Halbgeviertstrich) */
export function infoValue(raw: Record<string, string>, prefix: string, art: string): string {
  const pattern = new RegExp(`^${prefix}\\s*[–-]\\s*Art (\\d+)$`);
  for (const [key, value] of Object.entries(raw)) {
    const match = pattern.exec(key);
    if (match && value.trim() === art) {
      const content = Object.entries(raw).find(([k]) => new RegExp(`^${prefix}\\s*[–-]\\s*Inhalt ${match[1]}$`).test(k));
      return content?.[1].trim() ?? "";
    }
  }
  return "";
}

const normalizeBu = (bu: string) => bu.trim().replace(/^0+/, "");

/** Steuersatz in Prozent: Schlüssel, sonst Automatikkonto, sonst der Satz in der Kontobezeichnung */
function ratePercent(booking: DatevBooking, account: string, accountName: string, options: PkExportOptions, kontenrahmen: PkStack["kontenrahmen"]): number {
  if (options.kleinunternehmerAm(booking.date)) return 0;
  const bu = normalizeBu(booking.buKey);
  if (NO_TAX_KEYS.has(bu)) return 0;
  if (bu !== "") return BU_RATES[bu] ?? 0;
  const automatic = AUTOMATIC[kontenrahmen][shortAccount(account)];
  if (automatic !== undefined) return automatic;
  const named = NAMED_RATE.exec(accountName);
  return named ? Number(named[1]) : 0;
}

const isPl = (kind: ReturnType<typeof datevAccountKind>) => kind === "erloese" || kind === "aufwand";

function lineOf(stack: PkStack, booking: DatevBooking, options: PkExportOptions): PkLine {
  const accountLength = stack.stack.header.accountLength || 4;
  const accountKind = datevAccountKind(stack.kontenrahmen, booking.account, accountLength);
  const contraKind = datevAccountKind(stack.kontenrahmen, booking.contraAccount, accountLength);
  const accountName = infoValue(booking.raw, "Zusatzinformation", "Kontobezeichnung");
  const kind = isPl(accountKind) && isPl(contraKind) ? "intern" : "geld";
  const percent = ratePercent(booking, booking.account, accountName, options, stack.kontenrahmen);
  // Haben am Sachkonto: Geld kommt herein (Erlös, Erstattung, Storno einer Ausgabe); Soll: Geld geht hinaus
  const money = kind === "intern" ? 0 : booking.side === "H" ? booking.amount : -booking.amount;
  const tax = percent === 0 ? 0 : Math.sign(money) * Math.round((Math.abs(money) * percent) / (100 + percent));
  return {
    stack: stack.name,
    booking,
    kind,
    account: booking.account,
    accountKind: accountKind === "erloese" || accountKind === "aufwand" ? accountKind : "sonstige",
    accountName,
    storno: (booking.raw.Generalumkehr ?? "").trim() === "1",
    money: money + 0,
    rate: percent * 100,
    tax: tax + 0,
  };
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0) + 0;

function voucherOf(number: string, lines: PkLine[], files: Map<string, PkFile>, hints: string[]): PkVoucher | null {
  const money = lines.filter((l) => l.kind === "geld");
  const original = money.filter((l) => !l.storno);
  const storno = money.filter((l) => l.storno);
  if (money.length === 0) {
    hints.push(`Beleg ${number}: nur Umbuchungen ohne Geld (z. B. Privatanteil), nicht übernommen.`);
    return null;
  }
  const basis = original.length > 0 ? original : storno;
  const first = basis[0]!;
  const basisMoney = sum(basis.map((l) => l.money)) * (original.length > 0 ? 1 : -1);
  // Erlöskonto: Einnahme, Aufwandskonto: Ausgabe (eine Gutschrift wird negativ); sonst folgt die Richtung dem Geld
  const direction = first.accountKind === "erloese" ? "einnahme" : first.accountKind === "aufwand" ? "ausgabe" : basisMoney >= 0 ? "einnahme" : "ausgabe";
  const sign = (direction === "einnahme" ? 1 : -1) * (original.length > 0 ? 1 : -1);
  const gross = sign * sum(basis.map((l) => l.money)) + 0;
  const tax = sign * sum(basis.map((l) => l.tax)) + 0;
  const rates = [...new Set(basis.filter((l) => l.tax !== 0).map((l) => l.rate))];
  const stornoMoney = sum(storno.map((l) => l.money));
  const originalMoney = sum(original.map((l) => l.money));
  const state: PkVoucher["storno"] =
    storno.length === 0 ? null : original.length === 0 ? "nur-storno" : stornoMoney + originalMoney === 0 ? "storniert" : "teilweise";
  if (state === "teilweise") hints.push(`Beleg ${number}: Storno hebt den Beleg nur zum Teil auf; bitte prüfen.`);
  if (state === "nur-storno") hints.push(`Beleg ${number}: nur das Storno ist hochgeladen, das Original fehlt (anderes Jahr?).`);
  const guids = [...new Set(lines.map((l) => BEDI.exec(l.booking.documentLink)?.[1]).filter((g): g is string => Boolean(g)))];
  if (guids.length > 1) hints.push(`Beleg ${number}: mehrere Beleglinks; es gilt der erste.`);
  const guid = guids[0] ?? null;
  const file = guid ? (files.get(guid) ?? null) : null;
  const raw = first.booking.raw;
  return {
    number,
    guid,
    date: first.booking.date,
    cancelledOn: storno[0]?.booking.date ?? null,
    storno: state,
    direction,
    kind: number.startsWith("R-") ? "rechnung" : "beleg",
    gross,
    tax,
    net: gross - tax,
    rate: rates.length === 1 ? rates[0]! : 0,
    contactName: "",
    partnerNumber: infoValue(raw, "Beleginfo", "Kundennummer"),
    text: first.booking.text,
    lines,
    file,
    depreciation: [],
  };
}

/** Belege aller Stapel, nach Belegnummer zusammengeführt; Dateien ohne Buchung kommen nach `orphanFiles` */
export function buildVouchers(stacks: PkStack[], files: Map<string, PkFile>, options: PkExportOptions, hints: string[]) {
  const byNumber = new Map<string, PkLine[]>();
  const depreciation = new Map<string, { stack: string; booking: DatevBooking }[]>();
  for (const stack of stacks) {
    for (const booking of stack.stack.bookings) {
      const number = booking.voucherField1.trim();
      if (number === "") {
        hints.push(`${stack.name}, Zeile ${booking.row}: Buchung ohne Belegnummer, nicht übernommen.`);
        continue;
      }
      if (number.startsWith("Ref-")) {
        const target = number.slice(4);
        depreciation.set(target, [...(depreciation.get(target) ?? []), { stack: stack.name, booking }]);
        continue;
      }
      byNumber.set(number, [...(byNumber.get(number) ?? []), lineOf(stack, booking, options)]);
    }
  }
  const vouchers: PkVoucher[] = [];
  for (const [number, lines] of byNumber) {
    const voucher = voucherOf(number, lines, files, hints);
    if (!voucher) continue;
    voucher.depreciation = depreciation.get(number) ?? [];
    vouchers.push(voucher);
  }
  for (const target of depreciation.keys()) {
    if (!byNumber.has(target)) hints.push(`Abschreibung zu ${target}: der Beleg selbst ist nicht im Upload.`);
  }
  const linked = new Set(vouchers.map((v) => v.guid));
  const orphanFiles = [...files.values()].filter((f) => !linked.has(f.guid));
  for (const f of orphanFiles) hints.push(`${f.archive}: Datei ${f.fileName} ohne Buchung im Stapel.`);
  const missing = new Map<string, number>();
  for (const v of vouchers) if (v.guid && !v.file) missing.set(v.date.slice(0, 4), (missing.get(v.date.slice(0, 4)) ?? 0) + 1);
  for (const [year, count] of [...missing].sort()) hints.push(`${year}: ${count} Belegbilder fehlen; lade die ZIP „Belegbilder“ für dieses Jahr hoch.`);
  return { vouchers: vouchers.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number)), orphanFiles };
}
