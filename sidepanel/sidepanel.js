/**
 * Zijpaneel: de wachtrij, de Humble-catalogus, instellingen en diagnose.
 *
 * Het paneel houdt zelf geen waarheid vast — het vraagt de service worker om de
 * state en tekent die. De enige lokale state is welk tabblad open staat en welke
 * spellen in de catalogus zijn aangevinkt.
 */
'use strict';

(() => {
  const { MSG, STATUS } = HSG;

  const ui = {
    summary: document.querySelector('[data-role="summary"]'),
    notice: document.querySelector('[data-role="notice"]'),
    queue: document.querySelector('[data-role="queue"]'),
    queueEmpty: document.querySelector('[data-role="queue-empty"]'),
    catalog: document.querySelector('[data-role="catalog"]'),
    catalogHint: document.querySelector('[data-role="catalog-hint"]'),
    catalogFilter: document.querySelector('[data-role="catalog-filter"]'),
    settingsForm: document.querySelector('[data-role="settings"]'),
    schedulePreview: document.querySelector('[data-role="schedule-preview"]'),
    diagnostics: document.querySelector('[data-role="diagnostics"]'),
  };

  const local = { selected: new Set(), catalogSignature: null };
  let state = null;

  const splitIds = (value) => String(value || '').trim().split(/\s+/).filter(Boolean);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  /** Volledige URL's maken de smalle kolom onleesbaar. */
  const shortUrl = (value) => {
    try {
      const url = new URL(value);
      return url.pathname + (url.search.length > 24 ? '?…' : url.search);
    } catch (error) {
      return value;
    }
  };

  const STATUS_LABEL = {
    [STATUS.PENDING]: 'wacht',
    [STATUS.FILLED]: 'ingevuld',
    [STATUS.NEEDS_CHOICE]: 'keuze nodig',
    [STATUS.DONE]: 'klaar',
    [STATUS.ERROR]: 'fout',
  };

  // --- communicatie ----------------------------------------------------------

  async function call(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response) throw new Error('Geen antwoord van de extensie.');
    if (!response.ok) throw new Error(response.error || 'Onbekende fout');
    return response.result;
  }

  function showNotice(text, tone) {
    if (!text) {
      ui.notice.hidden = true;
      return;
    }
    ui.notice.hidden = false;
    ui.notice.textContent = text;
    ui.notice.dataset.tone = tone || 'warn';
  }

  /** Wikkelt een handler zodat een fout in het paneel landt en niet in het niets. */
  function guard(fn) {
    return async (...args) => {
      try {
        showNotice('');
        await fn(...args);
      } catch (error) {
        showNotice(String(error.message || error), 'error');
      }
    };
  }

  // --- tekenen ---------------------------------------------------------------

  async function refresh() {
    state = await call({ type: MSG.GET_STATE });
    renderSummary();
    renderQueue();
    renderCatalog();
    renderSettings();
    renderDiagnostics();
  }

  function renderSummary() {
    const s = state.summary;
    const parts = [`${s.total} in de wachtrij`];
    if (s.done) parts.push(`${s.done} klaar`);
    if (s.error) parts.push(`${s.error} fout`);
    if (s.needsChoice) parts.push(`${s.needsChoice} keuze nodig`);
    parts.push(state.queue.running ? 'bezig' : 'gepauzeerd');
    ui.summary.textContent = parts.join(' · ');
  }

  function renderQueue() {
    ui.queue.textContent = '';
    const { items, cursor, running } = state.queue;
    ui.queueEmpty.hidden = items.length > 0;

    items.forEach((item, index) => {
      const li = document.createElement('li');
      li.className = 'queue__item';
      if (index === cursor && running) li.classList.add('is-current');

      const head = document.createElement('div');
      head.className = 'queue__head';

      const name = document.createElement('span');
      name.className = 'queue__name';
      name.textContent = item.humanName;

      const status = document.createElement('span');
      status.className = 'queue__status';
      status.dataset.status = item.status;
      status.textContent = STATUS_LABEL[item.status] || item.status;

      head.append(name, status);
      li.append(head);

      const meta = document.createElement('div');
      meta.className = 'queue__meta';
      const bits = [];
      if (item.sgGameName) bits.push(`SteamGifts: ${item.sgGameName}`);
      else if (item.steamAppId) bits.push(`appid ${item.steamAppId}`);
      if (item.error) bits.push(item.error);
      if (item.giveawayUrl) bits.push(item.giveawayUrl);
      if (!state.keyIds.includes(item.id) && item.status !== STATUS.DONE) {
        bits.push('geen key meer opgeslagen');
      }
      meta.textContent = bits.join(' — ');
      if (meta.textContent) li.append(meta);

      if (item.status === STATUS.NEEDS_CHOICE && item.candidates) {
        li.append(renderCandidates(item));
      }

      const tools = document.createElement('div');
      tools.className = 'queue__tools';
      tools.append(
        toolButton('↑', () => call({ type: MSG.QUEUE_MOVE, id: item.id, delta: -1 })),
        toolButton('↓', () => call({ type: MSG.QUEUE_MOVE, id: item.id, delta: 1 })),
        toolButton('Opnieuw', () => call({ type: MSG.QUEUE_RETRY, id: item.id })),
        toolButton('Verwijder', () => call({ type: MSG.QUEUE_REMOVE, id: item.id }))
      );
      li.append(tools);

      ui.queue.append(li);
    });
  }

  function renderCandidates(item) {
    const wrap = document.createElement('div');
    wrap.className = 'candidates';
    for (const candidate of item.candidates) {
      wrap.append(
        toolButton(candidate.name, () =>
          call({
            type: MSG.PICK_CANDIDATE,
            id: item.id,
            gameId: candidate.id,
            gameName: candidate.name,
          })
        )
      );
    }
    return wrap;
  }

  function toolButton(label, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn--tiny';
    button.textContent = label;
    button.addEventListener(
      'click',
      guard(async () => {
        await action();
        await refresh();
      })
    );
    return button;
  }

  function renderCatalog() {
    const catalog = state.catalog;

    if (!catalog || !catalog.games || catalog.games.length === 0) {
      ui.catalog.textContent = '';
      local.catalogSignature = 'leeg';
      ui.catalogHint.textContent =
        'Nog geen catalogus. Open je Humble keys-pagina (/home/keys of de downloadpagina van de bundel) en klik op "Deze pagina scannen".';
      updateAddButton();
      return;
    }

    // Een item dat op fout staat mag opnieuw toegevoegd worden: mislukte de
    // reveal, dan is er nog helemaal geen key en helpt "opnieuw" in de wachtrij
    // niet.
    const queued = new Set(
      state.queue.items
        .filter((item) => item.status !== STATUS.ERROR)
        .map((item) => item.id)
    );
    const hints = [`${catalog.games.length} spellen gevonden.`];
    if (catalog.pageUrl) hints.push(`Van: ${shortUrl(catalog.pageUrl)}.`);
    if (catalog.bundles && catalog.bundles.length) {
      hints.push(`Bundels: ${catalog.bundles.slice(0, 4).join(', ')}.`);
    }
    if (catalog.source === 'dom') {
      hints.push('Zonder Steam-appid — er wordt op titel gezocht op SteamGifts.');
    }
    if (catalog.truncatedOrders) {
      hints.push(
        `${catalog.truncatedOrders} bundel(s) niet opgehaald — filter op één bundel of scan opnieuw.`
      );
    }
    if (catalog.apiError) hints.push(`API-aanvulling mislukt: ${catalog.apiError}`);
    ui.catalogHint.textContent = hints.join(' ');

    // Ook op bundelnaam filteren: zoeken op "July 2026" geeft precies de maand
    // die je wilt weggeven, ook als die over meerdere Humble-pagina's staat.
    const needle = HSG.normalizeTitle(ui.catalogFilter.value || '');
    const visible = needle
      ? catalog.games.filter((game) =>
          HSG.normalizeTitle(`${game.humanName} ${game.bundleName || ''}`).includes(needle)
        )
      : catalog.games;

    // Niet hertekenen als er niets veranderd is. Dit paneel ververst op elke
    // storage-wijziging, en de Humble-tab schrijft daar geregeld naartoe — het
    // vinkje waar je net op mikte werd dan onder je muis vervangen.
    const signature = [
      catalog.pageUrl,
      catalog.source,
      needle,
      visible.length,
      visible
        .map(
          (game) =>
            `${game.id}${game.revealed ? 'r' : ''}${game.unavailable ? 'u' : ''}${
              queued.has(game.id) ? 'q' : ''
            }`
        )
        .join(','),
    ].join('|');

    if (signature === local.catalogSignature) {
      updateAddButton();
      return;
    }
    local.catalogSignature = signature;
    ui.catalog.textContent = '';

    if (visible.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Niets gevonden met deze zoekterm.';
      ui.catalog.append(li);
    }

    visible.forEach((game, index) => {
      const li = document.createElement('li');
      li.className = 'catalog__item';

      const input = document.createElement('input');
      input.type = 'checkbox';
      // Zonder id/for is alleen het minuscule vakje aanklikbaar.
      input.id = `catalog-item-${index}`;
      input.checked = local.selected.has(game.id);
      input.disabled = queued.has(game.id) || Boolean(game.unavailable);
      input.addEventListener('change', () => {
        if (input.checked) local.selected.add(game.id);
        else local.selected.delete(game.id);
        updateAddButton();
      });

      const label = document.createElement('label');
      label.className = 'catalog__label';
      label.htmlFor = input.id;
      label.textContent = game.humanName;

      const tag = document.createElement('span');
      tag.className = 'catalog__tag';
      const tags = [];
      if (game.bundleName) tags.push(game.bundleName);
      if (game.unavailable) tags.push('niet meer beschikbaar bij Humble');
      if (queued.has(game.id)) tags.push('staat al in de wachtrij');
      if (game.revealed) tags.push('key al onthuld');
      if (!game.steamAppId) tags.push('geen appid — zoekt op titel');
      if (game.keyType && game.keyType !== 'steam') tags.push(`platform: ${game.keyType}`);
      if (tags.length) {
        tag.textContent = tags.join(' · ');
        label.append(document.createElement('br'), tag);
      }

      li.append(input, label);
      ui.catalog.append(li);
    });
    updateAddButton();
  }

  function updateAddButton() {
    const button = document.querySelector('[data-action="add-selected"]');
    button.disabled = local.selected.size === 0;
    button.textContent =
      local.selected.size > 0
        ? `Voeg ${local.selected.size} toe aan wachtrij`
        : 'Voeg toe aan wachtrij';
  }

  function renderSettings() {
    const form = ui.settingsForm;
    // Niet overschrijven terwijl er in een veld getypt wordt: een
    // storage-update van elders (bijv. een nieuwe catalogus) zou anders je
    // halve invoer weggooien.
    if (form.contains(document.activeElement)) {
      renderSchedulePreview();
      return;
    }
    const settings = state.settings;
    for (const [name, value] of Object.entries(settings)) {
      const field = form.elements[name];
      if (!field) continue;
      if (field.type === 'checkbox') field.checked = Boolean(value);
      else if (Array.isArray(value)) field.value = value.join(' ');
      else field.value = value;
    }
    renderSchedulePreview();
  }

  function renderSchedulePreview() {
    const schedule = HSG.computeSchedule(state.settings, new Date());
    ui.schedulePreview.textContent = `Nu zou dat worden: ${schedule.startText} → ${schedule.endText}`;
  }

  function renderDiagnostics() {
    ui.diagnostics.textContent = '';
    const diagnostics = state.diagnostics;
    if (!diagnostics) return;

    for (const [site, report] of Object.entries(diagnostics)) {
      const heading = document.createElement('h2');
      heading.textContent = site === 'humble' ? 'Humble Bundle' : 'SteamGifts';
      ui.diagnostics.append(heading);

      // Welke tab er gecontroleerd is, is geen detail: er kunnen meerdere tabs
      // van dezelfde site open staan en dan diagnosticeer je zomaar de verkeerde.
      if (report.url) {
        const where = document.createElement('p');
        where.className = 'hint';
        where.textContent = `Gedraaid op: ${report.url}`;
        ui.diagnostics.append(where);
      }

      if (report.error) {
        const error = document.createElement('p');
        error.className = 'hint';
        error.textContent = report.error;
        ui.diagnostics.append(error);
        continue;
      }

      for (const check of report.checks || []) {
        const row = document.createElement('div');
        row.className = `check ${check.ok ? 'is-ok' : 'is-bad'}`;

        const mark = document.createElement('span');
        mark.className = 'check__mark';
        mark.textContent = check.ok ? '✓' : '✕';

        const body = document.createElement('div');
        body.className = 'check__body';
        body.textContent = check.label;

        if (check.detail) {
          const detail = document.createElement('span');
          detail.className = 'check__detail';
          detail.textContent = check.detail;
          body.append(detail);
        }

        row.append(mark, body);
        ui.diagnostics.append(row);
      }
    }
  }

  // --- interactie ------------------------------------------------------------

  document.querySelector('[data-role="tabs"]').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');
    if (!tab) return;
    document.querySelectorAll('.tab').forEach((el) => el.classList.remove('is-active'));
    document.querySelectorAll('.panel').forEach((el) => el.classList.remove('is-active'));
    tab.classList.add('is-active');
    document.querySelector(`[data-panel="${tab.dataset.tab}"]`).classList.add('is-active');
  });

  const ACTIONS = {
    start: () => call({ type: MSG.QUEUE_START }),
    pause: () => call({ type: MSG.QUEUE_PAUSE }),
    'clear-queue': async () => {
      if (!confirm('De hele wachtrij en de opgeslagen keys wissen?')) return;
      await call({ type: MSG.QUEUE_CLEAR });
    },
    scan: async () => {
      showNotice('Scannen…', 'ok');
      await call({ type: MSG.HUMBLE_SCAN_REQUEST, scope: 'page' });
      showNotice('');
    },
    'scan-library': async () => {
      showNotice('Hele bibliotheek ophalen — dit kan even duren…', 'ok');
      await call({ type: MSG.HUMBLE_SCAN_REQUEST, scope: 'library' });
      showNotice('');
    },
    'select-all': () => {
      const queued = new Set(state.queue.items.map((item) => item.id));
      for (const game of (state.catalog && state.catalog.games) || []) {
        if (!queued.has(game.id)) local.selected.add(game.id);
      }
    },
    'select-none': () => {
      local.selected.clear();
    },
    'add-selected': async () => {
      const ids = Array.from(local.selected);
      if (ids.length === 0) return;
      // Onthullen is bij Humble niet terug te draaien; bij een grote selectie
      // eerst even vragen.
      if (ids.length > 25 && !confirm(`${ids.length} keys ophalen bij Humble. Doorgaan?`)) {
        return;
      }
      showNotice(`Keys ophalen voor ${ids.length} ${ids.length === 1 ? 'spel' : 'spellen'}…`, 'ok');
      const result = await call({ type: MSG.QUEUE_ADD, ids });
      local.selected.clear();
      showNotice(
        result.failed
          ? `${result.added} toegevoegd, ${result.failed} mislukt — zie de wachtrij.`
          : `${result.added} toegevoegd aan de wachtrij.`,
        result.failed ? 'warn' : 'ok'
      );
    },
    'diagnose-humble': () => call({ type: MSG.RUN_DIAGNOSE, site: 'humble' }),
    'diagnose-steamgifts': () => call({ type: MSG.RUN_DIAGNOSE, site: 'steamgifts' }),
    'clear-keys': async () => {
      if (!confirm('Alle opgeslagen keys wissen? De wachtrij blijft staan.')) return;
      await call({ type: MSG.KEYS_CLEAR });
    },
  };

  document.body.addEventListener(
    'click',
    guard(async (event) => {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      const action = ACTIONS[target.dataset.action];
      if (!action) return;
      await action();
      await refresh();
    })
  );

  ui.settingsForm.addEventListener(
    'change',
    guard(async () => {
      const form = ui.settingsForm;
      const patch = {
        startOffsetMinutes: Number(form.elements.startOffsetMinutes.value) || 5,
        durationDays: Number(form.elements.durationDays.value) || 7,
        copies: Number(form.elements.copies.value) || 1,
        whoCanEnter: form.elements.whoCanEnter.value,
        whitelist: form.elements.whitelist.checked,
        groupIds: splitIds(form.elements.groupIds.value),
        contributorLevel: clamp(Number(form.elements.contributorLevel.value) || 0, 0, 10),
        regionFromHumble: form.elements.regionFromHumble.checked,
        regionRestricted: form.elements.regionRestricted.checked,
        countryIds: splitIds(form.elements.countryIds.value),
        description: form.elements.description.value,
        autoSubmit: form.elements.autoSubmit.checked,
        autoSubmitDelaySeconds: clamp(
          Number(form.elements.autoSubmitDelaySeconds.value) || 15,
          3,
          120
        ),
      };
      await call({ type: MSG.SET_SETTINGS, patch });
      await refresh();
    })
  );

  // Filteren gebeurt lokaal; niet elke toetsaanslag hoeft langs de service worker.
  ui.catalogFilter.addEventListener('input', () => renderCatalog());

  // De service worker kan zonder ons de wachtrij bijwerken (bijv. wanneer een
  // giveaway is aangemaakt), dus meeluisteren op storage in plaats van pollen.
  let refreshTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' && area !== 'session') return;
    // Bundelen: één wachtrij-actie kan meerdere schrijfacties opleveren, en
    // hertekenen tijdens een klik kost je die klik.
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh().catch(() => {}), 250);
  });

  refresh().catch((error) => showNotice(String(error.message || error), 'error'));
})();
