// ============================================================================
// csv-import.js — v54.2
// BOM CSV import with per-row Component picker in a preview modal.
//
// Loaded by index.html via <script src="csv-import.js">. Depends on:
//   - M.componentRouting, M.stageConfig      (already on window from index.html)
//   - makeSegBOMRow(rowIdx, seg)             (defined in index.html)
//   - autoFillRoutingSeg(rowIdx, seg)        (defined in index.html)
//   - woodBomIdx, extBomIdx                  (mutable counters in index.html)
//   - toast(msg, icon)                       (defined in index.html)
//
// Exposes these functions on window so index.html's inline onclick/onchange
// handlers can reach them:
//   - downloadBOMTemplate_v2(seg)
//   - importBOMCSV_v2(input, seg)
//   - closeCsvImportModal_v2()
//   - commitCsvImportRows_v2()
// ============================================================================

(function () {
  'use strict';

  // ------------------------------------------------------------------------
  // Template download. New format: Description first, no Component, no Stream.
  // Sample rows are illustrative — Extrusion samples use L only (W/T blank).
  // ------------------------------------------------------------------------
  function downloadBOMTemplate_v2(seg) {
    seg = seg || 'wood';
    var uomList = ['PC', 'SET', 'NOS'].join('; ');
    var specialCharsList = 'CARB; FR (Fire Rated); FSC Grade; A.S.S.; Marmoleum; Alucore; Compact Laminate';
    var header = 'Description,Length (mm),Width (mm),Thickness (mm),UOM,Qty,Color/Finish,Special Characteristics';
    var samples = seg === 'ext'
      ? [
          'Vertical Profile Left,2100,,,PC,1,Anodised Silver,',
          'Vertical Profile Right,2100,,,PC,1,Anodised Silver,',
          'Horizontal Rail Top,900,,,PC,1,Anodised Silver,'
        ]
      : [
          'Straight Table Top With edge banding,1200,900,25,PC,1,White,FSC Grade',
          'Straight Table Top with Normal PU,1100,850,20,PC,1,Walnut,FR (Fire Rated)',
          'Straight Table Top With Modular PU,1000,800,15,PC,1,Custom Laminate,'
        ];
    var notes = [
      '// Add more rows below. Component will be selected in the preview after upload.',
      '// UOM options: ' + uomList,
      '// Special Characteristics options: ' + specialCharsList,
      '// Multiple Special Characteristics? Separate with semicolons, e.g. FSC Grade; FR (Fire Rated)',
      '// Length/Width/Thickness in mm. Extrusion segments typically use Length only.',
      '// Stream (Wood vs Extrusion) is derived automatically from the Component selected in the preview.'
    ];
    var csv = [header].concat(samples).concat(notes).join('\n');
    var blob = new Blob([csv], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (seg === 'ext' ? 'BOM_Import_Template_Extrusion.csv' : 'BOM_Import_Template_Wood.csv');
    a.click();
    if (typeof toast === 'function') toast('BOM template downloaded. Fill and re-import.', '\u{1F4E5}');
  }

  // ------------------------------------------------------------------------
  // Cross-reference component's route steps against M.stageConfig streams.
  // 'wood' + 'extrusion' + 'all' are the possible stage streams.
  //   - all wood-stream steps  -> 'wood'
  //   - all extrusion-only     -> 'extrusion'
  //   - mixed / all 'all' only -> 'both'
  //   - empty routing          -> 'both' (show in every dropdown; admin issue)
  // ------------------------------------------------------------------------
  function deriveComponentStream(compName) {
    var route = (window.M && window.M.componentRouting && window.M.componentRouting[compName]) || [];
    if (!route.length) return 'both';
    var stageStream = {};
    ((window.M && window.M.stageConfig) || []).forEach(function (sc) { stageStream[sc.name] = sc.stream; });
    var sawWood = false, sawExt = false;
    route.forEach(function (step) {
      var st = stageStream[step];
      if (st === 'wood') sawWood = true;
      else if (st === 'extrusion') sawExt = true;
    });
    if (sawWood && !sawExt) return 'wood';
    if (sawExt && !sawWood) return 'extrusion';
    return 'both';
  }

  function componentsForCsvSegment(seg) {
    // v54.2.1 — defer to the app's authoritative component list. Manual
    // "Add Row" in the BOM table uses bomComponentsForSegment() which
    // applies whatever admin-defined filtering matters (active flag,
    // segment eligibility, etc.). Using it here keeps CSV Import and
    // manual add in perfect sync — no chance of the two disagreeing on
    // what's importable.
    if (typeof window.bomComponentsForSegment === 'function') {
      var list = window.bomComponentsForSegment(seg) || [];
      return list.slice().sort();
    }
    // Fallback — should never fire in practice, but if the app's function
    // hasn't loaded yet, use the stream-derivation heuristic.
    var all = Object.keys((window.M && window.M.componentRouting) || {});
    var want = seg === 'ext' ? ['extrusion', 'both'] : ['wood', 'both'];
    return all.filter(function (c) { return want.indexOf(deriveComponentStream(c)) >= 0; }).sort();
  }

  // ------------------------------------------------------------------------
  // CSV parser + entry point. Refuses old-format files (Component-first) and
  // routes new-format files through the preview modal.
  // ------------------------------------------------------------------------
  function importBOMCSV_v2(input, seg) {
    seg = seg || 'wood';
    var file = input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      var raw = e.target.result;
      var lines = raw.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l && l.indexOf('//') !== 0; });
      if (lines.length < 2) {
        if (typeof toast === 'function') toast('CSV is empty or invalid.', '\u26A0');
        input.value = ''; return;
      }
      var headerLc = lines[0].toLowerCase();
      if (headerLc.indexOf('component') === 0) {
        if (typeof toast === 'function') toast('This looks like the old CSV format. Click Download Template to get the new format (no Component column) and re-fill.', '\u26A0');
        input.value = ''; return;
      }
      if (headerLc.indexOf('description') !== 0) {
        if (typeof toast === 'function') toast('Invalid CSV format. First column must be "Description". Please use the downloaded template.', '\u26A0');
        input.value = ''; return;
      }
      var rows = lines.slice(1);
      var parsed = [];
      rows.forEach(function (row, ri) {
        var cols = splitCsvLine(row);
        var description = (cols[0] || '').trim();
        if (!description) return;
        parsed.push({
          description: description,
          l: parseFloat(cols[1]) || null,
          w: parseFloat(cols[2]) || null,
          t: parseFloat(cols[3]) || null,
          uom: (cols[4] || 'PC').trim().toUpperCase(),
          qty: parseInt(cols[5]) || 1,
          colorFinish: (cols[6] || '').trim(),
          specialChars: (cols[7] || '').split(/[;,]/).map(function (s) { return s.trim(); }).filter(Boolean),
          include: true,
          component: '',
          sourceRow: ri + 2
        });
      });
      if (!parsed.length) {
        if (typeof toast === 'function') toast('No data rows found in CSV.', '\u26A0');
        input.value = ''; return;
      }
      openCsvImportPreview(parsed, seg);
      input.value = '';
    };
    reader.onerror = function () {
      if (typeof toast === 'function') toast('Could not read CSV file.', '\u26A0');
      input.value = '';
    };
    reader.readAsText(file);
  }

  // Simple CSV line splitter with quoted-field support.
  function splitCsvLine(line) {
    var out = [], cur = '', inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map(function (s) { return s.trim(); });
  }

  // ------------------------------------------------------------------------
  // Preview modal — built once at runtime, reused thereafter.
  // ------------------------------------------------------------------------
  var _rows = [];
  var _seg = 'wood';

  function buildModalIfNeeded() {
    if (document.getElementById('csvImportModal_v2')) return;
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'csvImportModal_v2';
    overlay.innerHTML =
      '<div class="modal" style="max-width:1300px;width:97%">' +
        '<div class="modal-header">' +
          '<div>' +
            '<div class="modal-title">\u{1F4C4} CSV Import Preview &mdash; <span id="csvImportSegLabel_v2">Wood</span> BOM</div>' +
            '<div class="text-xs text-muted" id="csvImportSummary_v2" style="margin-top:4px"></div>' +
          '</div>' +
          '<button class="modal-close" onclick="closeCsvImportModal_v2()">&times;</button>' +
        '</div>' +
        '<div class="modal-body" style="max-height:70vh;overflow-y:auto">' +
          '<div style="overflow-x:auto">' +
            '<table style="font-size:12px;min-width:1200px">' +
              '<thead><tr style="background:var(--surface2)">' +
                '<th style="width:36px;text-align:center" title="Include this row">\u2713</th>' +
                '<th style="width:36px;text-align:center">#</th>' +
                '<th style="min-width:180px">Component <span class="text-xs text-muted">(pick from master)</span></th>' +
                '<th>Description</th>' +
                '<th style="width:80px">L (mm)</th>' +
                '<th style="width:80px">W (mm)</th>' +
                '<th style="width:70px">T (mm)</th>' +
                '<th style="width:75px">UOM</th>' +
                '<th style="width:70px">Qty</th>' +
                '<th>Color / Finish</th>' +
                '<th>Special Characteristics</th>' +
              '</tr></thead>' +
              '<tbody id="csvImportRows_v2"></tbody>' +
            '</table>' +
          '</div>' +
          '<div style="margin-top:10px;padding:10px 12px;background:#f9fafb;border-radius:6px;font-size:12px;color:var(--text-muted)">' +
            '<div>\u{1F4A1} <b>Component</b> is picked from the master per row. The <b>Stream</b> is derived from the selected Component\u2019s routing.</div>' +
            '<div style="margin-top:4px">All fields are editable. Uncheck any row to skip it.</div>' +
          '</div>' +
        '</div>' +
        '<div class="modal-footer" style="justify-content:space-between;align-items:center;gap:12px">' +
          '<div class="text-xs text-muted"><span id="csvImportCommitCount_v2">0</span> row(s) selected</div>' +
          '<div style="display:flex;gap:8px">' +
            '<button class="btn btn-outline" onclick="closeCsvImportModal_v2()">Cancel</button>' +
            '<button class="btn btn-success" id="csvImportCommitBtn_v2" onclick="commitCsvImportRows_v2()">\u2705 Import Selected Rows</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
  }

  function openCsvImportPreview(rows, seg) {
    buildModalIfNeeded();
    _rows = rows;
    _seg = seg;
    var compList = componentsForCsvSegment(seg);
    var compOptsBase = '<option value="">-- Select Component --</option>' +
      compList.map(function (c) { return '<option value="' + c.replace(/"/g, '&quot;') + '">' + c + '</option>'; }).join('');
    document.getElementById('csvImportSummary_v2').textContent =
      rows.length + ' row' + (rows.length === 1 ? '' : 's') + ' parsed from CSV \u2014 pick a Component for each row.';
    document.getElementById('csvImportSegLabel_v2').textContent = seg === 'ext' ? 'Aluminium Extrusion' : 'Wood';
    var tbody = document.getElementById('csvImportRows_v2');
    tbody.innerHTML = rows.map(function (r, i) {
      var uomOpts = ['PC', 'SET', 'NOS', 'MTR'].map(function (u) {
        return '<option' + (u === r.uom ? ' selected' : '') + '>' + u + '</option>';
      }).join('');
      return '<tr data-row-idx="' + i + '">' +
        '<td style="text-align:center"><input type="checkbox" class="csv-row-include-v2" checked data-idx="' + i + '"></td>' +
        '<td style="text-align:center;color:var(--text-muted)">' + (i + 1) + '</td>' +
        '<td><select class="form-select csv-row-comp-v2" data-idx="' + i + '" style="height:28px;min-width:170px">' + compOptsBase + '</select>' +
          '<div class="text-xs" style="margin-top:2px;color:var(--text-muted)" id="csv_stream_v2_' + i + '">Stream: \u2014</div></td>' +
        '<td><input class="form-input" style="height:28px;width:200px" data-field="description" data-idx="' + i + '" value="' + (r.description || '').replace(/"/g, '&quot;') + '"></td>' +
        '<td><input class="form-input" type="number" style="height:28px;width:70px" data-field="l" data-idx="' + i + '" value="' + (r.l || '') + '"></td>' +
        '<td><input class="form-input" type="number" style="height:28px;width:70px" data-field="w" data-idx="' + i + '" value="' + (r.w || '') + '"></td>' +
        '<td><input class="form-input" type="number" style="height:28px;width:60px" data-field="t" data-idx="' + i + '" value="' + (r.t || '') + '"></td>' +
        '<td><select class="form-select" data-field="uom" data-idx="' + i + '" style="height:28px;width:65px">' + uomOpts + '</select></td>' +
        '<td><input class="form-input" type="number" style="height:28px;width:60px" data-field="qty" data-idx="' + i + '" value="' + (r.qty || 1) + '" min="1"></td>' +
        '<td><input class="form-input" style="height:28px;width:130px" data-field="colorFinish" data-idx="' + i + '" value="' + (r.colorFinish || '').replace(/"/g, '&quot;') + '"></td>' +
        '<td><input class="form-input" style="height:28px;width:150px" data-field="specialChars" data-idx="' + i + '" value="' + ((r.specialChars || []).join('; ')).replace(/"/g, '&quot;') + '" placeholder="; separated"></td>' +
        '</tr>';
    }).join('');

    tbody.querySelectorAll('.csv-row-comp-v2').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var idx = parseInt(this.dataset.idx);
        _rows[idx].component = this.value;
        var streamEl = document.getElementById('csv_stream_v2_' + idx);
        if (streamEl) {
          if (!this.value) { streamEl.textContent = 'Stream: \u2014'; }
          else {
            var s = deriveComponentStream(this.value);
            var label = s === 'wood' ? 'Wood' : s === 'extrusion' ? 'Aluminium Extrusion' : 'Both / Any';
            streamEl.textContent = 'Stream: ' + label;
          }
        }
      });
    });
    tbody.querySelectorAll('input[data-field], select[data-field]').forEach(function (el) {
      el.addEventListener('input', function () {
        var idx = parseInt(this.dataset.idx);
        var field = this.dataset.field;
        var val = this.value;
        if (field === 'l' || field === 'w' || field === 't') val = parseFloat(val) || null;
        else if (field === 'qty') val = parseInt(val) || 1;
        else if (field === 'specialChars') val = val.split(/[;,]/).map(function (s) { return s.trim(); }).filter(Boolean);
        else if (field === 'colorFinish' || field === 'description') val = val.trim();
        _rows[idx][field] = val;
      });
    });
    tbody.querySelectorAll('.csv-row-include-v2').forEach(function (cb) {
      cb.addEventListener('change', function () {
        _rows[parseInt(this.dataset.idx)].include = this.checked;
        updateCommitCount();
      });
    });
    updateCommitCount();
    document.getElementById('csvImportModal_v2').classList.add('open');
  }

  function updateCommitCount() {
    var n = _rows.filter(function (r) { return r.include; }).length;
    var countEl = document.getElementById('csvImportCommitCount_v2');
    var btn = document.getElementById('csvImportCommitBtn_v2');
    if (countEl) countEl.textContent = n;
    if (btn) btn.disabled = (n === 0);
  }

  function closeCsvImportModal_v2() {
    var m = document.getElementById('csvImportModal_v2');
    if (m) m.classList.remove('open');
    _rows = [];
  }

  function commitCsvImportRows_v2() {
    var seg = _seg;
    var rows = _rows.filter(function (r) { return r.include; });
    if (!rows.length) {
      if (typeof toast === 'function') toast('No rows selected for import.', '\u26A0');
      return;
    }
    var missing = rows.filter(function (r) { return !r.component; });
    if (missing.length) {
      if (typeof toast === 'function') toast(missing.length + ' row' + (missing.length === 1 ? '' : 's') + ' missing Component \u2014 pick one or uncheck the row.', '\u26A0');
      return;
    }
    var bodyId = seg === 'ext' ? 'extBomBody' : 'woodBomBody';
    var tbody = document.getElementById(bodyId);
    if (!tbody) {
      if (typeof toast === 'function') toast('BOM table not found for segment: ' + seg, '\u26A0');
      return;
    }
    rows.forEach(function (r) {
      var rowIdx = tbody.rows.length;
      var tmp = document.createElement('tbody');
      tmp.innerHTML = makeSegBOMRow(rowIdx, seg);
      var newRow = tmp.rows[0];
      var compSel = newRow.querySelector('[id^="bom_comp_"]');
      if (compSel) {
        var found = false;
        Array.from(compSel.options).forEach(function (o) {
          if (o.value === r.component || o.text === r.component) { o.selected = true; found = true; }
        });
        if (!found) {
          var opt = document.createElement('option');
          opt.value = r.component; opt.text = r.component; opt.selected = true;
          compSel.appendChild(opt);
        }
      }
      var descInput = newRow.querySelector('[id^="bom_desc_"]');
      if (descInput) descInput.value = (r.description || '').toUpperCase();
      var numInputs = newRow.querySelectorAll('input[type="number"]');
      if (seg === 'ext') {
        if (numInputs[0]) numInputs[0].value = r.l || '';
        if (numInputs[1]) numInputs[1].value = r.qty || 1;
      } else {
        if (numInputs[0]) numInputs[0].value = r.l || '';
        if (numInputs[1]) numInputs[1].value = r.w || '';
        if (numInputs[2]) numInputs[2].value = r.t || '';
        if (numInputs[3]) numInputs[3].value = r.qty || 1;
      }
      var uomSel = newRow.querySelector('select:not([id])');
      if (uomSel) {
        Array.from(uomSel.options).forEach(function (o) { if (o.value === r.uom) o.selected = true; });
      }
      var finishInput = newRow.querySelector('[id^="bom_finish_"]');
      if (finishInput) finishInput.value = r.colorFinish || '';
      if (r.specialChars && r.specialChars.length) {
        var charBoxes = newRow.querySelectorAll('.char-option');
        charBoxes.forEach(function (cb) { if (r.specialChars.indexOf(cb.value) >= 0) cb.checked = true; });
        var textEl = newRow.querySelector('[id^="ms_text_"]');
        if (textEl) {
          textEl.textContent = r.specialChars.join(', ');
          textEl.title = r.specialChars.join(', ');
          textEl.classList.remove('ms-placeholder');
        }
      }
      tbody.appendChild(newRow);
      setTimeout(function () { autoFillRoutingSeg(rowIdx, seg); }, 0);
      if (seg === 'wood') window.woodBomIdx++; else window.extBomIdx++;
    });
    if (typeof toast === 'function') {
      toast(rows.length + ' row' + (rows.length === 1 ? '' : 's') + ' added to ' + (seg === 'ext' ? 'Aluminium Extrusion' : 'Wood') + ' BOM.', '\u2705');
    }
    closeCsvImportModal_v2();
  }

  // Expose on window for inline handlers in index.html
  window.downloadBOMTemplate_v2  = downloadBOMTemplate_v2;
  window.importBOMCSV_v2         = importBOMCSV_v2;
  window.closeCsvImportModal_v2  = closeCsvImportModal_v2;
  window.commitCsvImportRows_v2  = commitCsvImportRows_v2;
})();