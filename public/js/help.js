'use strict';

// Helpdesk & feedback (kritik & saran): tickets with screenshots, and feedback.
// A plain <script> sharing globals with app.js (loaded after it; see
// index.html). Nothing here runs app code at load beyond wiring listeners —
// js/start.js boots the app once every script is in.

// ---------------------------------------------------------------------------
// Helpdesk & feedback (kritik & saran) — routes/help.js. Everyone opens tickets
// and sends feedback from the two Help tiles; the Super Admins are the
// helpdesk, so the same view shows them everyone's tickets and feedback to
// answer. Tickets are a thread of messages shown in a modal.
// ---------------------------------------------------------------------------
const HELP_CATEGORIES = [
  ['claim', 'Claims & reimbursement'], ['meal', 'Meal allowance'], ['advance', 'Cash advance'],
  ['account', 'Account & sign-in'], ['bug', 'Something isn’t working'], ['other', 'Something else']
];
const FEEDBACK_TOPICS = [['portal', 'The portal'], ['process', 'The reimbursement process'], ['other', 'Something else']];
const helpCategoryLabel = (k) => t((HELP_CATEGORIES.find(c => c[0] === k) || HELP_CATEGORIES[5])[1]);
const feedbackTopicLabel = (k) => t((FEEDBACK_TOPICS.find(c => c[0] === k) || FEEDBACK_TOPICS[2])[1]);
const feedbackKindLabel = (k) => (k === 'criticism' ? t('Criticism') : t('Suggestion'));
function ticketStatusChip(status) {
  const label = { open: t('Waiting for answer'), answered: t('Answered'), closed: t('Closed') }[status] || status;
  return `<span class="hp-chip hp-st-${esc(status)}">${esc(label)}</span>`;
}
function resetHelpState() {
  state.help = { summary: { staff: false, tickets: 0, feedback: 0 }, tab: 'tickets',
    ticketFilter: 'active', fbStatus: 'new', fbKind: '', tickets: null, feedback: null };
}
resetHelpState();
// The tile badges. A failure here must not cost anyone their menu.
async function loadHelpSummary() {
  try { state.help.summary = await api('/help/summary'); } catch { /* keep the last counts */ }
  renderHome();
}

function openHelp(tab) {
  state.view = 'help';
  state.help.tab = tab === 'feedback' ? 'feedback' : 'tickets';
  $('#homeView').hidden = true;
  $('#listView').hidden = true;
  const iv = $('#insightsView'); if (iv) iv.hidden = true;
  const dv = $('#dcView'); if (dv) dv.hidden = true;
  $('#helpView').hidden = false;
  state.help.tickets = null; state.help.feedback = null;
  renderHelp();
  loadHelpTab();
}
$('#backHomeHelp').addEventListener('click', goHome);

const helpRegionQS = () => (isSuperUser() && state.viewRegion ? `?region=${encodeURIComponent(state.viewRegion)}` : '');
async function loadHelpTab() {
  const h = state.help;
  const tab = h.tab;
  try {
    if (tab === 'tickets') h.tickets = (await api('/help/tickets' + helpRegionQS())).tickets || [];
    else h.feedback = (await api('/help/feedback' + helpRegionQS())).feedback || [];
  } catch (ex) {
    if (state.view === 'help' && h.tab === tab) $('#helpBody').innerHTML = `<p class="form-error">${esc(ex.message)}</p>`;
    return;
  }
  if (state.view === 'help' && h.tab === tab) renderHelp();
  loadHelpSummary();
}

// The page chrome (tabs, header button) plus the open tab's body.
function renderHelp() {
  const h = state.help;
  const staff = isSuperUser();
  $('#helpSub').innerHTML = `<span>${esc(staff
    ? t('Answer questions and read feedback from staff')
    : t('Ask the helpdesk, or tell us what to improve'))}</span>`;
  const badge = (n) => (n > 0 ? ` <span class="hp-tab-n">${n > 99 ? '99+' : n}</span>` : '');
  $('#helpTabs').innerHTML = `
    <button type="button" role="tab" data-tab="tickets" aria-selected="${h.tab === 'tickets'}" class="${h.tab === 'tickets' ? 'on' : ''}">${HOME_ICONS.helpdesk}<span>${esc(t('Helpdesk'))}</span>${badge(h.summary.tickets)}</button>
    <button type="button" role="tab" data-tab="feedback" aria-selected="${h.tab === 'feedback'}" class="${h.tab === 'feedback' ? 'on' : ''}">${HOME_ICONS.feedback}<span>${esc(t('Feedback & suggestions'))}</span>${staff ? badge(h.summary.feedback) : ''}</button>`;
  $$('#helpTabs [data-tab]').forEach(b => b.addEventListener('click', () => {
    if (h.tab === b.dataset.tab) return;
    h.tab = b.dataset.tab;
    renderHelp();
    loadHelpTab();
  }));
  const acts = $('#helpActs');
  acts.innerHTML = h.tab === 'tickets' && !staff
    ? `<button type="button" class="btn btn-primary btn-sm" id="hpNewTicket">${esc(t('+ New ticket'))}</button>` : '';
  if ($('#hpNewTicket')) $('#hpNewTicket').addEventListener('click', openNewTicket);
  if (h.tab === 'tickets') renderTickets(); else renderFeedbackTab();
}

const helpLoading = () => `<p class="muted hp-loading">${esc(t('Loading…'))}</p>`;
function helpEmpty(icon, title, sub, btn) {
  return `<div class="hp-empty"><span class="hp-empty-ic" aria-hidden="true">${icon}</span>
    <strong>${esc(title)}</strong><span>${esc(sub)}</span>${btn || ''}</div>`;
}
// A segmented filter: [[value, label, count]].
function helpSeg(id, items, cur) {
  return `<div class="seg hp-seg" id="${id}" role="group">${items.map(([v, l, n]) =>
    `<button type="button" data-v="${esc(v)}" class="${v === cur ? 'on' : ''}" aria-pressed="${v === cur}">${esc(l)}${n != null ? ` <span class="hp-seg-n">${n}</span>` : ''}</button>`).join('')}</div>`;
}

// --- Tickets ---
function renderTickets() {
  const body = $('#helpBody');
  const h = state.help;
  const staff = isSuperUser();
  if (!h.tickets) { body.innerHTML = helpLoading(); return; }
  const all = h.tickets;
  const n = (fn) => all.filter(fn).length;
  const filters = staff
    ? [['open', t('Waiting'), n(x => x.status === 'open')], ['answered', t('Answered'), n(x => x.status === 'answered')],
       ['closed', t('Closed'), n(x => x.status === 'closed')], ['all', t('All'), all.length]]
    : [['active', t('Open'), n(x => x.status !== 'closed')], ['closed', t('Closed'), n(x => x.status === 'closed')], ['all', t('All'), all.length]];
  if (!filters.some(f => f[0] === h.ticketFilter)) h.ticketFilter = staff ? 'open' : 'active';
  const f = h.ticketFilter;
  const list = all.filter(x => f === 'all' || (f === 'active' ? x.status !== 'closed' : x.status === f));
  if (!all.length) {
    body.innerHTML = staff
      ? helpEmpty(HOME_ICONS.helpdesk, t('No tickets yet'), t('Questions from staff will appear here.'))
      : helpEmpty(HOME_ICONS.helpdesk, t('No tickets yet'),
          t('Have a question about a claim, your account, or something that isn’t working? Open a ticket and the helpdesk will answer you here.'),
          `<button type="button" class="btn btn-primary btn-sm" id="hpEmptyNew">${esc(t('+ New ticket'))}</button>`);
    if ($('#hpEmptyNew')) $('#hpEmptyNew').addEventListener('click', openNewTicket);
    return;
  }
  const card = (x) => {
    const unread = !staff && x.user_unread;
    const who = staff
      ? [x.requester_name, x.department, x.region].filter(Boolean).map(esc).join(' · ')
      : esc(helpCategoryLabel(x.category));
    const last = x.last_from_staff != null ? `<p class="hp-preview"><span class="hp-preview-who">${esc(x.last_from_staff ? t('Helpdesk') : (staff ? x.requester_name || t('Staff') : t('You')))}:</span> ${x.last_body ? esc(x.last_body) : `<em>${esc(t('Screenshot'))}</em>`}</p>` : '';
    const clip = x.attachment_count ? `<span class="hp-clip" title="${esc(t('{n} screenshots', { n: x.attachment_count }))}">${PAPERCLIP_ICON}${x.attachment_count}</span>` : '';
    return `<button type="button" class="hp-ticket${unread ? ' hp-unread' : ''}" data-ticket="${x.id}">
      <span class="hp-ticket-top">
        <span class="hp-ticket-subj">${unread ? `<span class="hp-dot" aria-label="${esc(t('New reply'))}"></span>` : ''}${esc(x.subject)}</span>
        ${ticketStatusChip(x.status)}
      </span>
      <span class="hp-ticket-meta"><span class="mono">#${x.id}</span><span>${who}</span>${staff ? `<span>${esc(helpCategoryLabel(x.category))}</span>` : ''}<span>${esc(fmtDateTime(x.updated_at))}</span>${clip}</span>
      ${last}
    </button>`;
  };
  body.innerHTML = `
    <div class="hp-wrap">
      <div class="hp-toolbar">${helpSeg('hpTicketSeg', filters, f)}</div>
      <div class="hp-list">${list.length ? list.map(card).join('')
        : `<p class="muted hp-none">${esc(f === 'open' ? t('Nothing is waiting for an answer.') : t('No tickets here.'))}</p>`}</div>
    </div>`;
  $$('#hpTicketSeg [data-v]').forEach(b => b.addEventListener('click', () => { h.ticketFilter = b.dataset.v; renderTickets(); }));
  $$('#helpBody [data-ticket]').forEach(b => b.addEventListener('click', () => openTicket(Number(b.dataset.ticket))));
}

// --- Screenshots on a ticket message ---
// Images only, up to four per message: picked, pasted (Ctrl+V into the message
// box) or dropped onto the form. iPhone HEIC is converted and big images are
// compressed so they go up through our own origin (uploadReceipts). No photo
// editor — a screenshot needs no crop or capture stamp.
const MAX_HELP_SHOTS = 4;
const PAPERCLIP_ICON = svgI('<path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>');
function makeShotPicker({ list, button, dropZone, pasteTarget, onChange }) {
  const shots = []; // { file, url }
  let busy = 0;
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*'; input.multiple = true; input.hidden = true;
  list.after(input);
  const changed = () => { render(); if (onChange) onChange(); };
  function render() {
    list.hidden = !shots.length && !busy;
    list.innerHTML = shots.map((s, i) => `
      <figure class="hp-shot"><img src="${esc(s.url)}" alt="${esc(s.file.name)}" />
        <button type="button" class="hp-shot-x" data-rm="${i}" aria-label="${esc(t('Remove'))}" title="${esc(t('Remove'))}">×</button></figure>`).join('')
      + (busy ? `<span class="hp-shot hp-shot-busy" aria-live="polite">${esc(t('Preparing…'))}</span>` : '');
    $$('[data-rm]', list).forEach(b => b.addEventListener('click', () => {
      const [s] = shots.splice(Number(b.dataset.rm), 1);
      if (s) URL.revokeObjectURL(s.url);
      changed();
    }));
    button.disabled = shots.length + busy >= MAX_HELP_SHOTS;
  }
  async function add(fileList) {
    for (let file of [...fileList]) {
      if (shots.length + busy >= MAX_HELP_SHOTS) { toast(t('Up to {n} screenshots per message.', { n: MAX_HELP_SHOTS }), true); break; }
      if (!(String(file.type).startsWith('image/') || isHeic(file))) { toast(t('Only images can be attached as screenshots.'), true); continue; }
      busy++; changed();
      try {
        if (isHeic(file)) file = await heicToJpeg(file);
        if (file.size > COMPRESS_TARGET) {
          if (file.type === 'image/gif') throw new Error('too big');
          file = await compressImage(file, COMPRESS_TARGET);
        }
        // A pasted image arrives as "image.png"; give it a name worth keeping.
        if (/^image\.\w+$/i.test(file.name || '') || !file.name) {
          const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
          file = new File([file], `screenshot-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.${ext}`, { type: file.type });
        }
        shots.push({ file, url: URL.createObjectURL(file) });
      } catch {
        toast(t('{name} couldn’t be attached — try a smaller image.', { name: file.name || t('Screenshot') }), true);
      } finally { busy--; changed(); }
    }
  }
  button.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { add(input.files); input.value = ''; });
  pasteTarget.addEventListener('paste', (e) => {
    const files = [...((e.clipboardData && e.clipboardData.items) || [])]
      .filter(it => it.kind === 'file' && it.type.startsWith('image/')).map(it => it.getAsFile()).filter(Boolean);
    if (!files.length) return; // plain text pastes as usual
    e.preventDefault();
    add(files);
  });
  dropZone.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer.types || [])].includes('Files')) return;
    e.preventDefault(); dropZone.classList.add('hp-drop');
  });
  dropZone.addEventListener('dragleave', (e) => { if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('hp-drop'); });
  dropZone.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault(); dropZone.classList.remove('hp-drop');
    add(e.dataTransfer.files);
  });
  render();
  return {
    files: () => shots.map(s => s.file),
    count: () => shots.length,
    busy: () => busy > 0,
    clear: () => { shots.splice(0).forEach(s => URL.revokeObjectURL(s.url)); }
  };
}
const shotAttachHtml = (id) => `<button type="button" class="btn btn-ghost btn-sm hp-attach-btn" id="${id}">${PAPERCLIP_ICON}<span>${esc(t('Attach screenshot'))}</span></button>`;
// A screenshot at full size, over the ticket.
function openShot(att) {
  const src = `/api/help/attachments/${att.id}`;
  openModal2(`
    <div class="modal-head hp-lb-head">
      <h2 class="hp-lb-name">${esc(att.original_name || t('Screenshot'))}</h2>
      <a class="btn btn-ghost btn-sm" href="${src}" target="_blank" rel="noopener">${esc(t('Open full size'))}</a>
      <button type="button" class="x-btn" aria-label="${esc(t('Close'))}">×</button>
    </div>
    <div class="modal-body hp-lb"><img src="${src}" alt="${esc(att.original_name || t('Screenshot'))}" /></div>`);
  $('#modal2').classList.add('modal-xwide', 'modal-hp-lb');
  $('#modal2 .x-btn').addEventListener('click', closeModal2);
}

function openNewTicket() {
  openModal(`
    <div class="modal-head">
      <div><h2>${esc(t('New helpdesk ticket'))}</h2><p class="wn-sub">${esc(t('The helpdesk answers here, and you get an email when they do.'))}</p></div>
      <button type="button" class="x-btn" aria-label="${esc(t('Close'))}">×</button>
    </div>
    <div class="modal-body">
      <form class="form" id="hpTicketForm" novalidate>
        <label>${esc(t('What is it about?'))}
          <select name="category">${HELP_CATEGORIES.map(([v, l]) => `<option value="${v}">${esc(t(l))}</option>`).join('')}</select>
        </label>
        <label>${esc(t('Subject'))}
          <input name="subject" maxlength="120" autocomplete="off" placeholder="${esc(t('e.g. My claim was returned but I can’t edit it'))}" />
        </label>
        <label>${esc(t('Message'))}
          <textarea name="message" rows="6" maxlength="4000" placeholder="${esc(t('Describe what happened. If it’s about a claim, include its number.'))}"></textarea>
        </label>
        <div class="hp-attach">
          <div class="hp-shots" id="hpNewShots" hidden></div>
          <div class="hp-attach-row">${shotAttachHtml('hpNewAttach')}<span class="hp-attach-hint">${esc(t('Up to {n} images. You can also paste a screenshot into the message.', { n: MAX_HELP_SHOTS }))}</span></div>
        </div>
        <p class="form-error" id="hpTicketErr" hidden></p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="hpTicketCancel">${esc(t('Cancel'))}</button>
          <button type="submit" class="btn btn-primary" id="hpTicketSend">${esc(t('Send ticket'))}</button>
        </div>
      </form>
    </div>`);
  $('#modal').classList.add('modal-help');
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#hpTicketCancel').addEventListener('click', closeModal);
  const form = $('#hpTicketForm');
  const picker = makeShotPicker({ list: $('#hpNewShots'), button: $('#hpNewAttach'), dropZone: form, pasteTarget: form.message,
    onChange: () => { $('#hpTicketSend').disabled = picker && picker.busy(); } });
  modalCloseHook = picker.clear;
  form.subject.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#hpTicketErr');
    if (picker.busy()) return;
    const body = { category: form.category.value, subject: form.subject.value.trim(), message: form.message.value.trim() };
    const miss = !body.subject ? t('Give the ticket a short subject') : !body.message ? t('Describe the question or problem') : '';
    if (miss) { err.textContent = miss; err.hidden = false; (body.subject ? form.message : form.subject).focus(); return; }
    const send = $('#hpTicketSend');
    const label = send.textContent;
    send.disabled = true;
    try {
      if (picker.count()) {
        send.textContent = t('Uploading screenshots…');
        body.attachments = await uploadReceipts(picker.files());
        send.textContent = label;
      }
      const r = await api('/help/tickets', { method: 'POST', body: JSON.stringify(body) });
      closeModal();
      toast(t('Ticket sent — the helpdesk will answer you here.'));
      state.help.ticketFilter = 'active';
      if (state.view === 'help') { await loadHelpTab(); if (r && r.id) openTicket(r.id); }
    } catch (ex) {
      err.textContent = t(ex.message); err.hidden = false;
      send.textContent = label;
      send.disabled = false;
    }
  });
}

// One ticket's conversation, with a reply box and close / reopen.
async function openTicket(id) {
  openModal(`
    <div class="modal-head">
      <div class="hp-th-head"><h2 id="hpThTitle">${esc(t('Ticket'))} #${id}</h2><p class="wn-sub" id="hpThSub"></p></div>
      <button type="button" class="x-btn" aria-label="${esc(t('Close'))}">×</button>
    </div>
    <div class="modal-body hp-th-body" id="hpThBody">${helpLoading()}</div>`);
  $('#modal').classList.add('modal-help', 'modal-help-thread');
  $('#modal .x-btn').addEventListener('click', closeModal);
  let r;
  try { r = await api(`/help/tickets/${id}`); }
  catch (ex) { $('#hpThBody').innerHTML = `<p class="form-error">${esc(t(ex.message))}</p>`; return; }
  const tk = r.ticket;
  const closed = tk.status === 'closed';
  $('#hpThTitle').textContent = tk.subject;
  $('#hpThSub').innerHTML = [`<span class="mono">#${tk.id}</span>`, esc(helpCategoryLabel(tk.category)),
    r.staff ? esc([tk.requester_name, tk.department, tk.region].filter(Boolean).join(' · ')) : '', ticketStatusChip(tk.status)]
    .filter(Boolean).join('<span class="hp-sep">·</span>');
  const bubble = (m) => {
    const mine = m.author_id === state.user.id;
    const name = mine ? t('You') : (m.author_name || (m.from_staff ? t('Helpdesk') : t('Staff')));
    return `<div class="hp-msg ${mine ? 'hp-mine' : 'hp-theirs'}${m.from_staff ? ' hp-from-staff' : ''}">
      <div class="hp-msg-meta"><strong>${esc(name)}</strong>${m.from_staff && !mine ? `<span class="hp-tag">${esc(t('Helpdesk'))}</span>` : ''}<span>${esc(fmtDateTime(m.created_at))}</span></div>
      ${m.body ? `<div class="hp-msg-text">${esc(m.body)}</div>` : ''}
      ${(m.attachments || []).length ? `<div class="hp-msg-shots">${m.attachments.map(a => `
        <button type="button" class="hp-msg-shot" data-shot="${a.id}" aria-label="${esc(t('View screenshot {name}', { name: a.original_name }))}">
          <img src="/api/help/attachments/${a.id}" alt="" loading="lazy" /></button>`).join('')}</div>` : ''}
    </div>`;
  };
  const shotById = new Map(r.messages.flatMap(m => (m.attachments || []).map(a => [String(a.id), a])));
  const replyHint = closed
    ? (r.mine ? t('This ticket is closed. Writing again reopens it.') : t('This ticket is closed. Answering reopens it for the requester.'))
    : '';
  $('#hpThBody').innerHTML = `
    <div class="hp-thread" id="hpThread">${r.messages.map(bubble).join('')}</div>
    <form class="hp-compose" id="hpReplyForm" novalidate>
      ${replyHint ? `<p class="hp-compose-note">${esc(replyHint)}</p>` : ''}
      <textarea name="message" rows="3" maxlength="4000" class="input" aria-label="${esc(t('Your reply'))}" placeholder="${esc(r.staff && !r.mine ? t('Write an answer…') : t('Write a reply…'))}"></textarea>
      <div class="hp-shots" id="hpReplyShots" hidden></div>
      <p class="form-error" id="hpReplyErr" hidden></p>
      <div class="hp-compose-acts">
        <div class="hp-compose-left">
          <button type="button" class="btn btn-ghost btn-sm" id="hpStatusBtn">${esc(closed ? t('Reopen ticket') : t('Close ticket'))}</button>
          <button type="button" class="btn btn-ghost btn-sm hp-attach-icon" id="hpReplyAttach" aria-label="${esc(t('Attach screenshot'))}" title="${esc(t('Attach screenshot'))}">${PAPERCLIP_ICON}</button>
        </div>
        <button type="submit" class="btn btn-primary btn-sm" id="hpReplySend" disabled>${esc(r.staff && !r.mine ? t('Send answer') : t('Send reply'))}</button>
      </div>
    </form>`;
  const thread = $('#hpThread');
  const toBottom = () => { thread.scrollTop = thread.scrollHeight; };
  toBottom();
  // Screenshots load after the first paint; keep the newest message in view.
  $$('img', thread).forEach(img => img.addEventListener('load', toBottom, { once: true }));
  $$('[data-shot]', thread).forEach(b => b.addEventListener('click', () => { const a = shotById.get(b.dataset.shot); if (a) openShot(a); }));
  const form = $('#hpReplyForm');
  const canSend = () => { $('#hpReplySend').disabled = picker.busy() || !(form.message.value.trim() || picker.count()); };
  const picker = makeShotPicker({ list: $('#hpReplyShots'), button: $('#hpReplyAttach'), dropZone: form, pasteTarget: form.message, onChange: () => canSend() });
  modalCloseHook = picker.clear;
  form.message.addEventListener('input', canSend);
  // Ctrl/⌘+Enter sends.
  form.message.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
  });
  const after = async (msg) => {
    toast(msg);
    if (state.view === 'help') await loadHelpTab();
    openTicket(id);
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = form.message.value.trim();
    if (picker.busy() || !(message || picker.count())) return;
    const send = $('#hpReplySend');
    const label = send.textContent;
    send.disabled = true;
    try {
      let attachments = [];
      if (picker.count()) {
        send.textContent = t('Uploading screenshots…');
        attachments = await uploadReceipts(picker.files());
      }
      await api(`/help/tickets/${id}/messages`, { method: 'POST', body: JSON.stringify({ message, attachments }) });
      picker.clear(); // frees the picked images; the ticket re-renders below
      after(r.staff && !r.mine ? t('Answer sent — they’ve been emailed.') : t('Reply sent.'));
    } catch (ex) {
      const err = $('#hpReplyErr'); err.textContent = t(ex.message); err.hidden = false;
      send.textContent = label;
      send.disabled = false;
    }
  });
  $('#hpStatusBtn').addEventListener('click', async () => {
    $('#hpStatusBtn').disabled = true;
    try {
      await api(`/help/tickets/${id}/status`, { method: 'POST', body: JSON.stringify({ status: closed ? 'open' : 'closed' }) });
      after(closed ? t('Ticket reopened.') : t('Ticket closed.'));
    } catch (ex) { toast(t(ex.message), true); $('#hpStatusBtn').disabled = false; }
  });
  if (r.mine) loadHelpSummary(); // opening it cleared the "new reply" badge
}

// --- Feedback ---
function renderFeedbackTab() {
  if (isSuperUser()) renderFeedbackInbox(); else renderFeedbackForm();
}
function feedbackCard(x, staff) {
  const who = staff ? (x.anonymous ? `<span class="hp-anon">${esc(t('Anonymous'))}</span>` : esc(x.sender_name || '—')) : '';
  const meta = [who, staff && x.department ? esc(x.department) : '', staff && x.region ? esc(x.region) : '',
    esc(feedbackTopicLabel(x.topic)),
    // Anonymous feedback keeps only its date (the server stores noon UTC).
    esc(x.anonymous ? fmtDateTime(x.created_at).slice(0, 10) : fmtDateTime(x.created_at))].filter(Boolean);
  const answer = x.response ? `
    <div class="hp-answer"><div class="hp-answer-head">${esc(t('Answer from {name}', { name: x.responder_name || t('Helpdesk') }))}${x.responded_at ? ` · ${esc(fmtDateTime(x.responded_at))}` : ''}</div>
      <div class="hp-answer-text">${esc(x.response)}</div></div>` : '';
  const status = staff
    ? (x.status === 'new' ? `<span class="hp-chip hp-st-open">${esc(t('New'))}</span>` : `<span class="hp-chip hp-st-closed">${esc(t('Read'))}</span>`)
    : (x.response ? `<span class="hp-chip hp-st-answered">${esc(t('Answered'))}</span>`
      : x.status === 'read' ? `<span class="hp-chip hp-st-closed">${esc(t('Read'))}</span>` : `<span class="hp-chip hp-st-open">${esc(t('Sent'))}</span>`);
  const acts = staff ? `<div class="hp-fb-acts">
      ${x.status === 'new' ? `<button type="button" class="btn btn-ghost btn-sm" data-fb-read="${x.id}">${esc(t('Mark as read'))}</button>` : ''}
      ${!x.anonymous ? `<button type="button" class="btn btn-brand-soft btn-sm" data-fb-answer="${x.id}">${esc(x.response ? t('Edit answer') : t('Answer'))}</button>` : ''}
    </div>` : '';
  return `<article class="hp-fb${staff && x.status === 'new' ? ' hp-unread' : ''}">
    <div class="hp-fb-top"><span class="hp-kind hp-kind-${esc(x.kind)}">${esc(feedbackKindLabel(x.kind))}</span>
      <span class="hp-fb-meta">${meta.join('<span class="hp-sep">·</span>')}</span>${status}</div>
    <p class="hp-fb-text">${esc(x.body)}</p>
    ${answer}${acts}
  </article>`;
}
function renderFeedbackForm() {
  const body = $('#helpBody');
  const h = state.help;
  const kindCard = (v, title, desc) => `
    <label class="hp-kind-opt"><input type="radio" name="kind" value="${v}" />
      <span class="hp-kind-box"><strong>${esc(title)}</strong><span>${esc(desc)}</span></span></label>`;
  const mine = h.feedback;
  body.innerHTML = `
    <div class="hp-wrap">
      <form class="form hp-fb-form" id="hpFbForm" novalidate>
        <fieldset class="hp-kind-pick"><legend>${esc(t('Is it criticism or a suggestion?'))}</legend>
          ${kindCard('criticism', t('Criticism'), t('Something that doesn’t work well or bothers you'))}
          ${kindCard('suggestion', t('Suggestion'), t('An idea to make things better'))}
        </fieldset>
        <label>${esc(t('About'))}
          <select name="topic">${FEEDBACK_TOPICS.map(([v, l]) => `<option value="${v}">${esc(t(l))}</option>`).join('')}</select>
        </label>
        <label>${esc(t('Your feedback'))}
          <textarea name="body" rows="5" maxlength="4000" placeholder="${esc(t('Be as specific as you can — what happened, and what would be better.'))}"></textarea>
        </label>
        <label class="hp-anon-opt"><input type="checkbox" name="anonymous" />
          <span><strong>${esc(t('Send anonymously'))}</strong><span>${esc(t('Your name, department and the time you sent it aren’t saved — only the date — so it won’t be listed below and can’t be answered.'))}</span></span></label>
        <p class="form-error" id="hpFbErr" hidden></p>
        <div class="hp-fb-send"><button type="submit" class="btn btn-primary" id="hpFbSend" disabled>${esc(t('Send feedback'))}</button></div>
      </form>
      <h3 class="hp-head">${esc(t('Your feedback'))}</h3>
      <div class="hp-list" id="hpMine">${!mine ? helpLoading() : mine.length ? mine.map(x => feedbackCard(x, false)).join('')
        : `<p class="muted hp-none">${esc(t('Feedback you send with your name shows here, with any answer.'))}</p>`}</div>
    </div>`;
  const form = $('#hpFbForm');
  const ready = () => { $('#hpFbSend').disabled = !(form.querySelector('input[name="kind"]:checked') && form.body.value.trim()); };
  form.addEventListener('change', ready);
  form.body.addEventListener('input', ready);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const kind = form.querySelector('input[name="kind"]:checked');
    if (!kind || !form.body.value.trim()) return;
    const anonymous = form.anonymous.checked;
    $('#hpFbSend').disabled = true;
    try {
      await api('/help/feedback', { method: 'POST', body: JSON.stringify({ kind: kind.value, topic: form.topic.value, body: form.body.value.trim(), anonymous }) });
      toast(anonymous ? t('Thank you — your feedback was sent anonymously.') : t('Thank you — your feedback was sent.'));
      loadHelpTab();
    } catch (ex) {
      const err = $('#hpFbErr'); err.textContent = t(ex.message); err.hidden = false;
      $('#hpFbSend').disabled = false;
    }
  });
}
function renderFeedbackInbox() {
  const body = $('#helpBody');
  const h = state.help;
  if (!h.feedback) { body.innerHTML = helpLoading(); return; }
  const all = h.feedback;
  if (!all.length) { body.innerHTML = helpEmpty(HOME_ICONS.feedback, t('No feedback yet'), t('Criticism and suggestions from staff will appear here.')); return; }
  const byKind = all.filter(x => !h.fbKind || x.kind === h.fbKind);
  const list = byKind.filter(x => h.fbStatus === 'all' || x.status === h.fbStatus);
  const n = (fn) => byKind.filter(fn).length;
  body.innerHTML = `
    <div class="hp-wrap">
      <div class="hp-toolbar">
        ${helpSeg('hpFbStatus', [['new', t('New'), n(x => x.status === 'new')], ['read', t('Read'), n(x => x.status === 'read')], ['all', t('All'), byKind.length]], h.fbStatus)}
        ${helpSeg('hpFbKind', [['', t('All kinds')], ['criticism', t('Criticism')], ['suggestion', t('Suggestion')]], h.fbKind)}
      </div>
      <div class="hp-list">${list.length ? list.map(x => feedbackCard(x, true)).join('')
        : `<p class="muted hp-none">${esc(h.fbStatus === 'new' ? t('All feedback has been read.') : t('Nothing here.'))}</p>`}</div>
    </div>`;
  $$('#hpFbStatus [data-v]').forEach(b => b.addEventListener('click', () => { h.fbStatus = b.dataset.v; renderFeedbackInbox(); }));
  $$('#hpFbKind [data-v]').forEach(b => b.addEventListener('click', () => { h.fbKind = b.dataset.v; renderFeedbackInbox(); }));
  const review = async (id, response) => {
    try {
      await api(`/help/feedback/${id}/review`, { method: 'POST', body: JSON.stringify({ response: response || '' }) });
      toast(response ? t('Answer sent — they’ve been emailed.') : t('Marked as read.'));
      loadHelpTab();
    } catch (ex) { toast(t(ex.message), true); }
  };
  $$('#helpBody [data-fb-read]').forEach(b => b.addEventListener('click', () => { b.disabled = true; review(b.dataset.fbRead, ''); }));
  $$('#helpBody [data-fb-answer]').forEach(b => b.addEventListener('click', () => {
    const fb = all.find(x => String(x.id) === b.dataset.fbAnswer);
    if (fb) openFeedbackAnswer(fb, (text) => review(fb.id, text));
  }));
}
function openFeedbackAnswer(fb, onSend) {
  openModal(`
    <div class="modal-head">
      <div><h2>${esc(t('Answer feedback'))}</h2><p class="wn-sub">${esc(t('{name} sees your answer and gets an email.', { name: fb.sender_name || '—' }))}</p></div>
      <button type="button" class="x-btn" aria-label="${esc(t('Close'))}">×</button>
    </div>
    <div class="modal-body">
      <form class="form" id="hpAnsForm" novalidate>
        <div class="hp-quote"><span class="hp-kind hp-kind-${esc(fb.kind)}">${esc(feedbackKindLabel(fb.kind))}</span><p>${esc(fb.body)}</p></div>
        <label>${esc(t('Your answer'))}
          <textarea name="response" rows="5" maxlength="4000">${esc(fb.response || '')}</textarea>
        </label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="hpAnsCancel">${esc(t('Cancel'))}</button>
          <button type="submit" class="btn btn-primary" id="hpAnsSend" ${fb.response ? '' : 'disabled'}>${esc(t('Send answer'))}</button>
        </div>
      </form>
    </div>`);
  $('#modal').classList.add('modal-help');
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#hpAnsCancel').addEventListener('click', closeModal);
  const form = $('#hpAnsForm');
  form.response.focus();
  form.response.addEventListener('input', () => { $('#hpAnsSend').disabled = !form.response.value.trim(); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = form.response.value.trim();
    if (!text) return;
    closeModal();
    onSend(text);
  });
}
