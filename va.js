// va.js - Voice Assistant (Tone A: Polite & Home-friendly, Kannada pure)
// Frontend: speech recognition + TTS + POST to /api/chat (no API key here)

const API_URL = "/api/chat"; // unified backend endpoint after merge

// -------------------------------
// Language detection & settings
// -------------------------------
const KANNADA_REGEX = /[\u0C80-\u0CFF]/;
function getCurrentLang() {
  return window.currentLang || localStorage.getItem("lang") || "en";
}
function saveLang(lang) {
  if (!lang) return;
  window.currentLang = lang;
  try { localStorage.setItem("lang", lang); } catch (e) {}
}
function detectLangFromText(text) {
  if (!text) return "en";
  return KANNADA_REGEX.test(text) ? "kn" : "en";
}

// -------------------------------
// UI + state
// -------------------------------
let recognition = null;
let isListening = false;
let isBotSpeaking = false;
let wasListeningBeforeSpeak = false;
let chatHistory = [];

// -------------------------------
// UI creation
// -------------------------------
function createVoiceChatBox() {
  if (document.getElementById("voice-chat-box")) return;
  const box = document.createElement("div");
  box.id = "voice-chat-box";
  Object.assign(box.style, {
    position: "fixed",
    bottom: "90px",
    right: "20px",
    width: "350px",
    height: "480px",
    background: "#f9f4e7",
    borderRadius: "16px",
    boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
    display: "none",
    flexDirection: "column",
    overflow: "hidden",
    zIndex: "99999",
    fontFamily: "sans-serif",
  });

  // header
  const header = document.createElement("div");
  Object.assign(header.style, {
    background: "#c6a94c",
    color: "#4b2e2e",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 12px",
    fontWeight: "700",
  });
  const title = document.createElement("div");
  title.innerText = "Voice Assistant";

  const controls = document.createElement("div");
  controls.style.display = "flex";
  controls.style.alignItems = "center";
  controls.style.gap = "8px";

  const langBadge = document.createElement("button");
  langBadge.id = "va-lang-badge";
  Object.assign(langBadge.style, {
    background: "transparent",
    border: "1px solid rgba(75,46,46,0.12)",
    borderRadius: "8px",
    padding: "4px 8px",
    cursor: "pointer",
    fontWeight: "600",
    color: "#4b2e2e",
  });
  langBadge.onclick = () => {
    const newLang = getCurrentLang() === "kn" ? "en" : "kn";
    saveLang(newLang);
    updateLangBadge();
    recreateRecognition();
  };

  const clearBtn = document.createElement("button");
  clearBtn.innerText = "🧹";
  styleControlButton(clearBtn);
  clearBtn.onclick = clearChat;

  const closeBtn = document.createElement("button");
  closeBtn.innerText = "✕";
  styleControlButton(closeBtn);
  closeBtn.onclick = () => {
    stopListening(true);
    stopSpeaking();
    box.style.display = "none";
  };

  controls.appendChild(langBadge);
  controls.appendChild(clearBtn);
  controls.appendChild(closeBtn);
  header.appendChild(title);
  header.appendChild(controls);

  // messages
  const messages = document.createElement("div");
  messages.id = "voice-chat-messages";
  Object.assign(messages.style, {
    flex: "1",
    overflowY: "auto",
    padding: "10px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    background: "#fff",
  });

  // mic
  const micWrapper = document.createElement("div");
  micWrapper.style.textAlign = "center";
  micWrapper.style.padding = "12px";

  const micBtn = document.createElement("div");
  micBtn.id = "innerMicBtn";
  micBtn.innerText = "🎤";
  Object.assign(micBtn.style, {
    fontSize: "42px",
    cursor: "pointer",
    transition: "transform 0.15s ease, background 0.15s ease, box-shadow 0.15s ease",
    display: "inline-block",
    borderRadius: "50%",
    padding: "10px",
  });
  micBtn.onclick = toggleListening;
  micWrapper.appendChild(micBtn);

  const footer = document.createElement("div");
  Object.assign(footer.style, {
    background: "#f5eedc",
    padding: "8px",
    textAlign: "center",
    fontSize: "13px",
    color: "#4b2e2e",
  });
  footer.innerText = "Mic ಒತ್ತಿ ಮಾತನಾಡಿ — ಮತ್ತೆ ಒತ್ತಿದರೆ ನಿಲ್ಲಿಸುತ್ತದೆ.";

  box.appendChild(header);
  box.appendChild(messages);
  box.appendChild(micWrapper);
  box.appendChild(footer);
  document.body.appendChild(box);

  saveLang(getCurrentLang());
  updateLangBadge();
}

function styleControlButton(btn) {
  btn.style.background = "transparent";
  btn.style.border = "none";
  btn.style.cursor = "pointer";
  btn.style.fontSize = "16px";
}

function updateLangBadge() {
  const badge = document.getElementById("va-lang-badge");
  if (badge) badge.innerText = getCurrentLang() === "kn" ? "KN" : "EN";
}

// -------------------------------
// Messaging UI logic
// -------------------------------
function addMessage(role, text) {
  const area = document.getElementById("voice-chat-messages");
  if (!area) return;
  const msgContainer = document.createElement("div");
  msgContainer.style.display = "flex";
  msgContainer.style.justifyContent = role === "user" ? "flex-end" : "flex-start";

  const bubble = document.createElement("div");
  bubble.innerText = text;
  Object.assign(bubble.style, {
    maxWidth: "80%",
    padding: "10px 12px",
    borderRadius: "12px",
    whiteSpace: "pre-wrap",
    wordWrap: "break-word",
    boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
  });
  if (role === "user") {
    bubble.style.background = "#c6a94c";
    bubble.style.color = "#4b2e2e";
  } else {
    bubble.style.background = "#1f2833";
    bubble.style.color = "#fff";
  }

  msgContainer.appendChild(bubble);
  area.appendChild(msgContainer);
  area.scrollTop = area.scrollHeight;
}

function clearChat() {
  chatHistory = [];
  const area = document.getElementById("voice-chat-messages");
  if (area) area.innerHTML = "";
}

// -------------------------------
// Speech recognition
// -------------------------------
function recreateRecognition() {
  if (recognition) {
    try { recognition.onend = null; recognition.onerror = null; recognition.stop(); } catch (e) {}
    recognition = null;
  }
}

function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return alert("ನಿಮ್ಮ ಬ್ರೌಸರ್‌ಗೆ Speech Recognition ಬೆಂಬಲ ಇಲ್ಲ.");

  recognition = new SR();
  recognition.lang = getCurrentLang() === "kn" ? "kn-IN" : "en-IN";
  recognition.interimResults = false;
  recognition.continuous = false;

  recognition.onstart = () => {
    isListening = true;
    const mic = document.getElementById("innerMicBtn");
    if (mic) { mic.style.transform = "scale(1.25)"; mic.style.background = "#e6d67a"; }
  };

  recognition.onresult = (event) => {
    const transcript = (event.results[0][0].transcript || "").trim();
    if (!transcript) return;
    const detected = detectLangFromText(transcript);
    saveLang(detected);
    updateLangBadge();
    addMessage("user", transcript);
    sendMessageToAPI(transcript, detected);
  };

  recognition.onerror = (e) => {
    console.warn("Recognition error", e);
    addMessage("bot", "ಕ್ಷಮಿಸಿ, ವಾಚನವನ್ನು ಹಿಡಿಯಲಾಗಲಿಲ್ಲ.");
  };

  recognition.onend = () => {
    isListening = false;
    const mic = document.getElementById("innerMicBtn");
    if (mic) { mic.style.transform = "scale(1)"; mic.style.background = "transparent"; }
  };
}

function toggleListening() {
  if (!recognition) initRecognition();
  if (isListening) stopListening();
  else startListening();
}

function startListening() {
  if (!recognition) initRecognition();
  try { recognition.start(); } catch (e) { try { recognition.stop(); recognition.start(); } catch (e) {} }
}

function stopListening() {
  if (recognition) try { recognition.stop(); } catch (e) {}
  isListening = false;
  const mic = document.getElementById("innerMicBtn");
  if (mic) { mic.style.transform = "scale(1)"; mic.style.background = "transparent"; }
}

// -------------------------------
// Send message to backend
// -------------------------------
async function sendMessageToAPI(text, lang, triedRetry = false) {
  try {
    const systemInstructionKn = `
ನೀವು ಒಬ್ಬ ಸ್ನೇಹಭರಿತ, ಸರಳ, ಮತ್ತು ಸದಾ ಶಿಷ್ಟ Kannada ಸಹಾಯಗಾರ.
ನೀವು ಸರಳ ಮಾತಿನ ಶೈಲಿಯಲ್ಲಿ 100% ಕನ್ನಡದ ಉತ್ತರ ನೀಡಿ.
`;

    const systemInstructionEn = `Reply in short, friendly English.`;

    const systemInstruction = lang === "kn" ? systemInstructionKn : systemInstructionEn;
    const fullPrompt = `${systemInstruction}\n\nUser: ${text}`;

    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: fullPrompt, language: lang }),
    });

    if (!response.ok) {
      addMessage("bot", "⚠️ ಸಂಪರ್ಕ ದೋಷ.");
      return;
    }

    const data = await response.json();
    let reply = data.reply || "ಕ್ಷಮಿಸಿ — ಉತ್ತರ ಸಿಗಲಿಲ್ಲ.";

    if (lang === "kn" && /[A-Za-z]/.test(reply) && !triedRetry)
      return sendMessageToAPI(text, lang, true);

    addMessage("bot", reply);
    speakOut(reply, lang);
  } catch (err) {
    console.error("API Error:", err);
    addMessage("bot", "⚠️ ದೋಷ. ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.");
  }
}

// -------------------------------
// TTS
// -------------------------------
function selectFemaleVoiceForLang(voices, lang) {
  const femaleHints = ['female','zira','anya','meera','sangeet','sangeetha','google','amy','samantha','alloy'];
  let found = voices.find(v => v.lang && v.lang.toLowerCase().includes(lang === 'kn' ? 'kn' : 'en') && femaleHints.some(h => v.name.toLowerCase().includes(h)));
  if(found) return found;
  found = voices.find(v => v.lang && v.lang.toLowerCase().includes(lang === 'kn' ? 'kn' : 'en'));
  if(found) return found;
  found = voices.find(v => femaleHints.some(h => v.name.toLowerCase().includes(h)));
  if(found) return found;
  return voices.length ? voices[0] : null;
}

function speakOut(text, lang) {
  stopSpeaking();
  const synth = window.speechSynthesis;
  if(!synth) return;

  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang === 'kn' ? 'kn-IN' : 'en-IN';
  utter.rate = 1;
  utter.pitch = 1.05;

  const voices = synth.getVoices() || [];
  const selected = selectFemaleVoiceForLang(voices, lang);
  if(selected) utter.voice = selected;

  utter.onstart = () => {
    isBotSpeaking = true;
    wasListeningBeforeSpeak = isListening;
    stopListening();
  };
  utter.onend = () => {
    isBotSpeaking = false;
    if(wasListeningBeforeSpeak) setTimeout(()=>startListening(),200);
    wasListeningBeforeSpeak = false;
  };

  synth.speak(utter);
}

function stopSpeaking() {
  const synth = window.speechSynthesis;
  if(synth && (synth.speaking || synth.pending)) synth.cancel();
  isBotSpeaking = false;
}

// -------------------------------
// Init
// -------------------------------
document.addEventListener("DOMContentLoaded", () => {
  createVoiceChatBox();
  const btn = document.getElementById("voiceAssistantBtn");
  if(btn) btn.addEventListener("click", ()=>{
    const box = document.getElementById("voice-chat-box");
    if(box) box.style.display='flex';
  });

  function ensureVoicesLoaded(cb){
    const synth = window.speechSynthesis;
    let voices = synth.getVoices();
    if(voices.length) return cb(voices);
    synth.onvoiceschanged = ()=>cb(synth.getVoices());
    setTimeout(()=>cb(synth.getVoices()),1000);
  }

  ensureVoicesLoaded((voices)=>{
    window._va_cached_voices = voices;
  });
});

// expose helpers
window.va = { startListening, stopListening, speakOut, clearChat, getCurrentLang, saveLang };
