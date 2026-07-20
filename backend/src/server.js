require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const qcRoutes = require('./routes/qc');
const calibrationRoutes = require('./routes/calibration');

const app = express();
app.use(cors());
app.use(express.json());

const BACKEND_VERSION = '2026-07-19.1-calibration-persistence';
app.get('/api/health', (req, res) => res.json({
  ok: true,
  service: 'onepws-backend',
  version: BACKEND_VERSION,
  routes: {
    'DELETE /api/projects/:id': true,
    'POST /api/bom-lines/:lineId/stage-entry': true,
    'POST /api/bom-lines/:lineId/qc-decision': true,
    'GET /api/calibration-instruments': true,
    'POST /api/calibration-instruments/bulk': true,
  }
}));

app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/bom-lines', qcRoutes);
app.use('/api/calibration-instruments', calibrationRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`onepws-backend listening on port ${PORT}`));
