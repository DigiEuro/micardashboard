(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MicarLegalName = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Preserve the source name everywhere in the data model. This formatter is
  // only for presentation, and only changes words supplied in all caps.
  const WORD_OVERRIDES = {
    BITFLYER: 'bitFlyer',
    CAIXABANK: 'CaixaBank',
    CHECKSIG: 'CheckSig',
    CO: 'Co',
    COINSHARES: 'CoinShares',
    COMPLYCRYPTO: 'ComplyCrypto',
    CIE: 'Cie',
    DUE: 'Due',
    GMBH: 'GmbH',
    INC: 'Inc',
    LTD: 'Ltd',
    PAY: 'Pay'
  };

  const MINOR_WORDS = new Set([
    'AND', 'DA', 'DAS', 'DE', 'DEL', 'DER', 'DI', 'DO', 'DOS', 'DU',
    'ET', 'FOR', 'IN', 'LA', 'LE', 'OF', 'THE', 'UND', 'VAN', 'VON', 'Y'
  ]);

  const LONG_ACRONYMS = new Set([
    'EOOD', 'EООD', 'SARL', 'SASU', 'SICAV'
  ]);

  function titleCase(word) {
    const lower = word.toLocaleLowerCase('en');
    return lower.replace(/^\p{L}/u, function (letter) {
      return letter.toLocaleUpperCase('en');
    });
  }

  function formatLegalName(value) {
    const source = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    let wordIndex = 0;

    return source.replace(/\p{L}+/gu, function (word) {
      const upper = word.toLocaleUpperCase('en');
      const lower = word.toLocaleLowerCase('en');
      const isUppercaseWord = upper !== lower && word === upper;
      const isFirstWord = wordIndex === 0;
      wordIndex += 1;

      if (!isUppercaseWord) return word;
      if (WORD_OVERRIDES[upper]) return WORD_OVERRIDES[upper];
      if (MINOR_WORDS.has(upper)) return isFirstWord ? titleCase(word) : lower;
      if (word.length <= 3 || LONG_ACRONYMS.has(upper)) return word;
      return titleCase(word);
    });
  }

  return { formatLegalName };
}));
