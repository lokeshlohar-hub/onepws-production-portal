const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Maximum file size after base64 decode — 3 MB per document. Base64
// inflates ~33% so the base64 STRING may be up to ~4 MB, but we check
// the DECODED byte count so the user-facing "3 MB per file" limit stays
// consistent regardless of how the payload was encoded.
const MAX_FILE_BYTES = 3 * 1024 * 1024;

// Cap on access_log entries per document — preserves the most-recent
// audit trail while preventing unbounded JSONB growth on frequently
// viewed documents. Older entries drop off; no separate cleanup needed.
const ACCESS_LOG_CAP = 200;

// Maps a snake_case DB row to the camelCase shape the frontend expects.
// file_data is excluded from list responses (would send megabytes of
// base64 per document); the /:id/file endpoint returns it separately
// when the download flow actually needs it.
function rowToDoc(row, includeFileData) {
  const doc = {
    id: row.id,
    docNo: row.doc_no || '',
    name: row.name,
    dept: row.dept || '',
    origin: row.origin || '',
    category: row.category || '',
    level: row.level || '',
    freq: row.freq || '',
    status: row.status || '',
    purpose: row.purpose || '',
    owner: row.owner || '',
    prepBy: row.prep_by || '',
    approvedBy: row.approved_by || '',
    linkedDocs: row.linked_docs || '',
    auditRemarks: row.audit_remarks || '',
    folderId: row.folder_id || '',
    fileType: row.file_type || '',
    fileName: row.file_name || '',
    fileSize: row.file_size || '',
    firstIssueDate: row.first_issue_date,
    tags: row.tags || [],
    revisions: row.revisions || [],
    accessLog: row.access_log || [],
    createdBy: row.created_by || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (includeFileData) doc.fileData = row.file_data || '';
  return doc;
}

// Server-side size check — rejects with 413 (Payload Too Large) if the
// base64-decoded file bytes exceed MAX_FILE_BYTES. Returns true if valid
// (or no file uploaded), false if the response has already been sent.
function validateFileSize(fileData, res) {
  if (!fileData) return true;
  const bytes = Buffer.byteLength(fileData, 'base64');
  if (bytes > MAX_FILE_BYTES) {
    res.status(413).json({
      error: 'File too large — ' + Math.round(bytes / 1024) + ' KB exceeds the 3 MB per-document limit. Please reduce file size or split into multiple documents.',
    });
    return false;
  }
  return true;
}

// GET /api/dms-documents — list every document, most recent first.
// Deliberately excludes file_data (see rowToDoc comment) — downloads
// go through /:id/file below.
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, doc_no, name, dept, origin, category, level, freq, status,
            purpose, owner, prep_by, approved_by, linked_docs, audit_remarks,
            folder_id, file_type, file_name, file_size, first_issue_date,
            tags, revisions, access_log, created_by, created_at, updated_at
       FROM dms_documents ORDER BY created_at DESC`
  );
  res.json({ documents: rows.map(r => rowToDoc(r, false)) });
});

// GET /api/dms-documents/:id/file — returns just the base64 file bytes
// for one document. Separated from the list endpoint so we're never
// streaming file bytes when the caller only wanted metadata.
router.get('/:id/file', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, file_data, file_name, file_type FROM dms_documents WHERE id = $1',
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
  res.json({
    id: rows[0].id,
    fileName: rows[0].file_name || '',
    fileType: rows[0].file_type || '',
    fileData: rows[0].file_data || '',
  });
});

// POST /api/dms-documents — create a new document. Server generates the
// id via a Postgres sequence (dms_doc_seq) so concurrent uploads never
// collide on the same DOC-NNNN — the earlier COUNT(*)+1 pattern raced
// under load. Uppercases doc_no on write for consistent search/lookup.
// Enforces the 3 MB per-document file size limit even if the client
// didn't check.
router.post('/', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'Document name is required' });
    if (!validateFileSize(b.fileData, res)) return;

    const { rows: seq } = await pool.query("SELECT nextval('dms_doc_seq') AS n");
    const id = 'DOC-' + String(seq[0].n).padStart(4, '0');

    const nowTs = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const identity = req.user?.username || 'Admin';

    // Access log defaults to a single "Upload" entry if the client
    // didn't supply one — matches the frontend's existing convention
    // where a new document's accessLog starts with the upload event.
    const accessLog = Array.isArray(b.accessLog) && b.accessLog.length
      ? b.accessLog.slice(-ACCESS_LOG_CAP)
      : [{ ts: nowTs, user: identity, action: 'Upload', ip: '192.168.1.1' }];
    // Same for revisions — first revision defaults to "First Issue" if
    // the client didn't supply one, using whatever metadata came in.
    const revisions = Array.isArray(b.revisions) && b.revisions.length
      ? b.revisions
      : [{
          revNo: b.revNo || '01',
          revDate: b.revDate || null,
          revBy: b.prepBy || '',
          approvedBy: b.approvedBy || '',
          changeSummary: b.revLog || 'First Issue',
          fileRef: b.fileName || '',
          status: 'Active',
          archivedAt: null,
        }];
    const tags = Array.isArray(b.tags) && b.tags.length
      ? b.tags
      : [b.dept, b.origin, b.category, b.level].filter(Boolean);

    const { rows } = await pool.query(
      `INSERT INTO dms_documents (
         id, doc_no, name, dept, origin, category, level, freq, status,
         purpose, owner, prep_by, approved_by, linked_docs, audit_remarks,
         folder_id, file_type, file_name, file_size, file_data,
         first_issue_date, tags, revisions, access_log, created_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
         $16,$17,$18,$19,$20,$21,$22,$23,$24,$25
       ) RETURNING *`,
      [
        id,
        b.docNo ? String(b.docNo).trim().toUpperCase() : null,
        b.name.trim(),
        b.dept || null, b.origin || null, b.category || null,
        b.level || null, b.freq || null, b.status || 'Active',
        b.purpose || null, b.owner || null, b.prepBy || null,
        b.approvedBy || null, b.linkedDocs || null, b.auditRemarks || null,
        b.folderId || null,
        b.fileType || null, b.fileName || null, b.fileSize || null,
        b.fileData || null,
        b.firstIssueDate || null,
        JSON.stringify(tags),
        JSON.stringify(revisions),
        JSON.stringify(accessLog),
        identity,
      ]
    );
    res.json({ document: rowToDoc(rows[0], false) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/dms-documents/:id — update in place. Handles new revisions
// by archiving prior "Active" ones inside the revisions JSONB and
// pushing the new one on top (matches the frontend's existing revision
// versioning contract). Access log gets a new entry and is capped at
// ACCESS_LOG_CAP to prevent unbounded growth on frequently-updated
// documents. If fileData is omitted from the payload the existing file
// bytes are kept unchanged (COALESCE guards); if a new fileData is
// present, the size check runs before persisting.
router.put('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!validateFileSize(b.fileData, res)) return;

    const { rows: existing } = await pool.query(
      'SELECT * FROM dms_documents WHERE id = $1',
      [req.params.id]
    );
    const cur = existing[0];
    if (!cur) return res.status(404).json({ error: 'Document not found' });

    const nowTs = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const identity = req.user?.username || 'Admin';

    const revisions = Array.isArray(cur.revisions) ? [...cur.revisions] : [];
    revisions.forEach(r => { if (r.status === 'Active') { r.status = 'Archived'; r.archivedAt = nowTs; } });
    if (b.revNo) {
      revisions.push({
        revNo: b.revNo,
        revDate: b.revDate || null,
        revBy: b.prepBy || '',
        approvedBy: b.approvedBy || '',
        changeSummary: b.revLog || 'Revision update',
        fileRef: b.fileName || cur.file_name || '',
        status: 'Active',
        archivedAt: null,
      });
    }

    const accessLog = Array.isArray(cur.access_log) ? [...cur.access_log] : [];
    accessLog.push({
      ts: nowTs,
      user: identity,
      action: 'Revision Upload' + (b.revNo ? ' (' + b.revNo + ')' : ''),
      ip: '192.168.1.1',
    });
    while (accessLog.length > ACCESS_LOG_CAP) accessLog.shift();

    const tags = Array.isArray(b.tags) ? b.tags
      : [b.dept || cur.dept, b.origin || cur.origin, b.category || cur.category, b.level || cur.level].filter(Boolean);

    const { rows } = await pool.query(
      `UPDATE dms_documents SET
         doc_no = COALESCE($1, doc_no),
         name = COALESCE($2, name),
         dept = COALESCE($3, dept),
         origin = COALESCE($4, origin),
         category = COALESCE($5, category),
         level = COALESCE($6, level),
         freq = COALESCE($7, freq),
         status = COALESCE($8, status),
         purpose = COALESCE($9, purpose),
         owner = COALESCE($10, owner),
         prep_by = COALESCE($11, prep_by),
         approved_by = COALESCE($12, approved_by),
         linked_docs = COALESCE($13, linked_docs),
         audit_remarks = COALESCE($14, audit_remarks),
         folder_id = COALESCE($15, folder_id),
         file_type = COALESCE($16, file_type),
         file_name = COALESCE($17, file_name),
         file_size = COALESCE($18, file_size),
         file_data = COALESCE($19, file_data),
         first_issue_date = COALESCE($20, first_issue_date),
         tags = $21,
         revisions = $22,
         access_log = $23,
         updated_at = NOW()
       WHERE id = $24 RETURNING *`,
      [
        b.docNo !== undefined ? (b.docNo ? String(b.docNo).trim().toUpperCase() : null) : null,
        b.name !== undefined ? b.name.trim() : null,
        b.dept !== undefined ? b.dept : null,
        b.origin !== undefined ? b.origin : null,
        b.category !== undefined ? b.category : null,
        b.level !== undefined ? b.level : null,
        b.freq !== undefined ? b.freq : null,
        b.status !== undefined ? b.status : null,
        b.purpose !== undefined ? b.purpose : null,
        b.owner !== undefined ? b.owner : null,
        b.prepBy !== undefined ? b.prepBy : null,
        b.approvedBy !== undefined ? b.approvedBy : null,
        b.linkedDocs !== undefined ? b.linkedDocs : null,
        b.auditRemarks !== undefined ? b.auditRemarks : null,
        b.folderId !== undefined ? b.folderId : null,
        b.fileType !== undefined ? b.fileType : null,
        b.fileName !== undefined ? b.fileName : null,
        b.fileSize !== undefined ? b.fileSize : null,
        b.fileData !== undefined ? b.fileData : null,
        b.firstIssueDate !== undefined ? b.firstIssueDate : null,
        JSON.stringify(tags),
        JSON.stringify(revisions),
        JSON.stringify(accessLog),
        req.params.id,
      ]
    );
    res.json({ document: rowToDoc(rows[0], false) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/dms-documents/:id — permanent deletion. No soft-delete
// for now; audit trail entries elsewhere still reference doc_no for
// compliance history if needed.
router.delete('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM dms_documents WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Document not found' });
  res.json({ ok: true, id: req.params.id });
});

module.exports = router;
