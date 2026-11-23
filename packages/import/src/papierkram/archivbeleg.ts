import type { BasisPoints, Cents } from "@haben/core";
import type { PkVoucher } from "./types.ts";

/*
 * Ein Beleg aus dem DATEV-Export von Papierkram als Archivbeleg (lexoffice_vouchers, Quelle `papierkram`). Schlüssel ist die
 * Belegnummer: Papierkram vergibt sie einmal je Konto, und der Abruf über die API findet den Beleg darüber wieder.
 *
 * Status: Ein ganz stornierter Beleg ist `voided`, keine offene Forderung oder Verbindlichkeit. Sonst `unchecked`, weil der
 * Export keine Zahlungen kennt.
 */

export type PkArchiveType = "salesinvoice" | "salescreditnote" | "purchaseinvoice" | "purchasecreditnote";

export interface PkArchiveVoucher {
  externalId: string;
  type: PkArchiveType;
  direction: "einnahme" | "ausgabe";
  status: "voided" | "unchecked";
  number: string;
  date: string;
  net: Cents;
  tax: Cents;
  gross: Cents;
  rate: BasisPoints;
  remark: string;
}

export const PK_EXPORT_PREFIX = "papierkram/";

export function pkArchiveVoucher(voucher: PkVoucher): PkArchiveVoucher {
  const credit = voucher.gross < 0;
  const type: PkArchiveType =
    voucher.direction === "einnahme" ? (credit ? "salescreditnote" : "salesinvoice") : credit ? "purchasecreditnote" : "purchaseinvoice";
  return {
    externalId: `${PK_EXPORT_PREFIX}${voucher.number}`,
    type,
    direction: voucher.direction,
    status: voucher.storno === "storniert" || voucher.storno === "nur-storno" ? "voided" : "unchecked",
    number: voucher.number,
    date: voucher.date,
    net: voucher.net,
    tax: voucher.tax,
    gross: voucher.gross,
    rate: voucher.rate,
    remark: voucher.text,
  };
}
