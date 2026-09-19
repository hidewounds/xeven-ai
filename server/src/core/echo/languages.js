"use strict";

// Supported languages — mirrors xeven-echo (openai/whisper tokenizer list @ whisper/tokenizer.py)
// Subset most relevant to XEVEN businesses; full list is accepted via whisper in sidecar.
const ECHO_LANGUAGES = [
    "en","zh","de","es","ru","ko","fr","ja","pt","tr","pl","ca","nl","ar","sv","it","id","hi","fi","vi","he","uk","el","ms","cs","ro","da","hu","ta","no","th","ur","hr","bg","lt","la","mi","ml","cy","sk","te","fa","lv","bn","sr","az","sl","kn","et","mk","br","eu","is","hy","ne","mn","bs","kk","sq","sw","gl","mr","pa","si","km","sn","yo","so","af","oc","ka","be","tg","sd","gu","am","yi","lo","uz","fo","ht","ps","tk","nn","mt","sa","lb","my","bo","tl","mg","as","tt","haw","ln","ha","ba","jw","su",
];

const LANGUAGE_NAMES = {
    en: "English", es: "Spanish", fr: "French", de: "German", pt: "Portuguese",
    it: "Italian", ja: "Japanese", ko: "Korean", zh: "Chinese", ar: "Arabic",
    hi: "Hindi", ru: "Russian", nl: "Dutch", tr: "Turkish", pl: "Polish",
};

function normalizeLanguage(value) {
    if (!value || typeof value !== "string") return null;
    const v = value.trim().toLowerCase().slice(0, 10);
    if (ECHO_LANGUAGES.includes(v)) return v;
    // allow 3-letter alias? map via first 2
    if (v.length > 2 && ECHO_LANGUAGES.includes(v.slice(0, 2))) return v.slice(0, 2);
    return null;
}

module.exports = { ECHO_LANGUAGES, LANGUAGE_NAMES, normalizeLanguage };
