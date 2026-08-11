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

    steamdb: {
      /**
       * De pakketlijst op /app/<appid>/subs/. Geverifieerd (2022–2024):
       *   <tr class="package" data-subid="164520">
       *     <td><a href="/sub/164520/">164520</a></td>
       *     <td>PLAYERUNKNOWN'S BATTLEGROUNDS - Turkey Retail Keys</td>
       *     <td></td>
       *     <td>CD Key<br><small>(Buy Restrict)</small></td> …
       */
      packageRow: 'tr.package[data-subid], tr[data-subid]',
      subLink: 'a[href*="/sub/"]',

      /**
       * De regiovelden op een pakketpagina staan als tekst in een gewone
       * key/value-tabel; we matchen op de veldnaam zelf, niet op CSS-klassen —
       * die zijn al eens veranderd. In de waardecel staan de landcodes vóór een
       * <hr>; daarna volgen vlaggetjes met volledige landnamen.
       */
      infoRow: 'tr',

      /** Billing-type teksten die betekenen "hier worden keys tegen aangemaakt". */
      cdKeyPattern: /cd key|proof of prepurchase/i,
      /** SteamDB's eigen markering dat een pakket een aankooprestrictie heeft. */
      buyRestrictPattern: /buy restrict/i,
      /**
       * "The data for this package may be outdated, as our bot can no longer
       * access the package info." — dan is "geen restrictierij" geen bewijs.
       */
      stalePattern: /data for this (?:package|app) may be outdated|bot can no longer access/i,
      /** Lege pakketlijst omdat SteamDB een token mist. */
      noPackagesPattern: /not included in any package known to us|needs a token to access/i,
      /** Cloudflare-tussenpagina's, oud en nieuw. */
      challengePattern: /just a moment|__cf_chl|cf-browser-verification|complete_sec_check|challenge-platform/i,
    },
  };

  /** Een aanklikbare widget-optie, bijv. checkboxValue('key') of checkboxValue('everyone'). */
  HSG.checkboxValue = function (value) {
    return `[data-checkbox-value="${value}"]`;
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = HSG;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
