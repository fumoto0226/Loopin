// Emoji avatar pool — copied from CollabSync so the same emoji renders identically in both apps.
const EMOJI_POOL = `🐶🐰🐻‍❄️🐮🐵🐒🐤🐱🦊🐨🐷🙈🐣🐭🐻🐯🐽🙉🐧🐥🐹🐼🦁🙊🐦🪿🦆🦄🐜🦟🐦‍⬛🐺🦋🦅🐗🐝🐌🪲🦉🐴🐞🦖🪼🐳🐊🦍🦐🦧🐙🦞🐟🦀🐬🦭🐩🐈‍⬛🦥🦔🕊️🦜🐇🦫🐀🐉🦃🦢🦝🦦🐿️🐲🐦‍🔥🍏🍋🍇🍒🥥🥑🥒🍎🍋‍🟩🍓🍑🥝🫛🌶️🍐🍌🫐🥭🍅🥦🫑🍊🍉🍈🍍🍆🌽🥕🥔🥐🥨🥩🌭🫒🍣🍤🥪🍱🍙🥫🥟🍚🥗🍘🍥🍡🍿🥜🥠🍧🧁🍭🍩🥛🍯🍪🌰🍫🎂🍦🍢🍬🍰🍨🥮🍼🧊⚽️🥎🥏🏀🎾🎱🏈🏐🪀⚾️🏉🏓🚗🚨🚘🚃✈️🚀🛟⛺️⛰️🏠💿📟☎️💎🧨🔮💈💊🩸🧽🎁🛎️🪣🎈💛🧡❤️🩷💚🩵💙💜🤎🤍🩶🖤💔❤️‍🔥❤️‍🩹💝💘💖💗⚠️🔰💢😀😆🤣😇😌😗😛😃🥹🥲🙂😍😙😝😄😅☺️🙃🥰😚😜😁😂😊😉😘😋🤪🤨🥸😩😤🧐🤩🥺😠🤓🥳🙂‍↔️😖😢😡😎😫😭🤬🤯😶‍🌫️😱😳🥵🥶😰🫥🫨🤥🫠🫡🙄😵‍💫🤤😵😴🥱😪😮‍💨🤢😈🤡🤑🤧🤐🤕💩👽👻💀☠️🎃👾🤖💩🤡🤲👊😻🙀👌🫀👀👷‍♂️🧑‍💻👩‍💻🧑‍🚀🥷🙅‍♂️🙅‍♀️💆‍♂️🙎‍♂️🙎‍♀️🤷‍♀️🤦‍♂️🤦🤦‍♀️🩳🧤🍄🌏⭐️🍔🌭🍟🍖🥩🥪🧀`;

const _splitGraphemes = (input) => {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
    return Array.from(seg.segment(input), s => s.segment);
  }
  return Array.from(input);
};
const EMOJIS = _splitGraphemes(EMOJI_POOL).filter(e => /\p{Extended_Pictographic}/u.test(e));
const EMOJI_SET = new Set(EMOJIS);

function pickRandomEmoji() { return EMOJIS[Math.floor(Math.random() * EMOJIS.length)]; }
function normalizeEmoji(e) { return EMOJI_SET.has(e) ? e : '🙂'; }
