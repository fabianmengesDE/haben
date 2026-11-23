import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { UserError } from "../errors.ts";
import { authMiddleware } from "../middleware.ts";
import {
  analysePapierkramExport,
  cancelPapierkramImport as cancelRun,
  latestPapierkramImport,
  MAX_PAPIERKRAM_UPLOAD_SIZE,
  PapierkramError,
  papierkramImportStatus,
  startPapierkramImport as startRun,
} from "../modules/archiv/index.ts";

/*
 * Umzug aus Papierkram mit dem DATEV-Export: Buchungsstapel (CSV) und Belegbilder (ZIP) werden zusammen hochgeladen und
 * analysiert, übernommen wird erst auf Knopfdruck.
 */

export const uploadPapierkramExport = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: unknown) => {
    if (!(data instanceof FormData)) throw new UserError("FormData erwartet");
    const files = data.getAll("files").filter((f): f is File => f instanceof File);
    if (files.length === 0) throw new UserError("Bitte Buchungsstapel (CSV) und Belegbilder (ZIP) auswählen.");
    if (files.length > 20) throw new UserError("Höchstens 20 Dateien auf einmal.");
    if (files.reduce((sum, f) => sum + f.size, 0) > MAX_PAPIERKRAM_UPLOAD_SIZE) {
      throw new UserError("Die Dateien sind zusammen größer als 100 MB. Lade die Jahre einzeln hoch.");
    }
    return { files };
  })
  .handler(async ({ data }) =>
    analysePapierkramExport(await Promise.all(data.files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })))),
  );

export const startPapierkramImport = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => ({ id: await startRun(context.user.id) }));

export const cancelPapierkramImport = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) => ({ cancelled: cancelRun(data.id) }));

/** Ohne id der letzte Lauf, sonst der, den die Oberfläche beobachtet */
export const getPapierkramStatus = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.uuid().optional() }))
  .handler(async ({ data }) => {
    if (!data.id) return latestPapierkramImport();
    const run = await papierkramImportStatus(data.id);
    if (!run) throw new PapierkramError("Den Lauf gibt es nicht.");
    return run;
  });
