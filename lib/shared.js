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

  if (typeof module === 'object' && module.exports) {
    module.exports = HSG;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
