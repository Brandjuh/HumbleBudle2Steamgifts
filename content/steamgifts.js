/**
 * Content script voor steamgifts.com.
 *
 * Op /giveaways/new: vraagt de service worker om het volgende item uit de
 * wachtrij, zoekt het juiste spel op, vult het formulier en laat de knop
 * "Review Giveaway" aan jou over (tenzij automatisch verzenden aan staat).
 *
 * Op /giveaway/<code>/…: dat is de pagina waar SteamGifts je na het aanmaken
 * heen stuurt, dus dat is ons sein dat het gelukt is.
 */
'use strict';

(() => {
  const { MSG, SELECTORS } = HSG;
  const SG = SELECTORS.steamgifts;

  const q = (selector, root) => (root || document).querySelector(selector);

  // --- communicatie ----------------------------------------------------------

  async function call(message) {
    const response = await chrome.runtime.sendMessage(message).catch(() => null);
    if (!response) return null;
    if (!response.ok) throw new Error(response.error || 'Onbekende fout');
    return response.result;
  }

  // --- spel opzoeken ---------------------------------------------------------

  /**
   * SteamGifts' eigen autocomplete. Accepteert ook een Steam appid als query,
   * wat een stuk betrouwbaarder is dan een titel vergelijken.
   */
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
    const html = data && data.html;
    if (!html) return [];

    const doc = new DOMParser().parseFromString(html, 'text/html');
    return Array.from(doc.querySelectorAll(SG.autocompleteRow))
      .map((row) => ({
        id: row.getAttribute('data-autocomplete-id'),
        name: row.getAttribute('data-autocomplete-name'),
      }))
      .filter((row) => row.id && row.name);
  }

  /**
   * Zoekt eerst op Steam appid; die is eenduidig. Ontbreekt die (Humble laat
   * `steam_app_id` regelmatig leeg), dan op titel — en bij twijfel vragen we het
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

    const rows = await searchGames(item.humanName);
    return HSG.pickGameMatch(rows, item.humanName);
  }

  // --- formulier vullen ------------------------------------------------------

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

    // De waarden "0" en "1" komen in meerdere rijen voor (regio, whitelist),
    // dus zoeken binnen de rij van het bijbehorende verborgen veld — een
    // document-brede querySelector zou de eerste de beste aanklikken.
    const scope = hidden && (hidden.closest('.form__row') || hidden.parentElement);
    const widget =
      (scope && q(HSG.checkboxValue(value), scope)) || q(HSG.checkboxValue(value));

    if (widget) {
      HSG.clickWidget(widget);
      if (!hidden || String(hidden.value) === String(value)) return true;
    }
    // Terugvaloptie: de zichtbare staat klopt dan niet, maar het formulier wel.
    if (hidden) {
      HSG.setNativeValue(hidden, value);
      return Boolean(widget);
    }
    return false;
  }

  /**
   * De datumvelden hangen aan een jQuery-datepicker die wij vanuit de isolated
   * world niet kunnen aanroepen. Het formulier verstuurt echter gewoon de
   * waarde van de input, dus we zetten zowel het verborgen veld als het
   * zichtbare veld op dezelfde, correct opgemaakte tekst.
   */
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

  /**
   * De contributor-level-slider is jQuery UI. We zetten het verborgen veld en
   * trekken de visuele staat na, zoals ESGST dat ook doet.
   */
  function fillLevel(level) {
    const hidden = q(SG.contributorLevel);
    if (!hidden) return false;
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
    return true;
  }

  /**
   * De regio-restrictie.
   *
   * Humble geeft een verbodslijst (`disallowed_countries`), SteamGifts wil een
   * toestemmingslijst. Staat "Regio overnemen van Humble" aan, dan keren we die
   * om en vinken we alles aan behalve de landen waar de key niet werkt. Anders
   * geldt gewoon je eigen instelling.
   *
   * @returns {Promise<string[]>} opmerkingen voor de banner
   */
  async function fillRegion(item, settings) {
    const notes = [];
    const blocked = (item.disallowedCountries || []).filter(Boolean);
    const fromHumble = settings.regionFromHumble !== false && blocked.length > 0;

    if (!fromHumble) {
      if (!selectOption(SG.regionRestricted, settings.regionRestricted ? '1' : '0')) {
        notes.push('Regio-optie niet gevonden.');
      }
      if (settings.regionRestricted) {
        const list = await HSG.waitForElement(SG.countryList, { timeout: 5000 }).catch(
          () => null
        );
        if (!list) {
          notes.push('Landenlijst niet gevonden — controleer de regio-instelling.');
        } else {
          const result = HSG.syncItemList(list, settings.countryIds || [], 0);
          if (result.missing.length) {
            notes.push(`Onbekende landcode(s): ${result.missing.join(', ')}`);
          }
        }
      }
      if (blocked.length) {
        notes.push(
          `Let op: Humble meldt ${blocked.length} landen waar deze key niet werkt, maar "regio overnemen van Humble" staat uit.`
        );
      }
      return notes;
    }

    if (!selectOption(SG.regionRestricted, '1')) {
      notes.push('Regio-optie niet gevonden — zet de restrictie zelf aan.');
    }

    const list = await HSG.waitForElement(SG.countryList, { timeout: 5000 }).catch(
      () => null
    );
    if (!list) {
      notes.push(
        `Landenlijst niet gevonden; Humble sluit ${blocked.length} landen uit — stel de regio zelf in.`
      );
      return notes;
    }

    const available = HSG.readItemList(list, 0).map((entry) => entry.id);
    const { allowed, unknown } = HSG.allowedCountries(available, blocked);

    // Herkent SteamGifts geen enkel land uit Humble's lijst, dan zou "beperken"
    // hier alles toestaan — dat is misleidender dan geen restrictie.
    if (allowed.length === available.length) {
      selectOption(SG.regionRestricted, '0');
      notes.push(
        `Humble noemt ${blocked.length} landen, maar SteamGifts kent er daarvan geen. Regio-restrictie uit gelaten — controleer dit zelf.`
      );
      return notes;
    }

    HSG.syncItemList(list, allowed, 0);
    notes.push(
      `Regio beperkt volgens Humble: ${allowed.length} landen toegestaan, ${available.length - allowed.length} uitgesloten.`
    );
    if (unknown.length) {
      notes.push(`${unknown.length} landcode(s) van Humble kent SteamGifts niet.`);
    }
    return notes;
  }

  async function fillForm(job, resolved) {
    const { item, key, settings } = job;
    const notes = [];

    fillGame(resolved.id, resolved.name);

    if (!selectOption(SG.type, 'key')) {
      notes.push('Kon het type niet op "key" zetten — controleer sectie 2.');
    }
    // Het key-veld verschijnt pas nadat "key" gekozen is; jQuery doet dat niet
    // per se in dezelfde tick.
    await HSG.waitForElement(SG.keyString, { timeout: 5000 }).catch(() => null);

    const copies = q(SG.copies);
    if (copies) HSG.setNativeValue(copies, String(settings.copies || 1));

    const schedule = HSG.computeSchedule(settings, new Date());
    if (!fillDate(SG.startTime, schedule.startText)) notes.push('Starttijd niet gevonden.');
    if (!fillDate(SG.endTime, schedule.endText)) notes.push('Eindtijd niet gevonden.');

    notes.push(...(await fillRegion(item, settings)));

    // Wie mag meedoen
    if (!selectOption(SG.whoCanEnter, settings.whoCanEnter)) {
      notes.push('Optie "wie mag meedoen" niet gevonden.');
    }
    if (settings.whoCanEnter === 'groups') {
      const list = await HSG.waitForElement(SG.groupList, { timeout: 5000 }).catch(
        () => null
      );
      const whitelist = q(SG.whitelist);
      if (whitelist) HSG.setNativeValue(whitelist, settings.whitelist ? '1' : '0');
      // Kind 0 van de groepenlijst is "My Whitelist" en heeft zijn eigen veld.
      const result = HSG.syncItemList(list, settings.groupIds || [], 1);
      if (!list) notes.push('Groepenlijst niet gevonden.');
      else if (result.missing.length) {
        notes.push(`Onbekende groep(en): ${result.missing.join(', ')}`);
      }
    }

    fillLevel(Number(settings.contributorLevel) || 0);

    const description = q(SG.description);
    if (description) HSG.setNativeValue(description, settings.description || '');

    // De key als laatste, zodat een halverwege afgebroken vulronde geen key
    // in een verder leeg formulier achterlaat.
    const keyField = q(SG.keyString);
    if (!keyField) throw new Error('Het key-veld ontbreekt. Staat het type wel op "key"?');
    HSG.setNativeValue(keyField, key);

    return notes;
  }

  // --- banner op de pagina ---------------------------------------------------

  function showBanner({ title, detail, tone, actions }) {
    let banner = q('.hsg-sg-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'hsg-sg-banner';
      document.body.appendChild(banner);
    }
    banner.dataset.tone = tone || 'info';
    banner.textContent = '';

    const heading = document.createElement('strong');
    heading.textContent = title;
    banner.appendChild(heading);

    if (detail) {
      const paragraph = document.createElement('span');
      paragraph.textContent = detail;
      banner.appendChild(paragraph);
    }
    for (const action of actions || []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'hsg-sg-banner__btn';
      button.textContent = action.label;
      button.addEventListener('click', action.onClick);
      banner.appendChild(button);
    }
    return banner;
  }

  // --- automatisch verzenden -------------------------------------------------

  /**
   * Alleen actief als je dat expliciet aanzet. Klikt dezelfde knop als jij,
   * zodat SteamGifts' eigen validatie gewoon draait.
   */
  function scheduleAutoSubmit(seconds, label) {
    const button = q(SG.submitButton);
    if (!button) return;

    let remaining = Math.max(1, Number(seconds) || 1);
    let cancelled = false;

    const banner = showBanner({
      title: label,
      detail: `Automatisch verzenden over ${remaining}s…`,
      tone: 'warn',
      actions: [
        {
          label: 'Annuleren',
          onClick: () => {
            cancelled = true;
            clearInterval(timer);
            showBanner({
              title: label,
              detail: 'Automatisch verzenden geannuleerd. Je kunt zelf verzenden.',
              tone: 'info',
            });
          },
        },
      ],
    });

    const timer = setInterval(() => {
      if (cancelled) return;
      remaining -= 1;
      const detail = banner.querySelector('span');
      if (detail) detail.textContent = `Automatisch verzenden over ${remaining}s…`;
      if (remaining <= 0) {
        clearInterval(timer);
        HSG.clickWidget(button);
      }
    }, 1000);
  }

  // --- paginaherkenning ------------------------------------------------------

  const isNewGiveawayPage = () => location.pathname.startsWith('/giveaways/new');
  const isCreatedGiveawayPage = () => /^\/giveaway\/[^/]+\//.test(location.pathname);
  /** Op de review-stap rendert SteamGifts het formulier zonder invoervelden. */
  const isReviewStep = () => isNewGiveawayPage() && !q(SG.gameId);

  // --- hoofdroutine ----------------------------------------------------------

  async function handleNewGiveawayPage() {
    const result = await call({ type: MSG.SG_READY, url: location.href });
    const job = result && result.job;
    if (!job) return;

    const position = `${job.index + 1} van ${job.total}`;

    if (isReviewStep()) {
      showBanner({
        title: `Controleren — ${job.item.humanName} (${position})`,
        detail: 'Klopt alles? Bevestig hieronder om de giveaway aan te maken.',
        tone: 'info',
      });
      if (job.settings.autoSubmit) {
        scheduleAutoSubmit(job.settings.autoSubmitDelaySeconds, `Bevestigen — ${job.item.humanName}`);
      }
      return;
    }

    showBanner({
      title: `${job.item.humanName} (${position})`,
      detail: 'Spel opzoeken op SteamGifts…',
      tone: 'info',
    });

    let resolved;
    try {
      resolved = await resolveGame(job.item);
    } catch (error) {
      await call({ type: MSG.SG_FAILED, id: job.item.id, message: String(error.message || error) });
      showBanner({
        title: `Zoeken mislukt — ${job.item.humanName}`,
        detail: String(error.message || error),
        tone: 'error',
      });
      return;
    }

    if (!resolved.match) {
      await call({
        type: MSG.SG_NEEDS_CHOICE,
        id: job.item.id,
        candidates: (resolved.candidates || []).slice(0, 12),
        reason:
          resolved.reason === 'none'
            ? 'SteamGifts kent dit spel niet onder deze naam.'
            : 'Meerdere spellen komen in aanmerking.',
      });
      showBanner({
        title: `Kies het juiste spel — ${job.item.humanName}`,
        detail: 'De wachtrij staat op pauze. Kies in het zijpaneel welk spel bedoeld wordt.',
        tone: 'warn',
      });
      return;
    }

    let notes;
    try {
      notes = await fillForm(job, resolved.match);
    } catch (error) {
      await call({ type: MSG.SG_FAILED, id: job.item.id, message: String(error.message || error) });
      showBanner({
        title: `Invullen mislukt — ${job.item.humanName}`,
        detail: String(error.message || error),
        tone: 'error',
      });
      return;
    }

    await call({
      type: MSG.SG_FILLED,
      id: job.item.id,
      sgGameId: resolved.match.id,
      sgGameName: resolved.match.name,
    });

    showBanner({
      title: `Klaar om te verzenden — ${resolved.match.name} (${position})`,
      detail: notes.length
        ? `Let op: ${notes.join(' ')}`
        : 'Alles is ingevuld, inclusief de key. Controleer en klik op "Review Giveaway".',
      tone: notes.length ? 'warn' : 'ok',
    });

    if (job.settings.autoSubmit) {
      scheduleAutoSubmit(job.settings.autoSubmitDelaySeconds, `Verzenden — ${resolved.match.name}`);
    }
  }

  async function handleCreatedGiveawayPage() {
    const result = await call({ type: MSG.SG_CREATED, url: location.href });
    if (!result || !result.accepted) return;
    showBanner({
      title: 'Giveaway aangemaakt',
      detail: result.done
        ? 'De wachtrij is leeg. Klaar!'
        : 'Volgende spel wordt geopend…',
      tone: 'ok',
    });
  }

  /** Read-only controle of de selectors nog kloppen. */
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
        detail:
          found > 1
            ? `${found}× aanwezig — wordt binnen de eigen formulierrij gezocht`
            : HSG.checkboxValue(value),
      });
    }

    // Klopt onze aanname dat elk verborgen veld in een .form__row zit? Zo niet,
    // dan valt het scopen terug op de hele pagina en kan een klik misgaan.
    const rowScoped = [SG.type, SG.regionRestricted, SG.whoCanEnter].filter(
      (selector) => {
        const el = q(selector);
        return el && el.closest('.form__row');
      }
    );
    checks.push({
      label: 'Verborgen velden zitten in een .form__row',
      ok: rowScoped.length === 3,
      detail: `${rowScoped.length} van 3`,
    });

    checks.push({
      label: 'Groepen beschikbaar',
      ok: true,
      detail: JSON.stringify(HSG.readItemList(q(SG.groupList), 0).slice(0, 30)),
    });
    checks.push({
      label: 'Landen beschikbaar',
      ok: true,
      detail: JSON.stringify(HSG.readItemList(q(SG.countryList), 0).slice(0, 40)),
    });

    return { site: 'steamgifts', checks };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== MSG.SG_DIAGNOSE) return false;
    try {
      sendResponse(diagnose());
    } catch (error) {
      sendResponse({ error: String(error.message || error) });
    }
    return false;
  });

  if (isNewGiveawayPage()) {
    handleNewGiveawayPage().catch((error) => {
      showBanner({
        title: 'Er ging iets mis',
        detail: String(error.message || error),
        tone: 'error',
      });
    });
  } else if (isCreatedGiveawayPage()) {
    handleCreatedGiveawayPage().catch(() => {});
  }
})();
