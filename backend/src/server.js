require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const qcRoutes = require('./routes/qc');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'onepws-backend' }));

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
