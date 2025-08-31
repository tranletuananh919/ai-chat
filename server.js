// server.js
import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
app.use(express.json());
app.use(cors({ origin: true })); // dev: cho phép tất cả origin

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
// model nhanh, rẻ cho chat. Cần chất lượng cao hơn thì đổi sang "gemini-1.5-pro"
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// --- Routes ---
// Lấy lịch sử theo userId
app.get('/history/:userId', async (req, res) => {
  const convo = await Conversation.findOne({ userId: req.params.userId });
  if (!convo) return res.json({ userId: req.params.userId, messages: [] });
  res.json({ userId: convo.userId, messages: convo.messages });
});

// Gửi câu hỏi -> gọi Gemini -> lưu -> trả lời
app.post('/chat', async (req, res) => {
  try {
    const { userId, question } = req.body;
    if (!userId || !question) {
      return res.status(400).json({ error: 'userId và question là bắt buộc' });
    }

    // gọi Gemini
    const result = await model.generateContent(question);
    const answer = result?.response?.text() ?? '(Không có phản hồi)';

    // Xóa toàn bộ hội thoại cũ của user
    await Conversation.deleteMany({ userId });
    
    // Tạo hội thoại mới chỉ với message hiện tại
    const convo = new Conversation({
      userId,
      messages: [
        { role: "user", content: question },
        { role: "assistant", content: answer }
      ]
    });
    await convo.save();

    res.json({ answer, messages: convo.messages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error', detail: String(err?.message || err) });
  }
});

// Health check
app.get('/', (_, res) => res.send('AI chat backend OK'));

app.listen(PORT, () => {
  console.log(`Server chạy: http://localhost:${PORT}`);
});


