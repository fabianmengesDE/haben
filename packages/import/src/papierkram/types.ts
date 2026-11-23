import type { BasisPoints, Cents } from "@haben/core";
import type { DatevBooking, DatevStack, Kontenrahmen } from "../datev.ts";

/** Eine hochgeladene Datei: Buchungsstapel (`EXTF_Buchungsstapel_…csv`) oder Belegbilder (`DATEV_Belegbilder_…zip`) */
export interface PkUpload {
  name: string;
  bytes: Uint8Array;
}

export interface PkExportOptions {
  /** Papierkram lässt den Kontenrahmen im Kopf des Stapels leer; dann gilt der der Firma */
  kontenrahmen: Kontenrahmen;
  /** War die Firma an diesem Tag Kleinunternehmer (§ 19 UStG)? Dann trägt kein Beleg Umsatz- oder Vorsteuer. */
  kleinunternehmerAm: (date: string) => boolean;
}

export interface PkStack {
  name: string;
  bytes: Uint8Array;
  stack: DatevStack;
  kontenrahmen: Kontenrahmen;
}

export interface PkFile {
  guid: string;
  fileName: string;
  /** Name der ZIP, aus der die Datei stammt */
  archive: string;
  bytes: Uint8Array;
}

/** Wie eine Zeile zum Beleg gehört */
export type PkLineKind =
  /** Erlös, Aufwand oder Anlage gegen das Geldtransitkonto: bewegt Geld */
  | "geld"
  /** Privatanteil (z. B. 8922 gegen 4920): bucht innerhalb des Belegs um, ohne Geld */
  | "intern";

export interface PkLine {
  stack: string;
  booking: DatevBooking;
  kind: PkLineKind;
  /** Sachkonto der Zeile (Erlös, Aufwand, Anlage …), nicht das Geldtransitkonto */
  account: string;
  /** Art des Sachkontos nach den Kontenbereichen; `sonstige`: Anlage, Steuer, Privat */
  accountKind: "erloese" | "aufwand" | "sonstige";
  /** Kontobezeichnung aus „Zusatzinformation“, so wie Papierkram sie mitschreibt */
  accountName: string;
  /** Generalumkehr: Papierkram markiert so die Gegenbuchung eines Stornos */
  storno: boolean;
  /** Geld in Euro aus Sicht des Unternehmens: positiv herein, negativ hinaus; bei `intern` 0 */
  money: Cents;
  /** Steuersatz der Zeile laut Buchung, 0 ohne Steuer */
  rate: BasisPoints;
  /** Steueranteil am Geld der Zeile, mit dessen Vorzeichen */
  tax: Cents;
}

export interface PkVoucher {
  /** Belegnummer (Belegfeld 1), z. B. `B-00345` oder `R-00001`; Korrekturen tragen `-1` usw. */
  number: string;
  /** GUID aus dem Beleglink; null, wenn keine Zeile einen hat */
  guid: string | null;
  /** Belegdatum der ersten Zeile, die kein Storno ist; sonst der ersten Zeile */
  date: string;
  /** Datum der Stornozeilen, null ohne Storno */
  cancelledOn: string | null;
  /** `storniert`: die Stornozeilen heben das Geld ganz auf; `teilweise`: nur zum Teil; `nur-storno`: das Original fehlt im Upload */
  storno: "storniert" | "teilweise" | "nur-storno" | null;
  direction: "einnahme" | "ausgabe";
  /** Ausgangsrechnung (`R-…`) oder Beleg (`B-…`, Einnahme- und Ausgabebelege) */
  kind: "rechnung" | "beleg";
  /** Geld des Originals, positiv in Richtung des Belegs; Stornozeilen zählen nicht */
  gross: Cents;
  tax: Cents;
  net: Cents;
  /** einheitlicher Steuersatz, sonst 0 */
  rate: BasisPoints;
  contactName: string;
  /** Kunden- oder Lieferantennummer aus Beleginfo (`K-00002`, `L-00004`) */
  partnerNumber: string;
  text: string;
  lines: PkLine[];
  file: PkFile | null;
  /** Abschreibungen zum Jahresende (`Ref-<Belegnummer>`), nur zur Anzeige; sie bewegen kein Geld */
  depreciation: { stack: string; booking: DatevBooking }[];
}

export interface PkExport {
  stacks: PkStack[];
  vouchers: PkVoucher[];
  /** Dateien ohne Buchung im Stapel */
  orphanFiles: PkFile[];
  hints: string[];
}

export type PkExportResult = { ok: true; export: PkExport } | { ok: false; reason: string };
