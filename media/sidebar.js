(function () {
  // ── Read config injected by the extension host ──────────
  var CONFIG = window.__PR_REVIEWER_CONFIG || {};
  var DISP_SIZE = CONFIG.dispSize || 128;
  var IDLE_CONFIG = { url: CONFIG.idleUri || '', cols: CONFIG.idleCols || 5, rows: CONFIG.idleRows || 5 };
  var WORK_CONFIG = { url: CONFIG.workUri || '', cols: CONFIG.workCols || 5, rows: CONFIG.workRows || 5 };

  // ── DOM refs ────────────────────────────────────────────
  var vscode = acquireVsCodeApi();
  var sprite = document.getElementById('sprite');
  var bubble = document.getElementById('bubble');
  var container = document.getElementById('findings-container');
  var logEl = document.getElementById('log');
  var statusIcon = document.getElementById('status-icon');
  var statusText = document.getElementById('status-text');
  var startBtn = document.getElementById('start-btn');
  var fetchBtn = document.getElementById('fetch-btn');
  var modelSelect = document.getElementById('model-select');
  var personalitySelect = document.getElementById('personality-select');
  var branchSelect = document.getElementById('branch-select');
  var extraInstructionsInput = document.getElementById('extra-instructions');
  var languageSelect = document.getElementById('language-select');

  // ── Animation state ─────────────────────────────────────
  var currentFrame = 0;
  var animTimer = null;
  var currentConfig = IDLE_CONFIG;
  var isReviewing = false;

  function startAnimation(config, fps) {
    var total = config.cols * config.rows;
    if (currentConfig.url !== config.url) {
      currentConfig = config;
      sprite.style.backgroundImage = "url('" + config.url + "')";
      sprite.style.backgroundSize = (DISP_SIZE * config.cols) + 'px ' + (DISP_SIZE * config.rows) + 'px';
    }
    if (animTimer) { clearInterval(animTimer); }
    currentFrame = 0;
    animTimer = setInterval(function () {
      var col = currentFrame % config.cols;
      var row = Math.floor(currentFrame / config.cols);
      sprite.style.backgroundPosition = (-col * DISP_SIZE) + 'px ' + (-row * DISP_SIZE) + 'px';
      currentFrame = (currentFrame + 1) % total;
    }, 1000 / fps);
  }

  startAnimation(IDLE_CONFIG, 6);

  // ── Personality & talk state ────────────────────────────
  var talkTimer = null;
  var allPersonalities = [];
  var currentMessages = null;

  function updateIdleBubble() {
    if (currentMessages && !isReviewing) {
      bubble.textContent = currentMessages.idle;
    }
  }

  // ── Saved settings state ────────────────────────────────
  var savedSettings = { baseBranch: '', model: '', personalityId: 'sarcastic', extraInstructions: '', language: 'English' };
  var modelsLoaded = false;
  var branchesLoaded = false;
  var personalitiesLoaded = false;
  var languagesLoaded = false;
  var settingsLoaded = false;

  function applySavedSettings() {
    if (!settingsLoaded) { return; }
    var curBranchSelect = document.getElementById('branch-select');
    var curModelSelect = document.getElementById('model-select');
    var curPersonalitySelect = document.getElementById('personality-select');
    var curExtraInstructionsInput = document.getElementById('extra-instructions');
    var curLanguageSelect = document.getElementById('language-select');
    if (branchesLoaded && savedSettings.baseBranch && curBranchSelect) {
      for (var i = 0; i < curBranchSelect.options.length; i++) {
        if (curBranchSelect.options[i].value === savedSettings.baseBranch) {
          curBranchSelect.selectedIndex = i;
          break;
        }
      }
    }
    if (modelsLoaded && savedSettings.model && curModelSelect) {
      for (var i = 0; i < curModelSelect.options.length; i++) {
        if (curModelSelect.options[i].value === savedSettings.model) {
          curModelSelect.selectedIndex = i;
          break;
        }
      }
    }
    if (personalitiesLoaded && savedSettings.personalityId && curPersonalitySelect) {
      for (var i = 0; i < curPersonalitySelect.options.length; i++) {
        if (curPersonalitySelect.options[i].value === savedSettings.personalityId) {
          curPersonalitySelect.selectedIndex = i;
          var selectedPersonality = allPersonalities.find(function (p) { return p.id === savedSettings.personalityId; });
          if (selectedPersonality && selectedPersonality.messages) {
            currentMessages = selectedPersonality.messages;
            updateIdleBubble();
          }
          break;
        }
      }
    }
    if (savedSettings.extraInstructions && curExtraInstructionsInput) {
      curExtraInstructionsInput.value = savedSettings.extraInstructions;
    }
    if (savedSettings.language && curLanguageSelect && languagesLoaded) {
      curLanguageSelect.value = savedSettings.language;
    }
  }

  // ── Persistence handlers ────────────────────────────────
  function attachPersistenceHandlers(branchEl, modelEl, personalityEl, extraInstructionsEl, languageEl) {
    if (branchEl) {
      branchEl.addEventListener('change', function () {
        vscode.postMessage({ type: 'saveSettings', settings: { baseBranch: branchEl.value } });
      });
    }
    if (modelEl) {
      modelEl.addEventListener('change', function () {
        vscode.postMessage({ type: 'saveSettings', settings: { model: modelEl.value } });
      });
    }
    if (personalityEl) {
      personalityEl.addEventListener('change', function () {
        vscode.postMessage({ type: 'saveSettings', settings: { personalityId: personalityEl.value } });
        var selectedPersonality = allPersonalities.find(function (p) { return p.id === personalityEl.value; });
        if (selectedPersonality && selectedPersonality.messages) {
          currentMessages = selectedPersonality.messages;
          updateIdleBubble();
        }
      });
    }
    if (extraInstructionsEl) {
      extraInstructionsEl.addEventListener('change', function () {
        vscode.postMessage({ type: 'saveSettings', settings: { extraInstructions: extraInstructionsEl.value } });
      });
    }
    if (languageEl) {
      languageEl.addEventListener('change', function () {
        vscode.postMessage({ type: 'saveSettings', settings: { language: languageEl.value } });
      });
    }
  }

  // ── Initial data requests ───────────────────────────────
  vscode.postMessage({ type: 'requestModels' });
  vscode.postMessage({ type: 'requestBranches' });
  vscode.postMessage({ type: 'requestPRs' });
  vscode.postMessage({ type: 'requestPersonalities' });
  vscode.postMessage({ type: 'requestLanguages' });
  vscode.postMessage({ type: 'loadSettings' });

  // ── Fetch-PR-findings button visibility ─────────────────
  function updateFetchBtnVisibility(selectEl) {
    var btn = document.getElementById('fetch-btn');
    if (!btn) { return; }
    var val = selectEl ? selectEl.value : '';
    btn.style.display = (val.indexOf('pr:') === 0) ? 'inline-block' : 'none';
  }

  attachPersistenceHandlers(branchSelect, modelSelect, personalitySelect, extraInstructionsInput, languageSelect);

  if (branchSelect) {
    branchSelect.addEventListener('change', function () { updateFetchBtnVisibility(branchSelect); });
    updateFetchBtnVisibility(branchSelect);
  }

  // ── Start review button ─────────────────────────────────
  function getReviewPayload(branchEl, modelEl, personalityEl, extraInstructionsEl, languageEl) {
    var selectedModel = modelEl ? modelEl.value : '';
    var personalityId = personalityEl ? personalityEl.value : 'sarcastic';
    var baseBranchValue = branchEl ? branchEl.value : '';
    var extraInstructions = extraInstructionsEl ? extraInstructionsEl.value : '';
    var language = languageEl ? languageEl.value : 'English';
    var prNumber;
    var baseBranch = baseBranchValue;
    if (baseBranchValue.indexOf('pr:') === 0) {
      prNumber = parseInt(baseBranchValue.substring(3), 10);
      baseBranch = '';
    }
    return { type: 'startReview', model: selectedModel, personalityId: personalityId, baseBranch: baseBranch, extraInstructions: extraInstructions, language: language, prNumber: prNumber };
  }

  if (startBtn) {
    startBtn.addEventListener('click', function () {
      vscode.postMessage(getReviewPayload(branchSelect, modelSelect, personalitySelect, extraInstructionsInput, languageSelect));
    });
  }

  if (fetchBtn) {
    fetchBtn.addEventListener('click', function () {
      var baseBranchValue = branchSelect ? branchSelect.value : '';
      if (baseBranchValue.indexOf('pr:') === 0) {
        vscode.postMessage({ type: 'fetchPrFindings', prNumber: parseInt(baseBranchValue.substring(3), 10) });
      }
    });
  }

  // ── Helpers: status, bubble, log ────────────────────────
  function setStatus(icon, text) {
    statusIcon.textContent = icon;
    statusText.textContent = text;
  }

  function showBubble(text, state) {
    clearTimeout(talkTimer);
    bubble.textContent = text;
    if (state === 'thinking' || state === 'talking' || state === 'laughing') {
      startAnimation(WORK_CONFIG, state === 'laughing' ? 16 : 10);
    } else if (!isReviewing) {
      startAnimation(IDLE_CONFIG, 6);
    }
    if (!isReviewing) {
      talkTimer = setTimeout(function () {
        if (!isReviewing) { startAnimation(IDLE_CONFIG, 6); }
      }, 8000);
    }
  }

  function appendLog(text, isError) {
    var line = document.createElement('div');
    line.className = isError ? 'log-line error' : 'log-line';
    var now = new Date();
    var ts = String(now.getHours()).padStart(2, '0') + ':' +
             String(now.getMinutes()).padStart(2, '0') + ':' +
             String(now.getSeconds()).padStart(2, '0');
    line.textContent = '[' + ts + '] ' + text;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    while (logEl.children.length > 100) { logEl.removeChild(logEl.firstChild); }
  }

  function clearLog() { logEl.innerHTML = ''; }

  // ── Form HTML (used on reset) ───────────────────────────
  function getFormHtml() {
    return '<div class="empty-state">' +
      '<div class="input-row">' +
        '<label for="branch-select">Compare Against</label>' +
        '<select id="branch-select" class="model-dropdown">' +
          '<option value="">Loading branches...</option>' +
        '</select>' +
      '</div>' +
      '<div class="input-row">' +
        '<label for="model-select">Model</label>' +
        '<select id="model-select" class="model-dropdown">' +
          '<option value="">Loading models...</option>' +
        '</select>' +
      '</div>' +
      '<div class="input-row">' +
        '<label for="personality-select">Reviewer Personality</label>' +
        '<select id="personality-select" class="model-dropdown">' +
          '<option value="">Loading personalities...</option>' +
        '</select>' +
      '</div>' +
      '<div class="input-row">' +
        '<label for="language-select">Response Language</label>' +
        '<select id="language-select" class="model-dropdown">' +
          '<option value="">Loading languages...</option>' +
        '</select>' +
      '</div>' +
      '<div class="input-row">' +
        '<label for="extra-instructions">Extra Instructions</label>' +
        '<textarea id="extra-instructions" class="extra-instructions" rows="3" placeholder="e.g. Focus on security issues, ignore style..."></textarea>' +
      '</div>' +
      '<div class="btn-row">' +
        '<button class="review-btn" id="start-btn">Start Review</button>' +
        '<button class="fetch-btn" id="fetch-btn">Fetch PR Findings</button>' +
      '</div>' +
    '</div>';
  }

  function bindFormHandlers() {
    var newStartBtn = document.getElementById('start-btn');
    var newModelSelect = document.getElementById('model-select');
    var newPersonalitySelect = document.getElementById('personality-select');
    var newBranchSelect = document.getElementById('branch-select');
    var newExtraInstructionsInput = document.getElementById('extra-instructions');
    var newLanguageSelect = document.getElementById('language-select');
    if (newStartBtn) {
      newStartBtn.addEventListener('click', function () {
        vscode.postMessage(getReviewPayload(newBranchSelect, newModelSelect, newPersonalitySelect, newExtraInstructionsInput, newLanguageSelect));
      });
    }
    var newFetchBtn = document.getElementById('fetch-btn');
    if (newFetchBtn) {
      newFetchBtn.addEventListener('click', function () {
        var baseBranchValue = newBranchSelect ? newBranchSelect.value : '';
        if (baseBranchValue.indexOf('pr:') === 0) {
          vscode.postMessage({ type: 'fetchPrFindings', prNumber: parseInt(baseBranchValue.substring(3), 10) });
        }
      });
    }
    if (newBranchSelect) {
      newBranchSelect.addEventListener('change', function () { updateFetchBtnVisibility(newBranchSelect); });
      updateFetchBtnVisibility(newBranchSelect);
    }
    attachPersistenceHandlers(newBranchSelect, newModelSelect, newPersonalitySelect, newExtraInstructionsInput, newLanguageSelect);
  }

  function resetToInitialState() {
    isReviewing = false;
    logEl.innerHTML = '';
    setStatus('\u{1F4A4}', 'Idle \u2014 waiting for review');
    bubble.textContent = currentMessages ? currentMessages.idle : 'Ready to eviscerate some code\u2026';
    startAnimation(IDLE_CONFIG, 6);
    container.innerHTML = getFormHtml();
    bindFormHandlers();
    modelsLoaded = false;
    branchesLoaded = false;
    personalitiesLoaded = false;
    languagesLoaded = false;
    settingsLoaded = false;
    vscode.postMessage({ type: 'requestModels' });
    vscode.postMessage({ type: 'requestBranches' });
    vscode.postMessage({ type: 'requestPRs' });
    vscode.postMessage({ type: 'requestPersonalities' });
    vscode.postMessage({ type: 'requestLanguages' });
    vscode.postMessage({ type: 'loadSettings' });
  }

  // ── Findings data ───────────────────────────────────────
  var allFindings = [];
  var currentFindings = [];

  function getSourceLabel(source) {
    switch (source) {
      case 'github-review': return '\u{1F464} Review';
      case 'github-check':  return '\u2713 Check';
      case 'copilot':
      default:               return '\u{1F916} Copilot';
    }
  }

  function getReviewerFromFinding(f) {
    if (!f || !f.title) { return ''; }
    var match = String(f.title).match(/^([^:]+):/);
    return match ? match[1].trim() : 'Unknown';
  }

  function isInlineFinding(f) {
    return typeof f.line === 'number' && f.line > 0;
  }

  // ── Filter dropdowns ────────────────────────────────────
  function buildDropdown(id, label, options) {
    var html = '<div class="filter-group">' +
      '<label>' + escHtml(label) + '</label>' +
      '<div class="filter-dropdown" id="' + id + '">' +
        '<div class="filter-dropdown-header">' +
          '<span class="filter-dropdown-label">All</span>' +
          '<span class="filter-dropdown-arrow">\u25be</span>' +
        '</div>' +
        '<div class="filter-dropdown-panel">';
    for (var i = 0; i < options.length; i++) {
      var o = options[i];
      html += '<label class="filter-dropdown-item">' +
        '<input type="checkbox" value="' + escHtml(o.value) + '" checked>' +
        escHtml(o.label) + '</label>';
    }
    html += '</div></div></div>';
    return html;
  }

  function updateDropdownLabel(dropdown) {
    var checks = dropdown.querySelectorAll('input[type="checkbox"]');
    var checked = dropdown.querySelectorAll('input[type="checkbox"]:checked');
    var labelEl = dropdown.querySelector('.filter-dropdown-label');
    if (!labelEl) { return; }
    if (checked.length === 0) { labelEl.textContent = 'None'; }
    else if (checked.length === checks.length) { labelEl.textContent = 'All'; }
    else {
      var names = [];
      checked.forEach(function (cb) { names.push(cb.parentElement.textContent.trim()); });
      labelEl.textContent = names.join(', ');
    }
  }

  function buildFilterHtml(reviewers) {
    var html = '<div class="filters-section">';
    html += buildDropdown('filter-severity', 'Severity', [
      { value: 'error', label: 'Error' },
      { value: 'warning', label: 'Warning' },
      { value: 'info', label: 'Info' }
    ]);
    html += buildDropdown('filter-type', 'Comment or Review', [
      { value: 'comment', label: 'Comment' },
      { value: 'review', label: 'Review' }
    ]);

    if (reviewers.length > 0) {
      var revOpts = [];
      for (var i = 0; i < reviewers.length; i++) {
        revOpts.push({ value: reviewers[i], label: reviewers[i] });
      }
      html += buildDropdown('filter-reviewer', 'Reviewer', revOpts);
    }

    html += '<button class="filter-reset" id="filter-reset-btn" type="button">Reset Filters</button>' +
      '</div>';
    return html;
  }

  // ── Render findings list ────────────────────────────────
  function renderFindingsList(findings) {
    var html = '';
    for (var i = 0; i < findings.length; i++) {
      var f = findings[i];
      var icon = f.severity === 'error' ? '\u{1F534}' : f.severity === 'warning' ? '\u{1F7E1}' : '\u{1F535}';
      var loc = f.line > 0 ? f.file + ':' + f.line : f.file;
      var sourceLabel = getSourceLabel(f.source);
      html +=
        '<div class="finding ' + escHtml(f.severity) + '" data-file="' + escHtml(f.file) + '" data-line="' + f.line + '" data-finding-index="' + i + '">' +
          '<div class="finding-header">' + icon + ' <span class="badge ' + escHtml(f.severity) + '">' + escHtml(f.severity) + '</span> ' + escHtml(f.title) + ' <span class="source-badge">' + sourceLabel + '</span></div>' +
          '<div class="finding-location">' + escHtml(loc) + '</div>' +
          '<div class="finding-message">' + escHtml(f.message) + '</div>' +
          (f.suggestion ? '<div class="finding-suggestion">\u{1F4A1} ' + escHtml(f.suggestion) + '</div>' : '') +
          '<button class="fix-btn">\u2728 Fix with Copilot</button>' +
        '</div>';
    }
    return html;
  }

  function bindFindingActions() {
    container.querySelectorAll('.finding').forEach(function (el) {
      el.addEventListener('click', function (e) {
        if (e.target.classList && e.target.classList.contains('fix-btn')) { return; }
        vscode.postMessage({ type: 'navigate', file: el.dataset.file, line: parseInt(el.dataset.line || '-1', 10) });
      });
    });

    container.querySelectorAll('.fix-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var findingEl = btn.closest('.finding');
        if (!findingEl) { return; }
        var index = parseInt(findingEl.dataset.findingIndex || '-1', 10);
        var finding = currentFindings[index];
        if (finding) {
          vscode.postMessage({ type: 'fixWithCopilot', finding: finding });
        }
      });
    });
  }

  // ── Filter logic ────────────────────────────────────────
  function getCheckedValues(dropdownId) {
    var dd = document.getElementById(dropdownId);
    if (!dd) { return null; }
    var checked = dd.querySelectorAll('input[type="checkbox"]:checked');
    var vals = [];
    checked.forEach(function (cb) { vals.push(cb.value); });
    return new Set(vals);
  }

  function applyFilters() {
    var allowedSeverity = getCheckedValues('filter-severity') || new Set(['error', 'warning', 'info']);
    var selectedTypes = getCheckedValues('filter-type') || new Set(['comment', 'review']);
    var allowedReviewers = getCheckedValues('filter-reviewer');

    currentFindings = allFindings.filter(function (f) {
      if (!allowedSeverity.has(f.severity)) { return false; }
      var inline = isInlineFinding(f);
      if (inline && !selectedTypes.has('comment')) { return false; }
      if (!inline && !selectedTypes.has('review')) { return false; }
      if (allowedReviewers) {
        var reviewer = getReviewerFromFinding(f);
        if (!allowedReviewers.has(reviewer)) { return false; }
      }
      return true;
    });

    var summaryLine = 'Found ' + currentFindings.length + ' issue' + (currentFindings.length !== 1 ? 's' : '') + ' after filtering.';
    var findingsHtml = '<div class="findings-header-row">' +
      '<div class="findings-header">' + escHtml(summaryLine) + '</div>' +
      '<button class="fix-all-btn" id="fix-all-btn">\u2728 Fix All with Copilot</button>' +
      '</div>';

    if (currentFindings.length === 0) {
      findingsHtml += '<div class="empty-state">No findings match your filters.</div>';
    } else {
      findingsHtml += renderFindingsList(currentFindings);
    }

    // Remove only the findings portion, keep filter DOM intact
    var child = container.lastChild;
    while (child && !(child.classList && child.classList.contains('filters-section'))) {
      var prev = child.previousSibling;
      container.removeChild(child);
      child = prev;
    }
    container.insertAdjacentHTML('beforeend', findingsHtml);

    bindFindingActions();

    var fixAllBtn = document.getElementById('fix-all-btn');
    if (fixAllBtn) {
      fixAllBtn.addEventListener('click', function () {
        vscode.postMessage({ type: 'fixAllWithCopilot', findings: currentFindings });
      });
    }
  }

  function bindFilterActions() {
    container.querySelectorAll('.filter-dropdown').forEach(function (dd) {
      var header = dd.querySelector('.filter-dropdown-header');
      if (header) {
        header.addEventListener('click', function (e) {
          e.stopPropagation();
          var wasOpen = dd.classList.contains('open');
          container.querySelectorAll('.filter-dropdown.open').forEach(function (d) { d.classList.remove('open'); });
          if (!wasOpen) { dd.classList.add('open'); }
        });
      }
      dd.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          updateDropdownLabel(dd);
          applyFilters();
        });
      });
    });

    document.addEventListener('click', function (e) {
      if (!e.target.closest('.filter-dropdown')) {
        container.querySelectorAll('.filter-dropdown.open').forEach(function (d) { d.classList.remove('open'); });
      }
    });

    var resetBtn = document.getElementById('filter-reset-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        container.querySelectorAll('.filter-dropdown').forEach(function (dd) {
          dd.querySelectorAll('input[type="checkbox"]').forEach(function (cb) { cb.checked = true; });
          updateDropdownLabel(dd);
        });
        applyFilters();
      });
    }
  }

  // ── Render findings (called from extension message) ─────
  function renderFindings(findings) {
    if (!findings || findings.length === 0) {
      var noIssuesMsg = currentMessages ? currentMessages.quips.noIssues : "No findings. Either your code is decent, or I've gone blind.";
      container.innerHTML = '<div class="empty-state">' + escHtml(noIssuesMsg) + '</div>';
      showBubble(noIssuesMsg, 'idle');
      setStatus('\u2705', 'Review complete \u2014 no issues');
      return;
    }

    allFindings = Array.isArray(findings) ? findings.slice() : [];
    currentFindings = allFindings.slice();

    var errors = allFindings.filter(function (f) { return f.severity === 'error'; }).length;
    var warnings = allFindings.filter(function (f) { return f.severity === 'warning'; }).length;
    var infos = allFindings.filter(function (f) { return f.severity === 'info'; }).length;

    var summaryLine = 'Found ' + allFindings.length + ' issue' + (allFindings.length !== 1 ? 's' : '') + ': ' +
      errors + ' error' + (errors !== 1 ? 's' : '') + ', ' +
      warnings + ' warning' + (warnings !== 1 ? 's' : '') + ', ' +
      infos + ' note' + (infos !== 1 ? 's' : '') + '.';

    var quip = pickQuip(errors, warnings, allFindings.length);
    showBubble(quip, errors > 0 ? 'laughing' : 'talking');
    setStatus(errors > 0 ? '\u{1F534}' : warnings > 0 ? '\u{1F7E1}' : '\u{1F535}', summaryLine);

    var reviewerSet = new Set();
    for (var i = 0; i < allFindings.length; i++) {
      reviewerSet.add(getReviewerFromFinding(allFindings[i]));
    }
    var reviewers = Array.from(reviewerSet).filter(Boolean).sort();

    var html = buildFilterHtml(reviewers);
    html += '<div class="findings-header-row">' +
      '<div class="findings-header">' + escHtml(summaryLine) + '</div>' +
      '<button class="fix-all-btn" id="fix-all-btn">\u2728 Fix All with Copilot</button>' +
      '</div>' +
      renderFindingsList(currentFindings);

    container.innerHTML = html;
    bindFilterActions();
    bindFindingActions();

    var fixAllBtn = document.getElementById('fix-all-btn');
    if (fixAllBtn) {
      fixAllBtn.addEventListener('click', function () {
        vscode.postMessage({ type: 'fixAllWithCopilot', findings: currentFindings });
      });
    }
  }

  // ── Quip picker ─────────────────────────────────────────
  function pickQuip(errors, warnings, total) {
    var q = currentMessages ? currentMessages.quips : null;
    if (errors > 5)  { return q ? q.manyErrors : "Oh my god. This isn't code, it's a hate crime against computers."; }
    if (errors > 2)  { return q ? q.someErrors : "I've seen better code written by a drunk toddler."; }
    if (errors > 0)  { return q ? q.fewErrors : "There are errors in here. Real ones. Not just the ones in your life choices."; }
    if (warnings > 3) { return q ? q.manyWarnings : "No disasters, but the warnings tell a story. A sad one."; }
    if (warnings > 0) { return q ? q.someWarnings : "Could be worse. Could be better. Mostly just\u2026 there."; }
    if (total === 0)  { return q ? q.noIssues : "I can't find anything. Either it's fine or you've broken my scanner."; }
    return q ? q.default : "A few things to note. Do take it personally.";
  }

  // ── HTML escaping ───────────────────────────────────────
  function escHtml(s) {
    if (s === null || s === undefined) { return ''; }
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Message handler ─────────────────────────────────────
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg) { return; }
    switch (msg.type) {
      case 'message':
        showBubble(msg.text, msg.state || 'talking');
        if (msg.state === 'thinking') { setStatus('\u{1F504}', msg.text.replace(/[\u{1F680}\u{1F4C2}\u{1F914}\u{1F916}\u{1F3A8}]/gu, '').trim()); }
        break;
      case 'findings':
        renderFindings(msg.findings);
        break;
      case 'log':
        appendLog(msg.text, msg.isError);
        if (msg.isError) { setStatus('\u274C', msg.text.replace(/[\u274C]/g, '').trim()); }
        break;
      case 'clearLog':
        clearLog();
        setStatus('\u{1F680}', 'Review in progress\u2026');
        startAnimation(WORK_CONFIG, 10);
        break;
      case 'reviewingState':
        isReviewing = msg.isReviewing;
        var curStartBtn = document.getElementById('start-btn');
        var curModelSelect = document.getElementById('model-select');
        var curPersonalitySelect = document.getElementById('personality-select');
        var curBranchSelect = document.getElementById('branch-select');
        var curExtraInstructionsInput = document.getElementById('extra-instructions');
        if (curStartBtn) { curStartBtn.style.display = msg.isReviewing ? 'none' : 'inline-block'; }
        var curFetchBtn = document.getElementById('fetch-btn');
        if (curFetchBtn) { curFetchBtn.style.display = msg.isReviewing ? 'none' : (curBranchSelect && curBranchSelect.value.indexOf('pr:') === 0 ? 'inline-block' : 'none'); }
        if (curModelSelect) { curModelSelect.disabled = msg.isReviewing; }
        if (curPersonalitySelect) { curPersonalitySelect.disabled = msg.isReviewing; }
        if (curBranchSelect) { curBranchSelect.disabled = msg.isReviewing; }
        if (curExtraInstructionsInput) { curExtraInstructionsInput.disabled = msg.isReviewing; }
        var curLanguageSelect = document.getElementById('language-select');
        if (curLanguageSelect) { curLanguageSelect.disabled = msg.isReviewing; }
        if (msg.isReviewing) {
          startAnimation(WORK_CONFIG, 10);
        } else {
          startAnimation(IDLE_CONFIG, 6);
        }
        break;
      case 'models': {
        var modelSelectEl = document.getElementById('model-select');
        if (modelSelectEl) {
          modelSelectEl.innerHTML = '';
          var models = msg.models || [];
          if (models.length === 0) {
            var opt = document.createElement('option');
            opt.value = 'copilot-gpt-4o';
            opt.textContent = 'copilot-gpt-4o (default)';
            modelSelectEl.appendChild(opt);
          } else {
            for (var i = 0; i < models.length; i++) {
              var opt = document.createElement('option');
              opt.value = models[i];
              opt.textContent = models[i];
              if (models[i] === msg.currentModel) { opt.selected = true; }
              modelSelectEl.appendChild(opt);
            }
          }
          modelsLoaded = true;
          applySavedSettings();
        }
        break;
      }
      case 'branches': {
        var branchSelectEl = document.getElementById('branch-select');
        if (branchSelectEl) {
          branchSelectEl.innerHTML = '';
          var branches = msg.branches || [];
          var currentBranch = msg.currentBranch || '';
          var currentOpt = document.createElement('option');
          currentOpt.value = currentBranch;
          currentOpt.textContent = currentBranch + ' (uncommitted changes)';
          branchSelectEl.appendChild(currentOpt);
          for (var i = 0; i < branches.length; i++) {
            if (branches[i] !== currentBranch) {
              var opt = document.createElement('option');
              opt.value = branches[i];
              opt.textContent = branches[i];
              branchSelectEl.appendChild(opt);
            }
          }
          branchesLoaded = true;
          applySavedSettings();
        }
        break;
      }
      case 'pullRequests': {
        var branchSelectEl = document.getElementById('branch-select');
        var existingPrGroup = branchSelectEl ? branchSelectEl.querySelector('optgroup[data-pr-group]') : null;
        if (existingPrGroup) { existingPrGroup.remove(); }
        var existingAuthWarn = document.getElementById('gh-auth-warning');
        if (existingAuthWarn) { existingAuthWarn.remove(); }

        if (msg.notAuthenticated) {
          var branchRow = branchSelectEl ? branchSelectEl.closest('.input-row') : null;
          if (branchRow) {
            var warn = document.createElement('div');
            warn.id = 'gh-auth-warning';
            warn.style.cssText = 'font-size:0.75em; color:var(--vscode-editorWarning-foreground,#cca700); margin-top:4px; line-height:1.4;';
            var isGHE = msg.host && msg.host !== 'github.com';
            if (isGHE) {
              warn.innerHTML = '\u26A0\uFE0F To list open PRs, sign in to GitHub Enterprise: open the Command Palette (<b>Cmd+Shift+P</b>) and run <b>"GitHub Enterprise: Sign In"</b>, or add a PAT for <b>' + msg.host + '</b> in Settings.';
            } else {
              warn.innerHTML = '\u26A0\uFE0F To list open PRs, sign in to GitHub: open the Command Palette (<b>Cmd+Shift+P</b>) and run <b>"GitHub: Sign In"</b>.';
            }
            branchRow.appendChild(warn);
          }
        } else if (branchSelectEl && msg.pullRequests && msg.pullRequests.length > 0) {
          var prGroup = document.createElement('optgroup');
          prGroup.label = 'Open Pull Requests';
          prGroup.setAttribute('data-pr-group', 'true');
          for (var i = 0; i < msg.pullRequests.length; i++) {
            var pr = msg.pullRequests[i];
            var opt = document.createElement('option');
            opt.value = 'pr:' + pr.number;
            opt.textContent = 'PR #' + pr.number + ': ' + pr.title + ' (' + pr.headRefName + ' \u2192 ' + pr.baseRefName + ')';
            prGroup.appendChild(opt);
          }
          branchSelectEl.insertBefore(prGroup, branchSelectEl.firstChild);
        }
        break;
      }
      case 'personalities': {
        var personalitySelectEl = document.getElementById('personality-select');
        if (personalitySelectEl) {
          personalitySelectEl.innerHTML = '';
          var personalities = msg.personalities || [];
          allPersonalities = personalities;
          for (var i = 0; i < personalities.length; i++) {
            var opt = document.createElement('option');
            opt.value = personalities[i].id;
            opt.textContent = personalities[i].name;
            opt.title = personalities[i].description;
            personalitySelectEl.appendChild(opt);
          }
          if (personalities.length > 0 && personalities[0].messages) {
            currentMessages = personalities[0].messages;
            updateIdleBubble();
          }
          personalitiesLoaded = true;
          applySavedSettings();
        }
        break;
      }
      case 'languages': {
        var langSelect = document.getElementById('language-select');
        if (langSelect) {
          langSelect.innerHTML = '';
          var languages = msg.languages || [];
          for (var i = 0; i < languages.length; i++) {
            var opt = document.createElement('option');
            opt.value = languages[i];
            opt.textContent = languages[i];
            langSelect.appendChild(opt);
          }
          langSelect.value = savedSettings.language || 'English';
          languagesLoaded = true;
          applySavedSettings();
        }
        break;
      }
      case 'savedSettings':
        if (msg.settings) {
          savedSettings = msg.settings;
          settingsLoaded = true;
          applySavedSettings();
        }
        break;
      case 'reset':
        resetToInitialState();
        break;
    }
  });
})();
