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

  /** Leest de opties uit zo'n lijst, zodat het zijpaneel ze kan tonen. */
  HSG.readItemList = function (listEl, skipFirst) {
    if (!listEl) return [];
    return Array.from(listEl.children)
      .slice(skipFirst || 0)
      .map((child) => ({
        id: child.getAttribute('data-item-id'),
        name: (child.getAttribute('data-name') || child.textContent || '').trim(),
        selected: child.classList.contains('is-selected'),
      }))
      .filter((item) => item.id);
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = HSG;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
