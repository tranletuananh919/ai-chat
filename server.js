// server.js
import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
app.use(express.json());
app.use(cors({ origin: true })); // dev: mở CORS

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

// --- Gemini ---
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
// Cần chất lượng cao hơn thì: gemini-1.5-pro
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// --- Routes ---

// Tạo conversation mới (khi bấm "Chat với Chatbot AI" hoặc FAQ)
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

// Streaming chat (fetch + ReadableStream)
app.post('/chat-stream/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { userId, question } = req.body;
    if (!userId || !question) {
      return res.status(400).json({ error: 'userId và question là bắt buộc' });
    }

    const convo = await Conversation.findById(conversationId);
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });

    // Lưu câu hỏi của user trước
    convo.messages.push({ role: 'user', content: question });
    await convo.save();

    // Header để cho phép chunked streaming
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no'); // Nginx/railway: tắt buffering nếu có
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    // Gọi Gemini streaming
    const streamResp = await model.generateContentStream(question);

    let fullAnswer = '';
    for await (const chunk of streamResp.stream) {
      const text = chunk?.text() || '';
      if (!text) continue;
      fullAnswer += text;
      // Gửi từng mảnh xuống client
      res.write(text);
    }

    // Kết thúc stream
    res.end();

    // Lưu trả lời của assistant
    convo.messages.push({ role: 'assistant', content: fullAnswer });
    await convo.save();
  } catch (err) {
    console.error('stream error:', err);
    // Cố gửi lỗi xuống client nếu còn mở
    try {
      res.write('\n[STREAM_ERROR]');
      res.end();
    } catch (_) {}
  }
});

// Danh sách hội thoại (preview)
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
      preview: (c.messages[0]?.content || '(mới)')?.slice(0, 40) + '...'
    }));

    res.json({ success: true, conversations: previews });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Chi tiết 1 hội thoại
app.get('/conversation/:id', async (req, res) => {
  try {
    const convo = await Conversation.findById(req.params.id);
    if (!convo) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, messages: convo.messages });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Xoá 1 hội thoại
app.delete('/conversation/:id', async (req, res) => {
  try {
    await Conversation.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health
app.get('/', (_, res) => res.send('AI chat backend OK'));

app.listen(PORT, () => {
  console.log(`Server chạy: http://localhost:${PORT}`);
});
