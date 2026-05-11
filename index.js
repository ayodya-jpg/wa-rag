const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const csv = require('csv-parser');
require('dotenv').config();

let products = [];

// Membaca data CSV Shopee
fs.createReadStream('data/shopee.csv')
  .pipe(csv())
  .on('data', (row) => {
    products.push({
      nama: row['whitespace-normal'] || '-',
      harga: row['font-medium 2'] || '-',
      rating: row['flex-none'] || '-',
      lokasi: row['ml-[3px]'] || '-',
      link: row['contents href'] || '-',
      gambar: row['_image_yazkc_11 src'] || '-'
    });
  })
  .on('end', () => {
    console.log(`Data Shopee berhasil dibaca: ${products.length} produk`);
  })
  .on('error', (err) => {
    console.error('Gagal membaca file CSV:', err.message);
  });

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', qr => {
  console.log('Scan QR berikut menggunakan WhatsApp:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('Chatbot WhatsApp sudah siap!');
});

client.on('message', async message => {
  const pesanAsli = message.body.trim();
  const pesan = pesanAsli.toLowerCase();

  if (pesan === 'halo' || pesan === 'hai' || pesan === 'hi') {
    await message.reply(
      'Halo! Saya Chatbot Shopee RAG.\n\n' +
      'Ketik *menu* untuk melihat daftar perintah.'
    );
    return;
  }

  if (pesan === 'menu') {
    await message.reply(
      '*MENU CHATBOT SHOPEE*\n\n' +
      '1. *halo*\n' +
      '   Mengecek apakah bot aktif.\n\n' +
      '2. *jumlah data*\n' +
      '   Melihat jumlah produk dari hasil scraping.\n\n' +
      '3. *cari [nama produk]*\n' +
      '   Mencari produk berdasarkan kata kunci.\n' +
      '   Contoh: *cari garbera*\n\n' +
      '4. *lokasi [nama kota]*\n' +
      '   Mencari produk berdasarkan lokasi.\n' +
      '   Contoh: *lokasi surabaya*'
    );
    return;
  }

  if (pesan === 'jumlah data') {
    await message.reply(`Jumlah data produk yang terbaca adalah *${products.length} produk*.`);
    return;
  }

  if (pesan.startsWith('cari ')) {
    const keyword = pesan.replace('cari ', '').trim();

    if (!keyword) {
      await message.reply('Masukkan kata kunci produk.\nContoh: *cari garbera*');
      return;
    }

    const hasil = products.filter(item =>
      item.nama.toLowerCase().includes(keyword)
    );

    if (hasil.length === 0) {
      await message.reply(`Maaf, produk dengan kata kunci *${keyword}* tidak ditemukan.`);
      return;
    }

    let balasan = `Ditemukan *${hasil.length} produk* untuk kata kunci *${keyword}*.\n\n`;

    hasil.slice(0, 5).forEach((item, index) => {
      balasan +=
        `*${index + 1}. ${item.nama}*\n` +
        `Harga: Rp${item.harga}\n` +
        `Rating/Terjual: ${item.rating}\n` +
        `Lokasi: ${item.lokasi}\n` +
        `Link: ${item.link}\n\n`;
    });

    balasan += 'Menampilkan maksimal 5 produk teratas.';
    await message.reply(balasan);
    return;
  }

  if (pesan.startsWith('lokasi ')) {
    const lokasi = pesan.replace('lokasi ', '').trim();

    if (!lokasi) {
      await message.reply('Masukkan nama lokasi.\nContoh: *lokasi surabaya*');
      return;
    }

    const hasil = products.filter(item =>
      item.lokasi.toLowerCase().includes(lokasi)
    );

    if (hasil.length === 0) {
      await message.reply(`Maaf, produk dari lokasi *${lokasi}* tidak ditemukan.`);
      return;
    }

    let balasan = `Ditemukan *${hasil.length} produk* dari lokasi *${lokasi}*.\n\n`;

    hasil.slice(0, 5).forEach((item, index) => {
      balasan +=
        `*${index + 1}. ${item.nama}*\n` +
        `Harga: Rp${item.harga}\n` +
        `Rating/Terjual: ${item.rating}\n` +
        `Lokasi: ${item.lokasi}\n` +
        `Link: ${item.link}\n\n`;
    });

    balasan += 'Menampilkan maksimal 5 produk teratas.';
    await message.reply(balasan);
    return;
  }

  await message.reply(
    'Maaf, saya belum memahami perintah tersebut.\n\n' +
    'Ketik *menu* untuk melihat daftar perintah.'
  );
});

client.initialize();