/**
 * De SteamGifts-kant: het nieuwe-giveawayformulier invullen en de wachtrij
 * opschuiven zodra een giveaway bestaat.
 *
 * Geport uit de extensieversie. De tab-boekhouding van toen is verdwenen: hier
 * navigeert de pagina zichzelf naar het volgende formulier.
 */
'use strict';

(function (root) {
  const HSG = (root.HSG = root.HSG || {});
  const SG = HSG.SELECTORS.steamgifts;
  const q = (selector, scope) => (scope || document).querySelector(selector);

  const isNewGiveawayPage = () => location.pathname.startsWith('/giveaways/new');
  const isCreatedGiveawayPage = () => /^\/giveaway\/[^/]+\//.test(location.pathname);
  /** Op de review-stap rendert SteamGifts het formulier zonder invoervelden. */
  const isReviewStep = () => isNewGiveawayPage() && !q(SG.gameId);

  // --- spel opzoeken ----------------------------------------------------------

  async function searchGames(query) {
    const response = await fetch('/ajax.php', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams({
        do: 'autocomplete_giveaway_game',
        page_number: '1',
        search_query: String(query),
      }),
    });
    if (!response.ok) throw new Error(`SteamGifts antwoordde met ${response.status}`);

    const data = await response.json();
    if (!data || !data.html) return [];
    const doc = new DOMParser().parseFromString(data.html, 'text/html');
    return Array.from(doc.querySelectorAll(SG.autocompleteRow))
      .map((row) => ({
        id: row.getAttribute('data-autocomplete-id'),
        name: row.getAttribute('data-autocomplete-name'),
      }))
      .filter((row) => row.id && row.name);
  }

  /**
   * Eerst op Steam-appid; die is eenduidig. Ontbreekt die — Humble laat
   * `steam_app_id` regelmatig leeg — dan op titel, en bij twijfel vragen we het
   * liever dan te gokken.
   */
  async function resolveGame(item) {
    if (item.sgGameId) {
      return { match: { id: item.sgGameId, name: item.sgGameName || item.humanName } };
    }
    if (item.steamAppId) {
      const rows = await searchGames(item.steamAppId);
      const byAppId = HSG.pickGameMatch(rows, item.humanName);
      if (byAppId.match) return byAppId;
      if (rows.length === 1) return { match: rows[0] };
    }
    return HSG.pickGameMatch(await searchGames(item.humanName), item.humanName);
  }

  // --- formulier vullen -------------------------------------------------------

  function fillGame(gameId, gameName) {
    const hidden = q(SG.gameId);
    if (!hidden) throw new Error('Veld game_id niet gevonden op het formulier.');
    HSG.setNativeValue(hidden, gameId);
    const visible = q(SG.gameNameInput) || hidden.nextElementSibling;
    if (visible && 'value' in visible) HSG.setNativeValue(visible, gameName);
  }

  /**
   * Klikt een keuze-widget aan, maar alleen als hij nog niet die waarde heeft:
   * blind klikken kan een al gekozen optie juist weer uitzetten.
   */
  function selectOption(hiddenSelector, value) {
    const hidden = q(hiddenSelector);
    if (hidden && String(hidden.value) === String(value)) return true;

    // "0" en "1" komen in meerdere rijen voor, dus zoeken binnen de rij van het
    // bijbehorende verborgen veld.
    const scope = hidden && (hidden.closest('.form__row') || hidden.parentElement);
    const widget =
      (scope && q(HSG.checkboxValue(value), scope)) || q(HSG.checkboxValue(value));

    if (widget) {
      HSG.clickWidget(widget);
      if (!hidden || String(hidden.value) === String(value)) return true;
    }
    if (hidden) {
      HSG.setNativeValue(hidden, value);
      return Boolean(widget);
    }
    return false;
  }

  function fillDate(selector, text) {
    const input = q(selector);
    if (!input) return false;
    HSG.setNativeValue(input, text);
    const sibling = input.previousElementSibling;
    if (sibling && sibling.classList && sibling.classList.contains('hasDatepicker')) {
      HSG.setNativeValue(sibling, text);
    }
    return true;
  }

  /** De slider is jQuery UI; we zetten het veld en trekken de visuele staat na. */
  function fillLevel(level) {
    const hidden = q(SG.contributorLevel);
    if (!hidden) return;
    HSG.setNativeValue(hidden, String(level));

    const range = q(SG.levelSliderRange);
    if (range) range.style.width = `${level * 10}%`;
    const handle = q(SG.levelSliderHandle);
    if (handle) handle.style.left = `${level * 10}%`;
    const label = q(SG.levelLabel);
    if (label) label.textContent = `level ${level}`;

    const withLevel = q(SG.levelDescription);
    const withoutLevel = q(SG.noLevelDescription);
    if (withLevel && withoutLevel) {
      withLevel.classList.toggle('is-hidden', level === 0);
      withoutLevel.classList.toggle('is-hidden', level !== 0);
    }
  }

  /**
   * De regio. Op SteamGifts betekent aangevinkt "mag meedoen". Welke bron dat
   * bepaalt beslist `HSG.regionPlan`: verse SteamDB-pakketdata is leidend,
   * daarna Humble's `disallowed_countries`/`exclusive_countries`, daarna je
   * vaste instelling. Zie HSG.allowedCountries voor de omkering.
   */
  async function fillRegion(item, settings) {
    const plan = HSG.regionPlan(item, settings);
    const notes = plan.notes.slice();

    if (plan.mode === 'off' || plan.mode === 'none') {
      if (!selectOption(SG.regionRestricted, '0')) notes.push('Regio-optie niet gevonden.');
      return notes;
    }

    if (plan.mode === 'fixed') {
      if (!selectOption(SG.regionRestricted, '1')) {
        notes.push('Regio-optie niet gevonden.');
        return notes;
      }
      const list = await HSG.waitForElement(SG.countryList, { timeout: 5000 }).catch(() => null);
      if (!list) {
        notes.push('Landenlijst niet gevonden.');
        return notes;
      }
      const byCode = new Map(
        HSG.readItemList(list, 0)
          .filter((entry) => entry.code)
          .map((entry) => [entry.code.toUpperCase(), entry.id])
      );
      const wanted = (settings.countryIds || [])
        .map((code) => byCode.get(String(code).toUpperCase()))
        .filter(Boolean);
      HSG.syncItemList(list, wanted, 0);
      if (wanted.length !== (settings.countryIds || []).length) {
        notes.push('Niet alle landcodes uit je instellingen zijn herkend.');
      }
      return notes;
    }

    // 'steamdb' of 'humble': de bronlijsten omkeren naar de toestemmingslijst.
    const source =
      plan.mode === 'steamdb'
        ? `SteamDB${
            item.steamdb && (item.steamdb.subIds || []).length
              ? ` (pakket ${item.steamdb.subIds.join(', ')})`
              : ''
          }`
        : 'Humble';

    if (!selectOption(SG.regionRestricted, '1')) {
      notes.push('Regio-optie niet gevonden — zet de restrictie zelf aan.');
    }

    const list = await HSG.waitForElement(SG.countryList, { timeout: 5000 }).catch(() => null);
    if (!list) {
      notes.push('Landenlijst niet gevonden; stel de regio zelf in.');
      return notes;
    }

    const available = HSG.readItemList(list, 0);
    const { allowedIds, blockedCodes, unknownCodes, unmapped } = HSG.allowedCountries(
      available,
      plan.disallowed,
      plan.exclusive || []
    );

    // Sluit dit niets uit, dan zou "beperken" alles toestaan — misleidender dan
    // geen restrictie.
    if (blockedCodes.length === 0) {
      selectOption(SG.regionRestricted, '0');
      notes.push(
        `${source} noemt landen, maar geen daarvan komt voor in de lijst van SteamGifts. Regio-restrictie uit gelaten — stel dit zelf in.`
      );
      return notes;
    }

    HSG.syncItemList(list, allowedIds, 0);
    notes.push(
      plan.exclusive && plan.exclusive.length
        ? `${source}: deze key werkt alleen in ${plan.exclusive.length} landen; ${allowedIds.length} daarvan staan aangevinkt (aangevinkt = mag meedoen).`
        : `Regio overgenomen van ${source}: ${allowedIds.length} landen aangevinkt en dus toegestaan, ${blockedCodes.length} uitgezet.`
    );
    if (unknownCodes.length) {
      notes.push(`${unknownCodes.length} landcode(s) kent SteamGifts niet (${unknownCodes.slice(0, 6).join(', ')}).`);
    }
    if (unmapped.length) {
      notes.push(`${unmapped.length} land(en) zonder leesbare landcode.`);
    }
    return notes;
  }

  /**
   * De SteamDB-regiocontrole draait in een ander tabblad en kan nog bezig zijn
   * als dit formulier al opent. Even wachten is beter dan invullen met data
   * die tien seconden later alsnog binnenkomt.
   */
  async function waitForSteamdb(item, settings) {
    if (settings.steamdbRegion === false) return item;
    let current = item;
    for (let round = 0; round < 10; round += 1) {
      if (!current.steamdb || current.steamdb.status !== 'pending') break;
      if (round === 0) {
        HSG.panel.notice(`${item.humanName} — wachten op de SteamDB-regiocontrole…`, 'ok');
      }
      await HSG.sleep(2000);
      const queue = HSG.store.getQueue();
      current = queue.items.find((entry) => entry.id === item.id) || current;
    }
    return current;
  }

  async function fillForm(item, key, settings, resolved) {
    const notes = [];

    fillGame(resolved.id, resolved.name);
    if (!selectOption(SG.type, 'key')) notes.push('Kon het type niet op "key" zetten.');
    await HSG.waitForElement(SG.keyString, { timeout: 5000 }).catch(() => null);

    const copies = q(SG.copies);
    if (copies) HSG.setNativeValue(copies, String(settings.copies || 1));

    // De uiterste inwisseldatum is een harde bovengrens: een giveaway die later
    // eindigt levert de winnaar een dode key.
    const expiry = HSG.readExpiry(item.expiry);
    const schedule = HSG.computeSchedule(settings, new Date(), HSG.safeDeadline(expiry));

    if (schedule.impossible) {
      throw new Error(
        `Deze key verloopt te snel (${HSG.describeDeadline(expiry)}) — er past geen giveaway van een uur meer voor.`
      );
    }
    if (!fillDate(SG.startTime, schedule.startText)) notes.push('Starttijd niet gevonden.');
    if (!fillDate(SG.endTime, schedule.endText)) notes.push('Eindtijd niet gevonden.');
    if (schedule.cappedBy === 'deadline') {
      notes.push('Looptijd ingekort tot een week voor de key verloopt.');
    } else if (schedule.cappedBy === 'minimum') {
      notes.push('De key verloopt bijna: giveaway staat op het minimum van 1 uur.');
    } else if (schedule.cappedBy === 'maxRange') {
      notes.push('Looptijd ingekort tot de 30 dagen die SteamGifts toestaat.');
    }

    notes.push(...(await fillRegion(item, settings)));

    if (!selectOption(SG.whoCanEnter, settings.whoCanEnter)) {
      notes.push('Optie "wie mag meedoen" niet gevonden.');
    }
    if (settings.whoCanEnter === 'groups') {
      const list = await HSG.waitForElement(SG.groupList, { timeout: 5000 }).catch(() => null);
      // "My Whitelist" is de eerste rij, heeft geen data-item-id en hoort bij
      // een apart veld. Aanklikken, zodat de zichtbare staat klopt.
      const whitelistItem = q(SG.whitelistItem);
      const whitelistOn = Boolean(settings.whitelist);
      if (whitelistItem) {
        if (whitelistItem.classList.contains('is-selected') !== whitelistOn) {
          HSG.clickWidget(whitelistItem);
        }
      } else {
        const whitelist = q(SG.whitelist);
        if (whitelist) HSG.setNativeValue(whitelist, whitelistOn ? '1' : '0');
      }
      const result = HSG.syncItemList(list, settings.groupIds || [], 1);
      if (!list) notes.push('Groepenlijst niet gevonden.');
      else if (result.missing.length) notes.push(`Onbekende groep(en): ${result.missing.join(', ')}`);
    }

    fillLevel(Number(settings.contributorLevel) || 0);

    // De deadline hoort in de beschrijving: de winnaar moet weten waar hij aan toe is.
    const description = q(SG.description);
    if (description) {
      const warning = HSG.describeDeadline(expiry);
      const own = settings.description || '';
      HSG.setNativeValue(
        description,
        warning ? [warning, own].filter(Boolean).join('\n\n') : own
      );
    }

    // De key als laatste: een halverwege afgebroken vulronde laat dan geen key
    // in een verder leeg formulier achter.
    const keyField = q(SG.keyString);
    if (!keyField) throw new Error('Het key-veld ontbreekt. Staat het type wel op "key"?');
    HSG.setNativeValue(keyField, key);

    return notes;
  }

  // --- aftellen voor automatisch verzenden ------------------------------------

  function scheduleAutoSubmit(seconds, label) {
    const button = q(SG.submitButton);
    if (!button) return;

    let remaining = Math.max(1, Number(seconds) || 1);
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      remaining -= 1;
      HSG.panel.notice(`${label} — automatisch verzenden over ${remaining}s.`, 'warn');
      if (remaining <= 0) {
        clearInterval(timer);
        HSG.clickWidget(button);
      }
    };

    HSG.panel.notice(`${label} — automatisch verzenden over ${remaining}s.`, 'warn');
    const timer = setInterval(tick, 1000);
    // Elke muisklik of toetsaanslag geldt als "laat mij maar".
    const cancel = () => {
      cancelled = true;
      clearInterval(timer);
      HSG.panel.notice('Automatisch verzenden geannuleerd; je kunt zelf verzenden.', 'ok');
    };
    document.addEventListener('keydown', cancel, { once: true });
  }

  // --- hoofdroutine -----------------------------------------------------------

  async function handleNewGiveawayPage() {
    const queue = HSG.store.getQueue();
    if (!queue.running) return;

    const item = HSG.currentItem(queue);
    if (!item || item.status === 'done' || item.status === 'error') return;

    const key = HSG.store.getKey(item.id);
    if (!key) {
      HSG.store.withQueue((current) => ({
        queue: {
          ...HSG.updateItem(current, item.id, {
            status: HSG.STATUS.ERROR,
            error: 'Key niet meer beschikbaar. Haal hem opnieuw op via je Humble keys-pagina.',
          }),
          running: false,
        },
      }));
      HSG.panel.render();
      return;
    }

    const settings = HSG.store.getSettings();
    const position = `${queue.cursor + 1} van ${queue.items.length}`;

    if (isReviewStep()) {
      HSG.panel.notice(`Controleren — ${item.humanName} (${position}). Bevestig hieronder.`, 'ok');
      if (settings.autoSubmit) scheduleAutoSubmit(settings.autoSubmitDelaySeconds, 'Bevestigen');
      return;
    }

    HSG.panel.notice(`${item.humanName} (${position}) — spel opzoeken…`, 'ok');

    let resolved;
    try {
      resolved = await resolveGame(item);
    } catch (error) {
      fail(item.id, String(error.message || error));
      return;
    }

    if (!resolved.match) {
      HSG.store.withQueue((current) => ({
        queue: {
          ...HSG.updateItem(current, item.id, {
            status: HSG.STATUS.NEEDS_CHOICE,
            candidates: (resolved.candidates || []).slice(0, 12),
            error:
              resolved.reason === 'none'
                ? 'SteamGifts kent dit spel niet onder deze naam.'
                : 'Meerdere spellen komen in aanmerking.',
          }),
          running: false,
        },
      }));
      HSG.panel.notice(
        `Kies het juiste spel voor ${item.humanName} — de wachtrij staat op pauze.`,
        'warn'
      );
      HSG.panel.toggle(true);
      return;
    }

    let notes;
    try {
      const freshItem = await waitForSteamdb(item, settings);
      notes = await fillForm(freshItem, key, settings, resolved.match);
    } catch (error) {
      fail(item.id, String(error.message || error));
      return;
    }

    HSG.store.withQueue((current) => ({
      queue: HSG.updateItem(current, item.id, {
        status: HSG.STATUS.FILLED,
        sgGameId: resolved.match.id,
        sgGameName: resolved.match.name,
        error: null,
      }),
    }));

    HSG.panel.notice(
      notes.length
        ? `Klaar om te verzenden — ${resolved.match.name} (${position}). Let op: ${notes.join(' ')}`
        : `Klaar om te verzenden — ${resolved.match.name} (${position}). Controleer en klik op "Review Giveaway".`,
      notes.length ? 'warn' : 'ok'
    );
    HSG.panel.render();

    if (settings.autoSubmit) {
      scheduleAutoSubmit(settings.autoSubmitDelaySeconds, `Verzenden — ${resolved.match.name}`);
    }
  }

  function fail(id, message) {
    HSG.store.withQueue((current) => ({
      queue: { ...HSG.updateItem(current, id, { status: HSG.STATUS.ERROR, error: message }), running: false },
    }));
    HSG.panel.notice(message, 'error');
    HSG.panel.render();
  }

  /**
   * De giveaway-pagina is ons sein dat het gelukt is. Alleen accepteren als het
   * huidige item echt klaarstond — anders zou gewoon rondklikken op SteamGifts
   * items als klaar markeren.
   */
  function handleCreatedGiveawayPage() {
    const queue = HSG.store.getQueue();
    const item = HSG.currentItem(queue);
    if (!queue.running || !item || item.status !== 'filled') return;

    HSG.store.forgetKey(item.id);
    const updated = HSG.store.withQueue((current) => {
      const marked = HSG.updateItem(current, item.id, {
        status: HSG.STATUS.DONE,
        giveawayUrl: location.href,
        error: null,
      });
      return { queue: HSG.advance(marked) };
    });

    if (updated.running && HSG.currentItem(updated)) {
      HSG.panel.notice('Giveaway aangemaakt — volgende spel wordt geladen…', 'ok');
      setTimeout(() => {
        location.href = HSG.URLS.SG_NEW_GIVEAWAY;
      }, 1200);
    } else {
      HSG.panel.notice('Giveaway aangemaakt. De wachtrij is leeg — klaar!', 'ok');
    }
    HSG.panel.render();
  }

  // --- diagnose ---------------------------------------------------------------

  function diagnose() {
    const fields = [
      ['Formulier', SG.form],
      ['xsrf_token', SG.xsrfToken],
      ['game_id', SG.gameId],
      ['Zoekveld spel', SG.gameNameInput],
      ['type', SG.type],
      ['copies', SG.copies],
      ['key_string', SG.keyString],
      ['start_time', SG.startTime],
      ['end_time', SG.endTime],
      ['region_restricted', SG.regionRestricted],
      ['Landenlijst', SG.countryList],
      ['who_can_enter', SG.whoCanEnter],
      ['whitelist', SG.whitelist],
      ['Groepenlijst', SG.groupList],
      ['contributor_level', SG.contributorLevel],
      ['description', SG.description],
      ['Verzendknop', SG.submitButton],
    ];

    const checks = fields.map(([label, selector]) => ({
      label,
      ok: Boolean(q(selector)),
      detail: selector,
    }));

    for (const value of ['key', 'everyone', 'invite_only', 'groups', '0', '1']) {
      const found = document.querySelectorAll(HSG.checkboxValue(value)).length;
      checks.push({
        label: `Widget-optie "${value}"`,
        ok: found > 0,
        detail: found > 1 ? `${found}× aanwezig — wordt binnen de eigen rij gezocht` : HSG.checkboxValue(value),
      });
    }

    // De landcode is de kwetsbare schakel: SteamGifts identificeert landen met
    // een eigen nummer en zet de ISO-code alleen in `data-name`.
    const countries = HSG.readItemList(q(SG.countryList), 0);
    const withCode = countries.filter((entry) => entry.code);
    checks.push({
      label: 'Landcodes leesbaar',
      ok: countries.length > 0 && withCode.length === countries.length,
      detail: countries.length
        ? `${withCode.length} van ${countries.length} — bijv. ${withCode.slice(0, 6).map((e) => `${e.code}=${e.id}`).join(', ')}`
        : 'geen landenlijst gevonden',
    });

    const groups = HSG.readItemList(q(SG.groupList), 0);
    checks.push({
      label: `Groepen (${groups.length}) — id's voor de instellingen`,
      ok: true,
      detail: groups.map((entry) => `${entry.id} = ${entry.name}`).join(' · ') || 'geen',
    });

    return { site: 'steamgifts', checks };
  }

  // --- opstarten --------------------------------------------------------------

  function boot() {
    HSG.site = { name: 'steamgifts', diagnose };
    HSG.panel.mount();

    if (isNewGiveawayPage()) {
      handleNewGiveawayPage().catch((error) =>
        HSG.panel.notice(String(error.message || error), 'error')
      );
    } else if (isCreatedGiveawayPage()) {
      handleCreatedGiveawayPage();
    }
  }

  HSG.steamgifts = { boot };
})(typeof globalThis !== 'undefined' ? globalThis : window);
