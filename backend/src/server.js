require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const qcRoutes = require('./routes/qc');

const app = express();
app.use(cors());
app.use(express.json());

// BACKEND_VERSION: bump this with every backend change so a simple visit to
// /api/health tells you (and support) definitively whether the live server is
// running the code you think it's running — this exists specifically because
// "is the deployment actually up to date" has been the real cause behind more
// than one reported bug that looked like an application issue.
const BACKEND_VERSION = '2026-07-18.1-delete-project';
app.get('/api/health', (req, res) => res.json({
  ok: true,
  service: 'onepws-backend',
  version: BACKEND_VERSION,
  routes: {
    'DELETE /api/projects/:id': true,
    'POST /api/bom-lines/:lineId/stage-entry': true,
    'POST /api/bom-lines/:lineId/qc-decision': true,
  }
}));

app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/bom-lines', qcRoutes);

// Central error handler — keeps unexpected exceptions from crashing the
// process and always returns JSON instead of an HTML error page.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`onepws-backend listening on port ${PORT}`));
