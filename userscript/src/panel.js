/**
 * Het paneel op de pagina. Vervangt het zijpaneel van de extensieversie.
 *
 * Het hangt in een shadow root, dus de opmaak van Humble en SteamGifts kan er
 * niet bij en andersom evenmin — dat was bij de extensie gratis en moet hier
 * bewust geregeld worden.
 *
 * Elke site registreert zichzelf via `HSG.site`; het paneel weet verder niets
 * van Humble of SteamGifts en toont alleen wat die site aanbiedt.
 */
'use strict';

(function (root) {
  const HSG = (root.HSG = root.HSG || {});
  const STATUS_LABEL = {
    pending: 'wacht',
    filled: 'ingevuld',
    'needs-choice': 'keuze nodig',
    done: 'klaar',
    error: 'fout',
  };

  const local = { selected: new Set(), tab: 'queue', catalogSignature: null, filter: '' };
  let ui = null;
  let launcher = null;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  // --- opbouw -----------------------------------------------------------------

  const MARKUP = `
<div class="wrap" hidden>
  <header>
    <h1>Humble → SteamGifts</h1>
    <button type="button" class="btn btn--icon" data-action="close" title="Sluiten">✕</button>
  </header>
  <p class="summary" data-role="summary"></p>
  <nav class="tabs">
    <button type="button" class="tab is-active" data-tab="queue">Wachtrij</button>
    <button type="button" class="tab" data-tab="catalog">Keys</button>
    <button type="button" class="tab" data-tab="settings">Instellingen</button>
    <button type="button" class="tab" data-tab="diagnose">Diagnose</button>
  </nav>
  <div class="body">
    <p class="notice" data-role="notice" hidden></p>

    <section class="panel is-active" data-panel="queue">
      <div class="actions">
        <button type="button" class="btn btn--primary" data-action="start">Start</button>
        <button type="button" class="btn" data-action="pause">Pauze</button>
        <button type="button" class="btn btn--danger" data-action="clear-queue">Leegmaken</button>
      </div>
      <div class="hint" data-role="steamdb-status" hidden></div>
      <ol data-role="queue"></ol>
      <p class="empty" data-role="queue-empty">
        Nog niets in de wachtrij. Ga naar je Humble keys-pagina en vink daar spellen aan.
      </p>
    </section>

    <section class="panel" data-panel="catalog">
      <div class="actions">
        <button type="button" class="btn" data-action="scan">Deze pagina scannen</button>
        <button type="button" class="btn" data-action="scan-library">Hele bibliotheek</button>
        <button type="button" class="btn" data-action="select-all">Alles</button>
        <button type="button" class="btn" data-action="select-none">Niets</button>
      </div>
      <p class="hint" data-role="catalog-hint"></p>
      <input type="search" class="filter" data-role="filter" placeholder="Zoek spel of bundel…" />
      <ul data-role="catalog"></ul>
      <div class="actions">
        <button type="button" class="btn btn--primary" data-action="add-selected" disabled>
          Voeg toe aan wachtrij
        </button>
      </div>
    </section>

    <section class="panel" data-panel="settings">
      <form data-role="settings">
        <fieldset>
          <legend>Looptijd</legend>
          <label class="row">Start over (minuten)
            <input type="number" name="startOffsetMinutes" min="1" max="1440" /></label>
          <label class="row">Looptijd (dagen)
            <input type="number" name="durationDays" min="1" max="60" /></label>
          <p class="hint" data-role="schedule"></p>
        </fieldset>
        <fieldset>
          <legend>Wie mag meedoen</legend>
          <label class="row">Toegang
            <select name="whoCanEnter">
              <option value="everyone">Iedereen</option>
              <option value="invite_only">Alleen op uitnodiging</option>
              <option value="groups">Groepen / whitelist</option>
            </select></label>
          <label class="check"><input type="checkbox" name="whitelist" /> Mijn whitelist meenemen</label>
          <label class="row">Groep-id's (spatiegescheiden)
            <input type="text" name="groupIds" placeholder="bijv. 207 4979" /></label>
          <label class="row">Minimum contributor level
            <input type="number" name="contributorLevel" min="0" max="10" /></label>
          <p class="hint">De id's vind je via Diagnose → SteamGifts.</p>
        </fieldset>
        <fieldset>
          <legend>Regio</legend>
          <label class="check"><input type="checkbox" name="regionFromHumble" /> Regio automatisch overnemen</label>
          <label class="check"><input type="checkbox" name="steamdbRegion" /> Regio via SteamDB controleren</label>
          <p class="hint">
            SteamDB toont wat het Steam-pakket zelf toestaat en is leidend;
            meldt SteamDB niets bruikbaars, dan gelden Humble's gegevens. De
            controle leest bij het toevoegen kort een paar pagina's op
            steamdb.info via een achtergrondtabblad. Aangevinkt land = mag
            meedoen.
          </p>
          <label class="check"><input type="checkbox" name="regionRestricted" /> Anders: vaste regio-restrictie</label>
          <label class="row">Landcodes (spatiegescheiden)
            <input type="text" name="countryIds" placeholder="bijv. NL BE DE" /></label>
        </fieldset>
        <fieldset>
          <legend>Overig</legend>
          <label class="row">Aantal kopieën <input type="number" name="copies" min="1" max="100" /></label>
          <label class="row">Beschrijving (optioneel) <textarea name="description" rows="3"></textarea></label>
        </fieldset>
        <fieldset>
          <legend>Verzenden</legend>
          <label class="check"><input type="checkbox" name="autoSubmit" /> Automatisch verzenden</label>
          <p class="hint hint--warn">
            Uit betekent: alles wordt ingevuld en jij drukt op verzenden.
          </p>
          <label class="row">Aftellen voor verzenden (seconden)
            <input type="number" name="autoSubmitDelaySeconds" min="3" max="120" /></label>
        </fieldset>
        <fieldset>
          <legend>Keys bewaren</legend>
          <label class="row">Vervallen na (uren)
            <input type="number" name="keyTtlHours" min="1" max="168" /></label>
          <p class="hint">
            Anders dan de extensie bewaart Tampermonkey opgeslagen waarden op
            schijf. Opgehaalde keys verdwijnen daarom vanzelf, en sowieso zodra
            ze geplakt zijn.
          </p>
        </fieldset>
      </form>
    </section>

    <section class="panel" data-panel="diagnose">
      <p class="hint">
        Controleert of de velden op deze site nog herkend worden. Leest alleen;
        wijzigt niets en onthult geen keys.
      </p>
      <div class="actions">
        <button type="button" class="btn" data-action="diagnose">Deze pagina controleren</button>
        <button type="button" class="btn btn--danger" data-action="clear-keys">Wis opgeslagen keys</button>
        <button type="button" class="btn" data-action="clear-steamdb">Wis SteamDB-cache</button>
      </div>
      <div data-role="diagnostics"></div>
    </section>
  </div>
</div>`;

  function mount() {
    if (ui) return ui;

    GM_addStyle(HSG.PAGE_CSS);

    launcher = el('button', 'hsg-launcher');
    launcher.type = 'button';
    launcher.append(el('span', null, 'Humble → SteamGifts'));
    launcher.append(el('span', 'hsg-launcher__count', '0'));
    launcher.addEventListener('click', () => toggle());
    document.body.appendChild(launcher);

    const host = el('div');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = HSG.PANEL_CSS;
    shadow.append(style);
    const holder = el('div');
    holder.innerHTML = MARKUP;
    shadow.append(holder.firstElementChild);
    document.body.appendChild(host);

    const q = (selector) => shadow.querySelector(selector);
    ui = {
      shadow,
      wrap: q('.wrap'),
      summary: q('[data-role="summary"]'),
      notice: q('[data-role="notice"]'),
      queue: q('[data-role="queue"]'),
      queueEmpty: q('[data-role="queue-empty"]'),
      steamdbStatus: q('[data-role="steamdb-status"]'),
      catalog: q('[data-role="catalog"]'),
      catalogHint: q('[data-role="catalog-hint"]'),
      filter: q('[data-role="filter"]'),
      settings: q('[data-role="settings"]'),
      schedule: q('[data-role="schedule"]'),
      diagnostics: q('[data-role="diagnostics"]'),
    };

    shadow.addEventListener('click', onClick);
    ui.settings.addEventListener('change', onSettingsChange);
    ui.filter.addEventListener('input', () => {
      local.filter = ui.filter.value;
      renderCatalog();
    });

    // Wat de andere tab doet moet hier zichtbaar worden: de SteamGifts-pagina
    // schuift de wachtrij op terwijl dit paneel op Humble openstaat.
    HSG.store.onChange(HSG.store.NAMES.QUEUE, () => render());
    HSG.store.onChange(HSG.store.NAMES.CATALOG, () => render());
    HSG.store.onChange(HSG.store.NAMES.STEAMDB_JOBS, () => render());
    HSG.store.onChange(HSG.store.NAMES.STEAMDB_RESULTS, () => render());

    render();
    return ui;
  }

  function toggle(open) {
    const shouldOpen = open == null ? ui.wrap.hidden : open;
    ui.wrap.hidden = !shouldOpen;
    if (shouldOpen) render();
  }

  // --- tekenen ----------------------------------------------------------------

  function render() {
    if (!ui) return;
    const queue = HSG.store.getQueue();
    const summary = HSG.summarize(queue);

    const parts = [`${summary.total} in de wachtrij`];
    if (summary.done) parts.push(`${summary.done} klaar`);
    if (summary.error) parts.push(`${summary.error} fout`);
    if (summary.needsChoice) parts.push(`${summary.needsChoice} keuze nodig`);
    parts.push(queue.running ? 'bezig' : 'gepauzeerd');
    ui.summary.textContent = parts.join(' · ');

    if (launcher) {
      const open = summary.total - summary.done;
      launcher.lastElementChild.textContent = String(open);
    }

    renderQueue(queue);
    renderCatalog();
    renderSettings();
  }

  function renderQueue(queue) {
    ui.queue.textContent = '';
    ui.queueEmpty.hidden = queue.items.length > 0;
    const keyIds = new Set(HSG.store.keyIds());
    renderSteamdbStatus();

    queue.items.forEach((item, index) => {
      const li = el('li', 'queue-item');
      if (index === queue.cursor && queue.running) li.classList.add('is-current');

      const head = el('div', 'queue-head');
      head.append(el('span', 'queue-name', item.humanName));
      const status = el('span', 'status', STATUS_LABEL[item.status] || item.status);
      status.dataset.status = item.status;
      head.append(status);
      li.append(head);

      const bits = [];
      if (item.sgGameName) bits.push(`SteamGifts: ${item.sgGameName}`);
      else if (item.steamAppId) bits.push(`appid ${item.steamAppId}`);
      const steamdbLabel = HSG.describeSteamdbStatus(
        HSG.store.getSteamdbResult(item.id) || item.steamdb
      );
      if (steamdbLabel) bits.push(steamdbLabel);
      if (item.error) bits.push(item.error);
      if (item.giveawayUrl) bits.push(item.giveawayUrl);
      if (!keyIds.has(item.id) && item.status !== 'done') bits.push('geen key meer opgeslagen');
      if (bits.length) li.append(el('div', 'queue-meta', bits.join(' — ')));

      if (item.status === 'needs-choice' && item.candidates) {
        const wrap = el('div', 'queue-tools');
        for (const candidate of item.candidates) {
          wrap.append(
            toolButton(candidate.name, () => {
              HSG.store.withQueue((current) => {
                const next = HSG.updateItem(current, item.id, {
                  sgGameId: candidate.id,
                  sgGameName: candidate.name,
                  status: HSG.STATUS.PENDING,
                  candidates: null,
                  error: null,
                });
                const at = next.items.findIndex((entry) => entry.id === item.id);
                return { queue: { ...next, cursor: at === -1 ? next.cursor : at, running: true } };
              });
              openSteamGifts();
            })
          );
        }
        li.append(wrap);
      }

      const tools = el('div', 'queue-tools');
      tools.append(
        toolButton('↑', () => HSG.store.withQueue((q) => HSG.moveItem(q, item.id, -1))),
        toolButton('↓', () => HSG.store.withQueue((q) => HSG.moveItem(q, item.id, 1))),
        toolButton('Opnieuw', () => HSG.store.withQueue((q) => HSG.retryItem(q, item.id))),
        toolButton('Verwijder', () => {
          HSG.store.forgetKey(item.id);
          HSG.store.withQueue((q) => HSG.removeItem(q, item.id));
        })
      );
      li.append(tools);
      ui.queue.append(li);
    });
  }

  /** Loopt de SteamDB-regiocontrole nog, of wacht die op een Cloudflare-check? */
  function renderSteamdbStatus() {
    const node = ui.steamdbStatus;
    if (!node) return;
    const jobs = HSG.steamdb && HSG.steamdb.jobsSummary ? HSG.steamdb.jobsSummary() : null;
    if (!jobs) {
      node.hidden = true;
      node.textContent = '';
      return;
    }
    node.hidden = false;
    node.textContent = '';
    const retry = () =>
      toolButton('Opnieuw proberen', () => {
        if (!HSG.steamdb.retryLookups()) throw new Error('Geen openstaande controles.');
      });
    if (jobs.status === 'challenge') {
      node.append(
        el(
          'span',
          null,
          'SteamDB vraagt om een controle voordat de regiocheck verder kan. Los die op in het SteamDB-tabblad (of open steamdb.info) en probeer opnieuw. '
        ),
        retry()
      );
    } else if (jobs.stalled) {
      node.append(
        el(
          'span',
          null,
          `De SteamDB-regiocontrole ligt stil (${jobs.open} spel${jobs.open === 1 ? '' : 'len'} open) — het werktabblad is waarschijnlijk gesloten. `
        ),
        retry()
      );
    } else {
      node.append(
        el(
          'span',
          null,
          `SteamDB-regiocontrole loopt nog voor ${jobs.open} spel${jobs.open === 1 ? '' : 'len'}…`
        )
      );
    }
  }

  function toolButton(label, action) {
    const button = el('button', 'btn btn--tiny', label);
    button.type = 'button';
    button.addEventListener('click', () => {
      try {
        action();
        render();
      } catch (error) {
        notice(String(error.message || error), 'error');
      }
    });
    return button;
  }

  function renderCatalog() {
    const catalog = HSG.store.getCatalog();
    if (!catalog || !catalog.games || catalog.games.length === 0) {
      ui.catalog.textContent = '';
      local.catalogSignature = 'leeg';
      ui.catalogHint.textContent =
        'Nog geen catalogus. Open je Humble keys-pagina (/home/keys of de downloadpagina van de bundel) en klik op "Deze pagina scannen".';
      updateAddButton();
      return;
    }

    const queue = HSG.store.getQueue();
    const queued = new Set(
      queue.items.filter((item) => item.status !== 'error').map((item) => item.id)
    );

    const hints = [`${catalog.games.length} spellen gevonden.`];
    if (catalog.bundles && catalog.bundles.length) {
      hints.push(`Bundels: ${catalog.bundles.slice(0, 4).join(', ')}.`);
    }
    if (catalog.source === 'dom') hints.push('Zonder Steam-appid — er wordt op titel gezocht.');
    if (catalog.truncatedOrders) hints.push(`${catalog.truncatedOrders} bundel(s) niet opgehaald.`);
    if (catalog.apiError) hints.push(`API-aanvulling mislukt: ${catalog.apiError}`);
    ui.catalogHint.textContent = hints.join(' ');

    const needle = HSG.normalizeTitle(local.filter || '');
    const visible = needle
      ? catalog.games.filter((game) =>
          HSG.normalizeTitle(`${game.humanName} ${game.bundleName || ''}`).includes(needle)
        )
      : catalog.games;

    // Niet hertekenen als er niets veranderd is: dit paneel ververst op elke
    // opslagwijziging, en dan verdween het vinkje onder je muis.
    const signature = [
      needle,
      visible.length,
      visible
        .map((g) => `${g.id}${g.revealed ? 'r' : ''}${g.unavailable ? 'u' : ''}${queued.has(g.id) ? 'q' : ''}`)
        .join(','),
    ].join('|');
    if (signature === local.catalogSignature) {
      updateAddButton();
      return;
    }
    local.catalogSignature = signature;
    ui.catalog.textContent = '';

    if (visible.length === 0) {
      ui.catalog.append(el('li', 'empty', 'Niets gevonden met deze zoekterm.'));
    }

    visible.forEach((game, index) => {
      const li = el('li', 'item');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = `hsg-cat-${index}`;
      input.checked = local.selected.has(game.id);
      input.disabled = queued.has(game.id) || Boolean(game.unavailable);
      input.addEventListener('change', () => {
        if (input.checked) local.selected.add(game.id);
        else local.selected.delete(game.id);
        updateAddButton();
      });

      const label = el('label', null, game.humanName);
      label.htmlFor = input.id;

      const tags = [];
      if (game.bundleName) tags.push(game.bundleName);
      const expiry = HSG.readExpiry(game.expiry);
      if (expiry) {
        const days = HSG.daysUntil(HSG.safeDeadline(expiry));
        tags.push(days <= 0 ? 'verlopen' : `verloopt over ${days} dag${days === 1 ? '' : 'en'}`);
      }
      if (game.unavailable) tags.push('niet meer beschikbaar bij Humble');
      if (queued.has(game.id)) tags.push('staat al in de wachtrij');
      if (game.revealed) tags.push('key al onthuld');
      if (!game.steamAppId) tags.push('geen appid — zoekt op titel');
      if (game.keyType && game.keyType !== 'steam') tags.push(`platform: ${game.keyType}`);
      if (tags.length) {
        label.append(document.createElement('br'), el('span', 'tag', tags.join(' · ')));
      }

      li.append(input, label);
      ui.catalog.append(li);
    });
    updateAddButton();
  }

  function updateAddButton() {
    const button = ui.shadow.querySelector('[data-action="add-selected"]');
    button.disabled = local.selected.size === 0;
    button.textContent =
      local.selected.size > 0
        ? `Voeg ${local.selected.size} toe aan wachtrij`
        : 'Voeg toe aan wachtrij';
  }

  function renderSettings() {
    const form = ui.settings;
    if (form.contains(form.getRootNode().activeElement)) return;
    const settings = HSG.store.getSettings();
    for (const [name, value] of Object.entries(settings)) {
      const field = form.elements[name];
      if (!field) continue;
      if (field.type === 'checkbox') field.checked = Boolean(value);
      else if (Array.isArray(value)) field.value = value.join(' ');
      else field.value = value;
    }
    const schedule = HSG.computeSchedule(settings, new Date());
    ui.schedule.textContent = `Nu zou dat worden: ${schedule.startText} → ${schedule.endText}`;
  }

  function renderDiagnostics(report) {
    ui.diagnostics.textContent = '';
    if (!report) return;
    if (report.error) {
      ui.diagnostics.append(el('p', 'hint', report.error));
      return;
    }
    for (const check of report.checks || []) {
      const row = el('div', `check-row ${check.ok ? 'is-ok' : 'is-bad'}`);
      row.append(el('span', 'check-row__mark', check.ok ? '✓' : '✕'));
      const body = el('div', 'check-row__body', check.label);
      if (check.detail) body.append(el('span', 'check-row__detail', check.detail));
      row.append(body);
      ui.diagnostics.append(row);
    }
  }

  function notice(text, tone) {
    if (!text) {
      ui.notice.hidden = true;
      return;
    }
    ui.notice.hidden = false;
    ui.notice.textContent = text;
    ui.notice.dataset.tone = tone || 'warn';
  }

  // --- acties -----------------------------------------------------------------

  function openSteamGifts() {
    if (location.host === 'www.steamgifts.com') {
      location.href = HSG.URLS.SG_NEW_GIVEAWAY;
    } else {
      GM_openInTab(HSG.URLS.SG_NEW_GIVEAWAY, { active: true, setParent: true });
    }
  }

  const ACTIONS = {
    close: () => toggle(false),

    start: () => {
      const queue = HSG.store.getQueue();
      const at = queue.items.findIndex(
        (item) => item.status !== 'done' && item.status !== 'error'
      );
      if (at === -1) throw new Error('Er staat niets meer klaar in de wachtrij.');
      HSG.store.setQueue({ ...queue, cursor: at, running: true });
      openSteamGifts();
    },

    pause: () => HSG.store.withQueue((queue) => ({ ...queue, running: false })),

    'clear-queue': () => {
      if (!confirm('De hele wachtrij en de opgeslagen keys wissen?')) return;
      HSG.store.clearKeys();
      HSG.store.setQueue(HSG.emptyQueue());
    },

    scan: async () => {
      requireSite('humble');
      notice('Scannen…', 'ok');
      await HSG.site.scan('page');
      notice('');
    },

    'scan-library': async () => {
      requireSite('humble');
      notice('Hele bibliotheek ophalen — dit kan even duren…', 'ok');
      await HSG.site.scan('library');
      notice('');
    },

    'select-all': () => {
      const catalog = HSG.store.getCatalog();
      const queue = HSG.store.getQueue();
      const queued = new Set(
        queue.items.filter((item) => item.status !== 'error').map((item) => item.id)
      );
      for (const game of (catalog && catalog.games) || []) {
        if (!queued.has(game.id) && !game.unavailable) local.selected.add(game.id);
      }
      local.catalogSignature = null;
      if (HSG.site && HSG.site.syncSelection) HSG.site.syncSelection();
    },

    'select-none': () => {
      local.selected.clear();
      local.catalogSignature = null;
      if (HSG.site && HSG.site.syncSelection) HSG.site.syncSelection();
    },

    'add-selected': async () => {
      requireSite('humble');
      const ids = Array.from(local.selected);
      if (ids.length === 0) return;
      // Onthullen kost bij Humble de gift-link-optie en is niet terug te draaien.
      if (ids.length > 25 && !confirm(`${ids.length} keys ophalen bij Humble. Doorgaan?`)) return;

      notice(`Keys ophalen voor ${ids.length} ${ids.length === 1 ? 'spel' : 'spellen'}…`, 'ok');
      const results = await HSG.site.revealKeys(ids);
      const outcome = HSG.storeRevealResults(results);
      // Regiocontrole bij SteamDB: uit de cache wat kan, de rest via het
      // werktabblad. Loopt op de achtergrond door; de wachtrij toont de stand.
      if (HSG.steamdb) HSG.steamdb.enqueueLookups(results);
      local.selected.clear();
      local.catalogSignature = null;
      notice(
        outcome.failed
          ? `${outcome.added} toegevoegd, ${outcome.failed} mislukt — zie de wachtrij.`
          : `${outcome.added} toegevoegd aan de wachtrij.`,
        outcome.failed ? 'warn' : 'ok'
      );
    },

    diagnose: async () => {
      if (!HSG.site || !HSG.site.diagnose) {
        throw new Error('Op deze pagina valt niets te controleren.');
      }
      renderDiagnostics(await HSG.site.diagnose());
    },

    'clear-keys': () => {
      if (!confirm('Alle opgeslagen keys wissen? De wachtrij blijft staan.')) return;
      HSG.store.clearKeys();
    },

    'clear-steamdb': () => {
      const stats = HSG.store.steamdbCacheStats();
      if (
        !confirm(
          `De SteamDB-cache wissen (${stats.subs} pakket(ten), ${stats.apps} app(s))? Bij de volgende controle worden de pagina's opnieuw gelezen.`
        )
      ) {
        return;
      }
      HSG.store.clearSteamdbCache();
      HSG.store.clearSteamdbResults();
      HSG.store.setSteamdbJobs(null);
      notice('SteamDB-cache gewist.', 'ok');
    },
  };

  function requireSite(name) {
    if (!HSG.site || HSG.site.name !== name) {
      throw new Error(
        name === 'humble'
          ? 'Dit werkt alleen op je Humble keys-pagina.'
          : `Dit werkt alleen op ${name}.`
      );
    }
  }

  async function onClick(event) {
    const tab = event.target.closest && event.target.closest('[data-tab]');
    if (tab) {
      local.tab = tab.dataset.tab;
      ui.shadow.querySelectorAll('.tab').forEach((node) => node.classList.remove('is-active'));
      ui.shadow.querySelectorAll('.panel').forEach((node) => node.classList.remove('is-active'));
      tab.classList.add('is-active');
      ui.shadow.querySelector(`[data-panel="${local.tab}"]`).classList.add('is-active');
      return;
    }

    const target = event.target.closest && event.target.closest('[data-action]');
    if (!target) return;
    const action = ACTIONS[target.dataset.action];
    if (!action) return;

    try {
      notice('');
      await action();
      render();
    } catch (error) {
      notice(String(error.message || error), 'error');
    }
  }

  function onSettingsChange() {
    const form = ui.settings;
    const number = (name, fallback) => Number(form.elements[name].value) || fallback;
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const ids = (name) =>
      String(form.elements[name].value || '').trim().split(/\s+/).filter(Boolean);

    HSG.store.setSettings({
      startOffsetMinutes: number('startOffsetMinutes', 5),
      durationDays: number('durationDays', 7),
      copies: number('copies', 1),
      whoCanEnter: form.elements.whoCanEnter.value,
      whitelist: form.elements.whitelist.checked,
      groupIds: ids('groupIds'),
      contributorLevel: clamp(number('contributorLevel', 0), 0, 10),
      regionFromHumble: form.elements.regionFromHumble.checked,
      steamdbRegion: form.elements.steamdbRegion.checked,
      regionRestricted: form.elements.regionRestricted.checked,
      countryIds: ids('countryIds'),
      description: form.elements.description.value,
      autoSubmit: form.elements.autoSubmit.checked,
      autoSubmitDelaySeconds: clamp(number('autoSubmitDelaySeconds', 15), 3, 120),
      keyTtlHours: clamp(number('keyTtlHours', 12), 1, 168),
    });
    render();
  }

  /**
   * De selectie wordt op twee plekken bediend: de vinkjes in de key-rijen op de
   * pagina en de lijst in dit paneel. Eén Set, zodat ze niet uit elkaar lopen.
   */
  function setSelected(id, on) {
    if (on) local.selected.add(id);
    else local.selected.delete(id);
    // Bewust niet de hele lijst hertekenen: dat is precies wat het aanvinken
    // eerder onmogelijk maakte.
    if (ui) updateAddButton();
    if (HSG.site && HSG.site.syncSelection) HSG.site.syncSelection();
  }

  HSG.panel = {
    mount,
    toggle,
    render,
    notice,
    setSelected,
    selection: local.selected,
    isSelected: (id) => local.selected.has(id),
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
