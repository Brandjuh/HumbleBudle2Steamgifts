// ==UserScript==
// @name         Humble → SteamGifts
// @namespace    https://github.com/Brandjuh/HumbleBudle2Steamgifts
// @version      0.1.0
// @description  Vink op je Humble keys-pagina aan wat je weggeeft; het SteamGifts-formulier wordt ingevuld, key en al.
// @author       Brandjuh
// @homepageURL  https://github.com/Brandjuh/HumbleBudle2Steamgifts
// @supportURL   https://github.com/Brandjuh/HumbleBudle2Steamgifts/issues
// @match        https://www.humblebundle.com/home/keys*
// @match        https://www.humblebundle.com/download*
// @match        https://www.humblebundle.com/membership/*
// @match        https://www.humblebundle.com/subscription/*
// @match        https://www.steamgifts.com/giveaways/new*
// @match        https://www.steamgifts.com/giveaway/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_addStyle
// @grant        GM_openInTab
// @noframes
// @updateURL    https://raw.githubusercontent.com/Brandjuh/HumbleBudle2Steamgifts/refs/heads/claude/humble-steamgifts-chrome-plugin-fqr5w4/dist/humble-to-steamgifts.user.js
// @downloadURL  https://raw.githubusercontent.com/Brandjuh/HumbleBudle2Steamgifts/refs/heads/claude/humble-steamgifts-chrome-plugin-fqr5w4/dist/humble-to-steamgifts.user.js
// ==/UserScript==

/*
 * Gegenereerd door `node build.js` — niet met de hand bijwerken.
 * De bron staat in lib/ en userscript/src/.
 */
(function () {
  'use strict';

// ==========================================================================
// lib/shared.js
// ==========================================================================

/**
 * Gedeelde constanten en het `HSG` namespace-object.
 *
 * Dit bestand is bewust geschreven zodat het in drie werelden werkt zonder
 * buildstap: als content script (klassiek script in `js[]`), als
 * `importScripts()`-target in de service worker, en als CommonJS-module in
 * `node --test`. Vandaar het assigneren op `globalThis` in plaats van
 * top-level `const`.
 */
'use strict';

(function (root) {
  const HSG = (root.HSG = root.HSG || {});

  /** Berichttypes. Eén plek, zodat een typefout niet stil doodloopt. */
  HSG.MSG = {
    // sidepanel → background
    GET_STATE: 'GET_STATE',
    SET_SETTINGS: 'SET_SETTINGS',
    QUEUE_ADD: 'QUEUE_ADD',
    QUEUE_REMOVE: 'QUEUE_REMOVE',
    QUEUE_MOVE: 'QUEUE_MOVE',
    QUEUE_CLEAR: 'QUEUE_CLEAR',
    QUEUE_RETRY: 'QUEUE_RETRY',
    QUEUE_START: 'QUEUE_START',
    QUEUE_PAUSE: 'QUEUE_PAUSE',
    KEYS_CLEAR: 'KEYS_CLEAR',
    RUN_DIAGNOSE: 'RUN_DIAGNOSE',
    HUMBLE_SCAN_REQUEST: 'HUMBLE_SCAN_REQUEST',
    PICK_CANDIDATE: 'PICK_CANDIDATE',

    // background → humble content script
    HUMBLE_SCAN: 'HUMBLE_SCAN',
    HUMBLE_REVEAL: 'HUMBLE_REVEAL',
    HUMBLE_DIAGNOSE: 'HUMBLE_DIAGNOSE',
    HUMBLE_SELECTION_CHANGED: 'HUMBLE_SELECTION_CHANGED',

    // humble content script → background
    HUMBLE_CATALOG: 'HUMBLE_CATALOG',
    HUMBLE_ADD_SELECTION: 'HUMBLE_ADD_SELECTION',

    // background → steamgifts content script
    SG_DIAGNOSE: 'SG_DIAGNOSE',

    // steamgifts content script → background
    SG_READY: 'SG_READY',
    SG_FILLED: 'SG_FILLED',
    SG_CREATED: 'SG_CREATED',
    SG_FAILED: 'SG_FAILED',
    SG_NEEDS_CHOICE: 'SG_NEEDS_CHOICE',

    // background → sidepanel (broadcast)
    STATE_CHANGED: 'STATE_CHANGED',
  };

  /** Statussen van een wachtrij-item. */
  HSG.STATUS = {
    PENDING: 'pending',
    FILLED: 'filled',
    NEEDS_CHOICE: 'needs-choice',
    DONE: 'done',
    ERROR: 'error',
  };

  HSG.STORAGE_KEYS = {
    SETTINGS: 'settings',
    QUEUE: 'queue',
    CATALOG: 'catalog',
    DIAGNOSTICS: 'diagnostics',
    KEYS: 'keys', // uitsluitend in chrome.storage.session
  };

  HSG.URLS = {
    SG_NEW_GIVEAWAY: 'https://www.steamgifts.com/giveaways/new',
    HUMBLE_MEMBERSHIP: 'https://www.humblebundle.com/membership/home',
  };

  HSG.DEFAULT_SETTINGS = {
    /** Hoeveel minuten na "nu" de giveaway start. */
    startOffsetMinutes: 5,
    /** Looptijd in dagen, vanaf de starttijd. */
    durationDays: 7,
    /** Aantal kopieën per giveaway. Wij geven losse keys weg, dus 1. */
    copies: 1,
    /** 'everyone' | 'invite_only' | 'groups' */
    whoCanEnter: 'everyone',
    /** Alleen relevant bij whoCanEnter === 'groups'. */
    whitelist: false,
    /** data-item-id's uit de groepenlijst van SteamGifts. */
    groupIds: [],
    /** 0 t/m 10. */
    contributorLevel: 0,
    /**
     * Humble's `disallowed_countries` omzetten naar een SteamGifts-regio-
     * restrictie. Standaard aan: zonder dit kan iemand een giveaway winnen met
     * een key die in zijn land niet activeert.
     */
    regionFromHumble: true,
    /** Regio-restrictie aan/uit als Humble niets meldt (of overnemen uit staat). */
    regionRestricted: false,
    /** data-item-id's (landcodes) uit de landenlijst van SteamGifts. */
    countryIds: [],
    /** Vaste beschrijving; leeg laten mag. */
    description: '',
    /** Zelf verzenden (false) of de extensie laten verzenden (true). */
    autoSubmit: false,
    /** Wachttijd voor de extensie zelf op verzenden drukt. */
    autoSubmitDelaySeconds: 15,
    /** Pauze tussen twee reveal-calls richting Humble. */
    revealDelayMs: 700,
    /**
     * Hoe lang een opgehaalde key blijft staan voor hij vanzelf verdwijnt.
     * Alleen van belang in de userscript-versie: Tampermonkey heeft geen
     * geheugen-only opslag, dus daar staan keys op schijf en willen we ze niet
     * eindeloos laten liggen.
     */
    keyTtlHours: 12,
  };

  /** Wat we van Humble accepteren als bruikbare giveaway-key. */
  HSG.isUsableTpk = function (tpk) {
    return (
      !!tpk &&
      String(tpk.key_type || '').toLowerCase() === 'steam' &&
      !tpk.is_expired &&
      !tpk.is_gift
    );
  };

  /** `steam_app_id` is bij Humble nu eens een number, dan weer een string of 0. */
  HSG.normalizeAppId = function (value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  HSG.sleep = function (ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  };

  /** Nooit een key in een logregel laten belanden. */
  HSG.redact = function (value) {
    if (typeof value !== 'string') return value;
    return value.replace(/[A-Z0-9]{5}(-[A-Z0-9]{5}){2,4}/gi, '<key verborgen>');
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);

// ==========================================================================
// lib/selectors.js
// ==========================================================================

/**
 * Alle site-specifieke selectors op één plek.
 *
 * Humble en SteamGifts kunnen hun opmaak wijzigen zonder ons te waarschuwen.
 * Door alles hier te bundelen is zo'n wijziging één bestand aanpassen in plaats
 * van een zoektocht door de hele extensie. De diagnose-functie in het zijpaneel
 * controleert precies deze lijst.
 *
 * De SteamGifts-selectors komen oorspronkelijk uit ESGST
 * (MultipleGiveawayCreator.jsx, GiveawayTemplates.jsx) en zijn daarna
 * geverifieerd tegen de echte HTML van /giveaways/new.
 *
 * Twee dingen die je uit de naam niet zou raden:
 * - De landenlijst gebruikt een intern nummer als `data-item-id`; de ISO-code
 *   staat in `data-name` ("Netherlands NL").
 * - De groepenlijst begint met "My Whitelist", dat géén `data-item-id` heeft
 *   maar `data-whitelist="1"` en bij een apart formulierveld hoort.
 */
'use strict';

(function (root) {
  const HSG = (root.HSG = root.HSG || {});

  HSG.SELECTORS = {
    humble: {
      /**
       * Het keyveld op de keys-pagina. De key staat in het `title`-attribuut en
       * de klasse `redeemed` geeft aan dat hij al onthuld is:
       *   <div class="js-keyfield keyfield redeemed enabled" title="XXXXX-…">
       * Dit is op de echte pagina geverifieerd en is onze primaire bron.
       */
      keyField: '.js-keyfield',
      /** Klasse op het keyveld zodra de key onthuld is. */
      redeemedClass: 'redeemed',
      /** Tegenhanger van `enabled`: een key die niet meer op te halen is. */
      disabledClass: 'disabled',
      /** Het zichtbare vlak in het keyveld — dat klik je aan om te onthullen. */
      keyFieldValue: '.keyfield-value',
      /** Kandidaat-containers voor de rij rond een keyveld, van specifiek naar breed. */
      rowContainers: ['tr', 'li', '.row', '[class*="key-row"]', '[class*="keyfield-row"]'],
      /**
       * Waar de spelnaam staat. `.game-name h4` staat vooraan en dat is geen
       * detail: de bredere varianten pakken ook de disclaimer mee die in elke
       * rij staat, en dan krijgen alle rijen dezelfde naam.
       */
      rowName: '.game-name h4, .game-name h3, .js-game-name, [class*="game-name"] h4, h4',
      /**
       * De link naar de bundel: `<a href="/download?key=…">July 2026 Humble Choice</a>`.
       * Levert zowel de bundelnaam als de order-sleutel, per rij.
       */
      rowBundleLink: '.game-name a[href*="key="], a[href*="/download?key="]',
      /** Platform-icoontjes; Humble gebruikt een `hb-`-iconenfont (`hb hb-key hb-steam`). */
      platformIcon: '.platform i, [class*="hb-"], [class*="platform"], [class*="icon-"]',

      /**
       * JSON-blobs waar Humble het paginamodel in serverrenderde. Op de
       * membership-pagina staan die er niet meer (geverifieerd via de diagnose),
       * dus dit is nog slechts een bonus-bron, geen fundament.
       */
      modelScriptIds: [
        'webpack-monthly-product-data',
        'webpack-subscriber-hub-data',
        'webpack-json-data',
        'user-home-json-data',
      ],
      /** Fallbacks voor het CSRF-token als het niet in het paginamodel staat. */
      csrfInput: 'input[name="csrfmiddlewaretoken"], .csrftoken',
      /** Container waar we onze eigen balk in hangen; met document.body als laatste redmiddel. */
      pageRoot: '.inner-main-wrapper',
    },

    steamgifts: {
      form: '.form__rows',
      xsrfToken: 'input[name="xsrf_token"]',
      nextStep: '[name="next_step"]',

      gameId: '[name="game_id"]',
      gameNameInput: '.js__autocomplete-name',

      type: '[name="type"]',
      copies: '[name="copies"]',
      keyString: '[name="key_string"]',

      startTime: '[name="start_time"]',
      endTime: '[name="end_time"]',

      regionRestricted: '[name="region_restricted"]',
      countryItemString: '[name="country_item_string"]',
      countryList: '.form_list[data-input="country_item_string"]',

      whoCanEnter: '[name="who_can_enter"]',
      whitelist: '.form__row--who-can-enter [name="whitelist"]',
      groupItemString: '[name="group_item_string"]',
      groupList: '.form_list[data-input="group_item_string"]',
      /**
       * Eerste rij van de groepenlijst: "My Whitelist". Die heeft geen
       * `data-item-id` maar `data-whitelist="1"`, en hoort bij het aparte
       * `whitelist`-veld in plaats van bij `group_item_string`.
       */
      whitelistItem: '.form_list[data-input="group_item_string"] [data-whitelist="1"]',

      contributorLevel: '[name="contributor_level"]',
      levelSliderRange: '.ui-slider-range',
      levelSliderHandle: '.ui-slider-handle',
      levelLabel: '.form__level',
      levelDescription: '.form__input-description--level',
      noLevelDescription: '.form__input-description--no-level',

      description: '[name="description"]',

      submitButton: '.js__submit-form',
      formError: '.form__row__error',

      /** Rijen in het antwoord van de autocomplete-endpoint. */
      autocompleteRow: '.table__row-outer-wrap',
    },
  };

  /** Een aanklikbare widget-optie, bijv. checkboxValue('key') of checkboxValue('everyone'). */
  HSG.checkboxValue = function (value) {
    return `[data-checkbox-value="${value}"]`;
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);

// ==========================================================================
// lib/format.js
// ==========================================================================

/**
 * Pure functies: datumopmaak voor SteamGifts en het koppelen van een
 * Humble-titel aan het juiste spel in de SteamGifts-catalogus.
 *
 * Alles hier is testbaar zonder browser — zie test/format.test.js.
 */
'use strict';

(function (root) {
  const HSG = (root.HSG = root.HSG || {});

  const MONTHS = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];

  /**
   * SteamGifts verwacht `MMM d, yyyy h:mm a` (date-fns v2), bijv.
   * "Jul 30, 2026 8:00 PM". Een afwijkend formaat wordt stil genegeerd en
   * levert een onbruikbare giveaway op — dit is de klassieke valkuil.
   */
  HSG.formatSteamGiftsDate = function (date) {
    const hours24 = date.getHours();
    const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const meridiem = hours24 < 12 ? 'AM' : 'PM';
    return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} ${hours12}:${minutes} ${meridiem}`;
  };

  /** Start- en eindtijd afleiden uit de instellingen. */
  HSG.computeSchedule = function (settings, now) {
    const base = now instanceof Date ? now.getTime() : Date.now();
    const start = new Date(base + (settings.startOffsetMinutes || 0) * 60000);
    const end = new Date(start.getTime() + (settings.durationDays || 7) * 86400000);
    return {
      start,
      end,
      startText: HSG.formatSteamGiftsDate(start),
      endText: HSG.formatSteamGiftsDate(end),
    };
  };

  /**
   * Titels van Humble en SteamGifts lopen net uiteen: trademark-tekens,
   * "Definitive Edition", accenten, rare streepjes. Normaliseren voor we
   * vergelijken.
   */
  HSG.normalizeTitle = function (value) {
    return String(value || '')
      // ™ en ® eerst weg: NFKD zou er "tm" / "r" van maken en dat plakt
      // aan het voorgaande woord vast.
      .replace(/[™®©]/g, '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  };

  /**
   * Kies het juiste spel uit de autocomplete-resultaten.
   *
   * Bewust conservatief: liever één keer vragen dan een key aan het verkeerde
   * spel hangen. Dat laatste is namelijk niet meer terug te draaien zodra de
   * giveaway loopt.
   *
   * @param {{id: string, name: string}[]} rows
   * @param {string} humbleName
   * @returns {{match: object|null, reason: string, candidates: object[]}}
   */
  HSG.pickGameMatch = function (rows, humbleName) {
    const candidates = (rows || []).filter((row) => row && row.id && row.name);
    if (candidates.length === 0) {
      return { match: null, reason: 'none', candidates: [] };
    }

    const wanted = HSG.normalizeTitle(humbleName);
    const exact = candidates.filter((row) => HSG.normalizeTitle(row.name) === wanted);
    if (exact.length === 1) {
      return { match: exact[0], reason: 'exact', candidates };
    }
    if (exact.length > 1) {
      return { match: null, reason: 'ambiguous', candidates: exact };
    }
    if (candidates.length === 1) {
      return { match: candidates[0], reason: 'only-result', candidates };
    }
    return { match: null, reason: 'ambiguous', candidates };
  };

  /**
   * Tekst die in een key-rij naast de spelnaam staat en dus geen titel is.
   * Bewust klein gehouden: te agressief filteren gooit echte titels weg.
   */
  const ROW_NOISE = new Set([
    'steam', 'gog', 'epic', 'origin', 'uplay', 'battlenet', 'ubisoft connect',
    'key', 'keys', 'steam key', 'reveal', 'reveal your key', 'redeem', 'redeemed',
    'copy', 'copied', 'show', 'hide', 'gift', 'gift this', 'claimed', 'expired',
    'download', 'downloads', 'platform', 'game', 'name',
  ]);

  /**
   * Kiest de spelnaam uit de losse tekstjes van een rij op de keys-pagina.
   *
   * Humble's rijen bevatten naast de titel ook knoplabels ("Reveal your key"),
   * een platformnaam en soms een datum. De titel is doorgaans de langste
   * overgebleven tekst; keys en labels vallen eerst af.
   *
   * @param {string[]} candidates ruwe teksten uit de rij
   * @returns {string|null}
   */
  HSG.pickRowName = function (candidates) {
    let best = null;
    for (const raw of candidates || []) {
      const text = String(raw || '').replace(/\s+/g, ' ').trim();
      if (text.length < 2 || text.length > 80) continue;
      // Een Steam-key is geen titel.
      if (/^[A-Z0-9]{5}(-[A-Z0-9]{5}){2,4}$/i.test(text)) continue;
      if (ROW_NOISE.has(text.toLowerCase())) continue;
      // Losse getallen, datums en bedragen.
      if (/^[\d\s./:$€,-]+$/.test(text)) continue;
      if (HSG.looksLikeProse(text)) continue;
      if (!best || text.length > best.length) best = text;
    }
    return best;
  };

  /**
   * Volzinnen weren. Humble zet in elke key-rij dezelfde disclaimer ("Steam will
   * not provide extra giftable copies of games you already own."), en omdat die
   * langer is dan de meeste speltitels won hij van de titel — waarna elke rij
   * dezelfde naam kreeg en de hele lijst tot één regel samenklapte.
   *
   * Een punt aan het eind én vier of meer woorden is proza. `S.T.A.L.K.E.R.`
   * eindigt ook op een punt maar is één woord, dus die blijft staan.
   */
  HSG.looksLikeProse = function (text) {
    const value = String(text || '').trim();
    if (!/[.!?]$/.test(value)) return false;
    return value.split(/\s+/).length >= 4;
  };

  /**
   * Haalt de order-sleutel uit een bundellink: `/download?key=5UpZdUyMHhmZxuqa`.
   * Met die sleutel kunnen we de hele order opvragen — dat levert de Steam-appid's
   * én alle keys van die bundel, ook de exemplaren die op een volgende pagina
   * van Humble staan.
   */
  HSG.parseOrderKey = function (href) {
    const match = /[?&]key=([^&#]+)/.exec(String(href || ''));
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]) || null;
    } catch (error) {
      return match[1] || null;
    }
  };

  const PLATFORM_PATTERN =
    /\b(?:hb|platform|icon)[-_]?(steam|gog|epic|origin|uplay|battlenet)\b/i;

  /**
   * Leest het platform uit de klassenamen van een icoontje in de rij.
   * Geeft null terug als er niets herkenbaars in staat — dan weten we het niet,
   * en dat is iets anders dan "geen Steam".
   */
  HSG.detectPlatform = function (classNames) {
    const match = PLATFORM_PATTERN.exec(String(classNames || ''));
    return match ? match[1].toLowerCase() : null;
  };

  /**
   * De ISO-landcode uit het `data-name` van een SteamGifts-landrij.
   *
   * SteamGifts identificeert landen met een eigen nummer, niet met de landcode:
   *   <div data-name="Netherlands NL" data-item-id="160">
   *   <div data-name="Brazil BR"      data-item-id="30">
   *
   * De code staat als laatste woord in `data-name`. Zonder deze vertaalslag valt
   * Humble's "BR" nergens op te leggen.
   */
  HSG.parseCountryCode = function (dataName) {
    const match = /(?:^|\s)([A-Z]{2})$/.exec(String(dataName || '').trim());
    return match ? match[1] : null;
  };

  const upperList = (values) =>
    (values || []).map((code) => String(code).trim().toUpperCase()).filter(Boolean);

  /**
   * Keert Humble's regio-informatie om naar de toestemmingslijst die SteamGifts
   * wil. Op SteamGifts betekent een aangevinkt land "hier mag men meedoen".
   *
   * Humble heeft twee velden, en ze werken tegengesteld:
   * - `disallowed_countries` — hier werkt de key NIET; de rest wel.
   * - `exclusive_countries`  — de key werkt ALLEEN hier.
   *
   * Is `exclusive_countries` gevuld, dan is dat leidend en telt `disallowed`
   * daar nog bovenop. Wie alleen naar `disallowed` kijkt, zet een exclusieve key
   * open voor de hele wereld.
   *
   * @param {{id: string, code: string|null}[]} items landrijen van SteamGifts
   * @param {string[]} disallowed ISO-landcodes waar de key niet werkt
   * @param {string[]} [exclusive] ISO-landcodes waar de key uitsluitend werkt
   * @returns {{allowedIds: string[], blockedCodes: string[], unknownCodes: string[], unmapped: string[]}}
   */
  HSG.allowedCountries = function (items, disallowed, exclusive) {
    const blockSet = new Set(upperList(disallowed));
    const onlySet = new Set(upperList(exclusive));
    const hasExclusive = onlySet.size > 0;

    const allowedIds = [];
    const blockedCodes = [];
    const unmapped = [];
    const known = new Set();

    for (const item of items || []) {
      if (!item || !item.id) continue;
      const code = item.code ? String(item.code).trim().toUpperCase() : null;

      if (!code) {
        // Geen leesbare landcode. Bij een exclusieve key kunnen we niet
        // vaststellen dat dit land erbij hoort, dus dan valt hij af.
        unmapped.push(item.id);
        if (!hasExclusive) allowedIds.push(item.id);
        continue;
      }

      known.add(code);
      const blocked = blockSet.has(code) || (hasExclusive && !onlySet.has(code));
      if (blocked) blockedCodes.push(code);
      else allowedIds.push(item.id);
    }

    const mentioned = new Set([...blockSet, ...onlySet]);
    const unknownCodes = Array.from(mentioned).filter((code) => !known.has(code));
    return { allowedIds, blockedCodes, unknownCodes, unmapped };
  };

  /**
   * Bouwt een unieke, stabiele id voor een wachtrij-item. Stabiel is belangrijk:
   * hij is tevens de sleutel waaronder de key in storage.session staat.
   */
  HSG.itemId = function (gamekey, machineName) {
    return `${gamekey}:${machineName}`;
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);

// ==========================================================================
// lib/dom.js
// ==========================================================================

/**
 * DOM-hulpjes voor het vullen van andermans formulieren.
 *
 * De kern: `el.value = x` wordt genegeerd door de value-trackers van React, Vue
 * en (in mindere mate) jQuery-widgets. Je moet de *oorspronkelijke* setter van
 * het prototype aanroepen zodat de cache van de tracker verloopt, en pas daarna
 * de events vuren.
 */
'use strict';

(function (root) {
  const HSG = (root.HSG = root.HSG || {});

  const nativeSetter = (ctor, prop) => {
    if (typeof ctor !== 'function') return null;
    const desc = Object.getOwnPropertyDescriptor(ctor.prototype, prop);
    return desc ? desc.set : null;
  };

  const VALUE_SETTERS =
    typeof root.HTMLInputElement === 'function'
      ? new Map([
          [root.HTMLInputElement, nativeSetter(root.HTMLInputElement, 'value')],
          [root.HTMLTextAreaElement, nativeSetter(root.HTMLTextAreaElement, 'value')],
          [root.HTMLSelectElement, nativeSetter(root.HTMLSelectElement, 'value')],
        ])
      : new Map();

  /**
   * Zet een waarde zó dat de pagina het merkt.
   * Let op: textarea heeft een eigen setter — precies waar de Steam-key in moet.
   */
  HSG.setNativeValue = function (el, value) {
    if (!el) return false;
    const setter =
      VALUE_SETTERS.get(el.constructor) ||
      VALUE_SETTERS.get(Object.getPrototypeOf(el).constructor);

    if (setter) setter.call(el, value);
    else el.value = value;

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  /**
   * Klik een widget aan alsof de gebruiker het deed.
   * Sommige handlers luisteren op mousedown/mouseup in plaats van click.
   */
  HSG.clickWidget = function (el) {
    if (!el) return false;
    for (const type of ['mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, view: root })
      );
    }
    return true;
  };

  /** Wacht tot een element bestaat. Controleert eerst, observeert daarna pas. */
  HSG.waitForElement = function (selector, options) {
    const { timeout = 10000, root: scope = document } = options || {};
    const existing = scope.querySelector(selector);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      let timer;
      const observer = new MutationObserver(() => {
        const el = scope.querySelector(selector);
        if (!el) return;
        clearTimeout(timer);
        observer.disconnect();
        resolve(el);
      });

      observer.observe(scope === document ? document.documentElement : scope, {
        childList: true,
        subtree: true,
      });

      if (timeout > 0) {
        timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error(`Element niet gevonden binnen ${timeout}ms: ${selector}`));
        }, timeout);
      }
    });
  };

  /**
   * Wacht tot een attribuut een waarde krijgt. Gebruikt bij het onthullen van
   * een Humble-key via de DOM: het `title`-attribuut van het keyveld wordt pas
   * gevuld nadat de pagina het antwoord van de server binnen heeft.
   */
  HSG.waitForAttribute = function (el, attribute, options) {
    const { timeout = 10000 } = options || {};
    const current = el && el.getAttribute(attribute);
    if (current) return Promise.resolve(current);
    if (!el) return Promise.reject(new Error('waitForAttribute: element ontbreekt'));

    return new Promise((resolve, reject) => {
      let timer;
      const observer = new MutationObserver(() => {
        const value = el.getAttribute(attribute);
        if (!value) return;
        clearTimeout(timer);
        observer.disconnect();
        resolve(value);
      });
      observer.observe(el, { attributes: true, attributeFilter: [attribute] });

      if (timeout > 0) {
        timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error(`Attribuut "${attribute}" bleef leeg na ${timeout}ms`));
        }, timeout);
      }
    });
  };

  /**
   * Zorg dat een lijst met keuze-items exact de gegeven ids geselecteerd heeft.
   * Gebruikt voor de landen- en groepenlijsten van SteamGifts, waar de zichtbare
   * items via `.click()` togglen en `.is-selected` de staat bijhoudt.
   *
   * @param {Element} listEl container met kind-elementen die `data-item-id` dragen
   * @param {string[]} wantedIds
   * @param {number} skipFirst aantal kinderen aan het begin dat overgeslagen wordt
   *   (de groepenlijst begint met "My Whitelist", dat is een apart veld)
   */
  HSG.syncItemList = function (listEl, wantedIds, skipFirst) {
    if (!listEl) return { changed: 0, missing: wantedIds.slice() };
    const wanted = new Set(wantedIds);
    const seen = new Set();
    let changed = 0;

    const children = Array.from(listEl.children).slice(skipFirst || 0);
    for (const child of children) {
      const id = child.getAttribute('data-item-id');
      if (!id) continue;
      seen.add(id);
      const isSelected = child.classList.contains('is-selected');
      const shouldSelect = wanted.has(id);
      if (isSelected !== shouldSelect) {
        HSG.clickWidget(child);
        changed += 1;
      }
    }

    return { changed, missing: wantedIds.filter((id) => !seen.has(id)) };
  };

  /**
   * Leest de opties uit zo'n lijst.
   *
   * `id` is het interne nummer van SteamGifts (`data-item-id`), niet de
   * landcode; die zit in `data-name` en komt als `code` mee.
   */
  HSG.readItemList = function (listEl, skipFirst) {
    if (!listEl) return [];
    return Array.from(listEl.children)
      .slice(skipFirst || 0)
      .map((child) => {
        const dataName = child.getAttribute('data-name');
        return {
          id: child.getAttribute('data-item-id'),
          name: (dataName || child.textContent || '').trim(),
          code: HSG.parseCountryCode ? HSG.parseCountryCode(dataName) : null,
          selected: child.classList.contains('is-selected'),
        };
      })
      .filter((item) => item.id);
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);

// ==========================================================================
// lib/queue.js
// ==========================================================================

/**
 * De wachtrij als pure reducer. Geen chrome-API's hier, zodat dit met
 * `node --test` te testen is en de service worker er alleen state in en uit
 * hoeft te schuiven.
 *
 * Ontwerpregel: de wachtrij bevat nooit een key. Keys leven in
 * chrome.storage.session, gesleuteld op item-id. Zo kan de wachtrij zelf
 * gewoon op schijf staan.
 */
'use strict';

(function (root) {
  const HSG = (root.HSG = root.HSG || {});
  const STATUS = HSG.STATUS;

  HSG.emptyQueue = function () {
    return { items: [], cursor: 0, running: false, sgTabId: null };
  };

  /** Maakt een wachtrij-item van een catalogusregel. */
  HSG.makeItem = function (game) {
    return {
      id: HSG.itemId(game.gamekey, game.machineName),
      machineName: game.machineName,
      humanName: game.humanName,
      gamekey: game.gamekey,
      keyindex: game.keyindex,
      steamAppId: game.steamAppId != null ? game.steamAppId : null,
      disallowedCountries: game.disallowedCountries || [],
      exclusiveCountries: game.exclusiveCountries || [],
      status: STATUS.PENDING,
      error: null,
      sgGameId: null,
      sgGameName: null,
      giveawayUrl: null,
      candidates: null,
    };
  };

  /** Voegt toe zonder duplicaten; bestaande items blijven met hun status staan. */
  HSG.addItems = function (queue, games) {
    const next = { ...queue, items: queue.items.slice() };
    const known = new Set(next.items.map((item) => item.id));
    let added = 0;
    for (const game of games || []) {
      const item = HSG.makeItem(game);
      if (known.has(item.id)) continue;
      known.add(item.id);
      next.items.push(item);
      added += 1;
    }
    return { queue: next, added };
  };

  /**
   * Verwijdert een item en houdt de cursor op hetzelfde item gericht.
   * Zonder die correctie slaat het verwijderen van een afgehandeld item stilletjes
   * het volgende spel over.
   */
  HSG.removeItem = function (queue, id) {
    const index = queue.items.findIndex((item) => item.id === id);
    if (index === -1) return queue;
    const items = queue.items.slice();
    items.splice(index, 1);
    const cursor = index < queue.cursor ? queue.cursor - 1 : queue.cursor;
    return { ...queue, items, cursor: Math.max(0, Math.min(cursor, items.length)) };
  };

  /** Verschuift een item in de lijst. De cursor volgt de inhoud, niet de index. */
  HSG.moveItem = function (queue, id, delta) {
    const from = queue.items.findIndex((item) => item.id === id);
    if (from === -1) return queue;
    const to = from + delta;
    if (to < 0 || to >= queue.items.length) return queue;

    const currentId = queue.items[queue.cursor] ? queue.items[queue.cursor].id : null;
    const items = queue.items.slice();
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);

    let cursor = queue.cursor;
    if (currentId) {
      const found = items.findIndex((item) => item.id === currentId);
      if (found !== -1) cursor = found;
    }
    return { ...queue, items, cursor };
  };

  HSG.currentItem = function (queue) {
    return queue.items[queue.cursor] || null;
  };

  HSG.updateItem = function (queue, id, patch) {
    const items = queue.items.map((item) =>
      item.id === id ? { ...item, ...patch } : item
    );
    return { ...queue, items };
  };

  /**
   * Schuift de cursor naar het eerstvolgende item dat nog werk nodig heeft.
   * Items met status DONE of ERROR worden overgeslagen; ERROR blijft in de lijst
   * staan zodat je 'm in het zijpaneel kunt zien en opnieuw kunt proberen.
   */
  HSG.advance = function (queue) {
    let cursor = queue.cursor + 1;
    while (
      cursor < queue.items.length &&
      (queue.items[cursor].status === STATUS.DONE ||
        queue.items[cursor].status === STATUS.ERROR)
    ) {
      cursor += 1;
    }
    const running = cursor < queue.items.length ? queue.running : false;
    return { ...queue, cursor, running };
  };

  /** Zet een item terug op pending en richt de cursor erop. */
  HSG.retryItem = function (queue, id) {
    const index = queue.items.findIndex((item) => item.id === id);
    if (index === -1) return queue;
    const next = HSG.updateItem(queue, id, {
      status: STATUS.PENDING,
      error: null,
      candidates: null,
    });
    return { ...next, cursor: index };
  };

  HSG.summarize = function (queue) {
    const counts = { pending: 0, filled: 0, done: 0, error: 0, needsChoice: 0 };
    for (const item of queue.items) {
      if (item.status === STATUS.DONE) counts.done += 1;
      else if (item.status === STATUS.ERROR) counts.error += 1;
      else if (item.status === STATUS.NEEDS_CHOICE) counts.needsChoice += 1;
      else if (item.status === STATUS.FILLED) counts.filled += 1;
      else counts.pending += 1;
    }
    return { total: queue.items.length, ...counts };
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);

// ==========================================================================
// userscript/src/store.js
// ==========================================================================

/**
 * Opslag. Vervangt de service worker van de extensieversie.
 *
 * Tampermonkey's `GM_setValue` is gedeeld tussen alle pagina's waar dit script
 * draait, dus Humble en SteamGifts kijken naar dezelfde wachtrij zonder dat er
 * berichten heen en weer hoeven. Dat scheelt de hele router.
 *
 * Wat we hier wél moeten oplossen en de extensie gratis kreeg: `GM_setValue`
 * schrijft naar schijf. Er is geen tegenhanger van `chrome.storage.session`.
 * Keys krijgen daarom een vervaldatum en worden gewist zodra ze geplakt zijn.
 */
'use strict';

(function (root) {
  const HSG = (root.HSG = root.HSG || {});

  const KEYS = {
    SETTINGS: 'settings',
    QUEUE: 'queue',
    CATALOG: 'catalog',
    SECRETS: 'secrets',
  };

  const read = (name, fallback) => {
    try {
      const raw = GM_getValue(name, null);
      if (raw == null) return fallback;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (error) {
      return fallback;
    }
  };

  const write = (name, value) => GM_setValue(name, JSON.stringify(value));

  const store = {
    // --- instellingen ---------------------------------------------------------

    getSettings() {
      return { ...HSG.DEFAULT_SETTINGS, ...read(KEYS.SETTINGS, {}) };
    },

    setSettings(patch) {
      const settings = { ...store.getSettings(), ...patch };
      write(KEYS.SETTINGS, settings);
      return settings;
    },

    // --- catalogus ------------------------------------------------------------

    getCatalog() {
      return read(KEYS.CATALOG, null);
    },

    setCatalog(catalog) {
      write(KEYS.CATALOG, catalog);
    },

    // --- wachtrij -------------------------------------------------------------

    getQueue() {
      return { ...HSG.emptyQueue(), ...read(KEYS.QUEUE, {}) };
    },

    setQueue(queue) {
      write(KEYS.QUEUE, queue);
      return queue;
    },

    /**
     * Lees-wijzig-schrijf op één plek. GM_setValue is synchroon, dus binnen één
     * pagina is dit veilig; twee tabbladen die tegelijk schrijven blijft een
     * theoretisch risico, maar in deze flow werkt er maar één tegelijk.
     */
    withQueue(mutator) {
      const result = mutator(store.getQueue());
      const queue = result && result.queue ? result.queue : result;
      return store.setQueue(queue || store.getQueue());
    },

    // --- keys -----------------------------------------------------------------

    /**
     * Keys staan als `{ key, at }` opgeslagen. De tijdstempel is er niet voor de
     * sier: dit is schijfopslag, dus alles wat te lang blijft liggen gooien we
     * weg in plaats van het te laten rondslingeren.
     */
    readSecrets() {
      const ttlHours = store.getSettings().keyTtlHours || 12;
      const cutoff = Date.now() - ttlHours * 3600 * 1000;
      const stored = read(KEYS.SECRETS, {});
      const kept = {};
      let dropped = 0;

      for (const [id, entry] of Object.entries(stored)) {
        if (!entry || !entry.key) continue;
        if (entry.at && entry.at < cutoff) {
          dropped += 1;
          continue;
        }
        kept[id] = entry;
      }
      if (dropped) write(KEYS.SECRETS, kept);
      return kept;
    },

    getKey(id) {
      const entry = store.readSecrets()[id];
      return entry ? entry.key : null;
    },

    hasKey(id) {
      return Boolean(store.getKey(id));
    },

    keyIds() {
      return Object.keys(store.readSecrets());
    },

    putKeys(pairs) {
      const secrets = store.readSecrets();
      const at = Date.now();
      for (const [id, key] of Object.entries(pairs || {})) {
        if (key) secrets[id] = { key, at };
      }
      write(KEYS.SECRETS, secrets);
    },

    forgetKey(id) {
      const secrets = store.readSecrets();
      if (!(id in secrets)) return;
      delete secrets[id];
      write(KEYS.SECRETS, secrets);
    },

    clearKeys() {
      write(KEYS.SECRETS, {});
    },

    // --- meeluisteren ---------------------------------------------------------

    /**
     * Wijzigingen uit een ander tabblad. Zo ziet het paneel op Humble dat de
     * SteamGifts-tab een giveaway heeft aangemaakt.
     */
    onChange(name, callback) {
      if (typeof GM_addValueChangeListener !== 'function') return;
      GM_addValueChangeListener(name, (key, oldValue, newValue, remote) => {
        callback({ remote });
      });
    },

    NAMES: KEYS,
  };

  // --- wachtrij-acties --------------------------------------------------------

  /**
   * Neemt de uitkomst van een reveal-ronde over: keys apart, metadata in de
   * wachtrij. Mislukte spellen komen wél in de lijst, met foutstatus, zodat je
   * ziet wat er niet gelukt is.
   */
  HSG.storeRevealResults = function (results) {
    const ok = [];
    const failed = [];
    const pairs = {};

    for (const result of results || []) {
      const id = HSG.itemId(result.gamekey, result.machineName);
      if (result.key) {
        pairs[id] = result.key;
        ok.push(result);
      } else {
        failed.push(result);
      }
    }
    store.putKeys(pairs);

    const queue = store.withQueue((current) => {
      let next = HSG.addItems(current, ok.concat(failed)).queue;

      // addItems laat bestaande items met rust. Een spel dat de vorige keer
      // mislukte en nu wél een key opleverde moet daarom expliciet terug op
      // pending, anders blijft het als fout in de wachtrij hangen.
      for (const result of ok) {
        const id = HSG.itemId(result.gamekey, result.machineName);
        const existing = next.items.find((item) => item.id === id);
        if (existing && existing.status === HSG.STATUS.ERROR) {
          next = HSG.updateItem(next, id, { status: HSG.STATUS.PENDING, error: null });
        }
      }
      for (const result of failed) {
        next = HSG.updateItem(next, HSG.itemId(result.gamekey, result.machineName), {
          status: HSG.STATUS.ERROR,
          error: result.error || 'Key ophalen mislukt',
        });
      }
      return { queue: next };
    });

    return { added: ok.length, failed: failed.length, queue };
  };

  HSG.store = store;
})(typeof globalThis !== 'undefined' ? globalThis : window);

// ==========================================================================
// userscript/src/styles.js
// ==========================================================================

/**
 * Opmaak.
 *
 * Het paneel leeft in een shadow root, dus die stijlen kunnen niet botsen met
 * Humble of SteamGifts — en andersom evenmin. Alleen de vinkjes die we in hún
 * pagina hangen hebben stijl in het document zelf nodig; die krijgen een eigen
 * voorvoegsel en `all: initial` waar het telt.
 */
'use strict';

(function (root) {
  const HSG = (root.HSG = root.HSG || {});

  /** Gaat in het gastdocument: het vinkje in een key-rij en de zwevende knop. */
  HSG.PAGE_CSS = `
.hsg-row-check {
  display: inline-flex !important;
  align-items: center;
  gap: 6px;
  margin-right: 10px;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(20, 22, 28, 0.9);
  color: #f2f4f8;
  font: 600 11px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  vertical-align: middle;
  cursor: pointer;
  user-select: none;
}
.hsg-row-check input {
  width: 13px;
  height: 13px;
  margin: 0;
  accent-color: #2f7de1;
  cursor: pointer;
}
.hsg-row-check.is-unavailable {
  opacity: 0.5;
  cursor: default;
}
.hsg-launcher {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483000;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 15px;
  border: 0;
  border-radius: 999px;
  background: #2f7de1;
  color: #fff;
  font: 600 13px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  cursor: pointer;
}
.hsg-launcher__count {
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.25);
}
`;

  /** Gaat in de shadow root van het paneel. */
  HSG.PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }

.wrap {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 380px;
  max-width: 100vw;
  z-index: 2147483001;
  display: flex;
  flex-direction: column;
  background: #16181d;
  color: #eef1f6;
  font: 400 13px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  box-shadow: -8px 0 30px rgba(0, 0, 0, 0.45);
}
.wrap[hidden] { display: none; }

header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px 8px;
}
h1 { flex: 1 1 auto; margin: 0; font-size: 15px; }
.summary { margin: 0 14px 8px; color: #9aa4b4; font-size: 12px; }

.tabs { display: flex; gap: 4px; padding: 0 14px; border-bottom: 1px solid #2c313a; }
.tab {
  padding: 7px 9px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: #9aa4b4;
  font: inherit;
  cursor: pointer;
}
.tab.is-active { border-bottom-color: #4b93ea; color: #eef1f6; font-weight: 600; }

.body { flex: 1 1 auto; overflow-y: auto; padding: 12px 14px 24px; }
.panel { display: none; }
.panel.is-active { display: block; }

.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.btn {
  padding: 6px 11px;
  border: 1px solid #2c313a;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.btn:hover:not(:disabled) { background: #1d2027; }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn--primary { border-color: transparent; background: #4b93ea; color: #fff; font-weight: 600; }
.btn--danger { color: #e0675e; }
.btn--tiny { padding: 2px 7px; font-size: 12px; }
.btn--icon { padding: 4px 9px; }

.notice {
  margin: 0 0 10px;
  padding: 8px 10px;
  border-left: 3px solid #d9a33c;
  border-radius: 4px;
  background: #1d2027;
  font-size: 12px;
}
.notice[data-tone='error'] { border-left-color: #e0675e; }
.notice[data-tone='ok'] { border-left-color: #4fbb75; }
.notice[hidden] { display: none; }

.hint, .empty { margin: 8px 0; color: #9aa4b4; font-size: 12px; }
.hint--warn { color: #d9a33c; }

.filter, input[type='number'], input[type='text'], select, textarea {
  display: block;
  width: 100%;
  margin-top: 3px;
  padding: 6px 8px;
  border: 1px solid #2c313a;
  border-radius: 6px;
  background: #16181d;
  color: inherit;
  font: inherit;
}
textarea { resize: vertical; }

ul, ol { margin: 0; padding: 0; list-style: none; }

.item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid #2c313a;
}
.item input[type='checkbox'] { margin-top: 3px; accent-color: #4b93ea; }
.item label { flex: 1 1 auto; overflow-wrap: anywhere; cursor: pointer; }
.tag { color: #9aa4b4; font-size: 11px; }

.queue-item { padding: 9px 0; border-bottom: 1px solid #2c313a; }
.queue-item.is-current { margin: 0 -8px; padding: 9px 8px; border-radius: 6px; background: #1d2027; }
.queue-head { display: flex; align-items: baseline; gap: 6px; }
.queue-name { flex: 1 1 auto; font-weight: 600; overflow-wrap: anywhere; }
.status { font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; }
.status[data-status='done'] { color: #4fbb75; }
.status[data-status='error'], .status[data-status='needs-choice'] { color: #e0675e; }
.status[data-status='filled'] { color: #d9a33c; }
.queue-meta { color: #9aa4b4; font-size: 12px; overflow-wrap: anywhere; }
.queue-tools { display: flex; gap: 4px; margin-top: 4px; }

fieldset { margin: 0 0 14px; padding: 10px 12px; border: 1px solid #2c313a; border-radius: 8px; }
legend { padding: 0 4px; color: #9aa4b4; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
label.row { display: block; margin-bottom: 8px; font-size: 12px; }
label.check { display: flex; align-items: center; gap: 7px; margin-bottom: 8px; font-size: 12px; }
label.check input { width: auto; margin: 0; accent-color: #4b93ea; }

.check-row { display: flex; gap: 7px; padding: 5px 0; border-bottom: 1px solid #2c313a; font-size: 12px; }
.check-row__mark { font-weight: 700; }
.check-row.is-ok .check-row__mark { color: #4fbb75; }
.check-row.is-bad .check-row__mark { color: #e0675e; }
.check-row__body { flex: 1 1 auto; overflow-wrap: anywhere; }
.check-row__detail {
  display: block;
  color: #9aa4b4;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}
h2 { margin: 14px 0 4px; font-size: 13px; }
`;
})(typeof globalThis !== 'undefined' ? globalThis : window);

// ==========================================================================
// userscript/src/panel.js
// ==========================================================================

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
          <label class="check"><input type="checkbox" name="regionFromHumble" /> Regio overnemen van Humble</label>
          <p class="hint">
            Humble geeft per spel door waar de key niet werkt. Aan betekent: de
            giveaway wordt beperkt tot de landen waar hij wél werkt.
            Aangevinkt land = mag meedoen.
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

// ==========================================================================
// userscript/src/humble.js
// ==========================================================================

/**
 * De Humble-kant: keys van de keys-pagina lezen, aanvullen via de JSON-API, en
 * onthullen wat nog verborgen is.
 *
 * Geport uit de extensieversie. Wat verdween is de berichtenlaag — hier praat
 * alles binnen één script, dus de service worker en zijn router zijn overbodig.
 * Wat bleef is de kennis van de pagina, en die zit in `lib/selectors.js`.
 *
 * De rij ziet er zo uit:
 *   <tr>
 *     <td class="platform"><i class="hb hb-key hb-steam"></i></td>
 *     <td class="game-name"><h4>Dicefolk</h4>
 *       <p><a href="/download?key=…">July 2026 Humble Choice</a></p></td>
 *     <td class="js-redeemer-cell">… <div class="js-keyfield keyfield redeemed enabled" title="…">
 *   </tr>
 */
'use strict';

(function (root) {
  const HSG = (root.HSG = root.HSG || {});
  const H = HSG.SELECTORS.humble;
  const MAX_ORDERS_PER_SCAN = 12;

  const state = {
    gamekey: null,
    csrf: null,
    games: [],
    byId: new Map(),
    domKeys: new Map(),
    domNodes: new Map(),
    apiEntries: [],
    fetchedOrders: new Set(),
    bundles: [],
    truncatedOrders: 0,
    source: null,
    scanError: null,
    scannedSignature: null,
  };

  const isKeysPage = () =>
    location.pathname.startsWith('/home/keys') || location.pathname.startsWith('/download');
  const isMembership = () => /^\/(membership|subscription)(\/|$)/.test(location.pathname);

  // --- herkomst ---------------------------------------------------------------

  function readPageModel() {
    for (const id of H.modelScriptIds) {
      const node = document.getElementById(id);
      if (!node || !node.textContent) continue;
      try {
        return JSON.parse(node.textContent.trim());
      } catch (error) {
        // Volgende kandidaat.
      }
    }
    return null;
  }

  function readGamekey() {
    const fromUrl = new URLSearchParams(location.search).get('key');
    if (fromUrl) return fromUrl;
    const model = readPageModel();
    const options = model && model.contentChoiceOptions;
    return (options && options.gamekey) || (model && model.gamekey) || null;
  }

  function readCsrfToken() {
    const model = readPageModel();
    const raw = model && model.csrfTokenInput;
    const fromModel = typeof raw === 'string' && raw.match(/value=["']([^"']+)["']/);
    if (fromModel) return fromModel[1];

    const input = document.querySelector(H.csrfInput);
    const fromDom = input && input.getAttribute('value');
    if (fromDom) return fromDom;

    const cookie = document.cookie.match(/(?:^|;\s*)csrf_cookie=([^;]+)/);
    return cookie ? decodeURIComponent(cookie[1]) : null;
  }

  // --- DOM --------------------------------------------------------------------

  function findRow(keyField) {
    for (const selector of H.rowContainers) {
      const row = keyField.closest(selector);
      if (row && row !== keyField) return row;
    }
    return keyField.parentElement || keyField;
  }

  function rowTexts(row, keyField) {
    const texts = [];
    for (const node of row.querySelectorAll('*')) {
      if (node.children.length > 0) continue;
      if (keyField.contains(node) || node === keyField) continue;
      texts.push(node.textContent);
    }
    return texts;
  }

  /**
   * Staat er een echt naamelement in de rij, dan is dat het antwoord. De
   * heuristiek is alleen terugval: die koos ooit de disclaimer die in élke rij
   * staat, waarna alle rijen dezelfde naam kregen en de lijst tot één regel
   * samenklapte.
   */
  function readRowName(row, keyField) {
    const named = row.querySelector(H.rowName);
    if (named && !keyField.contains(named)) {
      const text = named.textContent.replace(/\s+/g, ' ').trim();
      if (text) return text;
    }
    return HSG.pickRowName(rowTexts(row, keyField));
  }

  function readRowBundle(row) {
    const link = row.querySelector(H.rowBundleLink);
    if (!link) return { gamekey: null, bundleName: null };
    return {
      gamekey: HSG.parseOrderKey(link.getAttribute('href')),
      bundleName: link.textContent.replace(/\s+/g, ' ').trim() || null,
    };
  }

  function rowPlatform(row) {
    for (const node of row.querySelectorAll(H.platformIcon)) {
      const platform = HSG.detectPlatform(node.className);
      if (platform) return platform;
    }
    return HSG.detectPlatform(row.className);
  }

  function domSignature() {
    const fields = document.querySelectorAll(H.keyField);
    if (fields.length === 0) return '0';
    const first = fields[0];
    const last = fields[fields.length - 1];
    return [
      fields.length,
      readRowName(findRow(first), first) || '',
      readRowName(findRow(last), last) || '',
    ].join('|');
  }

  function scanDom() {
    const entries = [];
    const used = new Set();

    document.querySelectorAll(H.keyField).forEach((keyField, index) => {
      const row = findRow(keyField);
      const humanName = readRowName(row, keyField);
      if (!humanName) return;

      const bundle = readRowBundle(row);
      const revealedKey = keyField.classList.contains(H.redeemedClass)
        ? (keyField.getAttribute('title') || '').trim()
        : '';
      const unavailable = keyField.classList.contains(H.disabledClass) && !revealedKey;

      const slug = HSG.normalizeTitle(humanName).replace(/\s+/g, '-') || `rij-${index}`;
      let id = HSG.itemId(bundle.gamekey || state.gamekey || 'dom', slug);
      if (used.has(id)) {
        let suffix = 2;
        while (used.has(`${id}-${suffix}`)) suffix += 1;
        id = `${id}-${suffix}`;
      }
      used.add(id);

      entries.push({
        id,
        machineName: null,
        humanName,
        gamekey: bundle.gamekey || state.gamekey || null,
        keyindex: null,
        steamAppId: null,
        keyType: rowPlatform(row),
        revealed: Boolean(revealedKey),
        unavailable,
        disallowedCountries: [],
        exclusiveCountries: [],
        bundleName: bundle.bundleName,
        fromDom: true,
      });

      if (revealedKey) state.domKeys.set(id, revealedKey);
      state.domNodes.set(id, keyField);
    });

    return entries;
  }

  // --- API --------------------------------------------------------------------

  async function fetchJson(url) {
    const response = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Humble antwoordde met ${response.status} op ${url}`);
    return response.json();
  }

  const fetchOrder = (gamekey) =>
    fetchJson(`/api/v1/order/${encodeURIComponent(gamekey)}?all_tpkds=true`);

  async function fetchAllOrders() {
    const list = await fetchJson('/api/v1/user/order');
    const gamekeys = (list || []).map((entry) => entry.gamekey).filter(Boolean);
    const orders = [];
    for (let i = 0; i < gamekeys.length; i += 20) {
      const params = new URLSearchParams();
      params.set('all_tpkds', 'true');
      for (const gamekey of gamekeys.slice(i, i + 20)) params.append('gamekeys', gamekey);
      const bulk = await fetchJson(`/api/v1/orders?${params.toString()}`);
      orders.push(...Object.values(bulk || {}));
    }
    return orders;
  }

  function toApiEntries(order) {
    const gamekey = order && order.gamekey;
    const tpks = (order && order.tpkd_dict && order.tpkd_dict.all_tpks) || [];
    return tpks.filter(HSG.isUsableTpk).map((tpk) => ({
      id: HSG.itemId(gamekey, tpk.machine_name),
      machineName: tpk.machine_name,
      humanName: tpk.human_name || tpk.machine_name,
      gamekey,
      keyindex: tpk.keyindex != null ? tpk.keyindex : 0,
      steamAppId: HSG.normalizeAppId(tpk.steam_app_id),
      keyType: 'steam',
      revealed: Boolean(tpk.redeemed_key_val),
      unavailable: false,
      disallowedCountries: tpk.disallowed_countries || [],
      exclusiveCountries: tpk.exclusive_countries || [],
      bundleName: (order.product && order.product.human_name) || null,
      fromDom: false,
    }));
  }

  function merge(domEntries, apiEntries) {
    const byBundleAndName = new Map();
    const byName = new Map();
    for (const entry of apiEntries) {
      const name = HSG.normalizeTitle(entry.humanName);
      byBundleAndName.set(`${entry.gamekey}|${name}`, entry);
      if (!byName.has(name)) byName.set(name, entry);
    }

    const merged = [];
    const usedApi = new Set();

    for (const domEntry of domEntries) {
      const name = HSG.normalizeTitle(domEntry.humanName);
      const candidate =
        (domEntry.gamekey && byBundleAndName.get(`${domEntry.gamekey}|${name}`)) ||
        byName.get(name);
      const match = candidate && !usedApi.has(candidate.id) ? candidate : null;

      if (!match) {
        merged.push(domEntry);
        continue;
      }
      usedApi.add(match.id);

      // De id verspringt naar die van de API-regel; de al gelezen key en het
      // DOM-element moeten mee, anders raken we ze kwijt.
      const domKey = state.domKeys.get(domEntry.id);
      const node = state.domNodes.get(domEntry.id);
      if (domKey) state.domKeys.set(match.id, domKey);
      if (node) state.domNodes.set(match.id, node);

      merged.push({
        ...match,
        revealed: match.revealed || domEntry.revealed,
        unavailable: domEntry.unavailable,
        bundleName: domEntry.bundleName || match.bundleName,
      });
    }

    // Regels uit dezelfde order die hier niet getoond worden horen er ook bij:
    // dat is meteen het antwoord op Humble's paginering.
    for (const entry of apiEntries) {
      if (!usedApi.has(entry.id)) merged.push(entry);
    }
    return merged;
  }

  async function scan(scope) {
    state.scanError = null;
    state.gamekey = readGamekey();
    state.csrf = readCsrfToken();
    state.domNodes.clear();

    if (scope !== 'dom') {
      state.domKeys.clear();
      state.apiEntries = [];
      state.fetchedOrders = new Set();
      state.truncatedOrders = 0;
    }

    const domEntries = scanDom();
    state.bundles = Array.from(
      new Set(domEntries.map((entry) => entry.bundleName).filter(Boolean))
    );

    let apiError = null;
    try {
      if (scope === 'library') {
        state.apiEntries = (await fetchAllOrders()).flatMap(toApiEntries);
      } else {
        const wanted = new Set(domEntries.map((entry) => entry.gamekey).filter(Boolean));
        if (state.gamekey) wanted.add(state.gamekey);

        const missing = Array.from(wanted).filter((key) => !state.fetchedOrders.has(key));
        const room = Math.max(0, MAX_ORDERS_PER_SCAN - state.fetchedOrders.size);
        const take = missing.slice(0, room);
        state.truncatedOrders += missing.length - take.length;

        const settled = await Promise.allSettled(take.map(fetchOrder));
        settled.forEach((result, index) => {
          state.fetchedOrders.add(take[index]);
          if (result.status === 'fulfilled') {
            state.apiEntries.push(...toApiEntries(result.value));
          } else {
            apiError = String((result.reason && result.reason.message) || result.reason);
          }
        });
      }
    } catch (error) {
      apiError = String(error.message || error);
    }

    const apiEntries = state.apiEntries;
    const games = domEntries.length > 0 ? merge(domEntries, apiEntries) : apiEntries.slice();
    state.source = domEntries.length
      ? apiEntries.length
        ? 'dom+api'
        : 'dom'
      : apiEntries.length
        ? 'api'
        : 'leeg';

    games.sort((a, b) => a.humanName.localeCompare(b.humanName, 'nl'));
    state.games = games;
    state.byId = new Map(games.map((game) => [game.id, game]));
    state.scannedSignature = domSignature();
    state.scanError = apiError;

    publish();
    injectRowCheckboxes();
    return games;
  }

  function publish() {
    HSG.store.setCatalog({
      // Nooit keys meesturen: dit gaat naar de schijf.
      games: state.games,
      gamekey: state.gamekey,
      pageUrl: location.href,
      source: state.source,
      bundles: state.bundles,
      truncatedOrders: state.truncatedOrders,
      apiError: state.scanError,
    });
  }

  // --- onthullen --------------------------------------------------------------

  async function revealViaApi(game) {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' };
    if (state.csrf) headers['CSRF-Prevention-Token'] = state.csrf;

    const response = await fetch('/humbler/redeemkey', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: new URLSearchParams({
        keytype: game.machineName,
        key: game.gamekey,
        keyindex: String(game.keyindex != null ? game.keyindex : 0),
      }),
    });

    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      throw new Error(`Onverwacht antwoord van Humble (HTTP ${response.status})`);
    }
    if (!data || data.success !== true || !data.key) {
      const reason = data && (data.error_msg || data.error);
      throw new Error(reason ? String(reason) : 'Onthullen mislukt');
    }
    return data.key;
  }

  async function revealViaDom(game) {
    const node = state.domNodes.get(game.id);
    if (!node) throw new Error('Geen keyveld op deze pagina gevonden.');

    const existing = (node.getAttribute('title') || '').trim();
    if (existing) return existing;

    HSG.clickWidget(node.querySelector(H.keyFieldValue) || node);
    const value = await HSG.waitForAttribute(node, 'title', { timeout: 15000 });
    const key = String(value || '').trim();
    if (!key) throw new Error('Het keyveld bleef leeg.');
    return key;
  }

  async function revealKeys(ids) {
    if (state.byId.size === 0) await scan('page');

    let wanted = ids.map((id) => state.byId.get(id)).filter(Boolean);
    if (wanted.length === 0) {
      await scan('page');
      wanted = ids.map((id) => state.byId.get(id)).filter(Boolean);
    }
    if (wanted.length === 0) {
      throw new Error(
        `Deze ${ids.length === 1 ? 'key staat' : 'keys staan'} niet op deze pagina. Ga naar de Humble-pagina waar ze staan en scan opnieuw.`
      );
    }

    // Eén keer de order ophalen levert alle al onthulde keys in één klap.
    const known = new Map();
    const gamekeys = Array.from(new Set(wanted.map((game) => game.gamekey).filter(Boolean)));
    for (const gamekey of gamekeys) {
      try {
        const order = await fetchOrder(gamekey);
        const tpks = (order && order.tpkd_dict && order.tpkd_dict.all_tpks) || [];
        for (const tpk of tpks) {
          if (!tpk.redeemed_key_val) continue;
          known.set(HSG.itemId(gamekey, tpk.machine_name), tpk.redeemed_key_val);
        }
      } catch (error) {
        // Niet fataal: terugval op de DOM of op onthullen.
      }
    }

    const delayMs = HSG.store.getSettings().revealDelayMs;
    const results = [];

    for (let i = 0; i < wanted.length; i += 1) {
      const game = wanted[i];
      const base = {
        machineName: game.machineName || game.id.split(':').pop(),
        humanName: game.humanName,
        gamekey: game.gamekey || 'dom',
        keyindex: game.keyindex != null ? game.keyindex : 0,
        steamAppId: game.steamAppId,
        disallowedCountries: game.disallowedCountries || [],
        exclusiveCountries: game.exclusiveCountries || [],
      };
      try {
        const cached = state.domKeys.get(game.id) || known.get(game.id) || null;
        let key = cached;
        let didReveal = false;

        if (!key && game.unavailable) throw new Error('Humble biedt deze key niet meer aan.');
        if (!key) {
          key =
            game.machineName && game.gamekey
              ? await revealViaApi(game)
              : await revealViaDom(game);
          didReveal = true;
        }

        results.push({ ...base, key, wasAlreadyRevealed: !didReveal });
        game.revealed = true;
        state.domKeys.set(game.id, key);
        if (didReveal && i < wanted.length - 1) await HSG.sleep(delayMs);
      } catch (error) {
        results.push({ ...base, error: String(error.message || error) });
      }
    }

    publish();
    injectRowCheckboxes();
    return results;
  }

  // --- vinkjes in de rijen ----------------------------------------------------

  /**
   * Een <label> rechtstreeks in een <tr> is ongeldige HTML — de browser schuift
   * hem dan buiten de tabel. Het gaat dus in een cel, en bij voorkeur de
   * naamcel: de eerste cel bevat alleen een icoontje en is zo smal dat het
   * vinkje daar makkelijk buiten beeld valt.
   */
  function checkboxHost(row) {
    if (row.tagName !== 'TR') return row;
    return row.querySelector('.game-name') || row.querySelector('td, th') || row;
  }

  function injectRowCheckboxes() {
    for (const game of state.games) {
      const keyField = state.domNodes.get(game.id);
      if (!keyField) continue;
      const row = findRow(keyField);
      if (!row || row.querySelector('.hsg-row-check')) continue;

      const label = document.createElement('label');
      label.className = `hsg-row-check${game.unavailable ? ' is-unavailable' : ''}`;
      label.dataset.hsgId = game.id;
      label.title = `${game.humanName} — aanvinken om weg te geven`;

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = HSG.panel.isSelected(game.id);
      input.disabled = Boolean(game.unavailable);
      input.addEventListener('change', () => HSG.panel.setSelected(game.id, input.checked));

      const text = document.createElement('span');
      text.textContent = 'Giveaway';
      label.append(input, text);
      label.addEventListener('click', (event) => event.stopPropagation());
      const host = checkboxHost(row);
      host.insertBefore(label, host.firstChild);
    }
  }

  /** Vinkjes gelijktrekken nadat de selectie elders veranderde. */
  function syncSelection() {
    document.querySelectorAll('.hsg-row-check').forEach((label) => {
      const input = label.querySelector('input');
      const wanted = HSG.panel.isSelected(label.dataset.hsgId);
      if (input && input.checked !== wanted) input.checked = wanted;
    });
  }

  // --- diagnose ---------------------------------------------------------------

  function sampleRow() {
    const keyField = document.querySelector(H.keyField);
    if (!keyField) return 'geen keyveld op deze pagina';
    return findRow(keyField)
      .outerHTML.replace(/title="[^"]*"/g, 'title="KEY-WEGGELATEN"')
      .replace(/[A-Z0-9]{5}(-[A-Z0-9]{5}){2,4}/gi, 'KEY-WEGGELATEN')
      .slice(0, 900);
  }

  async function diagnose() {
    const keyFields = document.querySelectorAll(H.keyField);
    const redeemed = document.querySelectorAll(`${H.keyField}.${H.redeemedClass}`);
    const gamekey = readGamekey();
    const domEntries = scanDom();
    const bundles = Array.from(
      new Set(domEntries.map((entry) => entry.bundleName).filter(Boolean))
    );

    const checks = [
      {
        label: 'Soort pagina',
        ok: isKeysPage(),
        detail: isKeysPage()
          ? location.pathname
          : `${location.pathname} — open je keys-pagina (/home/keys of /download?key=…)`,
      },
      {
        label: 'Keyvelden op de pagina',
        ok: keyFields.length > 0,
        detail: `${keyFields.length} gevonden, waarvan ${redeemed.length} al onthuld`,
      },
      {
        // Ongelijke aantallen betekenen dat rijen samenklappen doordat ze
        // dezelfde naam krijgen — precies de fout die dit ooit tot één regel
        // terugbracht.
        label: 'Rijen met een leesbare naam',
        ok: domEntries.length === keyFields.length && domEntries.length > 0,
        detail: `${domEntries.length} van ${keyFields.length} keyvelden`,
      },
      {
        label: 'Gelezen spelnamen',
        ok: domEntries.length > 0,
        detail: domEntries.slice(0, 6).map((entry) => entry.humanName).join(' · ') || 'geen',
      },
      {
        label: 'Bundels op deze pagina',
        ok: domEntries.some((entry) => entry.gamekey),
        detail: bundles.length
          ? `${bundles.length} bundel(s), ${domEntries.filter((e) => e.gamekey).length} rijen met order-sleutel — ${bundles.slice(0, 4).join(' · ')}`
          : 'geen bundellink gevonden — dan missen de Steam-appids',
      },
      { label: 'CSRF-token', ok: Boolean(readCsrfToken()), detail: readCsrfToken() ? 'gevonden' : 'niet gevonden' },
    ];

    const probeKey = gamekey || (domEntries.find((entry) => entry.gamekey) || {}).gamekey || null;
    let apiOk = false;
    let apiDetail = 'overgeslagen: geen order-sleutel gevonden';
    try {
      if (probeKey) {
        const order = await fetchOrder(probeKey);
        const tpks = (order && order.tpkd_dict && order.tpkd_dict.all_tpks) || [];
        apiOk = true;
        apiDetail = `${tpks.length} keys in die order, waarvan ${tpks.filter(HSG.isUsableTpk).length} bruikbare Steam-keys`;
      }
    } catch (error) {
      apiDetail = String(error.message || error);
    }
    checks.push({ label: 'Humble JSON-API', ok: apiOk || !probeKey, detail: apiDetail });
    checks.push({ label: 'Voorbeeldrij (keys weggelaten)', ok: true, detail: sampleRow() });

    return { site: 'humble', checks };
  }

  // --- opstarten --------------------------------------------------------------

  async function boot() {
    HSG.site = { name: 'humble', scan, revealKeys, diagnose, syncSelection };
    HSG.panel.mount();

    if (isMembership()) {
      HSG.panel.notice(
        'Haal hier de spellen op die je wilt weggeven en ga daarna naar humblebundle.com/home/keys.',
        'ok'
      );
      return;
    }
    if (!isKeysPage()) return;

    try {
      await scan('page');
      HSG.panel.render();
    } catch (error) {
      HSG.panel.notice(`Scannen mislukt: ${String(error.message || error)}`, 'error');
    }

    // De keys-pagina laadt rijen bij en hertekent bij het bladeren. Alleen echt
    // opnieuw scannen als de rijen veranderd zijn: elke scan schrijft naar de
    // opslag, en dat liet het paneel hertekenen terwijl je aan het aanvinken was.
    let timer = null;
    const observer = new MutationObserver((mutations) => {
      const fromPage = mutations.some((mutation) => {
        const target = mutation.target;
        return !(target instanceof Element) || !target.closest('.hsg-row-check, .hsg-launcher');
      });
      if (!fromPage) return;

      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (domSignature() === state.scannedSignature) {
          injectRowCheckboxes();
          syncSelection();
          return;
        }
        await scan('dom').catch(() => null);
        HSG.panel.render();
      }, 600);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  HSG.humble = { boot };
})(typeof globalThis !== 'undefined' ? globalThis : window);

// ==========================================================================
// userscript/src/steamgifts.js
// ==========================================================================

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
   * De regio. Op SteamGifts betekent aangevinkt "mag meedoen"; Humble zegt het
   * omgekeerd met `disallowed_countries`, en met `exclusive_countries` zelfs
   * "alleen hier". Zie HSG.allowedCountries.
   */
  async function fillRegion(item, settings) {
    const notes = [];
    const blocked = (item.disallowedCountries || []).filter(Boolean);
    const exclusive = (item.exclusiveCountries || []).filter(Boolean);
    const fromHumble =
      settings.regionFromHumble !== false && (blocked.length > 0 || exclusive.length > 0);

    if (!fromHumble) {
      if (!selectOption(SG.regionRestricted, settings.regionRestricted ? '1' : '0')) {
        notes.push('Regio-optie niet gevonden.');
      }
      if (settings.regionRestricted) {
        const list = await HSG.waitForElement(SG.countryList, { timeout: 5000 }).catch(() => null);
        if (!list) notes.push('Landenlijst niet gevonden.');
        else {
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
        }
      }
      if (blocked.length || exclusive.length) {
        notes.push(
          `Let op: Humble heeft regio-informatie voor dit spel, maar "regio overnemen van Humble" staat uit.`
        );
      }
      return notes;
    }

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
      blocked,
      exclusive
    );

    // Sluit dit niets uit, dan zou "beperken" alles toestaan — misleidender dan
    // geen restrictie.
    if (blockedCodes.length === 0) {
      selectOption(SG.regionRestricted, '0');
      notes.push(
        `Humble noemt ${blocked.length + exclusive.length} landen, maar geen daarvan komt voor in de lijst van SteamGifts. Regio-restrictie uit gelaten — stel dit zelf in.`
      );
      return notes;
    }

    HSG.syncItemList(list, allowedIds, 0);
    notes.push(
      exclusive.length
        ? `Humble geeft deze key alleen vrij in ${exclusive.length} landen; ${allowedIds.length} daarvan staan aangevinkt (aangevinkt = mag meedoen).`
        : `Regio overgenomen van Humble: ${allowedIds.length} landen aangevinkt en dus toegestaan, ${blockedCodes.length} uitgezet.`
    );
    if (unknownCodes.length) {
      notes.push(`${unknownCodes.length} landcode(s) kent SteamGifts niet (${unknownCodes.slice(0, 6).join(', ')}).`);
    }
    if (unmapped.length) {
      notes.push(`${unmapped.length} land(en) zonder leesbare landcode.`);
    }
    return notes;
  }

  async function fillForm(item, key, settings, resolved) {
    const notes = [];

    fillGame(resolved.id, resolved.name);
    if (!selectOption(SG.type, 'key')) notes.push('Kon het type niet op "key" zetten.');
    await HSG.waitForElement(SG.keyString, { timeout: 5000 }).catch(() => null);

    const copies = q(SG.copies);
    if (copies) HSG.setNativeValue(copies, String(settings.copies || 1));

    const schedule = HSG.computeSchedule(settings, new Date());
    if (!fillDate(SG.startTime, schedule.startText)) notes.push('Starttijd niet gevonden.');
    if (!fillDate(SG.endTime, schedule.endText)) notes.push('Eindtijd niet gevonden.');

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

    const description = q(SG.description);
    if (description) HSG.setNativeValue(description, settings.description || '');

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
      notes = await fillForm(item, key, settings, resolved.match);
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

// ==========================================================================
// userscript/src/boot.js
// ==========================================================================

/**
 * Welke site zijn we? Eén script, twee gastheren.
 */
'use strict';

(function (root) {
  const HSG = (root.HSG = root.HSG || {});

  function start() {
    try {
      if (location.host === 'www.humblebundle.com') HSG.humble.boot();
      else if (location.host === 'www.steamgifts.com') HSG.steamgifts.boot();
    } catch (error) {
      console.error('[Humble → SteamGifts]', HSG.redact(String(error && error.stack) || error));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);

})();
