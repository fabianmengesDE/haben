---
title: "Umzug aus Papierkram"
description: >-
  Papierkram.de verlassen: den DATEV-Export (Buchungsstapel und Belegbilder) je Jahr hochladen und Belege,
  Belegbilder und Buchungen unveränderlich ins Archiv von Haben übernehmen.
---

# Umzug aus Papierkram

Haben übernimmt aus Papierkram den **DATEV-Export**: je Geschäftsjahr den Buchungsstapel (CSV) und die Belegbilder (ZIP). Daraus werden Belege mit ihrem Belegbild im Archiv, dazu der Buchungsstapel für den Abgleich je Jahr.

Die API von Papierkram reicht dafür nicht: Sie liefert Rechnungen und Ausgaben, aber keine Einnahmebelege, etwa für erhaltene Provisionen. Im DATEV-Export stehen alle Belege.

## Export in Papierkram

1. **DATEV-Einstellungen:** Berater- und Mandantennummer eintragen. Ohne Steuerberatung gehen Platzhalter wie `1001` und `1`; Haben braucht die Nummern nicht. Die beiden Geldtransitkonten (SKR03 1890 und 1800) bleiben, wie sie sind.
2. **DATEV Export:** ein Geschäftsjahr als Zeitraum wählen, z. B. 01.01.2025 bis 31.12.2025.
3. Bei **Buchungsstapel** Eingangs- und Ausgangsrechnungen anhaken und exportieren, dann bei **Belegbilder** dasselbe.
4. Für jedes Jahr wiederholen, in dem du Papierkram genutzt hast.

## Übernehmen

Unter **Archiv › Umzug › Umzug aus Papierkram** die CSV- und ZIP-Dateien auswählen, gern mehrere Jahre zusammen, und **Hochladen und prüfen**. Die Prüfung legt noch nichts an und zeigt Jahre, Belege, Belegbilder und Stornos. **Übernehmen** legt alles unveränderlich ins Archiv.

Ein zweiter Lauf überspringt, was schon da ist. Fehlt beim ersten Mal die ZIP eines Jahres, lädst du sie später nach; der neue Lauf hängt die Belegbilder an die vorhandenen Belege.

## Was Haben aus dem Export macht

| Im Export | Im Archiv |
| --- | --- |
| Buchungen mit derselben Belegnummer (`R-00001`, `B-00345`) | ein Beleg, Einnahme auf einem Erlöskonto, Ausgabe auf einem Aufwandskonto |
| Beleglink `BEDI "<GUID>"` und die Datei `<GUID>.pdf` in der ZIP | das Belegbild am Beleg |
| Gegenbuchung mit Generalumkehr, auch im Folgejahr | Beleg „storniert“; er zählt nicht als offener Posten |
| Privatanteil (z. B. 8922 gegen 4920) | bleibt am Beleg, ändert den gezahlten Betrag nicht |
| Abschreibung zum Jahresende (`Ref-B-00381`) | steht beim Beleg der Anschaffung |

**Umsatzsteuer:** Der Steuerschlüssel 401 ist Vorsteuer 19 %. Ohne Schlüssel gilt die Automatik des Kontos, die Papierkram in der Kontobezeichnung nennt („Provisionserlöse 19% USt“). Belege nach § 13b (Schlüssel 506) tragen am Beleg keine Steuer.

**Kleinunternehmer:** In Jahren als Kleinunternehmer bucht Papierkram den Wareneingang trotzdem auf das Automatikkonto 3400. Haben rechnet solche Jahre ohne Umsatz- und Vorsteuer. Als Kleinunternehmerjahr gilt, was in den Firmendaten so steht, und jedes Jahr, in dem der Export Erlöse auf dem Konto für Kleinunternehmer bucht (SKR03 8195, SKR04 4185).

## Grenzen

- **Zahlungen** schreibt Papierkram nicht in den Export, solange einem Bankkonto kein eigenes Buchungskonto zugeordnet ist: Jede Buchung läuft gegen das Geldtransitkonto. Offene Posten übernimmt Haben deshalb nicht; trag sie am Stichtag von Hand ein. Bei **Ist-Versteuerung** bleibt im Abgleich „Zahlungshistorie vollständig“ offen.
- **Kontakte** stehen im Export nur als Kunden- oder Lieferantennummer.
- Die **Summen je Jahr** im Abgleich schätzt Haben aus dem Buchungsstapel. Konten, deren Automatik nur in der Bezeichnung steht (z. B. 8519), und Wareneingang auf 3400 in Kleinunternehmerjahren weichen dort ab; die Belege selbst tragen die richtige Steuer.
