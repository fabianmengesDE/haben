import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState, type FormEvent } from "react";
import { formatDateTime } from "../../lib/format.ts";
import { useAction } from "../../lib/use-action.ts";
import type { getMigration } from "../../server/functions/archive.ts";
import { cancelPapierkramImport, getPapierkramStatus, startPapierkramImport, uploadPapierkramExport } from "../../server/functions/papierkram.ts";
import { ConfirmDialog } from "../ConfirmDialog.tsx";
import { Field } from "../Field.tsx";
import { FilePicker } from "../FilePicker.tsx";
import { Icon } from "../Icon.tsx";
import { NoticeBanner } from "../NoticeBanner.tsx";

type MigrationData = Awaited<ReturnType<typeof getMigration>>;
type Run = NonNullable<MigrationData["papierkramImport"]>;
type Analysis = Awaited<ReturnType<typeof uploadPapierkramExport>>;

const STACK_STATE = { neu: "wird übernommen", vorhanden: "liegt schon im Archiv", zeitraum: "Zeitraum schon belegt" } as const;

/** Umzug aus Papierkram: DATEV-Export (Buchungsstapel und Belegbilder) hochladen, Vorschau prüfen, übernehmen */
export function PapierkramImport({ initial }: { initial: Run | null }) {
  const router = useRouter();
  const upload = useServerFn(uploadPapierkramExport);
  const start = useServerFn(startPapierkramImport);
  const cancel = useServerFn(cancelPapierkramImport);
  const poll = useServerFn(getPapierkramStatus);
  const check = useAction();
  const action = useAction();
  const [files, setFiles] = useState<File[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [run, setRun] = useState<Run | null>(initial);
  const [confirming, setConfirming] = useState(false);
  const running = run?.status === "laeuft";

  useEffect(() => {
    if (!running) return;
    let stopped = false;
    const timer = setInterval(async () => {
      const next = await poll({ data: { id: run?.id } }).catch(() => null);
      if (stopped || !next) return;
      setRun(next);
      if (next.status !== "laeuft") void router.invalidate();
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [running, poll, router, run?.id]);

  function onCheck(event: FormEvent) {
    event.preventDefault();
    if (files.length === 0) return;
    const data = new FormData();
    for (const file of files) data.append("files", file);
    void check.run(async () => setAnalysis(await upload({ data })));
  }

  const onStart = () =>
    action.run(async () => {
      setConfirming(false);
      const { id } = await start();
      const next = await poll({ data: { id } });
      setAnalysis(null);
      setRun(next);
      if (next && next.status !== "laeuft") await router.invalidate();
    });

  return (
    <section className="card stack" aria-labelledby="papierkram-heading">
      <div className="step-head">
        <span className="step-num">{run?.status === "fertig" ? <Icon name="check" /> : "1"}</span>
        <h2 id="papierkram-heading" style={{ margin: 0 }}>
          DATEV-Export aus Papierkram hochladen
        </h2>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Haben übernimmt den DATEV-Export von Papierkram. Die API von Papierkram liefert keine Einnahmebelege, der Export enthält alle Belege mit Buchung und
        Belegbild. Zahlungen und offene Posten enthält er nicht.
      </p>
      <ol className="small" style={{ margin: 0, paddingLeft: 20 }}>
        <li>
          In Papierkram unter <strong>DATEV-Einstellungen</strong> Berater- und Mandantennummer eintragen. Ohne Steuerberatung gehen Platzhalter wie 1001 und 1;
          Haben braucht sie nicht.
        </li>
        <li>
          Im <strong>DATEV Export</strong> ein Geschäftsjahr als Zeitraum wählen, bei <strong>Buchungsstapel</strong> und bei <strong>Belegbilder</strong> je
          Eingangs- und Ausgangsrechnungen anhaken und beides exportieren.
        </li>
        <li>CSV und ZIP hier zusammen hochladen, gern mehrere Jahre auf einmal.</li>
      </ol>
      {!running && (
        <form className="stack" onSubmit={onCheck} style={{ gap: 12 }}>
          <Field label="Buchungsstapel und Belegbilder" hint="CSV- und ZIP-Dateien. Die Prüfung legt noch nichts an.">
            {(control) => (
              <FilePicker
                {...control}
                multiple
                accept=".csv,.zip,text/csv,application/zip"
                onChange={(event) => {
                  setFiles([...(event.target.files ?? [])]);
                  setAnalysis(null);
                }}
              />
            )}
          </Field>
          <div className="actions">
            <button type="submit" className="btn" disabled={files.length === 0 || check.busy || action.busy}>
              {check.busy ? "Prüfe …" : "Hochladen und prüfen"}
            </button>
          </div>
        </form>
      )}
      <NoticeBanner notice={check.notice} />
      {analysis && !running && (
        <>
          <Facts analysis={analysis} />
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => setConfirming(true)} disabled={action.busy}>
              Übernehmen
            </button>
          </div>
        </>
      )}
      {run && <RunState run={run} onCancel={() => void action.run(() => cancel({ data: { id: run.id } }))} busy={action.busy} />}
      <NoticeBanner notice={action.notice} />
      <ConfirmDialog
        open={confirming}
        title="Export unveränderlich übernehmen?"
        confirmLabel="Übernehmen"
        facts={
          analysis
            ? [
                { label: "Jahre", value: analysis.years.join(", ") || "–" },
                { label: "Belege", value: String(analysis.vouchers) },
                { label: "Belegbilder", value: String(analysis.withFile) },
              ]
            : []
        }
        onConfirm={() => void onStart()}
        onClose={() => setConfirming(false)}
      >
        <p>Buchungsstapel, Belege und Belegbilder liegen danach unveränderlich im Archiv. Was schon da ist, überspringt Haben.</p>
      </ConfirmDialog>
    </section>
  );
}

function Facts({ analysis }: { analysis: Analysis }) {
  const facts: [string, number | string][] = [
    ["Jahre", analysis.years.join(", ") || "–"],
    ["Buchungen", analysis.bookings],
    ["Belege", analysis.vouchers],
    ["mit Belegbild", analysis.withFile],
    ["Belegbild fehlt", analysis.missingFile],
    ["storniert", analysis.cancelled],
  ];
  return (
    <div className="stack" style={{ gap: 12 }} aria-live="polite">
      <div className="progress-facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <span className="small muted">{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <ul className="small" style={{ margin: 0, paddingLeft: 20 }}>
        {analysis.stacks.map((s) => (
          <li key={s.name}>
            {s.name}: {STACK_STATE[s.state]}
            {s.other ? ` (${s.other})` : ""}
          </li>
        ))}
        {analysis.missingFile > 0 && <li>Fehlende Belegbilder kannst du später mit der ZIP des Jahres nachreichen; ein neuer Lauf hängt sie an.</li>}
      </ul>
      {analysis.hintCount > 0 && (
        <details>
          <summary className="small">{analysis.hintCount} Hinweise aus dem Export</summary>
          <ul className="small" style={{ margin: "8px 0 0", paddingLeft: 20 }}>
            {analysis.hints.map((hint) => (
              <li key={hint}>{hint}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function RunState({ run, onCancel, busy }: { run: Run; onCancel: () => void; busy: boolean }) {
  const p = run.progress;
  return (
    <div className="stack" style={{ gap: 12 }} aria-live="polite">
      <div className="small">
        {run.status === "laeuft" ? `Läuft: ${p.imported + p.skipped} von ${p.listed} Belegen` : null}
        {run.status === "fertig"
          ? `Übernommen am ${formatDateTime(run.finishedAt ?? run.updatedAt)}: ${p.imported} neu, ${p.skipped} übersprungen, ${p.files} Belegbilder`
          : null}
        {run.status === "fehler" ? "Abgebrochen mit Fehler" : null}
        {run.status === "abgebrochen" ? "Abgebrochen" : null}
      </div>
      {run.papierkram?.note && (
        <p className="small muted" style={{ margin: 0 }}>
          {run.papierkram.note}
        </p>
      )}
      {run.error && (
        <div className="banner banner-danger" role="alert">
          {run.error}
        </div>
      )}
      {p.failed.length > 0 && (
        <details>
          <summary className="small">{p.failed.length} Belege nicht übernommen</summary>
          <ul className="small" style={{ margin: "8px 0 0", paddingLeft: 20 }}>
            {p.failed.slice(0, 50).map((f) => (
              <li key={f.lexofficeId}>
                {f.number || f.lexofficeId}: {f.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      {run.status === "laeuft" && (
        <div className="actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Abbrechen
          </button>
        </div>
      )}
    </div>
  );
}
