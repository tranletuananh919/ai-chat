// server.js
import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
app.use(express.json());
app.use(cors({ origin: true }));

// --- MongoDB connect ---
const { MONGODB_URI, GEMINI_API_KEY, PORT = 3000 } = process.env;
if (!MONGODB_URI) throw new Error('Missing MONGODB_URI');
if (!GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY');

await mongoose.connect(MONGODB_URI);

// --- Schema / Model ---
const MessageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
}, { _id: false });

const ConversationSchema = new mongoose.Schema({
  userId: { type: String, index: true, required: true },
  createdAt: { type: Date, default: Date.now },
  messages: { type: [MessageSchema], default: [] }
});

const Conversation = mongoose.model('Conversation', ConversationSchema);

// --- Gemini setup ---
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

/* ---------------- ROUTES ---------------- */

// Tạo conversation mới
app.post('/conversation', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId là bắt buộc' });

    const convo = new Conversation({ userId, messages: [] });
    await convo.save();

    res.json({ success: true, id: convo._id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Gửi tin nhắn thường (không streaming)
app.post('/chat/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { userId, question } = req.body;
    if (!userId || !question) {
      return res.status(400).json({ error: 'userId và question là bắt buộc' });
    }

    const result = await model.generateContent(question);
    const answer = result?.response?.text() ?? '(Không có phản hồi)';

    const convo = await Conversation.findById(conversationId);
    if (!convo) return res.status(404).json({ error: "Conversation not found" });

    convo.messages.push({ role: 'user', content: question });
    convo.messages.push({ role: 'assistant', content: answer });
    await convo.save();

    res.json({ success: true, answer, messages: convo.messages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 🔥 Gửi tin nhắn có streaming (ChatGPT style)
app.post('/chat-stream/:conversationId', async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  try {
    const { conversationId } = req.params;
    const { userId, question } = req.body;
    if (!userId || !question) return res.status(400).end("Thiếu userId hoặc question");

    const convo = await Conversation.findById(conversationId);
    if (!convo) return res.status(404).end("Không tìm thấy hội thoại");

    convo.messages.push({ role: "user", content: question });
    await convo.save();

    const result = await model.generateContentStream(question);

    let fullAnswer = "";
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        fullAnswer += text;
        res.write(text); // gửi từng đoạn về client
      }
    }

    convo.messages.push({ role: "assistant", content: fullAnswer });
    await convo.save();

    res.end();
  } catch (err) {
    console.error("Stream error:", err);
    res.end("[STREAM_ERROR]");
  }
});

// Lấy danh sách hội thoại
app.get('/conversations/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const convos = await Conversation.find({ userId })
      .sort({ createdAt: -1 })
      .select('_id createdAt messages')
      .lean();

    const previews = convos.map(c => ({
      id: c._id,
      createdAt: c.createdAt,
      preview: c.messages[0]?.content?.slice(0, 40) || "(Trống)"
    }));

    res.json({ success: true, conversations: previews });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Lấy chi tiết 1 hội thoại
app.get('/conversation/:id', async (req, res) => {
  try {
    const convo = await Conversation.findById(req.params.id);
    if (!convo) return res.status(404).json({ error: "Not found" });
    res.json({ success: true, messages: convo.messages });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Xóa hội thoại
app.delete('/conversation/:id', async (req, res) => {
  try {
    const deleted = await Conversation.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health check
app.get('/', (_, res) => res.send('AI chat backend OK'));

app.listen(PORT, () => {
  console.log(`✅ Server chạy: http://localhost:${PORT}`);
});
