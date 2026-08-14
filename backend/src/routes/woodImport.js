// POST /api/wood/import/pdfs
//
// Accepts up to 20 PDF uploads (multipart), forwards each to the local
// extractor sidecar (http://127.0.0.1:8082/extract), aggregates the
// results, and returns a single JSON payload the frontend can render
// in the preview modal.
//
// Design decisions:
//   - No DB writes here. This endpoint is stateless. The frontend
//     collects the user's edits from the preview modal and then calls
//     the existing project-create / add-segment endpoints with the
//     approved rows.
//   - One bad PDF does NOT fail the whole batch. Each PDF gets its own
//     success/error entry in the response so the UI can show per-file
//     status.
//   - Admin-only. Same gating pattern used by /api/projects create.
//   - In-memory multer (files <= 32 MB, deleted after handling).

const express = require('express');
const multer  = require('multer');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const EXTRACTOR_URL         = process.env.EXTRACTOR_URL || 'http://127.0.0.1:8082';
const EXTRACTOR_TIMEOUT_MS  = 60_000;   // per-PDF hard timeout
const MAX_FILE_SIZE_BYTES   = 32 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 20;

// ---- Multer setup -----------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files:    MAX_FILES_PER_REQUEST,
  },
  fileFilter: (req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    if (file.mimetype === 'application/pdf' || name.endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('only .pdf files accepted'));
    }
  },
});

// ---- Extractor call ---------------------------------------------------------
async function extractOnePdf(fileBuffer, filename) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTRACTOR_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append(
      'file',
      new Blob([fileBuffer], { type: 'application/pdf' }),
      filename
    );
    const res = await fetch(`${EXTRACTOR_URL}/extract`, {
      method: 'POST',
      body:   form,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`extractor ${res.status}: ${text.slice(0, 200)}`);
    }
    return JSON.parse(text);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`extractor timeout after ${EXTRACTOR_TIMEOUT_MS} ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Route: POST /pdfs ------------------------------------------------------
router.post(
  '/pdfs',
  requireRole('admin', 'superadmin'),
  upload.array('files', MAX_FILES_PER_REQUEST),
  async (req, res) => {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        error: 'no files uploaded (expected multipart field: files)',
      });
    }

    const results = [];
    let totalRows  = 0;
    let totalPages = 0;

    for (const f of req.files) {
      try {
        const data      = await extractOnePdf(f.buffer, f.originalname);
        const pageCount = Array.isArray(data.pages) ? data.pages.length : 0;
        const rowCount  = data.row_count || 0;

        results.push({
          filename:  f.originalname,
          success:   true,
          pageCount, rowCount,
          pages:     data.pages || [],
        });
        totalPages += pageCount;
        totalRows  += rowCount;
      } catch (err) {
        console.error(`[wood-import] ${f.originalname} failed:`, err.message);
        results.push({
          filename: f.originalname,
          success:  false,
          error:    err.message,
          pageCount: 0,
          rowCount:  0,
          pages:     [],
        });
      }
    }

    res.json({
      files:            results,
      totalFiles:       results.length,
      successfulFiles:  results.filter((r) => r.success).length,
      totalPages,
      totalRows,
    });
  }
);

// ---- Multer error handler --------------------------------------------------
// Catches "file too large", "too many files", "only .pdf files accepted".
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message, code: err.code });
  }
  if (err && err.message === 'only .pdf files accepted') {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

module.exports = router;