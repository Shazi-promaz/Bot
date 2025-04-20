// server.js
import express from 'express';
import QRCode from 'qrcode';
import { promises as fs } from 'fs';
import { CONFIG } from './config.js';
import pino from 'pino';
import path from 'path';
import { AIHandler } from './ai_handler.js';

const logger = pino({ level: 'info' });
const app = express();
const aiHandler = new AIHandler();
let qrCode = null;
let server = null;
let isServerStarting = false;

app.use(express.static('public'));
app.use(express.json());

export function startServer(sock) {
  if (isServerStarting) return;
  isServerStarting = true;

  if (server) {
    try {
      server.close();
    } catch (error) {
      logger.error('Error closing server:', error);
    }
  }

  sock.ev.on('connection.update', async ({ qr, connection, lastDisconnect }) => {
    if (qr) {
      qrCode = qr;
      logger.info('QR code available at /qr');
      try {
        await fs.appendFile(CONFIG.ERROR_LOG, `[${new Date().toISOString()}] New QR code generated\n`);
      } catch (error) {
        logger.error('Failed to log QR event:', error);
      }
    }
    if (connection === 'open') {
      qrCode = null;
      logger.info('*WhatsApp connected!*');
      try {
        await fs.mkdir('./auth_info', { recursive: true });
        await fs.appendFile(CONFIG.ERROR_LOG, `[${new Date().toISOString()}] Connection established\n`);
      } catch (error) {
        logger.error('Session storage error:', error);
      }
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      logger.warn(`Connection closed. Status code: ${statusCode}`);
      await fs.appendFile(CONFIG.ERROR_LOG, `[${new Date().toISOString()}] Connection closed: ${statusCode}\n`);
    }
  });

  app.get('/', (req, res) => {
    res.send('*WhatsApp Bot Running*');
  });

  app.get('/health', (req, res) => {
    res.json({
      status: qrCode ? 'waiting' : 'connected',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/status', (req, res) => {
    res.json({ botRunning: !qrCode });
  });

  app.get('/qr', async (req, res) => {
    if (!qrCode) {
      return res.send(`
        <html>
          <head><title>No QR Code</title><meta http-equiv="refresh" content="3"></head>
          <body style="display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; font-family: Arial;">
            <div style="text-align: center; padding: 20px; border-radius: 10px; background: #f5f5f5;">
              <h2>Waiting for QR Code...</h2>
              <p>Refreshing in 3 seconds</p>
            </div>
          </body>
        </html>
      `);
    }

    try {
      const qrDataUrl = await QRCode.toDataURL(qrCode);
      res.send(`
        <html>
          <head><title>WhatsApp QR</title></head>
          <body style="display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; font-family: Arial; background: #f0f2f5;">
            <div style="text-align: center; padding: 20px; border-radius: 10px; background: white; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
              <h2 style="color: #128C7E;">Scan to Connect</h2>
              <img src="${qrDataUrl}" style="max-width: 200px; margin: 10px 0;"/>
              <p style="color: #666;">Open WhatsApp > Settings > Linked Devices</p>
            </div>
          </body>
        </html>
      `);
    } catch (error) {
      res.status(500).send('*QR code failed*: ' + error.message);
    }
  });

  app.get('/chat', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'public_chat.html'));
  });

  app.post('/api/ai', async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt) return res.status(400).json({ error: 'No prompt provided' });
      const { response } = await aiHandler.tryFetchAIResponse(prompt);
      res.json({ text: response });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  const port = process.env.PORT || 5000;
  server = app.listen(port, '0.0.0.0', () => {
    logger.info(`Server running on port ${port}`);
    logger.info(`QR URL: /qr`);
    logger.info(`Chat Interface: /chat`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      logger.error(`Port ${port} in use, attempting recovery`);
      setTimeout(() => {
        server.close();
        server.listen(port, '0.0.0.0');
      }, 1000);
    } else {
      logger.error('Server error:', error.message);
    }
  });
}