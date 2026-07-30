/**
 * Alle site-specifieke selectors op één plek.
 *
 * Humble en SteamGifts kunnen hun opmaak wijzigen zonder ons te waarschuwen.
 * Door alles hier te bundelen is zo'n wijziging één bestand aanpassen in plaats
 * van een zoektocht door de hele extensie. De diagnose-functie in het zijpaneel
 * controleert precies deze lijst.
 *
 * Herkomst van de SteamGifts-selectors: ESGST (MultipleGiveawayCreator.jsx en
 * GiveawayTemplates.jsx), dat dit formulier al jaren aanstuurt.
 */
'use strict';

(function (root) {
  const HSG = (root.HSG = root.HSG || {});

  HSG.SELECTORS = {
    humble: {
      /** JSON-blobs waar Humble het paginamodel in serverrendert, op volgorde van voorkeur. */
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
      /** Ongescopet matcht [name="whitelist"] ook iets in de groepenlijst. */
      whitelist: '.form__row--who-can-enter [name="whitelist"]',
      groupItemString: '[name="group_item_string"]',
      groupList: '.form_list[data-input="group_item_string"]',

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

  if (typeof module === 'object' && module.exports) {
    module.exports = HSG;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
