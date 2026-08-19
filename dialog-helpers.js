// ============================================================================
// dialog-helpers.js — v54.4
// Promise-based replacements for window.prompt() and window.confirm(),
// which Electron blocks. Loaded via <script src="dialog-helpers.js"> from
// index.html. Same isolation pattern as csv-import.js — kept out of the
// main HTML file to avoid splice-related syntax bugs.
//
// Exposes on window:
//   - electronPrompt(message, defaultValue)         → Promise<string|null>
//   - electronConfirm(message, {yes, no})           → Promise<boolean>
//
// Usage — replace this:
//     const v = prompt('Name:');
//     if (!v) return;
// with this:
//     const v = await electronPrompt('Name:');
//     if (!v) return;
// (calling function must be async).
// ============================================================================

(function () {
  'use strict';

  // Build (or reuse) the shared dialog element and return references to its
  // internal parts. Idempotent — safe to call every time.
  function ensureDialog() {
    let overlay = document.getElementById('electronDialogOverlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'electronDialogOverlay';
    overlay.innerHTML =
      '<div class="modal" style="max-width:460px;width:92%">' +
        '<div class="modal-header">' +
          '<div class="modal-title" id="electronDialogTitle">Input required</div>' +
          '<button class="modal-close" id="electronDialogClose" type="button">&times;</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<div id="electronDialogMessage" style="font-size:13px;margin-bottom:10px;white-space:pre-wrap;line-height:1.5"></div>' +
          '<input type="text" class="form-input" id="electronDialogInput" style="width:100%;height:34px;display:none">' +
        '</div>' +
        '<div class="modal-footer" style="justify-content:flex-end;gap:8px">' +
          '<button class="btn btn-outline" id="electronDialogCancel" type="button">Cancel</button>' +
          '<button class="btn btn-primary" id="electronDialogOk" type="button">OK</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    return overlay;
  }

  function openDialog(opts) {
    // opts: { title, message, input:boolean, defaultValue, okLabel, cancelLabel }
    // Returns Promise; resolves via OK/Cancel/close/Escape/Enter.
    return new Promise(function (resolve) {
      const overlay = ensureDialog();
      const titleEl  = document.getElementById('electronDialogTitle');
      const msgEl    = document.getElementById('electronDialogMessage');
      const inputEl  = document.getElementById('electronDialogInput');
      const okBtn    = document.getElementById('electronDialogOk');
      const cancelBtn= document.getElementById('electronDialogCancel');
      const closeBtn = document.getElementById('electronDialogClose');

      titleEl.textContent   = opts.title || (opts.input ? 'Input required' : 'Confirm');
      msgEl.textContent     = opts.message || '';
      okBtn.textContent     = opts.okLabel || 'OK';
      cancelBtn.textContent = opts.cancelLabel || 'Cancel';

      if (opts.input) {
        inputEl.style.display = 'block';
        inputEl.value = opts.defaultValue == null ? '' : String(opts.defaultValue);
        setTimeout(function () { inputEl.focus(); inputEl.select(); }, 30);
      } else {
        inputEl.style.display = 'none';
        inputEl.value = '';
        setTimeout(function () { okBtn.focus(); }, 30);
      }

      // Cleanup and resolve — avoid leaking listeners across dialogs.
      function done(result) {
        overlay.classList.remove('open');
        okBtn.removeEventListener('click', okHandler);
        cancelBtn.removeEventListener('click', cancelHandler);
        closeBtn.removeEventListener('click', cancelHandler);
        inputEl.removeEventListener('keydown', keyHandler);
        document.removeEventListener('keydown', escHandler);
        resolve(result);
      }

      function okHandler() {
        if (opts.input) done(inputEl.value); // caller trims/validates
        else done(true);
      }
      function cancelHandler() {
        if (opts.input) done(null);
        else done(false);
      }
      function keyHandler(e) {
        if (e.key === 'Enter' && opts.input) { e.preventDefault(); okHandler(); }
      }
      function escHandler(e) {
        if (e.key === 'Escape') { e.preventDefault(); cancelHandler(); }
      }

      okBtn.addEventListener('click', okHandler);
      cancelBtn.addEventListener('click', cancelHandler);
      closeBtn.addEventListener('click', cancelHandler);
      inputEl.addEventListener('keydown', keyHandler);
      document.addEventListener('keydown', escHandler);

      overlay.classList.add('open');
    });
  }

  // Public API
  function electronPrompt(message, defaultValue) {
    return openDialog({
      title: 'Input required',
      message: message,
      input: true,
      defaultValue: defaultValue,
      okLabel: 'OK',
      cancelLabel: 'Cancel'
    });
  }

  function electronConfirm(message, options) {
    options = options || {};
    return openDialog({
      title: options.title || 'Confirm',
      message: message,
      input: false,
      okLabel: options.yes || 'Yes',
      cancelLabel: options.no || 'No'
    });
  }

  window.electronPrompt  = electronPrompt;
  window.electronConfirm = electronConfirm;
})();