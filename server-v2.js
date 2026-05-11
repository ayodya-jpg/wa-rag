require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Groq = require('groq-sdk');

const RAGEngine = require('./lib/rag');
const DatasetManager = require('./lib/dataset');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

const ragEngine = new RAGEngine();
const datasetManager = new DatasetManager();

let client = null;
let qrCodeData = null;
let isReady = false;
let isInitializing = false;

const knowledgeFile = path.join(__dirname, 'knowledge.json');
const behaviorFile = path.join(__dirname, 'config', 'behavior.json');

if (!fs.existsSync(knowledgeFile)) {
  fs.writeFileSync(
    knowledgeFile,
    JSON.stringify({ keywords: {}, responses: {} }, null, 2)
  );
}

function loadKnowledge() {
  try {
    const data = fs.readFileSync(knowledgeFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return { keywords: {}, responses: {} };
  }
}

function loadBehavior() {
  try {
    if (!fs.existsSync(behaviorFile)) return null;

    const content = fs.readFileSync(behaviorFile, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error('Gagal membaca behavior.json:', error.message);
    return null;
  }
}

async function getAIResponse(message, contextItems = [], behavior = null) {
  try {
    const contextBlock = ragEngine.buildContextBlock(contextItems);

    if (!behavior) {
      behavior = loadBehavior() || {
        system_instructions: 'Jawab hanya berdasarkan konteks yang diberikan.',
        fallback_response: 'Mohon maaf, data produk tersebut belum tersedia di dataset kami.',
        max_sentences: 2,
        language: 'id'
      };
    }

    if (!contextBlock || contextItems.length === 0) {
      return behavior.fallback_response;
    }

    const systemMessage = `
${behavior.system_instructions}

Aturan:
1. Jawab hanya berdasarkan konteks dataset.
2. Jangan mengarang produk, harga, lokasi, atau link.
3. Jika konteks tidak cukup, jawab: ${behavior.fallback_response}
4. Jawab maksimal ${behavior.max_sentences || 2} kalimat.
5. Gunakan bahasa ${behavior.language || 'id'}.
`;

    const userMessage = `
Konteks:
${contextBlock}

Pertanyaan user:
${message}
`;

    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage }
      ],
      model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
      max_tokens: Number(process.env.GROQ_MAX_TOKENS || 250),
      temperature: 0.1
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Gagal mendapatkan respons AI:', error.message);
    return 'Maaf, terjadi kesalahan saat memproses jawaban AI.';
  }
}

function initializeClient() {
  if (client) return client;

  client = new Client({
    authStrategy: new LocalAuth({ clientId: 'whatsapp-bot' }),
    puppeteer: {
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ],
      timeout: 120000
    }
  });

  client.on('qr', qr => {
    console.log('Scan QR berikut menggunakan WhatsApp:');
    qrCodeData = qr;
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    console.log('Bot WhatsApp RAG sudah siap!');
    isReady = true;
    isInitializing = false;
  });

  client.on('authenticated', () => {
    console.log('WhatsApp berhasil diautentikasi.');
  });

  client.on('disconnected', reason => {
    console.log('Bot terputus:', reason);
    isReady = false;
    client = null;
  });

  client.on('message', async msg => {
    try {
      if (msg.fromMe) return;

      const isPersonalChat = msg.from.endsWith('@c.us') || msg.from.endsWith('@lid');
      const isNotStatus = !msg.from.endsWith('@status');

      if (!isPersonalChat || !isNotStatus) return;

      const userMessage = msg.body.trim();
      const keyword = userMessage.toLowerCase();

      console.log(`Pesan masuk dari ${msg.from}: ${userMessage}`);

      const knowledge = loadKnowledge();

      if (knowledge.responses[keyword]) {
        await msg.reply(knowledge.responses[keyword]);
        return;
      }

      if (keyword === 'menu') {
        await msg.reply(
          '*Menu Chatbot RAG Shopee*\n\n' +
          '1. Tanyakan produk yang ingin dicari.\n' +
          '2. Contoh: rekomendasikan bunga gerbera yang murah.\n' +
          '3. Contoh: ada produk dari Surabaya?\n' +
          '4. Contoh: produk mana yang cocok untuk dekorasi?'
        );
        return;
      }

      if (keyword === 'jumlah data') {
        const totalDocuments = datasetManager.getAllDocuments().length;
        await msg.reply(`Jumlah dokumen produk dalam dataset adalah ${totalDocuments}.`);
        return;
      }

      const allDocuments = datasetManager.getAllDocuments();

      const contextItems = ragEngine.retrieveContext(
        userMessage,
        allDocuments,
        Number(process.env.RAG_TOP_K || 3)
      );

      console.log(`RAG mengambil ${contextItems.length} konteks relevan.`);

      const behavior = loadBehavior();

      const aiResponse = await getAIResponse(userMessage, contextItems, behavior);

      await msg.reply(aiResponse);
    } catch (error) {
      console.error('Error saat memproses pesan:', error.message);
      await msg.reply('Maaf, terjadi kesalahan saat memproses pesan Anda.');
    }
  });

  return client;
}

async function startBot() {
  if (isReady || isInitializing) {
    return { success: false, message: 'Bot sudah berjalan atau sedang dimulai.' };
  }

  isInitializing = true;

  const clientInstance = initializeClient();
  await clientInstance.initialize();

  return { success: true, message: 'Bot dimulai. Silakan scan QR jika diminta.' };
}

app.get('/api/bot/status', (req, res) => {
  res.json({
    isReady,
    isInitializing,
    hasQRCode: qrCodeData ? true : false
  });
});

app.post('/api/bot/start', async (req, res) => {
  try {
    const result = await startBot();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal memulai bot: ' + error.message
    });
  }
});

app.get('/api/bot/qr', (req, res) => {
  res.json({ qr: qrCodeData });
});

app.get('/api/datasets', (req, res) => {
  res.json({
    datasets: datasetManager.listDatasets(),
    totalDocuments: datasetManager.getAllDocuments().length
  });
});

app.listen(PORT, () => {
  console.log(`Server berjalan di http://localhost:${PORT}`);
  console.log(`Dataset terbaca: ${datasetManager.getAllDocuments().length} dokumen`);

  if (process.env.AUTO_START_BOT !== 'false') {
    setTimeout(() => {
      startBot().catch(error => {
        console.error('Gagal auto-start bot:', error.message);
      });
    }, 500);
  }
});