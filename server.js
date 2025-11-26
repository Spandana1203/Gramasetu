// -------------------- IMPORTS --------------------
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const emailjs = require('@emailjs/nodejs');
const path = require('path');
const OpenAI = require('openai'); // ✅ OpenAI client (used for BOTH VA + chatbot)

const app = express();

// -------------------- MIDDLEWARE --------------------
app.use(cors());
app.use(express.json());

// ✅ Serve the frontend folder statically
const __dirnameFull = path.resolve();
app.use(express.static(path.join(__dirnameFull, '..', 'frontend')));

// -------------------- DATABASE SETUP (Render Compatible) --------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // REQUIRED for Render PostgreSQL
});

pool.connect()
  .then(() => console.log('✅ Connected to PostgreSQL'))
  .catch(err => console.error('❌ DB Connection Error:', err));

// -------------------- OTP STORE --------------------
const otpStore = {}; // Temporary memory OTP storage

// -------------------- OPENAI CLIENTS --------------------
// ✅ Voice Assistant client (uses OPENAI_KEY)
if (!process.env.OPENAI_KEY) {
  console.warn('⚠️ OPENAI_KEY not set in .env — /api/chat (voice assistant) will fail until it is configured.');
}
const openaiVoiceClient = new OpenAI({
  apiKey: process.env.OPENAI_KEY,
});

// ✅ Chatbot client (uses OPENAI_API_KEY)
if (!process.env.OPENAI_API_KEY) {
  console.warn('⚠️ OPENAI_API_KEY not set in .env — /api/cb-chat (chatbot) will fail until it is configured.');
}
const openaiChatbotClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// -------------------- ROUTES --------------------

// REGISTER USER ✅ correct hashed_password insert
app.post('/api/register', async (req, res) => {
  const { username, email, phone, password } = req.body;

  if (!username || (!email && !phone) || !password) {
    return res.status(400).json({ error: 'Username, email/phone, and password required' });
  }
  try {
    const hashed_password = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (username, email, phone, hashed_password)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, phone`,
      [username, email, phone, hashed_password]
    );

    res.status(201).json({ success: true, user: result.rows[0] });

  } catch (err) {
    console.error('Register error:', err);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Username or email already exists' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// LOGIN USER ✅ checks hashed_password correctly
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username / email / phone and password required' });

  try {
    const result = await pool.query(
      `SELECT * FROM users WHERE username=$1 OR email=$1 OR phone=$1`,
      [username]
    );

    if (result.rows.length === 0)
      return res.status(400).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.hashed_password);

    if (!isMatch)
      return res.status(400).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { userId: user.id, username: user.username },
      process.env.JWT_SECRET || "fallback_secret",
      { expiresIn: '1h' }
    );

    res.json({
      success: true,
      token,
      user: { username: user.username, email: user.email }
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ✅ FEEDBACK endpoint (simple version – basic table: name, email, message)
app.post('/api/feedback', async (req, res) => {
  const { name, email, message } = req.body;

  if (!name || !email || !message) {
    return res.status(400).json({ success: false, error: "All fields required." });
  }

  try {
    const result = await pool.query(
      "INSERT INTO feedback (name, email, message) VALUES ($1, $2, $3) RETURNING *",
      [name, email, message]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error("❌ Feedback insert error:", err);
    res.status(500).json({ success: false, error: "Database error." });
  }
});

// SEND OTP (Forgot Password) ✅
app.post('/api/forgot-password', async (req, res) => {
  const { identifier } = req.body;
  if (!identifier) return res.status(400).json({ error: 'Identifier required' });

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE email=$1 OR phone=$1',
      [identifier]
    );
    if (result.rows.length === 0)
      return res.status(400).json({ error: 'User not found' });

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    otpStore[identifier] = { otp, expiresAt };

    // If email → send using EmailJS
    if (identifier.includes('@')) {
      try {
        await emailjs.send(
          process.env.EMAILJS_SERVICE_ID,
          process.env.EMAILJS_TEMPLATE_ID,
          {
            email: identifier,
            passcode: otp,
            time: new Date(expiresAt).toLocaleTimeString(),
            cc_email: process.env.EMAILJS_CC_EMAIL,
          },
          { publicKey: process.env.EMAILJS_PUBLIC_KEY }
        );
        console.log(`✅ OTP Email sent to ${identifier}`);
      } catch (err) {
        console.error('❌ EmailJS error:', err);
        return res.status(500).json({ error: 'Failed to send OTP email' });
      }
    } else {
      // SMS fallback
      const smsResp = await fetch('https://textbelt.com/text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: identifier,
          message: `Your Gramasetu OTP is ${otp}`,
          key: 'textbelt',
        }),
      });
      const smsJson = await smsResp.json();
      if (!smsJson.success) {
        console.error('Textbelt failed:', smsJson);
        return res.status(500).json({ error: 'Could not send OTP' });
      }
    }

    res.json({ success: true, message: 'OTP sent successfully' });

  } catch (err) {
    console.error('Forgot-password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// VERIFY OTP + RESET PASSWORD ✅ uses hashed_password
app.post('/api/verify-otp', async (req, res) => {
  const { identifier, otp, newPassword } = req.body;
  if (!identifier || !otp || !newPassword)
    return res.status(400).json({ error: 'All fields required' });

  const record = otpStore[identifier];
  if (!record || record.otp !== otp)
    return res.status(400).json({ error: 'Invalid OTP' });

  if (record.expiresAt < Date.now())
    return res.status(400).json({ error: 'OTP expired' });

  try {
    const hashed_password = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE users SET hashed_password=$1 WHERE email=$2 OR phone=$2',
      [hashed_password, identifier]
    );
    delete otpStore[identifier];
    res.json({ success: true, message: 'Password reset successful' });
  } catch (err) {
    console.error('Verify-OTP error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// -------------------- VOICE ASSISTANT CHAT ENDPOINT (/api/chat) --------------------
// Uses OPENAI_KEY + gpt-4.1-mini (same style as your original serverva.js)
app.post('/api/chat', async (req, res) => {
  try {
    const { message, language } = req.body;
    if (!message || !language) {
      return res.status(400).json({ reply: 'Invalid request' });
    }

    const systemPrompt = language === 'kn'
      ? `ನೀವು ಒಬ್ಬ ಸ್ನೇಹಭರಿತ ಸಹಾಯಗಾರ. ಉತ್ತರಗಳು 100% ಕನ್ನಡದಲ್ಲಿ ಇರಬೇಕು, ಸರಳ, ದೈನಂದಿನ ಮಾತು ಶೈಲಿಯಲ್ಲಿ, 1-2 ವಾಕ್ಯಗಳಲ್ಲಿ ಕೊಡಿ. ಇಂಗ್ಲಿಷ್ ಪದಗಳ ಬಳಕೆ ಬೇಡ. ಉದಾಹರಣೆ:
- "ನಮಸ್ಕಾರ, ಹೇಗಿದ್ದೀರಾ? ಹೇಳಿ, ಏನು ಸಹಾಯ ಬೇಕು?"
- "ಸರಿ, ಹೀಗೆ ಮಾಡಿ. ಇದರಿಂದ ಸಮಸ್ಯೆ ಸರಿಯಾಗಬಹುದು."
- "ಈ ವಿಷಯದ ಬಗ್ಗೆ ಸದ್ಯ ನನಗೆ ಮಾಹಿತಿ ಇಲ್ಲ, ದಯವಿಟ್ಟು ಕಚೇರಿಯಲ್ಲಿ ಕೇಳಿ."`
      : `Reply in short, friendly English. Keep responses natural and helpful.`;

    if (!openaiVoiceClient.apiKey) {
      console.error('❌ OPENAI_KEY missing — cannot call OpenAI for voice assistant.');
      return res.status(500).json({ reply: '⚠️ Server configuration error. Contact admin.' });
    }

    const completion = await openaiVoiceClient.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
      temperature: 0.7,
    });

    const reply =
      completion?.choices?.[0]?.message?.content?.trim() ||
      'ಕ್ಷಮಿಸಿ — ಉತ್ತರ ಸಿಗಲಿಲ್ಲ.';

    res.json({ reply });
  } catch (err) {
    console.error('API Error (voice assistant):', err);
    res.status(500).json({ reply: '⚠️ ಸಂಪರ್ಕದಲ್ಲಿ ದೋಷ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.' });
  }
});

// -------------------- CHATBOT ENDPOINTS (/api/cb-chat, /api/cb-clear) --------------------

// In-memory context for chatbot (like old servercb.js)
let cbChatContext = [];

// Helper: translate Kannada → English when language toggle is "en"
async function translateToEnglish(text) {
  if (!openaiChatbotClient.apiKey) return text;

  try {
    const prompt = `Translate the following text to English only. Do not explain anything:\n\n${text}`;
    const completion = await openaiChatbotClient.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: 'You are a translator.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
    });
    const out = completion?.choices?.[0]?.message?.content?.trim();
    return out || text;
  } catch (err) {
    console.error('translateToEnglish error:', err);
    return text;
  }
}

// Main chatbot endpoint (text chat)
app.post('/api/cb-chat', async (req, res) => {
  let userMessage = req.body.message || '';
  const language = req.body.language || 'en';

  if (!userMessage) {
    return res.status(400).json({ reply: 'Message required' });
  }

  if (!openaiChatbotClient.apiKey) {
    console.error('❌ OPENAI_API_KEY missing — cannot call OpenAI for chatbot.');
    return res.status(500).json({ reply: '⚠️ Server configuration error. Contact admin.' });
  }

  try {
    // 🪄 Force-translate user message to English if language= "en"
    if (language === 'en') {
      userMessage = await translateToEnglish(userMessage);
    }

    // 🪄 Language-specific system prompt (from original servercb.js)
    const systemPrompt =
      language === 'kn'
        ? `You are a helpful assistant that always replies in natural and fluent Kannada language. 
If something cannot be translated, keep it in English.`
        : `You are a helpful assistant that always replies in natural and fluent English language. 
Translate any non-English input to English and reply in English.`;

    console.log('Incoming /api/cb-chat ->', userMessage);

    // Reset context when user switches language mode
    if (cbChatContext.length > 0 && cbChatContext[0].lang && cbChatContext[0].lang !== language) {
      cbChatContext = [];
    }

    // Save user message with language tag
    cbChatContext.push({ role: 'user', content: userMessage, lang: language });

    // Build messages without exposing lang flag
    const messagesToSend = [
      { role: 'system', content: systemPrompt },
      ...cbChatContext.map(({ role, content }) => ({ role, content })),
    ];

    const completion = await openaiChatbotClient.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: messagesToSend,
      temperature: 0.7,
    });

    const botReply = completion?.choices?.[0]?.message?.content?.trim();

    if (!botReply) {
      console.error('⚠️ No content in chatbot response');
      return res.status(500).json({ reply: '⚠️ No response from model.' });
    }

    cbChatContext.push({ role: 'assistant', content: botReply, lang: language });
    if (cbChatContext.length > 10) {
      cbChatContext = cbChatContext.slice(-10);
    }

    res.json({ reply: botReply });
  } catch (err) {
    console.error('Chatbot server error:', err);
    res.status(500).json({ reply: 'Failed to connect to chatbot model.' });
  }
});

// Clear chatbot context
app.post('/api/cb-clear', (req, res) => {
  cbChatContext = [];
  console.log('✅ Chatbot context cleared.');
  res.json({ ok: true });
});

// -------------------- DEFAULT FRONTEND ROUTE --------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirnameFull, 'log.html'));
});


// -------------------- SERVER START --------------------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});


