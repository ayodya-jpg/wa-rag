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
let botStartedAt = Math.floor(Date.now() / 1000);

const userSessions = new Map();

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

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractImportantKeywords(message) {
  const stopwords = new Set([
    'saya', 'aku', 'mau', 'ingin', 'cari', 'carikan', 'tolong', 'ada',
    'produk', 'barang', 'yang', 'untuk', 'dengan', 'dong', 'kak', 'min',
    'rekomendasi', 'rekomendasikan', 'pilihkan', 'kasih', 'lihat',
    'berapa', 'harga', 'termurah', 'murah', 'bagus', 'butuh', 'nyari',
    'mencari', 'punya', 'apakah', 'tampilkan', 'lihatkan', 'berikan',
    'lagi', 'lainnya', 'selanjutnya', 'next', 'dari', 'di', 'ke',
    'buat', 'pakai', 'mohon'
  ]);

  return normalizeText(message)
    .split(' ')
    .filter(word => word.length > 2 && !stopwords.has(word));
}

function getRequestedProductCount(message) {
  const normalized = normalizeText(message);
  const match = normalized.match(/(\d+)\s*(produk|barang|item|rekomendasi)?/i);

  if (!match) return 5;

  const count = Number(match[1]);
  if (Number.isNaN(count) || count < 1) return 5;

  return Math.min(count, 10);
}

function extractField(text, fieldName) {
  const regex = new RegExp(`${fieldName}:\\s*(.*)`, 'i');
  const match = text.match(regex);
  return match ? match[1].trim() : '-';
}

function getValueFromCandidates(product, candidates) {
  for (const field of candidates) {
    const value = extractField(product.text, field);
    if (value && value !== '-') return value;
  }

  return '-';
}

function getProductName(product) {
  const value = getValueFromCandidates(product, [
    'nama_produk',
    'nama produk',
    'whitespace-normal',
    'nama',
    'product_name',
    'title'
  ]);

  return value !== '-' ? value : product.source || '-';
}

function getProductPrice(product) {
  return getValueFromCandidates(product, [
    'harga',
    'font-medium 2',
    'price',
    'harga_produk',
    'harga produk'
  ]);
}

function getProductRating(product) {
  return getValueFromCandidates(product, [
    'rating',
    'flex-none',
    'terjual',
    'rating_terjual',
    'rating terjual',
    'sold'
  ]);
}

function getProductLocation(product) {
  return getValueFromCandidates(product, [
    'lokasi',
    'ml-\\[3px\\]',
    'location',
    'kota',
    'alamat'
  ]);
}

function getProductLink(product) {
  return getValueFromCandidates(product, [
    'link_produk',
    'link produk',
    'contents href',
    'link',
    'url',
    'product_url'
  ]);
}

function getStoreName(product) {
  const value = getValueFromCandidates(product, [
    'nama_toko',
    'nama toko',
    'toko',
    'store',
    'shop'
  ]);

  if (value && value !== '-') return value;

  const source = normalizeText(product.source || '');
  const text = normalizeText(product.text || '');

  if (source.includes('adidas') || text.includes('adidas')) {
    return 'Adidas Official Store';
  }

  return '-';
}

function getCategoryFromSource(product) {
  const source = normalizeText(product.source || '');

  if (source.includes('basketball')) return 'Basketball';
  if (source.includes('football')) return 'Football';
  if (source.includes('footware') || source.includes('footwear')) return 'Footwear';
  if (source.includes('mensapparel') || source.includes('mens apparel')) return 'Mens Apparel';
  if (source.includes('womensapparel') || source.includes('womens apparel')) return 'Womens Apparel';
  if (source.includes('worldcup') || source.includes('world cup')) return 'World Cup';

  return '-';
}

function getProductCategory(product) {
  const categoryFromColumn = getValueFromCandidates(product, [
    'kategori_produk',
    'kategori produk',
    'kategori',
    'category'
  ]);

  if (categoryFromColumn && categoryFromColumn !== '-') {
    return categoryFromColumn;
  }

  return getCategoryFromSource(product);
}

function getAllDocuments() {
  return datasetManager.getAllDocuments();
}

function getUniqueCategories(documents) {
  const categories = new Map();

  documents.forEach(doc => {
    const category = getProductCategory(doc);

    if (category && category !== '-') {
      const key = normalizeText(category);

      if (!categories.has(key)) {
        categories.set(key, {
          name: category,
          count: 0
        });
      }

      categories.get(key).count += 1;
    }
  });

  return Array.from(categories.values()).sort((a, b) => b.count - a.count);
}

function filterProductsByCategory(categoryName, documents, limit = 30) {
  const target = normalizeText(categoryName);

  return documents
    .map(doc => {
      const category = normalizeText(getProductCategory(doc));
      const source = normalizeText(doc.source);
      const text = normalizeText(doc.text);
      const name = normalizeText(getProductName(doc));

      let score = 0;

      if (category.includes(target)) score += 10;
      if (source.includes(target)) score += 6;
      if (name.includes(target)) score += 4;
      if (text.includes(target)) score += 3;

      return { ...doc, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function searchProductsByKeyword(message, documents, limit = 30) {
  const normalizedMessage = normalizeText(message);
  const keywords = extractImportantKeywords(message);

  const categories = getUniqueCategories(documents).map(item => normalizeText(item.name));

  const productTerms = [
    'adidas',
    'sepatu',
    'shoes',
    'sneakers',
    'footwear',
    'footware',
    'basketball',
    'basket',
    'football',
    'bola',
    'world',
    'cup',
    'worldcup',
    'mens',
    'men',
    'pria',
    'mensapparel',
    'womens',
    'women',
    'wanita',
    'womensapparel',
    'apparel',
    'jersey',
    'shirt',
    'tshirt',
    'pants',
    'shorts',
    'jacket',
    'hoodie',
    'running',
    'training',
    'sport',
    'sportswear',
    'original',
    'black',
    'white',
    'hitam',
    'putih',
    'kaos',
    'celana'
  ];

  const expandedKeywords = [...keywords];

  productTerms.forEach(term => {
    if (normalizedMessage.includes(term) && !expandedKeywords.includes(term)) {
      expandedKeywords.push(term);
    }
  });

  categories.forEach(category => {
    if (category && normalizedMessage.includes(category)) {
      expandedKeywords.push(category);
    }
  });

  if (expandedKeywords.length === 0) {
    if (normalizedMessage.includes('adidas')) expandedKeywords.push('adidas');
    if (normalizedMessage.includes('sepatu')) expandedKeywords.push('sepatu');
    if (normalizedMessage.includes('footwear')) expandedKeywords.push('footwear');
    if (normalizedMessage.includes('footware')) expandedKeywords.push('footwear');
    if (normalizedMessage.includes('basket')) expandedKeywords.push('basketball');
    if (normalizedMessage.includes('football')) expandedKeywords.push('football');
    if (normalizedMessage.includes('apparel')) expandedKeywords.push('apparel');
  }

  if (expandedKeywords.length === 0) return [];

  const scored = documents.map(doc => {
    const text = normalizeText(doc.text);
    const source = normalizeText(doc.source);
    const store = normalizeText(getStoreName(doc));
    const category = normalizeText(getProductCategory(doc));
    const productName = normalizeText(getProductName(doc));
    const combinedText = `${source} ${store} ${category} ${productName} ${text}`;

    let score = 0;

    expandedKeywords.forEach(keyword => {
      if (combinedText.includes(keyword)) score += 2;
      if (productName.includes(keyword)) score += 5;
      if (category.includes(keyword)) score += 6;
      if (source.includes(keyword)) score += 4;
    });

    if (combinedText.includes('adidas') && normalizedMessage.includes('adidas')) score += 5;

    if (
      (combinedText.includes('footwear') || combinedText.includes('footware')) &&
      (normalizedMessage.includes('footwear') || normalizedMessage.includes('footware'))
    ) {
      score += 10;
    }

    if (combinedText.includes('sepatu') && normalizedMessage.includes('sepatu')) score += 10;
    if (combinedText.includes('shoes') && normalizedMessage.includes('sepatu')) score += 6;
    if (combinedText.includes('sneakers') && normalizedMessage.includes('sneakers')) score += 6;

    if (combinedText.includes('basketball') && normalizedMessage.includes('basket')) score += 10;
    if (combinedText.includes('football') && normalizedMessage.includes('football')) score += 10;
    if (combinedText.includes('world cup') && normalizedMessage.includes('world')) score += 10;
    if (combinedText.includes('worldcup') && normalizedMessage.includes('world')) score += 10;

    if (combinedText.includes('mens apparel') && normalizedMessage.includes('mens')) score += 10;
    if (combinedText.includes('mensapparel') && normalizedMessage.includes('mens')) score += 10;
    if (combinedText.includes('womens apparel') && normalizedMessage.includes('womens')) score += 10;
    if (combinedText.includes('womensapparel') && normalizedMessage.includes('womens')) score += 10;

    if (combinedText.includes('apparel') && normalizedMessage.includes('apparel')) score += 6;
    if (combinedText.includes('running') && normalizedMessage.includes('running')) score += 6;
    if (combinedText.includes('training') && normalizedMessage.includes('training')) score += 6;

    if (combinedText.includes('white') && normalizedMessage.includes('white')) score += 4;
    if (combinedText.includes('black') && normalizedMessage.includes('black')) score += 4;
    if (combinedText.includes('putih') && normalizedMessage.includes('putih')) score += 4;
    if (combinedText.includes('hitam') && normalizedMessage.includes('hitam')) score += 4;

    return {
      ...doc,
      score
    };
  });

  return scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function formatProductList(products, total = products.length) {
  let reply = 'Produk yang relevan:\n';
  reply += `Menampilkan *${products.length} dari ${total} produk*.\n\n`;

  products.forEach((item, index) => {
    const nama = getProductName(item);
    const harga = getProductPrice(item);
    const kategori = getProductCategory(item);

    reply += `*${index + 1}. ${nama}*\n`;
    if (kategori !== '-') reply += `Kategori: ${kategori}\n`;
    reply += `Harga: ${harga}\n\n`;
  });

  reply += 'Ketik nomor produk, misalnya *1*, untuk melihat detail.\n';
  reply += 'Ketik *0* untuk kembali.';

  if (total > products.length) {
    reply += '\nKetik *ada lagi* untuk produk berikutnya.';
  }

  return reply;
}

function formatProductDetail(product) {
  const nama = getProductName(product);
  const harga = getProductPrice(product);
  const rating = getProductRating(product);
  const lokasi = getProductLocation(product);
  const link = getProductLink(product);
  const kategori = getProductCategory(product);

  let reply = '*Detail Produk Adidas*\n\n';
  reply += `Nama: ${nama}\n`;
  if (kategori !== '-') reply += `Kategori: ${kategori}\n`;
  reply += `Harga: ${harga}\n`;
  reply += `Rating/Terjual: ${rating}\n`;
  reply += `Lokasi: ${lokasi}\n`;
  reply += `Link: ${link}\n\n`;
  reply += 'Ketik *0* untuk kembali.';

  return reply;
}

function formatCategoryList(categories) {
  if (!categories.length) {
    return 'Data kategori belum tersedia. Pastikan file CSV kategori berada di folder data/.';
  }

  let reply = '*Kategori Adidas*\n\n';

  categories.slice(0, 10).forEach((category, index) => {
    reply += `*${index + 1}. ${category.name}* (${category.count} produk)\n`;
  });

  reply += '\nKetik *kategori 1* untuk melihat produk dari kategori nomor 1.';
  reply += '\nKetik *0* untuk kembali.';

  return reply;
}

function getWelcomeMessage() {
  const documents = getAllDocuments();
  const categories = getUniqueCategories(documents);

  let reply = `Halo! Selamat datang di *Adidas Store Assistant*.\n\n`;
  reply += `Toko: *Adidas Official Store*\n`;
  reply += `Total produk: *${documents.length} produk*\n`;
  reply += `Total kategori: *${categories.length || 0} kategori*\n\n`;

  reply += `*Menu Utama*\n`;
  reply += `1. Lihat kategori\n`;
  reply += `2. Cari sepatu / Footwear\n`;
  reply += `3. Mens Apparel\n`;
  reply += `4. Womens Apparel\n`;
  reply += `5. Basketball\n`;
  reply += `6. Football / World Cup\n`;
  reply += `7. Bantuan\n\n`;

  reply += `Ketik angka pilihan. Contoh: *2*\n`;
  reply += `Ketik *0* untuk kembali ke menu utama.\n\n`;

  reply += `Contoh pencarian:\n`;
  reply += `- sepatu adidas putih\n`;
  reply += `- jersey football\n`;
  reply += `- apparel wanita`;

  return reply;
}

function getBackMessage(userId) {
  const session = userSessions.get(userId);
  const documents = getAllDocuments();
  const categories = getUniqueCategories(documents);

  if (!session) {
    return {
      message: getWelcomeMessage(),
      newSession: {
        mode: 'main-menu',
        categories,
        createdAt: Date.now()
      }
    };
  }

  if (
    session.mode === 'main-menu' ||
    session.mode === 'category-list' ||
    session.mode === 'search-guide'
  ) {
    return {
      message: getWelcomeMessage(),
      newSession: {
        mode: 'main-menu',
        categories,
        createdAt: Date.now()
      }
    };
  }

  if (session.mode === 'product-list' && session.previousMode === 'category-list') {
    return {
      message: formatCategoryList(categories),
      newSession: {
        mode: 'category-list',
        categories,
        createdAt: Date.now()
      }
    };
  }

  return {
    message: getWelcomeMessage(),
    newSession: {
      mode: 'main-menu',
      categories,
      createdAt: Date.now()
    }
  };
}

async function getAIResponse(message, contextItems = [], behavior = null) {
  try {
    const contextBlock = ragEngine.buildContextBlock(contextItems);

    if (!behavior) {
      behavior = loadBehavior() || {
        system_instructions: 'Jawab hanya berdasarkan konteks dataset Adidas yang diberikan.',
        fallback_response: 'Mohon maaf, data produk tersebut belum tersedia di dataset Adidas kami.',
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
1. Jawab hanya berdasarkan konteks dataset Adidas.
2. Jangan mengarang produk, harga, lokasi, toko, kategori, atau link.
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
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions'
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
    botStartedAt = Math.floor(Date.now() / 1000);
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

      if (msg.timestamp && msg.timestamp < botStartedAt) {
        console.log(`Mengabaikan pesan lama dari ${msg.from}: ${userMessage}`);
        return;
      }

      console.log(`Pesan masuk dari ${msg.from}: ${userMessage}`);

      const knowledge = loadKnowledge();

      if (knowledge.responses[keyword]) {
        await msg.reply(knowledge.responses[keyword]);
        return;
      }

      const allDocuments = getAllDocuments();
      const categories = getUniqueCategories(allDocuments);

      if (['halo', 'hai', 'hi', 'hello', 'assalamualaikum'].includes(keyword)) {
        userSessions.set(msg.from, {
          mode: 'main-menu',
          categories,
          createdAt: Date.now()
        });

        await msg.reply(getWelcomeMessage());
        return;
      }

      if (keyword === 'menu' || keyword === 'bantuan') {
        userSessions.set(msg.from, {
          mode: 'main-menu',
          categories,
          createdAt: Date.now()
        });

        await msg.reply(getWelcomeMessage());
        return;
      }

      if (
        keyword === '0' ||
        keyword === 'kembali' ||
        keyword === 'back' ||
        keyword === 'balik'
      ) {
        const backResult = getBackMessage(msg.from);
        userSessions.set(msg.from, backResult.newSession);
        await msg.reply(backResult.message);
        return;
      }

      if (keyword === 'jumlah data') {
        await msg.reply(
          `Total produk: *${allDocuments.length} produk*.\n` +
          `Total kategori: *${categories.length} kategori*.`
        );
        return;
      }

      if (/^[1-7]$/.test(keyword)) {
        const session = userSessions.get(msg.from);

        if (session && session.mode === 'main-menu') {
          if (keyword === '1') {
            userSessions.set(msg.from, {
              mode: 'category-list',
              categories,
              createdAt: Date.now()
            });

            await msg.reply(formatCategoryList(categories));
            return;
          }

          if (keyword === '2') {
            const results = searchProductsByKeyword('footwear footware sepatu shoes sneakers adidas', allDocuments, 30);
            const displayedProducts = results.slice(0, 5);

            userSessions.set(msg.from, {
              mode: 'product-list',
              previousMode: 'main-menu',
              products: results,
              displayedProducts,
              page: 1,
              perPage: 5,
              lastQuery: 'Footwear Adidas',
              createdAt: Date.now()
            });

            await msg.reply(formatProductList(displayedProducts, results.length));
            return;
          }

          if (keyword === '3') {
            const results = filterProductsByCategory('Mens Apparel', allDocuments, 30);
            const displayedProducts = results.slice(0, 5);

            userSessions.set(msg.from, {
              mode: 'product-list',
              previousMode: 'main-menu',
              products: results,
              displayedProducts,
              page: 1,
              perPage: 5,
              lastQuery: 'Mens Apparel',
              createdAt: Date.now()
            });

            await msg.reply(formatProductList(displayedProducts, results.length));
            return;
          }

          if (keyword === '4') {
            const results = filterProductsByCategory('Womens Apparel', allDocuments, 30);
            const displayedProducts = results.slice(0, 5);

            userSessions.set(msg.from, {
              mode: 'product-list',
              previousMode: 'main-menu',
              products: results,
              displayedProducts,
              page: 1,
              perPage: 5,
              lastQuery: 'Womens Apparel',
              createdAt: Date.now()
            });

            await msg.reply(formatProductList(displayedProducts, results.length));
            return;
          }

          if (keyword === '5') {
            const results = filterProductsByCategory('Basketball', allDocuments, 30);
            const displayedProducts = results.slice(0, 5);

            userSessions.set(msg.from, {
              mode: 'product-list',
              previousMode: 'main-menu',
              products: results,
              displayedProducts,
              page: 1,
              perPage: 5,
              lastQuery: 'Basketball',
              createdAt: Date.now()
            });

            await msg.reply(formatProductList(displayedProducts, results.length));
            return;
          }

          if (keyword === '6') {
            const results = searchProductsByKeyword('football world cup worldcup jersey adidas bola', allDocuments, 30);
            const displayedProducts = results.slice(0, 5);

            userSessions.set(msg.from, {
              mode: 'product-list',
              previousMode: 'main-menu',
              products: results,
              displayedProducts,
              page: 1,
              perPage: 5,
              lastQuery: 'Football World Cup',
              createdAt: Date.now()
            });

            await msg.reply(formatProductList(displayedProducts, results.length));
            return;
          }

          if (keyword === '7') {
            userSessions.set(msg.from, {
              mode: 'search-guide',
              categories,
              createdAt: Date.now()
            });

            await msg.reply(
              '*Bantuan*\n\n' +
              'Ketik *halo* untuk menu utama.\n' +
              'Ketik *kategori* untuk daftar kategori.\n' +
              'Ketik *ada lagi* untuk produk berikutnya.\n' +
              'Ketik nomor produk untuk detail.\n' +
              'Ketik *0* untuk kembali.'
            );
            return;
          }
        }
      }

      if (keyword === 'kategori' || keyword === 'daftar kategori') {
        userSessions.set(msg.from, {
          mode: 'category-list',
          categories,
          createdAt: Date.now()
        });

        await msg.reply(formatCategoryList(categories));
        return;
      }

      const kategoriMatch = keyword.match(/^kategori\s+(\d+)$/);
      if (kategoriMatch) {
        const selectedIndex = Number(kategoriMatch[1]) - 1;
        const selectedCategory = categories[selectedIndex];

        if (!selectedCategory) {
          await msg.reply('Nomor kategori tidak tersedia. Ketik *kategori* untuk melihat daftar kategori.');
          return;
        }

        const results = filterProductsByCategory(selectedCategory.name, allDocuments, 30);
        const displayedProducts = results.slice(0, 5);

        userSessions.set(msg.from, {
          mode: 'product-list',
          previousMode: 'category-list',
          products: results,
          displayedProducts,
          page: 1,
          perPage: 5,
          lastQuery: `kategori ${selectedCategory.name}`,
          createdAt: Date.now()
        });

        await msg.reply(formatProductList(displayedProducts, results.length));
        return;
      }

      if (
        keyword === 'ada lagi' ||
        keyword === 'lagi' ||
        keyword === 'next' ||
        keyword === 'selanjutnya' ||
        keyword === 'lihat lagi' ||
        keyword === 'produk lainnya'
      ) {
        const session = userSessions.get(msg.from);

        if (!session || !session.products || session.products.length === 0) {
          await msg.reply('Belum ada pencarian produk sebelumnya. Coba ketik: *sepatu adidas putih*');
          return;
        }

        const start = session.page * session.perPage;
        const end = start + session.perPage;
        const nextProducts = session.products.slice(start, end);

        if (nextProducts.length === 0) {
          await msg.reply('Tidak ada produk tambahan lagi dari hasil pencarian sebelumnya.');
          return;
        }

        session.page += 1;
        session.displayedProducts = nextProducts;
        userSessions.set(msg.from, session);

        await msg.reply(formatProductList(nextProducts, session.products.length));
        return;
      }

      if (/^(10|[1-9])$/.test(keyword)) {
        const session = userSessions.get(msg.from);

        if (!session || session.mode !== 'product-list' || !session.displayedProducts || session.displayedProducts.length === 0) {
          await msg.reply('Belum ada daftar produk. Coba ketik: *sepatu adidas putih*');
          return;
        }

        const selectedIndex = Number(keyword) - 1;
        const selectedProduct = session.displayedProducts[selectedIndex];

        if (!selectedProduct) {
          await msg.reply('Nomor produk tidak tersedia.');
          return;
        }

        await msg.reply(formatProductDetail(selectedProduct));
        return;
      }

      const jumlahTampil = getRequestedProductCount(userMessage);
      const semuaHasilProduk = searchProductsByKeyword(userMessage, allDocuments, 30);

      if (semuaHasilProduk.length > 0) {
        const produkDitampilkan = semuaHasilProduk.slice(0, jumlahTampil);

        userSessions.set(msg.from, {
          mode: 'product-list',
          previousMode: 'main-menu',
          products: semuaHasilProduk,
          displayedProducts: produkDitampilkan,
          page: 1,
          perPage: jumlahTampil,
          lastQuery: userMessage,
          createdAt: Date.now()
        });

        await msg.reply(formatProductList(produkDitampilkan, semuaHasilProduk.length));
        return;
      }

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