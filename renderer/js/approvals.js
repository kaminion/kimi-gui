/* approvals.js — approval & AskUserQuestion modals.
 * Exposes window.Approvals.maybeHandle(event); app.js forwards every session
 * event here. Renders .modal-backdrop > .modal into #modal-root.
 *
 * Wire facts (docs/ref/openapi.json + webui-bundle.js):
 * - approval.requested payload: {approval_id, session_id, tool_call_id,
 *   tool_name, action, tool_input_display, created_at, expires_at}
 *   resolved/expired payloads carry {approval_id, ...}.
 * - Decision strings accepted by the server: 'approved' | 'rejected' | 'cancelled'.
 * - question.requested payload: {question_id, session_id, questions:[{id,
 *   question, header?, body?, options:[{id,label,description?,recommended?}],
 *   multi_select?, allow_other?, other_label?}], created_at}
 * - Answer body: {answers: {questionId: {kind:'single',option_id} |
 *   {kind:'multi',option_ids} | {kind:'other',text} |
 *   {kind:'multi_with_other',option_ids,other_text} | {kind:'skipped'}}}
 * - Dismiss: POST questions/{question_id}:dismiss with an empty body.
 */
(function () {
  'use strict';

  const T = (k, f) => (window.I18N?.t ? window.I18N.t(k, f) : f);

  const ARGS_MAX = 900; // pretty-printed tool args truncation

  const pending = [];   // FIFO queue of { kind:'approval'|'question', sessionId, id, data }
  let currentEl = null; // backdrop element currently shown
  let currentId = null; // pending entry id currently shown
  let inflight = false; // a respond/answer request is on the wire

  function modalRoot() { return document.getElementById('modal-root'); }

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  // ---- normalization ---------------------------------------------------------
  function normApproval(d) {
    return {
      approvalId: d.approval_id ?? d.approvalId ?? d.id ?? '',
      sessionId: d.session_id ?? d.sessionId ?? null,
      toolName: d.tool_name ?? d.toolName ?? 'tool',
      action: d.action ?? '',
      display: d.tool_input_display ?? d.display ?? d.input,
      expiresAt: d.expires_at ?? d.expiresAt,
    };
  }

  function normOption(o) {
    if (o == null || typeof o !== 'object') return { id: String(o ?? ''), label: String(o ?? '') };
    return {
      id: o.id ?? o.label ?? '',
      label: o.label ?? String(o.id ?? ''),
      description: o.description ?? '',
      recommended: !!(o.recommended ?? o.is_recommended),
    };
  }

  function normQuestion(d) {
    const qs = Array.isArray(d.questions) ? d.questions : [];
    return {
      questionId: d.question_id ?? d.questionId ?? d.id ?? '',
      sessionId: d.session_id ?? d.sessionId ?? null,
      questions: qs.map((q) => ({
        id: q.id ?? q.question ?? '',
        question: q.question ?? '',
        header: q.header ?? '',
        body: q.body ?? '',
        options: (Array.isArray(q.options) ? q.options : []).map(normOption),
        multiSelect: !!(q.multi_select ?? q.multiSelect),
        allowOther: !!(q.allow_other ?? q.allowOther),
        otherLabel: q.other_label ?? q.otherLabel ?? T('approval.other', '기타'),
      })),
    };
  }

  function prettyArgs(display) {
    if (display == null) return T('approval.no_args', '(인자 없음)');
    let s;
    if (typeof display === 'string') s = display;
    else { try { s = JSON.stringify(display, null, 2); } catch { s = String(display); } }
    return s.length > ARGS_MAX ? s.slice(0, ARGS_MAX - 1) + '…' : s;
  }

  // ---- queue / modal lifecycle -------------------------------------------------
  function enqueue(entry) {
    if (!entry.id || pending.some((p) => p.id === entry.id)) return;
    pending.push(entry);
    if (!currentEl) showNext();
  }

  function removeById(id) {
    if (!id) return;
    const i = pending.findIndex((p) => p.id === id);
    if (i !== -1) pending.splice(i, 1);
    if (currentId === id) closeModal(); // server resolved it elsewhere
  }

  function closeModal() {
    if (currentEl) currentEl.remove();
    currentEl = null;
    currentId = null;
    inflight = false;
    document.removeEventListener('keydown', onKeydown, true);
    showNext(); // no-op when the queue is empty
  }

  function showNext() {
    const root = modalRoot();
    if (!root || currentEl) return;
    const entry = pending[0];
    if (!entry) return;
    currentId = entry.id;
    currentEl = entry.kind === 'approval' ? buildApprovalModal(entry) : buildQuestionModal(entry);
    root.append(currentEl);
    document.addEventListener('keydown', onKeydown, true);
    const primary = currentEl.querySelector('.btn-accent, .btn-primary');
    if (primary) primary.focus();
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      dismissCurrent();
    }
  }

  // ESC / backdrop = reject (approval) or dismiss (question).
  function dismissCurrent() {
    const entry = pending.find((p) => p.id === currentId);
    if (!entry || inflight) { if (!entry) closeModal(); return; }
    if (entry.kind === 'approval') respondApproval(entry, 'rejected');
    else dismissQuestion(entry);
  }

  function finishEntry(entry) {
    const i = pending.findIndex((p) => p.id === entry.id);
    if (i !== -1) pending.splice(i, 1);
    closeModal();
  }

  // ---- approval ------------------------------------------------------------
  function respondApproval(entry, decision) {
    if (inflight) return;
    inflight = true;
    setButtonsDisabled(true);
    const done = () => finishEntry(entry);
    try {
      if (window.kimi && typeof window.kimi.respondApproval === 'function') {
        Promise.resolve(window.kimi.respondApproval(entry.sessionId, entry.data.approvalId, decision))
          .then(done)
          .catch(() => done()); // already resolved/expired server-side: just close
      } else {
        done();
      }
    } catch {
      done();
    }
  }

  function buildApprovalModal(entry) {
    const { toolName, action, display } = entry.data;
    const backdrop = el('div', 'modal-backdrop');
    const modal = el('div', 'modal modal-approval');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const title = el('div', 'modal-title', T('approval.title', '도구 승인 요청'));
    const body = el('div', 'modal-body');
    const toolLine = el('div', 'approval-tool-line');
    toolLine.append(el('span', 'approval-tool-name', toolName));
    if (action) toolLine.append(el('span', 'approval-action', String(action)));
    const hint = el('p', 'approval-hint', T('approval.hint', '에이전트가 다음 작업을 실행하려고 합니다.'));
    const args = el('pre', 'approval-args', prettyArgs(display));
    body.append(hint, toolLine, args);

    const actions = el('div', 'modal-actions');
    const rejectBtn = el('button', 'btn btn-ghost', T('approval.reject', '거절'));
    rejectBtn.type = 'button';
    rejectBtn.addEventListener('click', () => respondApproval(entry, 'rejected'));
    const approveBtn = el('button', 'btn btn-primary', T('approval.approve', '승인'));
    approveBtn.type = 'button';
    approveBtn.addEventListener('click', () => respondApproval(entry, 'approved'));
    actions.append(rejectBtn, approveBtn);

    modal.append(title, body, actions);
    backdrop.append(modal);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) dismissCurrent(); });
    return backdrop;
  }

  // ---- question ---------------------------------------------------------------
  function dismissQuestion(entry) {
    if (inflight) return;
    inflight = true;
    setButtonsDisabled(true);
    const done = () => finishEntry(entry);
    try {
      if (window.kimi && typeof window.kimi.answerQuestion === 'function') {
        Promise.resolve(window.kimi.answerQuestion(entry.sessionId, entry.data.questionId + ':dismiss', {}))
          .then(done)
          .catch(() => done());
      } else {
        done();
      }
    } catch {
      done();
    }
  }

  function submitQuestion(entry, modal) {
    if (inflight) return;
    const answers = {};
    for (const q of entry.data.questions) {
      const a = collectAnswer(modal, q);
      if (!a) return; // validation failed (button should have been disabled)
      answers[q.id] = a;
    }
    inflight = true;
    setButtonsDisabled(true);
    const done = () => finishEntry(entry);
    try {
      if (window.kimi && typeof window.kimi.answerQuestion === 'function') {
        Promise.resolve(window.kimi.answerQuestion(entry.sessionId, entry.data.questionId, { answers, method: 'click' }))
          .then(done)
          .catch(() => done());
      } else {
        done();
      }
    } catch {
      done();
    }
  }

  // Read one question's answer from the DOM; null when unanswered.
  function collectAnswer(modal, q) {
    const block = modal.querySelector('[data-question-id="' + (window.CSS ? CSS.escape(q.id) : q.id) + '"]');
    if (!block) return { kind: 'skipped' };
    const otherInput = block.querySelector('.question-other-input');
    const otherText = otherInput ? otherInput.value.trim() : '';
    if (q.multiSelect) {
      const ids = Array.from(block.querySelectorAll('input[type="checkbox"]:checked'))
        .map((c) => c.value)
        .filter((v) => v !== '__other__');
      const otherChecked = block.querySelector('input[type="checkbox"][value="__other__"]:checked');
      if (ids.length && (otherChecked || otherText)) return { kind: 'multi_with_other', option_ids: ids, other_text: otherText };
      if (ids.length) return { kind: 'multi', option_ids: ids };
      if (otherChecked || otherText) return { kind: 'other', text: otherText };
      return null;
    }
    const checked = block.querySelector('input[type="radio"]:checked');
    if (!checked) return null;
    if (checked.value === '__other__') return otherText ? { kind: 'other', text: otherText } : null;
    return { kind: 'single', option_id: checked.value };
  }

  function validateQuestion(entry, modal) {
    const okBtn = modal.querySelector('.question-submit');
    if (!okBtn) return;
    const allAnswered = entry.data.questions.every((q) => collectAnswer(modal, q) !== null);
    okBtn.disabled = !allAnswered || inflight;
  }

  function buildQuestionModal(entry) {
    const data = entry.data;
    const backdrop = el('div', 'modal-backdrop');
    const modal = el('div', 'modal modal-question');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const firstHeader = data.questions.find((q) => q.header)?.header;
    modal.append(el('div', 'modal-title', firstHeader || T('approval.question_title', '질문')));
    const body = el('div', 'modal-body');

    data.questions.forEach((q, qi) => {
      const block = el('div', 'question-block');
      block.dataset.questionId = q.id;
      block.append(el('div', 'question-text', q.question));
      if (q.body) block.append(el('div', 'question-body', q.body));

      const name = 'q-' + qi + '-' + Math.random().toString(36).slice(2, 8);
      const list = el('div', 'question-options');
      const inputType = q.multiSelect ? 'checkbox' : 'radio';
      for (const opt of q.options) {
        const label = el('label', 'question-option');
        const input = document.createElement('input');
        input.type = inputType;
        input.name = name;
        input.value = opt.id;
        const texts = el('span', 'question-option-texts');
        const labelRow = el('span', 'question-option-label', opt.label);
        if (opt.recommended) labelRow.append(el('span', 'question-option-badge', T('approval.recommended', '권장')));
        texts.append(labelRow);
        if (opt.description) texts.append(el('span', 'question-option-desc', opt.description));
        label.append(input, texts);
        list.append(label);
      }
      let otherInput = null;
      if (q.allowOther) {
        const label = el('label', 'question-option question-option-other');
        const input = document.createElement('input');
        input.type = inputType;
        input.name = name;
        input.value = '__other__';
        otherInput = document.createElement('input');
        otherInput.type = 'text';
        otherInput.className = 'question-other-input';
        otherInput.placeholder = q.otherLabel;
        otherInput.addEventListener('focus', () => { input.checked = true; validateQuestion(entry, modal); });
        label.append(input, otherInput);
        list.append(label);
      }
      block.append(list);
      body.append(block);
    });

    const actions = el('div', 'modal-actions');
    const skipBtn = el('button', 'btn btn-ghost', T('approval.skip', '건너뛰기'));
    skipBtn.type = 'button';
    skipBtn.addEventListener('click', () => dismissQuestion(entry));
    const okBtn = el('button', 'btn btn-primary question-submit', T('approval.confirm', '확인'));
    okBtn.type = 'button';
    okBtn.disabled = true;
    okBtn.addEventListener('click', () => submitQuestion(entry, modal));
    actions.append(skipBtn, okBtn);

    modal.append(body, actions);
    backdrop.append(modal);
    // Any selection change re-validates the submit button.
    modal.addEventListener('change', () => validateQuestion(entry, modal));
    modal.addEventListener('input', () => validateQuestion(entry, modal));
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) dismissCurrent(); });
    return backdrop;
  }

  function setButtonsDisabled(disabled) {
    if (!currentEl) return;
    currentEl.querySelectorAll('button, input').forEach((b) => { b.disabled = !!disabled; });
  }

  // ---- public entry point -------------------------------------------------------
  function maybeHandle(event) {
    if (!event || typeof event !== 'object') return false;
    let type = typeof event.type === 'string' ? event.type : '';
    if (type.startsWith('event.')) type = type.slice(6);
    const data = (event.payload && typeof event.payload === 'object') ? event.payload : event;
    const sid = event.session_id ?? event.sessionId ?? data.session_id ?? data.sessionId ?? null;

    switch (type) {
      case 'approval.requested': {
        const a = normApproval(data);
        enqueue({ kind: 'approval', sessionId: sid ?? a.sessionId ?? null, id: a.approvalId, data: a });
        return true;
      }
      case 'approval.resolved':
      case 'approval.expired':
        removeById(data.approval_id ?? data.approvalId);
        return true;
      case 'question.requested': {
        const q = normQuestion(data);
        enqueue({ kind: 'question', sessionId: sid ?? q.sessionId ?? null, id: q.questionId, data: q });
        return true;
      }
      case 'question.answered':
      case 'question.dismissed':
        removeById(data.question_id ?? data.questionId);
        return true;
      default:
        return false;
    }
  }

  window.Approvals = { maybeHandle };
})();
