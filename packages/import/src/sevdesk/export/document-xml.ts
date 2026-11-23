import { XMLParser } from "fast-xml-parser";
import type { SevExportDirection, SevExportDocument } from "./types.ts";

/*
 * `document.xml` im Namensraum http://xml.datev.de/bedi/tps/document/v06.0.
 * DATEV: https://developer.datev.de/de/file-format/details/datev-xml-interface-online/getting-started-
 * Der sevDesk-Aufbau ist an den Testdaten belegt (test-fixtures/sevdesk, beide Buchhaltungsversionen):
 * `<archive generatingSystem="sevDesk"><content><document guid="…" type="1|2"><extension name="…" xsi:type="File"/>`.
 */

export type DocumentXml = { ok: true; documents: SevExportDocument[]; hints: string[] } | { ok: false; reason: string };

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", removeNSPrefix: true });

const asArray = (value: unknown): unknown[] => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | null => (typeof value === "string" || typeof value === "number" ? String(value).trim() || null : null);

/** `type` 1 ist Rechnungseingang, 2 Rechnungsausgang; fehlt er, sagt es der Name der inneren ZIP */
function directionOf(type: string | null, archive: string): SevExportDirection | null {
  if (type === "1") return "eingang";
  if (type === "2") return "ausgang";
  if (/rechnungseingang/i.test(archive)) return "eingang";
  if (/rechnungsausgang/i.test(archive)) return "ausgang";
  return null;
}

/** `system`: das Programm, das `generatingSystem` nennen muss (sevDesk, Papierkram) */
export function parseDocumentXml(bytes: Uint8Array, archive: string, system = "sevDesk"): DocumentXml {
  let parsed: unknown;
  try {
    parsed = parser.parse(new TextDecoder("utf-8").decode(bytes), true);
  } catch {
    return { ok: false, reason: `${archive}: document.xml ist kein gültiges XML.` };
  }
  const archiveRoot = record(parsed).archive;
  if (archiveRoot === undefined) return { ok: false, reason: `${archive}: document.xml enthält kein archive-Element.` };
  const root = record(archiveRoot);
  const generator = text(root.generatingSystem);
  if (generator !== null && generator !== system) {
    return { ok: false, reason: `${archive}: document.xml ist erzeugt von „${generator}“, nicht von ${system}.` };
  }
  const content = record(root.content);
  if (
    (root.content !== undefined && root.content !== "" && typeof root.content !== "object") ||
    Object.keys(content).some((key) => key !== "document") ||
    (generator === null && content.document === undefined)
  ) {
    return { ok: false, reason: `${archive}: document.xml enthält keine erkennbare ${system}-Dateiliste.` };
  }
  const documents: SevExportDocument[] = [];
  const hints: string[] = [];
  for (const node of asArray(content.document)) {
    const element = record(node);
    const guid = text(element.guid);
    const fileName = text(record(asArray(element.extension)[0]).name);
    if (!guid || !fileName) {
      hints.push(`${archive}: Eintrag in document.xml ohne GUID oder Dateiname übersprungen.`);
      continue;
    }
    documents.push({ guid, direction: directionOf(text(element.type), archive), fileName, archive, element });
  }
  return { ok: true, documents, hints };
}
