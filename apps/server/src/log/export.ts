import {
  amendFieldLabel,
  CREW_FIELD_KEYS,
  EVENT_LABELS,
  formatSnapshotValue,
  orderedSnapshotKeys,
  snapshotValueForCsv,
  type LogEntry,
  type Passage,
  type UnitPrefs,
} from '@watchkeeper/shared';
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import type { DB } from '../db/index.js';

// Passage exports: CSV of every snapshot field in the user's units, GPX of
// 1-minute positions, and a PDF in traditional logbook layout (landscape,
// one page per UTC day). Plus the full JSON backup.

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Value with amendments applied, as display text. */
function shown(e: LogEntry, key: string, prefs: UnitPrefs): string {
  const amended = e.current[`snapshot.${key}`];
  return amended !== undefined ? (amended ?? '--') : formatSnapshotValue(key, e.snapshot[key], prefs);
}

export function passageCsv(entries: LogEntry[], prefs: UnitPrefs): string {
  const keys = orderedSnapshotKeys(entries.flatMap((e) => Object.keys(e.snapshot)));
  const units = new Map(keys.map((k) => [k, snapshotValueForCsv(k, 0, prefs).unit]));
  const header = [
    'time_utc',
    'kind',
    'event',
    'clock_source',
    ...keys.map((k) => {
      const u = units.get(k);
      return u ? `${k} (${u})` : k;
    }),
    ...CREW_FIELD_KEYS,
    'remarks',
    'created_by',
    'signed_by',
    'signed_at',
    'amendments',
  ];
  const rows = entries.map((e) => [
    e.ts,
    e.kind,
    e.eventType ?? '',
    String(e.snapshot.clockSource ?? ''),
    ...keys.map((k) => snapshotValueForCsv(k, e.snapshot[k], prefs).value),
    ...CREW_FIELD_KEYS.map((k) => e.current[`crew.${k}`] ?? ''),
    e.current.remarks ?? '',
    e.createdByName ?? '',
    e.signedByName ?? '',
    e.signedAt ?? '',
    e.amendments.map((a) => `${amendFieldLabel(a.field)}: ${a.oldValue ?? ''} -> ${a.newValue ?? ''} (${a.reason}, ${a.userName ?? a.userId}, ${a.ts})`).join('; '),
  ]);
  // BOM so spreadsheet apps read the degree signs as UTF-8.
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** GPX 1.1 track. A gap of more than 5 minutes starts a new segment. */
export function passageGpx(passage: Passage, points: { ts: number; lat: number; lon: number }[]): string {
  const segs: string[][] = [];
  let prev: number | null = null;
  for (const p of points) {
    if (prev === null || p.ts - prev > 5 * 60_000) segs.push([]);
    segs[segs.length - 1]!.push(`<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><time>${new Date(p.ts).toISOString()}</time></trkpt>`);
    prev = p.ts;
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Data Hub" xmlns="http://www.topografix.com/GPX/1/1">',
    `<metadata><name>${xml(passage.name)}</name><time>${passage.startedAt}</time></metadata>`,
    `<trk><name>${xml(passage.name)}</name>`,
    ...segs.map((s) => `<trkseg>\n${s.join('\n')}\n</trkseg>`),
    '</trk>',
    '</gpx>',
    '',
  ].join('\n');
}

// PDF

/** The standard PDF fonts only cover WinAnsi. Swap what we use for close equivalents, drop the rest. */
function pdfText(s: string): string {
  return s
    .replace(/[′’‘]/g, "'")
    .replace(/[″“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '');
}

function wrap(text: string, font: PDFFont, size: number, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  for (const para of pdfText(text).split(/\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) line = next;
      else {
        if (line) lines.push(line);
        line = word;
        while (font.widthOfTextAtSize(line, size) > width && line.length > 1) line = line.slice(0, -1);
      }
    }
    lines.push(line);
  }
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1]!;
    while (last && font.widthOfTextAtSize(`${last}...`, size) > width) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last}...`;
    return kept;
  }
  return lines;
}

interface Column {
  title: string;
  width: number;
  cell: (e: LogEntry) => string;
  maxLines: number;
}

const PAGE_W = 792; // US Letter, landscape
const PAGE_H = 612;
const MARGIN = 30;
const FONT_SIZE = 7;
const LINE_H = 8.6;
const INK = rgb(0.055, 0.102, 0.133);
const MUTED = rgb(0.31, 0.37, 0.41);
const RULE = rgb(0.83, 0.86, 0.87);

/** Column titles, in order. The acceptance test checks every one is on every page. */
export const PDF_COLUMNS = ['Time UTC', 'Position', 'Course', 'Speed', 'Wind', 'Barometer', 'Sea state', 'Sail plan', 'Remarks', 'Signature'] as const;

export async function passagePdf(passage: Passage, entries: LogEntry[], prefs: UnitPrefs): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Logbook: ${pdfText(passage.name)}`);
  doc.setCreator('Data Hub');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const label = (e: LogEntry) => {
    const kind = e.kind.toUpperCase();
    const ev = e.eventType ? (EVENT_LABELS[e.eventType] ?? e.eventType).toUpperCase() : '';
    return ev ? `${kind} - ${ev}` : kind;
  };
  const cells: Record<(typeof PDF_COLUMNS)[number], Omit<Column, 'title'>> = {
    'Time UTC': { width: 40, maxLines: 1, cell: (e) => e.ts.slice(11, 16) },
    Position: { width: 82, maxLines: 2, cell: (e) => `${shown(e, 'lat', prefs)}\n${shown(e, 'lon', prefs)}` },
    Course: { width: 52, maxLines: 2, cell: (e) => `COG ${shown(e, 'cog', prefs)}\nHDG ${shown(e, 'heading', prefs)}` },
    Speed: { width: 50, maxLines: 2, cell: (e) => `SOG ${shown(e, 'sog', prefs)}\nSTW ${shown(e, 'stw', prefs)}` },
    Wind: { width: 60, maxLines: 2, cell: (e) => `${shown(e, 'tws', prefs)}\nfrom ${shown(e, 'twd', prefs)}` },
    Barometer: {
      width: 54,
      maxLines: 2,
      cell: (e) => {
        const t = e.snapshot.pressureTendency;
        const trend = typeof t === 'number' ? (t <= -100 ? 'falling' : t >= 100 ? 'rising' : 'steady') : '';
        return `${shown(e, 'pressure', prefs)}${trend ? `\n${trend}` : ''}`;
      },
    },
    'Sea state': { width: 46, maxLines: 2, cell: (e) => e.current['crew.seaState'] ?? '' },
    'Sail plan': { width: 76, maxLines: 2, cell: (e) => e.current['crew.sailPlan'] ?? '' },
    Remarks: {
      width: 0, // takes the rest
      maxLines: 3,
      cell: (e) => {
        const r = e.current.remarks ?? '';
        return `${label(e)}${r ? `: ${r}` : ''}${e.amendments.length > 0 ? ' (amended)' : ''}`;
      },
    },
    Signature: { width: 72, maxLines: 2, cell: (e) => (e.signedAt ? `${e.signedByName ?? 'Signed'}\n${e.signedAt.slice(11, 16)} UTC` : 'UNSIGNED') },
  };
  const columns: Column[] = PDF_COLUMNS.map((title) => ({ title, ...cells[title] }));
  const fixed = columns.reduce((a, c) => a + c.width, 0);
  columns.find((c) => c.width === 0)!.width = PAGE_W - 2 * MARGIN - fixed;

  // Group by UTC day.
  const days = new Map<string, LogEntry[]>();
  for (const e of entries) {
    const d = e.ts.slice(0, 10);
    days.set(d, [...(days.get(d) ?? []), e]);
  }
  if (days.size === 0) days.set(passage.startedAt.slice(0, 10), []);

  const route = [passage.fromPlace, passage.toPlace].filter(Boolean).join(' to ');
  for (const [day, list] of days) {
    let page = doc.addPage([PAGE_W, PAGE_H]);
    let y = 0;
    let part = 1;
    const header = (p: PDFPage) => {
      y = PAGE_H - MARGIN;
      const dayName = new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
      p.drawText(pdfText(passage.name), { x: MARGIN, y: y - 12, size: 13, font: bold, color: INK });
      p.drawText(pdfText(`${dayName} (UTC)${part > 1 ? ', continued' : ''}`), { x: MARGIN, y: y - 26, size: 9, font, color: MUTED });
      if (route) {
        const w = font.widthOfTextAtSize(pdfText(route), 9);
        p.drawText(pdfText(route), { x: PAGE_W - MARGIN - w, y: y - 12, size: 9, font, color: MUTED });
      }
      y -= 40;
      let x = MARGIN;
      for (const c of columns) {
        p.drawText(c.title.toUpperCase(), { x: x + 2, y: y - 9, size: 6.5, font: bold, color: MUTED });
        x += c.width;
      }
      y -= 13;
      p.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.8, color: INK });
      part += 1;
    };
    header(page);
    for (const e of list) {
      const lines = columns.map((c) => wrap(c.cell(e), font, FONT_SIZE, c.width - 4, c.maxLines));
      const h = Math.max(...lines.map((l) => l.length)) * LINE_H + 4;
      // A day that doesn't fit continues on another page rather than shrinking the text.
      if (y - h < MARGIN) {
        page = doc.addPage([PAGE_W, PAGE_H]);
        header(page);
      }
      let x = MARGIN;
      lines.forEach((cellLines, i) => {
        const unsigned = columns[i]!.title === 'Signature' && !e.signedAt;
        cellLines.forEach((line, j) => {
          page.drawText(line, { x: x + 2, y: y - (j + 1) * LINE_H, size: FONT_SIZE, font: unsigned || i === 0 ? bold : font, color: unsigned ? MUTED : INK });
        });
        x += columns[i]!.width;
      });
      y -= h;
      page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.4, color: RULE });
    }
  }
  return doc.save();
}

// Full backup

/** Left out of the JSON backup: history samples, sessions and the migration ledger. PIN hashes too. */
const BACKUP_SKIP = new Set(['sample_1s', 'sample_1m', 'sample_10m', 'session', 'schema_migration']);

export function fullBackup(db: DB, exportedAt: string): Record<string, unknown> {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
    .map((t) => t.name)
    .filter((n) => !BACKUP_SKIP.has(n));
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    const rows = db.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[];
    out[t] = t === 'user' ? rows.map(({ pin_hash: _omit, ...rest }) => rest) : rows;
  }
  const migrations = (db.prepare('SELECT version FROM schema_migration ORDER BY version').all() as { version: string }[]).map((r) => r.version);
  return { format: 'data-hub-backup', version: 1, exportedAt, schema: migrations, tables: out };
}
