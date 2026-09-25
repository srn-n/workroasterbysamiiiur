/**
 * export.js
 * -----------------------------------------------------------------------
 * Per-cycle export to PDF, JPG and Excel. Given ONE cycle group (the
 * shape calculations.js#groupByCycle returns: { cycleStart, cycleEnd,
 * cycleLabel, records, totalMinutes, totalPay, ... }), each function
 * produces a file containing only that cycle's data and triggers a
 * download.
 *
 * This module never recomputes a duration, rate or total itself — every
 * number printed here comes from calculations.js, so the export can
 * never drift from what the dashboard shows. It has no DOM state of its
 * own and never touches localStorage.
 * -----------------------------------------------------------------------
 */
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import ExcelJS from 'exceljs';
import * as calc from './calculations.js';

const APP_TITLE = 'WorkRoaster';
const TABLE_COLUMNS = [
  { label: 'Date', key: 'date', w: 92 },
  { label: 'Day', key: 'day', w: 44 },
  { label: 'Start', key: 'start', w: 68 },
  { label: 'Duration', key: 'duration', w: 68 },
  { label: 'Map/Job', key: 'map', w: 64 },
  { label: 'Day type', key: 'dayType', w: 84 },
  { label: 'Payment type', key: 'paymentType', w: 96 },
  { label: 'Amount', key: 'amount', w: 76 },
  { label: 'Rate/hr', key: 'rate', w: 76 },
  { label: 'Notes', key: 'notes', w: 150 },
];

/** Filenames use the cycle's actual dates, e.g. WorkRoaster_2026-09-21_to_2026-10-04. */
function cycleFilenameBase(cycle) {
  const start = cycle.cycleStart || 'unassigned';
  const end = cycle.cycleEnd || 'unassigned';
  return `${APP_TITLE}_${start}_to_${end}`;
}

function cycleSummary(cycle, currency) {
  return {
    title: APP_TITLE,
    range: cycle.cycleLabel || 'Unassigned',
    totalDuration: calc.formatDuration(cycle.totalMinutes),
    totalPay: calc.formatMoney(cycle.totalPay, currency),
    rate: calc.formatRate(cycle.totalPay, cycle.totalMinutes, currency),
    recordCount: cycle.records.length,
  };
}

function recordRows(cycle, currency) {
  return cycle.records.map((r) => {
    const mins = calc.recordMinutes(r);
    return {
      date: r.date ? calc.dateLabel(r.date) : '—',
      day: r.date ? calc.dayName(r.date) : '—',
      start: calc.formatTime12h(r.start),
      duration: calc.formatDuration(mins),
      map: r.mapNumber || '—',
      dayType: r.dayType || '—',
      paymentType: r.paymentType || '—',
      amount: calc.formatMoney(r.paymentAmount, currency),
      rate: calc.formatRate(r.paymentAmount, mins, currency),
      notes: r.notes || '',
    };
  });
}

// ---------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------

export function exportCyclePDF(cycle, { currency = 'AUD' } = {}) {
  const summary = cycleSummary(cycle, currency);
  const rows = recordRows(cycle, currency);
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(32, 33, 36);
  doc.text(summary.title, 40, 44);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(107, 114, 128);
  doc.text(`Pay cycle: ${summary.range}`, 40, 64);

  doc.setFontSize(10);
  doc.setTextColor(32, 33, 36);
  const statLines = [
    `Total working time: ${summary.totalDuration}`,
    `Total pay: ${summary.totalPay}`,
    `Average hourly rate: ${summary.rate}`,
    `Records: ${summary.recordCount}`,
  ];
  statLines.forEach((line, i) => doc.text(line, 40, 86 + i * 16));

  autoTable(doc, {
    startY: 86 + statLines.length * 16 + 14,
    head: [TABLE_COLUMNS.map((c) => c.label)],
    body: rows.map((r) => TABLE_COLUMNS.map((c) => r[c.key])),
    styles: { fontSize: 8, cellPadding: 4, textColor: [32, 33, 36] },
    headStyles: { fillColor: [91, 91, 214], textColor: [255, 255, 255] },
    alternateRowStyles: { fillColor: [247, 248, 250] },
    margin: { left: 40, right: 40 },
  });

  doc.save(`${cycleFilenameBase(cycle)}.pdf`);
}

// ---------------------------------------------------------------------
// Excel (.xlsx)
// ---------------------------------------------------------------------

export async function exportCycleExcel(cycle, { currency = 'AUD' } = {}) {
  const summary = cycleSummary(cycle, currency);
  const rows = recordRows(cycle, currency);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = APP_TITLE;
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Cycle');

  sheet.addRow([summary.title]).font = { bold: true, size: 14 };
  sheet.addRow([`Pay cycle: ${summary.range}`]);
  sheet.addRow([`Total working time: ${summary.totalDuration}`]);
  sheet.addRow([`Total pay: ${summary.totalPay}`]);
  sheet.addRow([`Average hourly rate: ${summary.rate}`]);
  sheet.addRow([`Records: ${summary.recordCount}`]);
  sheet.addRow([]);

  const headerRow = sheet.addRow(TABLE_COLUMNS.map((c) => c.label));
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5B5BD6' } };
  });

  rows.forEach((r) => sheet.addRow(TABLE_COLUMNS.map((c) => r[c.key])));

  sheet.columns = TABLE_COLUMNS.map((c) => ({ width: Math.max(10, Math.round(c.w / 7)) }));

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${cycleFilenameBase(cycle)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------
// JPG — drawn directly on an offscreen canvas (a clean report, not a
// screenshot of the app UI).
// ---------------------------------------------------------------------

function truncateToWidth(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

export function exportCycleJPG(cycle, { currency = 'AUD' } = {}) {
  const summary = cycleSummary(cycle, currency);
  const rows = recordRows(cycle, currency);

  const width = TABLE_COLUMNS.reduce((sum, c) => sum + c.w, 0) + 60;
  const headerH = 150;
  const tableHeaderH = 28;
  const rowH = 24;
  const height = headerH + tableHeaderH + Math.max(rows.length, 1) * rowH + 30;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // Background + brand accent bar
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#5b5bd6';
  ctx.fillRect(0, 0, width, 5);

  // Title + cycle range
  ctx.fillStyle = '#202124';
  ctx.font = 'bold 24px Arial, Helvetica, sans-serif';
  ctx.fillText(summary.title, 30, 42);

  ctx.fillStyle = '#6b7280';
  ctx.font = '14px Arial, Helvetica, sans-serif';
  ctx.fillText(`Pay cycle: ${summary.range}`, 30, 64);

  // Summary stats
  ctx.fillStyle = '#202124';
  ctx.font = '13px Arial, Helvetica, sans-serif';
  const stats = [
    `Total working time: ${summary.totalDuration}`,
    `Total pay: ${summary.totalPay}`,
    `Average hourly rate: ${summary.rate}`,
    `Records: ${summary.recordCount}`,
  ];
  stats.forEach((line, i) => ctx.fillText(line, 30, 92 + i * 18));

  // Table header
  const tableY = headerH;
  ctx.fillStyle = '#f1f2f5';
  ctx.fillRect(30, tableY, width - 60, tableHeaderH);
  ctx.fillStyle = '#202124';
  ctx.font = 'bold 11px Arial, Helvetica, sans-serif';
  let x = 30;
  TABLE_COLUMNS.forEach((c) => {
    ctx.fillText(truncateToWidth(ctx, c.label, c.w - 10), x + 6, tableY + 18);
    x += c.w;
  });

  // Table rows
  ctx.font = '11px Arial, Helvetica, sans-serif';
  if (!rows.length) {
    ctx.fillStyle = '#9ca3af';
    ctx.fillText('No records in this cycle.', 36, tableY + tableHeaderH + 17);
  }
  rows.forEach((r, i) => {
    const y = tableY + tableHeaderH + i * rowH;
    if (i % 2 === 1) {
      ctx.fillStyle = '#fafafa';
      ctx.fillRect(30, y, width - 60, rowH);
    }
    ctx.fillStyle = '#202124';
    let cx = 30;
    TABLE_COLUMNS.forEach((c) => {
      const text = truncateToWidth(ctx, String(r[c.key] ?? ''), c.w - 10);
      ctx.fillText(text, cx + 6, y + 16);
      cx += c.w;
    });
  });

  canvas.toBlob(
    (blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${cycleFilenameBase(cycle)}.jpg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    'image/jpeg',
    0.92
  );
}
