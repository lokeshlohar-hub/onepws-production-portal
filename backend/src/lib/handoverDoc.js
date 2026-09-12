'use strict';

// Builds the two rendered forms of a Handover Notification from the same
// `pdfData` payload the frontend already assembles for its in-app preview:
//
//   buildEmailHtml(pdfData)  -> Outlook-safe HTML for the email BODY
//   buildPdfBuffer(pdfData)  -> A4 PDF Buffer for the email ATTACHMENT
//
// pdfData shape (produced by the frontend's single-line and bulk handover
// flows alike — see index.html `_handoverContext.pdfData` / `_handoverBulkContext.pdfData`):
//   { sap, customer, type, segmentDisplay, finalStageDisplay,
//     components: [{ sr, item, description, colorFinish, materialFinish,
//                    size, totalQty, handoverQty, pendingQty, status }] }

const PdfPrinter = require('pdfmake');

const BRAND = '#1a56db';
const GREEN = '#2b8a3e';
const BLUE = '#1971c2';

function esc(v) {
  if (v === undefined || v === null || v === '') return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Em dash for empty cells, matching the in-app preview.
function dash(v) {
  const s = esc(v);
  return s === '' ? '&mdash;' : s;
}

function plainDash(v) {
  return (v === undefined || v === null || v === '') ? '—' : String(v);
}

function safeComponents(pdfData) {
  const list = Array.isArray(pdfData && pdfData.components) ? pdfData.components : [];
  return list.map((c, i) => ({
    sr: c.sr != null ? c.sr : i + 1,
    item: c.item || '',
    description: c.description || '',
    colorFinish: c.colorFinish || '',
    materialFinish: c.materialFinish || '',
    size: c.size || '',
    totalQty: c.totalQty != null ? c.totalQty : 0,
    handoverQty: c.handoverQty != null ? c.handoverQty : 0,
    pendingQty: c.pendingQty != null ? c.pendingQty : 0,
    status: c.status || '',
  }));
}

// Generated-on stamp, always IST regardless of where the server runs (Cloud
// Run containers are UTC; a dev box may be IST already). Shifting the epoch by
// +5:30 and then reading the UTC parts is correct in both cases — reading
// local parts after the shift would double-count the offset on an IST machine.
function istStamp() {
  const d = new Date(Date.now() + 330 * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} IST`;
}

// ---------------------------------------------------------------------------
// HTML email body
// ---------------------------------------------------------------------------
// Outlook on Windows renders HTML email through Word's engine, which ignores
// flexbox/grid/float and most shorthand CSS. Everything here is therefore
// table-based with inline styles and explicit widths — the same constraint the
// original SMTP plan called out in ARCHITECTURE.md.
function buildEmailHtml(pdfData) {
  const d = pdfData || {};
  const components = safeComponents(d);

  const cellBase = 'padding:6px 9px;border:1px solid #cfd4dc;font-size:12px;font-family:Arial,Helvetica,sans-serif;vertical-align:top';
  const thBase = cellBase + ';background:#f0f2f5;font-weight:bold;text-align:left';
  const lblCell = cellBase + ';background:#fafbfc;color:#555';
  const valCell = cellBase + ';font-weight:bold';

  const infoRows = [
    ['Project No', plainDash(d.sap), 'Manufacturing Segment', plainDash(d.segmentDisplay)],
    ['Customer', plainDash(d.customer), 'Product Type', plainDash(d.type)],
    ['Final Stage', plainDash(d.finalStageDisplay), 'QC Status', 'Approved'],
  ].map((r) => {
    const qcApproved = r[2] === 'QC Status';
    const lastVal = qcApproved
      ? `<td style="${valCell};color:${GREEN}">${esc(r[3])}</td>`
      : `<td style="${valCell}">${dash(r[3])}</td>`;
    return `<tr><td style="${lblCell}">${esc(r[0])}</td><td style="${valCell}">${dash(r[1])}</td>`
      + `<td style="${lblCell}">${esc(r[2])}</td>${lastVal}</tr>`;
  }).join('');

  const compRows = components.map((c) => {
    const statusColor = c.status === 'Complete' ? GREEN : BLUE;
    const desc = c.description
      ? `<div style="font-size:10.5px;color:#555;margin-top:2px">${esc(c.description)}</div>` : '';
    const applied = c.materialFinish
      ? `<div style="font-size:10.5px;color:#065f46;margin-top:2px">Applied: ${esc(c.materialFinish)}</div>` : '';
    return '<tr>'
      + `<td style="${cellBase};text-align:center">${esc(c.sr)}</td>`
      + `<td style="${cellBase}"><b>${esc(c.item)}</b>${desc}</td>`
      + `<td style="${cellBase}">${dash(c.colorFinish)}${applied}</td>`
      + `<td style="${cellBase}">${dash(c.size)}</td>`
      + `<td style="${cellBase};text-align:right">${esc(c.totalQty)}</td>`
      + `<td style="${cellBase};text-align:right">${esc(c.handoverQty)}</td>`
      + `<td style="${cellBase};text-align:right">${esc(c.pendingQty)}</td>`
      + `<td style="${cellBase};font-weight:bold;color:${statusColor}">${esc(c.status)}</td>`
      + '</tr>';
  }).join('');

  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    + '<body style="margin:0;padding:0;background:#f4f6f9">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6f9;padding:18px 0">'
    + '<tr><td align="center">'
    + '<table role="presentation" width="900" cellpadding="0" cellspacing="0" border="0" style="width:900px;max-width:100%;background:#ffffff;border:1px solid #d8dde5">'

    // Header band
    + `<tr><td style="background:${BRAND};padding:14px 18px">`
    + '<div style="font-family:Arial,Helvetica,sans-serif;font-size:17px;font-weight:bold;color:#ffffff">ONEPWS Production Control Portal</div>'
    + '<div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#d7e3fb;padding-top:2px">Final-Stage Handover Notification</div>'
    + '</td></tr>'

    + '<tr><td style="padding:18px">'

    // Project / production information
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%">'
    + '<tr>'
    + `<th style="${thBase};width:20%">Project Information</th><th style="${thBase};width:30%">Value</th>`
    + `<th style="${thBase};width:20%">Production Information</th><th style="${thBase};width:30%">Value</th>`
    + '</tr>'
    + infoRows
    + '</table>'

    // Components
    + '<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;color:#111;margin:16px 0 6px 0">'
    + `Components Ready for Handover (${components.length})</div>`
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%">'
    + '<tr>'
    + `<th style="${thBase};width:6%;text-align:center">Sr.</th>`
    + `<th style="${thBase}">Component</th>`
    + `<th style="${thBase}">Color / Finish</th>`
    + `<th style="${thBase}">Size / Dimensions</th>`
    + `<th style="${thBase};width:9%;text-align:right">Total Qty</th>`
    + `<th style="${thBase};width:10%;text-align:right">Handover Qty</th>`
    + `<th style="${thBase};width:9%;text-align:right">Pending Qty</th>`
    + `<th style="${thBase};width:10%">Status</th>`
    + '</tr>'
    + compRows
    + '</table>'

    + '<div style="font-family:Arial,Helvetica,sans-serif;font-size:11.5px;color:#555;margin-top:14px;line-height:1.5">'
    + 'The same details are attached as a PDF for printing and record-keeping.</div>'

    + '</td></tr>'

    // Footer
    + '<tr><td style="background:#f7f8fa;border-top:1px solid #e2e6ed;padding:10px 18px">'
    + '<div style="font-family:Arial,Helvetica,sans-serif;font-size:10.5px;color:#888">'
    + `Auto-generated by the ONEPWS Production Control Portal &middot; ${istStamp()}</div>`
    + '</td></tr>'

    + '</table></td></tr></table></body></html>';
}

// Plain-text alternative, for mail clients that refuse HTML.
function buildEmailText(pdfData) {
  const d = pdfData || {};
  const components = safeComponents(d);
  const lines = [
    'ONEPWS PRODUCTION CONTROL PORTAL',
    'Final-Stage Handover Notification',
    '',
    'PROJECT INFORMATION',
    `  Project No            : ${plainDash(d.sap)}`,
    `  Customer              : ${plainDash(d.customer)}`,
    `  Final Stage           : ${plainDash(d.finalStageDisplay)}`,
    `  Manufacturing Segment : ${plainDash(d.segmentDisplay)}`,
    `  Product Type          : ${plainDash(d.type)}`,
    '  QC Status             : Approved',
    '',
    `COMPONENTS READY FOR HANDOVER (${components.length})`,
    '',
  ];
  components.forEach((c) => {
    lines.push(`  ${c.sr}. ${c.item}${c.description ? ' — ' + c.description : ''}`);
    lines.push(`     Color/Finish : ${plainDash(c.colorFinish)}`);
    lines.push(`     Size         : ${plainDash(c.size)}`);
    lines.push(`     Qty          : ${c.handoverQty} of ${c.totalQty} handed over, ${c.pendingQty} pending  [${c.status}]`);
    lines.push('');
  });
  lines.push('The full formatted details are attached as a PDF.');
  lines.push('');
  lines.push(`Auto-generated by the ONEPWS Production Control Portal · ${istStamp()}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// PDF attachment
// ---------------------------------------------------------------------------
// pdfmake with the standard-14 PDF fonts (Helvetica) — these are built into
// every PDF reader, so no .ttf files need to ship in the container image. A
// headless-browser renderer would reproduce the print HTML more literally but
// costs ~300MB and far more RAM than this service's 512Mi/scale-to-zero
// configuration allows.
const PDF_FONTS = {
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
};

function buildPdfDefinition(pdfData) {
  const d = pdfData || {};
  const components = safeComponents(d);

  const infoBody = [
    [
      { text: 'Project Information', style: 'th' },
      { text: 'Value', style: 'th' },
      { text: 'Production Information', style: 'th' },
      { text: 'Value', style: 'th' },
    ],
    [
      { text: 'Project No', style: 'lbl' }, { text: plainDash(d.sap), style: 'val' },
      { text: 'Manufacturing Segment', style: 'lbl' }, { text: plainDash(d.segmentDisplay), style: 'val' },
    ],
    [
      { text: 'Customer', style: 'lbl' }, { text: plainDash(d.customer), style: 'val' },
      { text: 'Product Type', style: 'lbl' }, { text: plainDash(d.type), style: 'val' },
    ],
    [
      { text: 'Final Stage', style: 'lbl' }, { text: plainDash(d.finalStageDisplay), style: 'val' },
      { text: 'QC Status', style: 'lbl' }, { text: 'Approved', style: 'val', color: GREEN },
    ],
  ];

  const compBody = [[
    { text: 'Sr.', style: 'th', alignment: 'center' },
    { text: 'Component', style: 'th' },
    { text: 'Color / Finish', style: 'th' },
    { text: 'Size / Dimensions', style: 'th' },
    { text: 'Total Qty', style: 'th', alignment: 'right' },
    { text: 'Handover Qty', style: 'th', alignment: 'right' },
    { text: 'Pending Qty', style: 'th', alignment: 'right' },
    { text: 'Status', style: 'th' },
  ]];

  components.forEach((c) => {
    const itemStack = [{ text: c.item || '—', bold: true }];
    if (c.description) itemStack.push({ text: c.description, fontSize: 7.5, color: '#555' });

    const finishStack = [{ text: plainDash(c.colorFinish) }];
    if (c.materialFinish) finishStack.push({ text: 'Applied: ' + c.materialFinish, fontSize: 7.5, color: '#065f46' });

    compBody.push([
      { text: String(c.sr), alignment: 'center' },
      { stack: itemStack },
      { stack: finishStack },
      { text: plainDash(c.size) },
      { text: String(c.totalQty), alignment: 'right' },
      { text: String(c.handoverQty), alignment: 'right' },
      { text: String(c.pendingQty), alignment: 'right' },
      { text: c.status || '—', bold: true, color: c.status === 'Complete' ? GREEN : BLUE },
    ]);
  });

  return {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [28, 30, 28, 34],
    defaultStyle: { font: 'Helvetica', fontSize: 8.5, color: '#111' },
    footer: (currentPage, pageCount) => ({
      margin: [28, 6, 28, 0],
      columns: [
        { text: `Generated: ${istStamp()} · ONEPWS Production Control Portal`, fontSize: 7, color: '#888' },
        { text: `Page ${currentPage} of ${pageCount}`, fontSize: 7, color: '#888', alignment: 'right' },
      ],
    }),
    content: [
      { text: 'ONEPWS Production Control Portal', fontSize: 14, bold: true, color: BRAND },
      { text: 'Final-Stage Handover Notification', fontSize: 9.5, color: '#555', margin: [0, 1, 0, 12] },
      {
        table: { headerRows: 1, widths: ['20%', '30%', '20%', '30%'], body: infoBody },
        layout: { hLineColor: () => '#cfd4dc', vLineColor: () => '#cfd4dc', hLineWidth: () => 0.7, vLineWidth: () => 0.7 },
      },
      {
        text: `Components Ready for Handover (${components.length})`,
        fontSize: 10, bold: true, margin: [0, 16, 0, 6],
      },
      {
        table: {
          headerRows: 1,
          widths: ['auto', '*', '*', '*', 'auto', 'auto', 'auto', 'auto'],
          body: compBody,
        },
        layout: { hLineColor: () => '#cfd4dc', vLineColor: () => '#cfd4dc', hLineWidth: () => 0.7, vLineWidth: () => 0.7 },
      },
    ],
    styles: {
      th: { bold: true, fontSize: 8, fillColor: '#f0f2f5' },
      lbl: { color: '#555' },
      val: { bold: true },
    },
  };
}

function buildPdfBuffer(pdfData) {
  return new Promise((resolve, reject) => {
    try {
      const printer = new PdfPrinter(PDF_FONTS);
      const doc = printer.createPdfKitDocument(buildPdfDefinition(pdfData));
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// "Handover-CD-26-27-10048.pdf" — safe on Windows, Android and mail clients.
function pdfFileName(pdfData) {
  const sap = String((pdfData && pdfData.sap) || 'Notification').replace(/[^A-Za-z0-9._-]+/g, '-');
  return `Handover-${sap}.pdf`;
}

module.exports = { buildEmailHtml, buildEmailText, buildPdfBuffer, pdfFileName };
