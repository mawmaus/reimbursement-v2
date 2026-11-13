'use strict';

// A step-by-step guide for every screen, like the GPS meal form's (js/meal-gps.js).
// Each entry below says where its screen lives (a view, the drawer, the modal or
// the stacked modal2), how to recognise it, and its steps for runGuide
// (js/guide.js). A light ticker puts a "Guide" button on whichever screen is on
// top and opens that screen's guide by itself the first time an account sees it
// on this device; the button replays it any time. Steps whose element isn't on
// screen (a role without that tile, a phone-only button, …) are skipped.

const gq = (s) => `<p>${esc(s)}</p>`;
const gFirst = (sel, root) => [...(root || document).querySelectorAll(sel)].find(guideVisible) || null;
const gEl = (sel) => () => gFirst(sel);
// One cell of the first line of a table form (claims, realization, meal).
const gCell = (body, n) => () => gFirst(`${body} tr[data-i] > td:nth-child(${n})`);
const gGroup = (tile) => () => { const el = gFirst(`#homeMenu .ht-${tile}`); return el && el.closest('.home-group'); };
const gIn = (sel, root) => () => { const r = $(root); return r ? gFirst(sel, r) : null; };
const modalHas = (sel) => () => !!$(`#modal ${sel}`);

// Steps shared by the reimbursement claim and the advance realization (same line editor).
function gClaimLineSteps() {
  return [
    { el: gCell('#rcRows', 1), title: t('Date'),
      html: gq(t('The date of the expense. It has to fall inside the claim window shown under the lines.')) },
    { el: gCell('#rcRows', 2), title: t('DB No.'),
      html: gq(t('Was the expense for a customer site? Choose “With DB” and type its DB number. Otherwise leave it on “No DB”.')) },
    { el: gCell('#rcRows', 3), title: t('Type of expense'),
      html: gq(t('Pick what kind of expense it is. Not on the list? Choose “Others (specify)” and type it.')) },
    { el: gCell('#rcRows', 4), title: t('Amount'),
      html: gq(t('The amount on the receipt. The 🧮 button adds several amounts up for you.')) },
    { el: gCell('#rcRows', 5), title: t('Description / purpose'),
      html: gq(t('A few words on what the expense was for.')) },
    { el: gCell('#rcRows', 6), title: t('Receipts'),
      html: gq(t('Attach this expense’s receipts: Take photo on a phone, or Add for a PDF or image — up to 8 per line.')) },
    { el: gEl('#rcAddRow'), title: t('More expenses'),
      html: gq(t('One line per expense. Add another line for each extra receipt; × removes a line.')) },
    { el: gEl('#claimDateBox'), title: t('Claim window'),
      html: gq(t('Which dates you can claim right now. Dates outside it can’t be submitted.')) },
    { el: gEl('#modal .lf-approval'), title: t('Approval'), html: gq(t('Choose who approves this claim first.')) }
  ];
}
const gDraftStep = () => ({ el: gEl('#draftBanner'), title: t('Your saved draft'),
  html: gq(t('The form picked up where you left off. Delete draft starts again from scratch.')) });

const SCREEN_GUIDES = [
  // ---- Views ---------------------------------------------------------------
  { key: 'home', where: 'view', view: '#homeView', ready: () => !!$('#homeMenu .home-tile'),
    steps: () => [
      { el: gEl('.home-hero'), title: t('Welcome to the menu'),
        html: gq(t('This is where everything starts. This short guide shows what each part does — press Next, or Skip guide to close it.')) },
      { el: gEl('#advanceHoldNotice'), title: t('Claims on hold'),
        html: gq(t('A cash advance that isn’t cleared yet holds new claims. Realize it and return any unused balance to unlock them.')) },
      { el: gEl('#newMenuBtn'), title: t('Start a new claim'),
        html: gq(t('Press New and pick what to submit: a reimbursement, a meal allowance or a cash advance.')) },
      { el: gGroup('mine'), title: t('Your claims'),
        html: gq(t('Everything you submitted and where it stands, and how long your claims take to be approved.')) },
      { el: gGroup('approval'), title: t('Approvals'),
        html: gq(t('Claims waiting for your decision, and the ones you already approved or rejected — a decision can be reverted from there.')) },
      { el: gGroup('paid'), title: t('Finance'),
        html: gq(t('Claims already marked as paid. Open one to revert a payment made by mistake.')) },
      { el: gGroup('unrealized'), title: t('Cash advances'),
        html: gq(t('Advances that are paid but not yet accounted for, and the ones already realized.')) },
      { el: () => gGroup('all')() || gGroup('insights')(), title: t('Overview'),
        html: gq(t('Every claim in the system, and charts of where the money goes.')) },
      { el: gGroup('basemap'), title: t('Bases map'),
        html: gq(t('Every base and its radius for the GPS meal allowance.')) },
      { el: gGroup('helpdesk'), title: t('Help'),
        html: gq(t('Ask the helpdesk a question, or send criticism and suggestions.')) },
      { el: gEl('.topbar .tb-context'), title: t('Region and language'),
        html: gq(t('Switch the language here — and the region, if you work across several.')) },
      { el: gEl('#whatsNewBtn'), title: t("What's new"), html: gq(t('The latest changes to the app.')) },
      { el: gEl('#exportBtn'), title: t('Export Excel'), html: gq(t('Download claims as an Excel file.')) },
      { el: gEl('#profileBtn'), title: t('Profile'), html: gq(t('Your email, bank details, password and how the app looks.')) },
      { el: gEl('#accountsBtn'), title: t('Manage accounts'), html: gq(t('Add accounts and change who can do what.')) },
      { el: gEl('#settingsBtn'), title: t('Settings'), html: gq(t('Regions, departments, expense types, the claim window and the other rules.')) },
      { el: gEl('#tbMenuBtn'), title: t('Your account'), html: gq(t('Your profile, language, dark mode and Sign out are in here.')) },
      { el: gEl('#homeView [data-guide-btn]'), title: t('A guide on every screen'),
        html: gq(t('Every screen has a Guide button like this one. Press it any time to see how that screen works.')) }
    ] },
  { key: 'list', where: 'view', view: '#listView', ready: () => !!$('#claimRows .ledger-row') || !$('#emptyState').hidden,
    steps: () => [
      { el: gEl('#listView .list-title-wrap'), title: t('Which list this is'),
        html: gq(t('The list’s name and how many claims it holds. ← Menu takes you back.')) },
      { el: gEl('#summaryCards'), title: t('Totals by status'),
        html: gq(t('How many claims are in each status, and their total. Tap a card to show only those claims.')) },
      { el: gEl('#searchInput'), title: t('Search'),
        html: gq(t('Find a claim by its number, the claimant, the expense type or a DB number.')) },
      { el: gEl('#filterPanel'), title: t('Filters'),
        html: gq(t('Narrow the list by status, department or claimant. Clear filters shows everything again.')) },
      { el: gEl('#filterToggle'), title: t('Filters'),
        html: gq(t('Narrow the list by status, department or claimant. Clear filters shows everything again.')) },
      { el: gEl('.ledger-head'), title: t('Sort the list'),
        html: gq(t('Click a column heading to sort by it; click it again to reverse the order.')) },
      { el: gEl('#claimRows .ledger-row'), title: t('Open a claim'),
        html: gq(t('Open a claim to see its lines, receipts, approval chain and history — and to approve, reject or edit it.')) },
      { el: gEl('.ledger-head .col-check'), title: t('Select several claims'),
        html: gq(t('Tick claims to download them as one PDF — or, for Finance, to mark them as paid together.')) },
      { el: gEl('#selectModeBtn'), title: t('Select several claims'),
        html: gq(t('Tick claims to download them as one PDF — or, for Finance, to mark them as paid together.')) },
      { el: gEl('#ledgerScope'), title: t('Recent or all history'),
        html: gq(t('The list keeps to open claims and the last 90 days. Switch here to see the full history.')) },
      { el: gEl('#refreshBtn'), title: t('Refresh'),
        html: gq(t('Reload the list to see decisions made since you opened it.')) }
    ] },
  { key: 'insights', where: 'view', view: '#insightsView', match: () => state.view === 'insights',
    ready: () => !!$('#insightsBody .insights-kpis'),
    steps: () => [
      { el: gEl('#inFilterToggle'), title: t('Filters'),
        html: gq(t('Choose the year, month, department, DB number, status or employee. Everything below follows them.')) },
      { el: gEl('#insightsBody .insights-kpis:not(.insights-flow)'), title: t('Key numbers'),
        html: gq(t('The totals for the period you picked, compared with the one before.')) },
      { el: gEl('#insightsBody .insights-flow'), title: t('Pipeline & speed'),
        html: gq(t('What is waiting right now, and how fast claims get approved.')) },
      { el: gEl('#insightsBody .in-approval'), title: t('Approval times by employee'),
        html: gq(t('How long each person’s claims wait for Manager and Finance AP approval.')) },
      { el: gEl('#typeBars'), title: t('Spend by expense type'),
        html: gq(t('Which expense types cost the most. Click a type to see its expenses.')) },
      { el: gEl('#trendChart'), title: t('Total over time'),
        html: gq(t('Spending month by month, or year by year.')) },
      { el: gEl('#insightsBody .insights-ranks'), title: t('Rankings'),
        html: gq(t('Which departments, employees and DB numbers account for the most spending.')) }
    ] },
  { key: 'myapproval', where: 'view', view: '#insightsView', match: () => state.view === 'myapproval',
    ready: () => !!$('#insightsBody .in-approval'),
    steps: () => [
      { el: gEl('#inApprovalPeriod'), title: t('Approval period'),
        html: gq(t('Pick the period to measure. Choose Custom range for your own dates.')) },
      { el: gEl('#insightsBody .in-approval-table'), title: t('Your average'),
        html: gq(t('On average, how long your claims wait for Manager approval and then for Finance AP approval.')) },
      { el: () => { const h = $('#inApprovalClaimsTitle'); return h && h.closest('.chart-card'); }, title: t('Per claim'),
        html: gq(t('Each claim’s own wait. Click a claim number to open it.')) }
    ] },
  { key: 'help', where: 'view', view: '#helpView', match: () => state.help && state.help.tab === 'tickets',
    ready: () => !!$('#helpBody .hp-wrap, #helpBody .hp-empty'),
    steps: () => [
      { el: gEl('#helpTabs'), title: t('Two kinds of help'),
        html: gq(t('Helpdesk is for questions and problems; Feedback & suggestions is for ideas and criticism.')) },
      { el: () => gFirst('#hpNewTicket') || gFirst('#hpEmptyNew'), title: t('Ask the helpdesk'),
        html: gq(t('Open a ticket: pick a topic, describe the problem and add screenshots. You get an email when they answer.')) },
      { el: gEl('#hpTicketSeg'), title: t('Open or closed'),
        html: gq(t('Switch between tickets still waiting and the ones already solved.')) },
      { el: gEl('#helpBody .hp-list'), title: t('Tickets'),
        html: gq(isSuperUser()
          ? t('Questions from staff. Open one to answer it, and mark it solved when you’re done.')
          : t('Your tickets and the helpdesk’s answers. A dot marks a new reply.')) }
    ] },
  { key: 'feedback', where: 'view', view: '#helpView', match: () => state.help && state.help.tab === 'feedback',
    ready: () => !!$('#helpBody .hp-wrap, #helpBody .hp-empty'),
    steps: () => [
      { el: gEl('#helpTabs'), title: t('Two kinds of help'),
        html: gq(t('Helpdesk is for questions and problems; Feedback & suggestions is for ideas and criticism.')) },
      { el: gEl('#hpFbForm .hp-kind-pick'), title: t('Criticism or suggestion'),
        html: gq(t('Say whether something bothers you, or you have an idea to make things better.')) },
      { el: gEl('#hpFbForm textarea'), title: t('Your feedback'),
        html: gq(t('Be specific — what happened, and what would be better.')) },
      { el: gEl('#hpFbForm .hp-anon-opt'), title: t('Send anonymously'),
        html: gq(t('Hides your name. Anonymous feedback isn’t listed for you or answered.')) },
      { el: gEl('#hpMine'), title: t('Your feedback'),
        html: gq(t('Feedback you sent with your name, with any answer.')) },
      { el: gEl('#helpBody .hp-seg'), title: t('Filters'),
        html: gq(t('Switch between new feedback and feedback already read.')) },
      { el: () => !$('#hpFbForm') && gFirst('#helpBody .hp-list'), title: t('Feedback & suggestions'),
        html: gq(t('What staff sent. Open one to read it and answer.')) }
    ] },
  { key: 'datechange', where: 'view', view: '#dcView', ready: () => !!$('#dcBody .dc-wrap'),
    steps: () => [
      { el: gEl('#dcBody .dc-intro'), title: t('Request change of date'),
        html: gq(t('Older requests to unlock the dates on a returned claim, from before claimants could re-date claims themselves.')) },
      { el: gEl('#dcBody .dc-card'), title: t('Decide'),
        html: gq(t('Unlock lets that claimant re-date the claim once, ignoring the claim window. Decline says no, with a reason.')) }
    ] },

  // ---- Claim detail (drawer) ---------------------------------------------
  { key: 'drawer', where: 'drawer',
    steps: () => [
      { el: gEl('#drawer .drawer-head'), title: t('The claim at a glance'),
        html: gq(t('What it is, the amount to be paid, its status and whose claim it is.')) },
      { el: gEl('#drawer .note-box'), title: t('Why it was returned'),
        html: gq(t('The reason the approver gave for sending it back.')) },
      { el: gEl('#drawer .kv'), title: t('Details'),
        html: gq(t('The claim’s details, bank account and any supporting documents.')) },
      { el: gEl('#drawerMap'), title: t('Map'),
        html: gq(t('Where each meal’s customer site is, measured from the claimant’s base.')) },
      { el: gEl('#drawerLines'), title: t('Lines and receipts'),
        html: gq(t('Every expense line with its receipts — tap a receipt to open it. An approver can reject a single line here and approve the rest.')) },
      { el: gEl('#drawer .chain-progress'), title: t('Approval chain'),
        html: gq(t('Who approves it, in order, and who it is waiting on now.')) },
      { el: gEl('#drawer .timeline'), title: t('History'),
        html: gq(t('Every step taken on it, with who did it and when.')) },
      { el: gEl('#drawer .drawer-actions'), title: t('What you can do'),
        html: gq(t('The actions open to you at this stage — approve, reject, mark as paid, edit and resubmit, or revert. Only what your role allows shows here.')) }
    ] },

  // ---- Forms (modal) ------------------------------------------------------
  { key: 'claim', where: 'modal', match: modalHas('#claimForm'),
    steps: () => [gDraftStep(), ...gClaimLineSteps(),
      { el: gEl('#claimForm .meal-foot'), title: t('Check and submit'),
        html: gq(t('Check the total, then submit. Not finished? Save draft and come back later.')) }] },
  { key: 'realize', where: 'modal', match: modalHas('#realizeForm'),
    steps: () => [
      { el: gEl('#advDiffWrap'), title: t('Advance vs. spend'),
        html: gq(t('How much of the advance you have accounted for. Spend less and you return the rest; spend more and the difference is paid to you.')) },
      ...gClaimLineSteps(),
      { el: gEl('#realizeForm .meal-foot'), title: t('Check and submit'),
        html: gq(t('Submit the realization once every expense paid from the advance is listed with its receipt.')) }] },
  { key: 'meal', where: 'modal', match: modalHas('#mealForm'),
    steps: () => [gDraftStep(),
      { el: gCell('#mealRows', 1), title: t('Date'), html: gq(t('The day of the meal — one line per day.')) },
      { el: gCell('#mealRows', 2), title: t('DB Number Site'),
        html: gq(t('The customer site’s DB number. Choose “No DB” if it has none.')) },
      { el: gCell('#mealRows', 3), title: t('Job Category'), html: gq(t('The work done there, for example Install, Repair or Service.')) },
      { el: gCell('#mealRows', 4), title: t('Amount'), html: gq(t('Pick the allowance for that day.')) },
      { el: gCell('#mealRows', 5), title: t('Additional Description'), html: gq(t('Anything else worth noting, such as the city.')) },
      { el: gEl('#mealAddRow'), title: t('More days'), html: gq(t('Add a line for every extra day; × removes a line.')) },
      { el: gEl('#claimDateBox'), title: t('Claim window'),
        html: gq(t('Which dates you can claim right now. Dates outside it can’t be submitted.')) },
      { el: gEl('#mealForm .lf-approval'), title: t('Approval'), html: gq(t('Choose who approves this claim first.')) },
      { el: gEl('#mealForm .meal-foot'), title: t('Check and submit'),
        html: gq(t('Check the total, then submit. Not finished? Save draft and come back later.')) }] },
  { key: 'advance', where: 'modal', match: modalHas('#advForm'),
    steps: () => [gDraftStep(),
      { el: gEl('#advForm [name="purpose"]'), title: t('Purpose of the cash advance'),
        html: gq(t('Say what the money is for, so your approver can judge the request.')) },
      { el: gEl('#advForm .amt-field'), title: t('Amount needed'), html: gq(t('How much you need up front.')) },
      { el: gEl('#advForm .adv-docs'), title: t('Supporting documents (optional)'),
        html: gq(t('A quotation, invoice or booking confirmation helps it get approved.')) },
      { el: gEl('#advForm .lf-approval'), title: t('Approval'), html: gq(t('Choose who approves this claim first.')) },
      { el: gEl('#advForm .meal-foot'), title: t('After it is paid'),
        html: gq(t('Submit the request. Once it is approved and paid, open it from Unrealized cash advances and realize it with what you actually spent.')) }] },
  { key: 'settle', where: 'modal', match: modalHas('#settleForm'),
    steps: () => [
      { el: gEl('#settleForm .kv'), title: t('Advance vs. spend'),
        html: gq(t('The advance paid, what was actually spent, and the difference.')) },
      { el: gEl('#settleForm [name="note"]'), title: t('Settlement note (optional)'),
        html: gq(t('Note how the difference was settled, for example the date the balance came back.')) },
      { el: gEl('#settleForm .modal-actions'), title: t('Confirm'),
        html: gq(t('Confirm once the money has actually changed hands. The cash advance is then cleared.')) }] },
  { key: 'export', where: 'modal', match: modalHas('#exportForm'),
    steps: () => [
      { el: () => { const s = $('#exportForm .lf-sec'); return s && guideVisible(s) ? s : null; }, title: t('Date range'),
        html: gq(t('Pick the dates to export, or tap a quick range. Leave them blank to export every date.')) },
      { el: gEl('#exportForm .export-groups'), title: t('What to include'),
        html: gq(t('Tick the statuses and claim types to include.')) },
      { el: gEl('#exportForm .user-filter'), title: t('Users (submitters)'),
        html: gq(t('Export everyone, or search and tick just some people.')) },
      { el: gEl('#exportForm .meal-foot'), title: t('Download Excel'),
        html: gq(t('Shows how much will be exported. Download Excel saves the file.')) }] },
  { key: 'profile', where: 'modal', match: modalHas('.pf-body'),
    steps: () => [
      { el: gEl('#modal .look-pick'), title: t('Appearance'), html: gq(t('Choose how the app looks.')) },
      { el: gEl('#profileForm'), title: t('Contact & bank details'),
        html: gq(t('Your email for password resets and notifications, and the bank account your claims are paid into. Check the bank details carefully.')) },
      { el: gEl('#pwForm'), title: t('Change password'),
        html: gq(t('Type your current password, then the new one twice. The meter shows how strong it is.')) }] },
  { key: 'regions', where: 'modal', match: () => !!$('#modal #rgAddForm'), ready: () => !!$('#modal .rg-row'),
    steps: () => [
      { el: gEl('#modal .rg-row'), title: t('Regions'),
        html: gq(t('Each region has its own accounts, departments, job positions, expense types, claim window and roles.')) },
      { el: gEl('#modal .rg-row [data-open]'), title: t('Open settings'), html: gq(t('Open a region to change its settings.')) },
      { el: gEl('#modal .rg-row .row-more'), title: t('More actions'), html: gq(t('Rename a region, or switch it off.')) },
      { el: gEl('#rgAddBtn'), title: t('Add region'), html: gq(t('Start a new region with its own settings.')) }] },
  { key: 'settings', where: 'modal', match: () => !!$('#modal #settingsTabs'), ready: () => !!$('#wsTitle') && !!$('#wsTitle').textContent,
    steps: () => [
      { el: gEl('#settingsTabs'), title: t('Settings'),
        html: gq(t('Every setting, grouped by topic. Pick one on the left to open it.')) },
      { el: gEl('#modal .ws-page-head'), title: t('What this page does'),
        html: gq(t('The page’s name and what it controls. Its buttons sit on the right.')) },
      { el: gEl('#settingsPanel'), title: t('Make your changes'),
        html: gq(t('Change the setting here. Most pages save as soon as you press their Save or Add button.')) },
      { el: gEl('#wsBack'), title: t('Regions'), html: gq(t('Go back to the list of regions.')) }] },
  { key: 'accounts', where: 'modal', match: () => !!$('#modal #maBody'), ready: () => !!$('#maBody #acctSearch'),
    steps: () => [
      { el: gEl('#maAddUserBtn'), title: t('+ Add user'), html: gq(t('Create a new account in your team.')) },
      { el: gEl('#acctSearch'), title: t('Search'), html: gq(t('Find someone by name or username.')) },
      { el: () => { const b = gFirst('#maBody [data-filter]'); return b && b.parentElement; }, title: t('Filters'),
        html: gq(t('Show only some accounts, for example the ones switched off.')) },
      { el: gEl('#maBody .settings-list'), title: t('Accounts'),
        html: gq(t('Open an account to change its details, role, approvers or password.')) }] },
  { key: 'basemap', where: 'modal', match: modalHas('#bmMap'), ready: () => !!$('#bmList') && $('#bmList').children.length > 0,
    steps: () => [
      { el: gEl('#bmMap'), title: t('Bases map'),
        html: gq(t('Every base, with the ring an in-town GPS meal has to be outside of. Drag and zoom to look around.')) },
      { el: gEl('#bmKey'), title: t('Map key'), html: gq(t('What the rings and dots on the map mean.')) },
      { el: gEl('#bmFind'), title: t('Find a customer site'), html: gq(t('Type a DB number, name or alias to show a customer site on the map.')) },
      { el: gEl('#bmList'), title: t('Bases'), html: gq(t('Tap a base to fly to it. Yours is tagged.')) }] },
  { key: 'ticket', where: 'modal', match: modalHas('#hpTicketForm'),
    steps: () => [
      { el: gEl('#hpTicketForm [name="category"]'), title: t('Topic'), html: gq(t('What your question is about.')) },
      { el: gEl('#hpTicketForm [name="subject"]'), title: t('Subject'), html: gq(t('A short line that sums it up.')) },
      { el: gEl('#hpTicketForm [name="message"]'), title: t('Message'),
        html: gq(t('Describe what happened. If it’s about a claim, include its number.')) },
      { el: gEl('#hpTicketForm .hp-attach'), title: t('Screenshots'),
        html: gq(t('A screenshot shows the problem faster than words. You can also paste one.')) },
      { el: gEl('#hpTicketForm .modal-actions'), title: t('Send ticket'),
        html: gq(t('The helpdesk answers in Help & feedback, and you get an email when they do.')) }] },
  // The GPS meal form has its own guide and button (js/meal-gps.js).
  { key: 'mealgps', where: 'modal', match: modalHas('#mgForm'), own: true },

  // ---- Stacked forms (modal2) ---------------------------------------------
  { key: 'user', where: 'modal2', match: () => !!$('#modal2 #uForm'),
    steps: () => [
      { el: gEl('#modal2 .ue-nav'), title: t('Sections'),
        html: gq(t('Jump to a section of the account. The one you are in is highlighted.')) },
      { el: gEl('#ueScroll'), title: t('Account details'),
        html: gq(t('Fill in each section: who they are, their role and job position, their approvers and what they can claim.')) },
      { el: gEl('#modal2 .ue-foot'), title: t('Save changes'), html: gq(t('Save when you’re done. Fields with a problem are marked in red.')) }] }
];

// Which guide belongs to the screen on top (or to a given layer).
function screenGuideFor(where) {
  return SCREEN_GUIDES.find(g => g.where === where && (!g.view || !$(g.view).hidden) && (!g.match || g.match())) || null;
}
function topScreen() {
  if (!state.user || !$('#tbSheet').hidden) return null;
  if (!$('#modal2').hidden) return 'modal2';
  if (!$('#modal').hidden) return 'modal';
  if (!$('#drawer').hidden) return 'drawer';
  return 'view';
}
function startScreenGuide(g) {
  if (!g || g.own) return;
  runGuide(g.steps(), { onEnd: () => markGuideSeen(`screen.${g.key}.v1`) });
}

// Where a layer's Guide button goes: before the close × of a modal or the
// drawer, or at the end of a view's header row.
function guideBtnSpot(where) {
  if (where === 'modal' || where === 'modal2') {
    const x = $(`#${where} .modal-head .x-btn`);
    return x && { parent: x.parentNode, before: x };
  }
  if (where === 'drawer') {
    const x = $('#drawer .dh-top .x-btn');
    return x && { parent: x.parentNode, before: x };
  }
  const v = ['#homeView', '#listView', '#insightsView', '#helpView', '#dcView'].map(s => $(s)).find(el => el && !el.hidden);
  if (!v) return null;
  const head = v.querySelector(':scope > .list-head, :scope > .home-hero');
  return head && { parent: head, before: null };
}
function ensureGuideBtn(where) {
  const spot = guideBtnSpot(where);
  if (!spot || spot.parent.querySelector(':scope > [data-guide-btn]')) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn btn-ghost btn-sm lf-guide-btn screen-guide-btn sg-${where}`;
  b.dataset.guideBtn = where;
  b.title = t('Show me how this screen works');
  b.setAttribute('aria-label', t('Guide'));
  b.innerHTML = `<span aria-hidden="true">?</span> <span class="sg-l">${esc(t('Guide'))}</span>`;
  b.addEventListener('click', () => startScreenGuide(screenGuideFor(where)));
  spot.parent.insertBefore(b, spot.before);
}

// The ticker: buttons on the screen on top (and the view under a split-view
// drawer), plus the first-time auto start once the screen has settled.
const guideTick = { last: null, since: 0, tried: new Set() };
function syncScreenGuides() {
  if (document.hidden) return;
  const top = topScreen();
  if (!top) return;
  const layers = top === 'drawer' ? ['drawer', 'view'] : [top];
  for (const where of layers) {
    const g = screenGuideFor(where);
    if (g && !g.own) ensureGuideBtn(where);
  }
  if (guideState) return;
  const g = screenGuideFor(top);
  const id = g ? g.key : null;
  if (id !== guideTick.last) { guideTick.last = id; guideTick.since = Date.now(); return; }
  if (!g || g.own || guideTick.tried.has(id) || Date.now() - guideTick.since < 500) return;
  if (g.ready && !g.ready()) return;
  guideTick.tried.add(id);
  if (!guideSeen(`screen.${id}.v1`)) startScreenGuide(g);
}
setInterval(syncScreenGuides, 400);
// A language switch re-labels the buttons: drop them and let the ticker re-add.
window.addEventListener('i18n:changed', () => { $$('[data-guide-btn]').forEach(b => b.remove()); });
