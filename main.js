const express = require('express');
const app = express();
const port = process.env.PORT || 10000;

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
});
import { Telegraf } from 'telegraf';
import axios from 'axios';
import fs from 'fs';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { chromium } from 'playwright';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

dotenv.config();

const TOKEN = process.env.BOT_TOKEN;
const originalAdminId = process.env.ORIGINAL_ADMIN_ID;

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(process.env.MONGODB_DB_NAME);
const adminsCollection = db.collection('admins');

await adminsCollection.insertOne({ userId: originalAdminId, original: true });

const bot = new Telegraf(TOKEN);

const state = {};

bot.use(async (ctx, next) => {
  const adminUser = await adminsCollection.findOne({ userId: String(ctx.from.id) });
  if (adminUser) {
    return next(ctx);
  } else {
    return ctx.reply('Sorry, you do not have access to this bot. Please contact the admin to get access.');
  }
});

bot.command('addadmin', async (ctx) => {
  const originalAdmin = await adminsCollection.findOne({ original: true });
  if (String(ctx.from.id) === originalAdmin.userId) {
    const newAdminId = ctx.message.text.split(' ')[1];
    if (newAdminId && !isNaN(newAdminId)) {
      await adminsCollection.insertOne({ userId: newAdminId });
      ctx.reply(`User ${newAdminId} has been added as an admin.`);
    } else {
      ctx.reply('Please provide a valid user ID of the new admin.');
    }
  } else {
    ctx.reply('Only the original admin can add new admins.');
  }
});

bot.command('removeadmin', async (ctx) => {
  const originalAdmin = await adminsCollection.findOne({ original: true });
  if (String(ctx.from.id) === originalAdmin.userId) {
    const adminIdToRemove = ctx.message.text.split(' ')[1];
    if (adminIdToRemove && !isNaN(adminIdToRemove)) {
      await adminsCollection.deleteOne({ userId: adminIdToRemove });
      ctx.reply(`User ${adminIdToRemove} has been removed as an admin.`);
    } else {
      ctx.reply('Please provide a valid user ID of the admin to remove.');
    }
  } else {
    ctx.reply('Only the original admin can remove admins.');
  }
});

bot.on('text', async (ctx) => {
  const userId = String(ctx.from.id);
  const message = ctx.message.text;

  if (state[userId] && state[userId].waitingForRenameConfirmation) {
    clearTimeout(state[userId].timeout);
    if (message.toLowerCase() === 'yes') {
      state[userId].waitingForRenameConfirmation = false;
      state[userId].waitingForNewName = true;
      await ctx.reply('Please enter the new name for the PDF file (without extension):');
      state[userId].timeout = setTimeout(() => {
        state[userId] = null;
        ctx.reply('You did not respond in time. The renaming process has been aborted.');
      }, 60000);
    } else {
      state[userId].waitingForRenameConfirmation = false;
      state[userId].newName = 'images';
      await createPDF(ctx, state[userId].url, state[userId].newName);
      state[userId] = null;
    }
    return;
  } else if (state[userId] && state[userId].waitingForNewName) {
    clearTimeout(state[userId].timeout);
    state[userId].newName = message;
    await createPDF(ctx, state[userId].url, state[userId].newName);
    state[userId] = null;
    return;
  } else {
    state[userId] = { url: message, waitingForRenameConfirmation: true };
    await ctx.reply('Do you want to rename the PDF file? (yes/no)');
    state[userId].timeout = setTimeout(() => {
      state[userId] = null;
      ctx.reply('You did not respond in time. The renaming process has been aborted.');
    }, 60000);
  }
});

async function createPDF(ctx, url, newName) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  } catch (error) {
    console.error('Navigation timed out', error);
  }

  const pdf = new PDFDocument();
  const pdfStream = fs.createWriteStream(`${newName}.pdf`);
  pdf.pipe(pdfStream);

  let filenames = [];

  const images = await page.$$eval('img', imgs => imgs.map(img => img.src));
  console.log('Image URLs:', images);

  const downloadPromises = images.map(async (image, index) => {
    if (!image.startsWith('data:') && (image.endsWith('.jpg') || image.endsWith('.jpeg') || image.endsWith('.webp'))) {
      try {
        const response = await axios.get(image, { 
          responseType: 'arraybuffer',
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3' }
        });

        let buffer = Buffer.from(response.data, 'binary');

        if (image.endsWith('.webp')) {
          buffer = await sharp(buffer).jpeg().toBuffer();
        }

        const filename = `image-${Date.now()}.jpg`;
        fs.writeFileSync(filename, buffer);
        filenames.push({ filename, index });

      } catch (error) {
        console.error(`Failed to download image ${image}:`, error);
      }
    } else {
      console.log(`Skipping unsupported image format: ${image}`);
    }
  });

  await Promise.all(downloadPromises);

  filenames.sort((a, b) => a.index - b.index);

  for (const { filename } of filenames) {
    try {
      const { width, height } = await sharp(filename).metadata();

      pdf.addPage({
        size: [width, height]
      });

      pdf.image(filename, 0, 0, { width: width, height: height });
    } catch (error) {
      console.error(`Failed to add image ${filename} to PDF:`, error);
    }
  }

  pdf.end();

  await new Promise(resolve => pdfStream.on('finish', resolve));

  try {
    const readStream = fs.createReadStream(`${newName}.pdf`);
    await ctx.replyWithDocument({ source: readStream, filename: `${newName}.pdf` });
  } catch (error) {
    console.error('Failed to send PDF:', error);
    await ctx.reply('Sorry, there was an error sending the PDF. Please try again.');
  }

  for (const { filename } of filenames) {
    try {
      if (fs.existsSync(filename)) {
        fs.unlinkSync(filename);
      }
    } catch (error) {
      console.error(`Failed to delete image file ${filename}:`, error);
    }
  }

  try {
    if (fs.existsSync(`${newName}.pdf`)) {
      fs.unlinkSync(`${newName}.pdf`);
    }
  } catch (error) {
    console.error(`Failed to delete PDF file ${newName}.pdf:`, error);
  }
}  

bot.launch();
