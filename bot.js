// bot.js
process.removeAllListeners('warning');

import baileys from '@whiskeysockets/baileys';
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeInMemoryStore, fetchLatestBaileysVersion } = baileys;
import { Boom } from '@hapi/boom';
import { promises as fs } from 'fs';
import pino from 'pino';
import { CONFIG } from './config.js';
import { startServer } from './server.js';
import { AIHandler } from './ai_handler.js';

const logger = pino({ level: 'info' });
const silentLogger = pino({ level: 'silent' });
const aiHandler = new AIHandler();
const store = makeInMemoryStore({ logger: silentLogger });
let groupMetadataCache = {};
let rateLimitStatus = { lastChecked: 0, isLimited: false, retryAfter: 0 };
let pendingBindings = {};

const MAX_RETRIES = 8;
let retryCount = 0;
let lastCrashTime = 0;

async function logNetworkError(error) {
  try {
    await fs.mkdir('./data', { recursive: true });
    const errorDetails = {
      timestamp: new Date().toISOString(),
      message: error.message,
      stack: error.stack,
      code: error.code || 'UNKNOWN'
    };
    await fs.appendFile(
      CONFIG.ERROR_LOG,
      `[${errorDetails.timestamp}] ${JSON.stringify(errorDetails)}\n`
    );
    logger.error('Error logged:', errorDetails);
  } catch (err) {
    logger.error('Failed to log error:', err);
  }
}

const handleError = async (err, type) => {
  const now = Date.now();
  console.error(`${type}:`, err);
  await logNetworkError(err);

  if (now - lastCrashTime > 3 * 60 * 1000) {
    retryCount = 0;
  }

  lastCrashTime = now;
  retryCount++;

  const delay = Math.min(Math.pow(2, retryCount) * 1000, 20000);
  if (retryCount <= MAX_RETRIES) {
    console.log(`Restarting bot in ${delay/1000} seconds... (Attempt ${retryCount}/${MAX_RETRIES})`);
    setTimeout(() => startBot(), delay);
  } else {
    console.error('Max retries exceeded, exiting...');
    process.exit(1);
  }
};

process.on('uncaughtException', err => handleError(err, 'Uncaught Exception'));
process.on('unhandledRejection', err => handleError(err, 'Unhandled Rejection'));

const PHONE_NUMBER = process.env.PHONE_NUMBER;
const validatePhoneNumber = (num) => /^\d{10,12}$/.test(num?.replace(/[^\d]/g, ''));
if (!PHONE_NUMBER || !validatePhoneNumber(PHONE_NUMBER)) {
  logger.error('Invalid or missing PHONE_NUMBER in environment variables. Format: +1234567890');
  process.exit(1);
}// Part 2: Core Functions
async function loadData() {
  let bindings = {};
  let settings = { ...CONFIG.DEFAULT_SETTINGS };
  let permissions = { allowed: [] };
  try {
    await fs.mkdir('./data', { recursive: true });
    const bindingsData = await fs.readFile(CONFIG.BINDINGS_FILE, 'utf8').catch(() => '{}');
    bindings = bindingsData.trim() ? JSON.parse(bindingsData) : {};
    const settingsData = await fs.readFile(CONFIG.SETTINGS_FILE, 'utf8').catch(() => '{}');
    settings = settingsData.trim() ? JSON.parse(settingsData) : { ...CONFIG.DEFAULT_SETTINGS };
    const permissionsData = await fs.readFile(CONFIG.PERMISSIONS_FILE, 'utf8').catch(() => '{}');
    permissions = permissionsData.trim() ? JSON.parse(permissionsData) : { allowed: [] };
  } catch (error) {
    logger.error('Error loading data:', error.message);
    await fs.writeFile(CONFIG.BINDINGS_FILE, JSON.stringify(bindings, null, 2));
    await fs.writeFile(CONFIG.SETTINGS_FILE, JSON.stringify(settings, null, 2));
    await fs.writeFile(CONFIG.PERMISSIONS_FILE, JSON.stringify(permissions, null, 2));
  }
  return { bindings, settings, permissions };
}

async function saveData(bindings, settings, permissions) {
  try {
    await fs.mkdir('./data', { recursive: true });
    await Promise.all([
      fs.writeFile(CONFIG.BINDINGS_FILE, JSON.stringify(bindings, null, 2)),
      fs.writeFile(CONFIG.SETTINGS_FILE, JSON.stringify(settings, null, 2)),
      fs.writeFile(CONFIG.PERMISSIONS_FILE, JSON.stringify(permissions, null, 2)),
    ]);
  } catch (error) {
    logger.error('Error saving data:', error.message);
  }
}

async function validateSession(sock) {
  try {
    if (sock.ws.readyState !== 1) {
      logger.warn('Socket disconnected, reconnecting...');
      await sock.ws.close();
      await new Promise(resolve => setTimeout(resolve, 500));
      await sock.connect();
    }
    return !!(await sock.user);
  } catch {
    return false;
  }
}

async function checkRateLimit(sock) {
  const now = Date.now();
  if (rateLimitStatus.isLimited && now < rateLimitStatus.retryAfter) return true;
  if (now - rateLimitStatus.lastChecked < CONFIG.RATE_LIMIT_CACHE) return rateLimitStatus.isLimited;
  try {
    await Promise.race([
      sock.groupFetchAllParticipating(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), CONFIG.GROUP_FETCH_TIMEOUT))
    ]);
    rateLimitStatus = { lastChecked: now, isLimited: false, retryAfter: 0 };
    return false;
  } catch (error) {
    await logNetworkError(error);
    if (error.message?.includes('rate-overlimit')) {
      rateLimitStatus = { lastChecked: now, isLimited: true, retryAfter: now + CONFIG.RATE_LIMIT_BACKOFF };
      logger.warn(`Rate limit detected. Retry after ${new Date(rateLimitStatus.retryAfter).toLocaleTimeString()}.`);
      return true;
    }
    return false;
  }
}

async function validateGroupAccess(sock, groupId, userId, isSource = false) {
  try {
    let groupMetadata;
    const now = Date.now();
    if (groupMetadataCache[groupId]?.timestamp && now - groupMetadataCache[groupId].timestamp < CONFIG.CACHE_DURATION) {
      groupMetadata = groupMetadataCache[groupId].data;
    } else {
      for (let attempt = 1; attempt <= CONFIG.RETRY_ATTEMPTS; attempt++) {
        try {
          groupMetadata = await Promise.race([
            sock.groupMetadata(groupId),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), CONFIG.GROUP_METADATA_TIMEOUT))
          ]);
          groupMetadataCache[groupId] = { data: groupMetadata, timestamp: now };
          break;
        } catch (error) {
          await logNetworkError(error);
          if (error.message.includes('rate-overlimit')) {
            await new Promise(resolve => setTimeout(resolve, CONFIG.BASE_RETRY_DELAY * attempt));
            continue;
          }
          throw error;
        }
      }
    }
    const participant = groupMetadata.participants?.find(p => p.id === userId);
    if (!participant) return { valid: false, reason: `*Not in group!* Join \`${groupId}\` first.` };
    if (!isSource && !participant.admin) return { valid: false, reason: `*Admin required!* You must be an admin in \`${groupId}\`.` };
    if (isSource && !groupMetadata.participants.some(p => p.id === userId)) return { valid: false, reason: `*Not a member!* Join \`${groupId}\` as a member.` };
    return { valid: true, metadata: groupMetadata };
  } catch (error) {
    await logNetworkError(error);
    return { valid: false, reason: `*Group access failed!* ${error.message}. Try /status.` };
  }
}

async function fetchCommunitySubgroups(sock, communityName, userId) {
  try {
    let groups;
    const now = Date.now();
    if (groupMetadataCache['allGroups']?.timestamp && now - groupMetadataCache['allGroups'].timestamp < CONFIG.CACHE_DURATION) {
      groups = groupMetadataCache['allGroups'].data;
    } else {
      for (let attempt = 1; attempt <= CONFIG.RETRY_ATTEMPTS; attempt++) {
        try {
          groups = await Promise.race([
            sock.groupFetchAllParticipating(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), CONFIG.GROUP_FETCH_TIMEOUT))
          ]);
          groupMetadataCache['allGroups'] = { data: groups, timestamp: now };
          break;
        } catch (error) {
          await logNetworkError(error);
          if (error.message.includes('rate-overlimit')) continue;
          if (attempt === CONFIG.RETRY_ATTEMPTS) throw error;
          await new Promise(resolve => setTimeout(resolve, CONFIG.BASE_RETRY_DELAY * attempt));
        }
      }
    }
    const groupArray = Object.values(groups).filter(g => g.id.endsWith('@g.us'));
    const community = groupArray.find(
      g => g.subject?.toLowerCase().includes(communityName.toLowerCase()) && g.isCommunity
    );
    if (!community) return { valid: false, reason: `*Community not found!* Check \`${communityName}\` with /listgroups.` };
    const subgroups = groupArray
      .filter(g => 
        g.id !== community.id && 
        (g.isCommunitySubGroup || g.participants.some(p => community.participants.some(cp => cp.id === p.id))) &&
        g.participants.some(p => p.id === userId)
      )
      .slice(0, CONFIG.MAX_SUBGROUPS)
      .map(g => ({ id: g.id, name: g.subject || 'Unnamed', chatId: g.id.split('@')[0] }));
    if (subgroups.length === 0) return { valid: false, reason: `*No subgroups found!* Join subgroups of \`${communityName}\`.` };
    return { valid: true, communityId: community.id, communityName: community.subject || communityName, subgroups };
  } catch (error) {
    await logNetworkError(error);
    return { valid: false, reason: `*Subgroup fetch failed!* ${error.message}. Try /status.` };
  }
}

async function fetchUserChats(sock, userId) {
  try {
    let groups;
    const now = Date.now();
    const BATCH_SIZE = CONFIG.MAX_BATCH_SIZE;
    const BATCH_DELAY = CONFIG.BATCH_DELAY;

    if (!(await validateSession(sock))) {
      throw new Error('Session validation failed');
    }

    if (!groupMetadataCache['allGroups'] || Object.keys(groupMetadataCache['allGroups'].data).length < CONFIG.MIN_GROUP_COUNT) {
      groupMetadataCache['allGroups'] = null;
    }

    if (!groupMetadataCache['allGroups'] || now - groupMetadataCache['allGroups'].timestamp > CONFIG.CACHE_DURATION) {
      for (let attempt = 1; attempt <= CONFIG.RETRY_ATTEMPTS; attempt++) {
        try {
          groups = await Promise.race([
            sock.groupFetchAllParticipating(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), CONFIG.GROUP_FETCH_TIMEOUT))
          ]);
          const groupIds = Object.keys(groups);

          for (let i = 0; i < groupIds.length; i += BATCH_SIZE) {
            const batch = groupIds.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async (groupId) => {
              try {
                const metadata = await Promise.race([
                  sock.groupMetadata(groupId),
                  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), CONFIG.GROUP_METADATA_TIMEOUT))
                ]);
                groups[groupId] = { ...groups[groupId], ...metadata };
              } catch (err) {
                logger.error(`Metadata error for ${groupId}:`, err);
              }
            }));
            await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
          }
          groupMetadataCache['allGroups'] = { data: groups, timestamp: now };
          break;
        } catch (error) {
          await logNetworkError(error);
          if (error.message.includes('rate-overlimit')) continue;
          if (attempt === CONFIG.RETRY_ATTEMPTS) throw error;
          await new Promise(resolve => setTimeout(resolve, CONFIG.BASE_RETRY_DELAY * attempt));
        }
      }
    } else {
      groups = groupMetadataCache['allGroups'].data;
    }

    const groupArray = Object.values(groups)
      .filter(g => g.id.endsWith('@g.us') && g.participants?.some(p => p.id === userId))
      .map(g => ({
        id: g.id,
        name: g.subject || 'Unnamed',
        chatId: g.id.split('@')[0],
        type: g.isCommunity ? 'Community' : (g.subjectOwner && groups[g.subjectOwner]?.isCommunity) ? 'Subgroup' : 'Group',
        admin: g.participants.find(p => p.id === userId)?.admin ? '✅ Yes' : '❌ No',
        parent: g.subjectOwner && groups[g.subjectOwner]?.isCommunity ? groups[g.subjectOwner].subject : null,
      }));

    const communities = groupArray.filter(g => g.type === 'Community');
    const subgroups = groupArray.filter(g => g.type === 'Subgroup');
    const standaloneGroups = groupArray.filter(g => g.type === 'Group');
    const organizedChats = [
      ...communities.map(c => ({
        ...c,
        subgroups: subgroups.filter(s => s.parent === c.name || s.id.includes(c.id.split('@')[0])).slice(0, CONFIG.MAX_SUBGROUPS),
      })),
      ...standaloneGroups,
    ];

    return { valid: true, chats: organizedChats };
  } catch (error) {
    await logNetworkError(error);
    return { valid: false, reason: `*Chat fetch failed!* ${error.message}. Try /status.` };
  }
}// Part 3: Connection and Event Handlers
async function startBot() {
  try {
    await fs.mkdir('./data', { recursive: true });
    await fs.mkdir('./auth_info', { recursive: true });
  } catch (error) {
    logger.error('Session directory error:', error);
  }

  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    defaultQueryTimeoutMs: CONFIG.DEFAULT_QUERY_TIMEOUT,
    connectTimeoutMs: CONFIG.CONNECTION_TIMEOUT,
    keepAliveIntervalMs: 5000,
    logger: silentLogger,
    browser: ['WhatsApp Bot', 'Chrome', '1.0.0'],
    syncFullHistory: false,
  });

  try {
    await fs.mkdir('./data', { recursive: true });
    store.bind(sock.ev);
    await store.readFromFile(CONFIG.STORE_FILE).catch(() => {});
    setInterval(async () => {
      try {
        await store.writeToFile(CONFIG.STORE_FILE);
      } catch (err) {
        logger.warn('Store write failed:', err.message);
      }
    }, CONFIG.STORE_WRITE_INTERVAL);
  } catch (error) {
    logger.error('Store initialization error:', error.message);
  }

  startServer(sock);

  let pairingAttempts = 0;
  const MAX_PAIRING_ATTEMPTS = 3;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && pairingAttempts < MAX_PAIRING_ATTEMPTS) {
      logger.info(`QR code generated. Access via /qr endpoint.`);
      pairingAttempts++;
      await fs.appendFile(CONFIG.ERROR_LOG, `[${new Date().toISOString()}] QR code generated\n`);
    }

    if (connection === 'connecting' && pairingAttempts < MAX_PAIRING_ATTEMPTS) {
      try {
        if (PHONE_NUMBER) {
          const pairingCode = await sock.requestPairingCode(PHONE_NUMBER);
          logger.info(`Pairing Code: ${pairingCode} (WhatsApp > Linked Devices > Link with Phone Number)`);
          pairingAttempts++;
        }
      } catch (error) {
        await logNetworkError(error);
        logger.error('Pairing code failed:', error.message);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      const reconnectDelay = Math.min(2000 * Math.pow(2, pairingAttempts), 20000);
      logger.info(`Connection closed: ${lastDisconnect?.error?.message || 'Unknown'} (Status: ${statusCode})`);
      await fs.appendFile(CONFIG.ERROR_LOG, `[${new Date().toISOString()}] Connection closed: ${statusCode}\n`);
      if (shouldReconnect) {
        logger.info(`Reconnecting in ${reconnectDelay/1000} seconds...`);
        setTimeout(startBot, reconnectDelay);
      } else {
        logger.info('Logged out. Pair again.');
        await fs.appendFile(CONFIG.ERROR_LOG, `[${new Date().toISOString()}] Logged out\n`);
      }
    } else if (connection === 'open') {
      logger.info('✅ Bot online! User: ' + JSON.stringify(sock.user));
      pairingAttempts = 0;
      await fs.writeFile(`./data/auth_info_backup_${Date.now()}.json`, JSON.stringify(state, null, 2));
      logger.info('Session backed up!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  setInterval(async () => {
    try {
      if (sock?.user?.id) {
        await sock.sendPresenceUpdate('available');
      }
    } catch (err) {
      logger.error('Keep-alive error:', err);
    }
  }, 20000);

  setInterval(() => {
    const now = Date.now();
    for (const chatId in pendingBindings) {
      if (now - pendingBindings[chatId].timestamp > 3 * 60 * 1000) {
        delete pendingBindings[chatId];
        logger.info(`Cleaned expired binding: ${chatId}`);
      }
    }
  }, 30 * 1000);

  setInterval(async () => {
    try {
      await fs.writeFile(`./data/auth_info_backup_${Date.now()}.json`, JSON.stringify(state, null, 2));
      logger.info('Periodic session backup');
    } catch (error) {
      logger.error('Backup failed:', error.message);
    }
  }, 5 * 60 * 1000);// Part 4: Message Processing and Commands
sock.ev.on('messages.upsert', async ({ messages, type }) => {
  try {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg?.message || msg.key?.remoteJid?.endsWith('@broadcast')) return;
    if (msg.key.fromMe) return;

    await sock.sendPresenceUpdate('available', msg.key.remoteJid);
    await sock.readMessages([msg.key]);

    const chatId = msg.key.remoteJid;
    const senderId = msg.key.participant || msg.key.remoteJid;
    const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
    const text = messageText.toLowerCase().trim();

    if (!text) return;
    const ownerId = sock.user?.id.split(':')[0] + '@s.whatsapp.net';

    if (!(await validateSession(sock))) {
      await sock.sendMessage(chatId, { text: '*Session Error!* Scan QR or enter pairing code!' }, { timeout: CONFIG.MESSAGE_TIMEOUT });
      return;
    }

    if (await checkRateLimit(sock)) {
      const retryTime = new Date(rateLimitStatus.retryAfter).toLocaleTimeString();
      await sock.sendMessage(chatId, { text: `*Too many requests!* Try after ${retryTime}. Check /cooldown.` }, { timeout: CONFIG.MESSAGE_TIMEOUT });
      return;
    }

    let { bindings, settings, permissions } = await loadData();
    const isOwner = senderId === ownerId;
    const isAllowed = isOwner || permissions.allowed.includes(senderId);

    const sendMessage = async (content) => {
      try {
        await Promise.race([
          sock.sendMessage(chatId, { text: content }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Message send timeout')), CONFIG.MESSAGE_TIMEOUT))
        ]);
      } catch (error) {
        await logNetworkError(error);
        logger.error('Send message failed:', error.message);
      }
    };

    if (text.startsWith('/')) {
      const [command, ...args] = text.split(' ');
      const argText = args.join(' ');

      if (command === '/ai') {
        if (!isAllowed) {
          await sendMessage('*Access Denied!* Ask owner to allow with /allow.');
          return;
        }
        const aiQuery = argText.trim();
        if (!aiQuery) {
          await sendMessage('*No query!* Use: /ai <command> <query> or /ai help.');
          return;
        }
        const [aiCommand, ...aiArgs] = argText.split(' ');
        const aiArgText = aiArgs.join(' ');
        const response = await aiHandler.handleCommand(aiCommand, aiArgText);

        if (typeof response === 'object' && response.images) {
          for (const imageBuffer of response.images) {
            await sock.sendMessage(chatId, {
              image: imageBuffer,
              caption: response.text
            }, { timeout: CONFIG.MESSAGE_TIMEOUT });
          }
        } else {
          await sendMessage(response);
        }
        return;
      }

      switch (command) {
        case '/allow':
          if (!isOwner) {
            await sendMessage('*Owner Only!* Only owner can allow users.');
            return;
          }
          if (args.length !== 1 || !args[0].startsWith('+')) {
            await sendMessage('*Wrong format!* Use: /allow +1234567890');
            return;
          }
          const allowedUser = args[0].replace('+', '') + '@s.whatsapp.net';
          if (permissions.allowed.includes(allowedUser)) {
            await sendMessage(`*Already Allowed!* ${args[0]} has access.`);
            return;
          }
          permissions.allowed.push(allowedUser);
          await saveData(bindings, settings, permissions);
          await sendMessage(`*Access Granted!* ${args[0]} can use AI/settings.`);
          break;

        case '/bindcommunity':
          if (args.length < 2) {
            await sendMessage('*Wrong format!* Use: /bindcommunity <community-name> <target-id>');
            return;
          }
          const communityName = args.slice(0, -1).join(' ');
          const targetId = args[args.length - 1].endsWith('@g.us') ? args[args.length - 1] : `${args[args.length - 1]}@g.us`;
          if (!targetId.endsWith('@g.us')) {
            await sendMessage('*Invalid Target ID!* Use /getid in target group.');
            return;
          }
          const targetValidation = await validateGroupAccess(sock, targetId, senderId, false);
          if (!targetValidation.valid) {
            await sendMessage(`*Binding Failed!* ${targetValidation.reason}`);
            return;
          }
          const communityData = await fetchCommunitySubgroups(sock, communityName, senderId);
          if (!communityData.valid) {
            await sendMessage(`*Binding Failed!* ${communityData.reason}`);
            return;
          }
          pendingBindings[chatId] = {
            communityName: communityData.communityName,
            targetId,
            targetName: targetValidation.metadata.subject,
            subgroups: communityData.subgroups,
            timestamp: Date.now(),
          };
          const subgroupList = communityData.subgroups.map((g, i) => `🌟 ${i + 1}. ${g.name} (\`${g.id}\`)`).join('\n');
          await sendMessage(
            `*Binding Preview*\n📤 Community: *${communityData.communityName}*\n📥 Target: *${targetValidation.metadata.subject}* (\`${targetId}\`)\n🔗 Subgroups:\n${subgroupList}\n💡 Reply with /confirmbind to finish! (Expires in 3 min)`
          );
          break;

        case '/confirmbind':
          const pending = pendingBindings[chatId];
          if (!pending || Date.now() - pending.timestamp > 3 * 60 * 1000) {
            await sendMessage('*No Pending Binding!* Start with /bindcommunity.');
            return;
          }
          let boundCount = 0;
          for (const subgroup of pending.subgroups) {
            const sourceValidation = await validateGroupAccess(sock, subgroup.id, senderId, true);
            if (!sourceValidation.valid) continue;
            if (!bindings[subgroup.id]) {
              bindings[subgroup.id] = {
                target: pending.targetId,
                credit: settings.forwardCredit,
                note: settings.forwardNote,
                sourceName: subgroup.name,
                targetName: pending.targetName,
              };
              boundCount++;
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          }
          if (boundCount === 0) {
            await sendMessage('*No New Bindings!* Subgroups already bound or invalid. Check /listbinds.');
            return;
          }
          await saveData(bindings, settings, permissions);
          await sendMessage(`*Success!* Bound ${boundCount} subgroups to *${pending.targetName}* (\`${pending.targetId}\`)`);
          delete pendingBindings[chatId];
          break;

        case '/bindviareply':
          if (!msg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
            await sendMessage('*Reply to a message!* Use: /bindviareply <target-id>');
            return;
          }
          if (args.length !== 1) {
            await sendMessage('*Wrong format!* Use: /bindviareply <target-id>');
            return;
          }
          const sourceId = msg.message.extendedTextMessage.contextInfo.remoteJid;
          const replyTargetId = args[0].endsWith('@g.us') ? args[0] : `${args[0]}@g.us`;
          if (!replyTargetId.endsWith('@g.us')) {
            await sendMessage('*Invalid Target ID!* Use /getid in target group.');
            return;
          }
          const sourceValidation = await validateGroupAccess(sock, sourceId, senderId, true);
          const replyTargetValidation = await validateGroupAccess(sock, replyTargetId, senderId, false);
          if (!sourceValidation.valid || !replyTargetValidation.valid) {
            await sendMessage(`*Binding Failed!* Source: ${sourceValidation.reason}\nTarget: ${replyTargetValidation.reason}`);
            return;
          }
          bindings[sourceId] = {
            target: replyTargetId,
            credit: settings.forwardCredit,
            note: settings.forwardNote,
            sourceName: sourceValidation.metadata.subject,
            targetName: replyTargetValidation.metadata.subject,
          };
          await saveData(bindings, settings, permissions);
          await sendMessage(`*Success!* Bound *${sourceValidation.metadata.subject}* to *${replyTargetValidation.metadata.subject}*`);
          break;

        case '/cooldown':
          await sendMessage(
            rateLimitStatus.isLimited
              ? `*Cooldown Active!* Try after ${new Date(rateLimitStatus.retryAfter).toLocaleTimeString()}.`
              : '*All clear!* You can use commands now.'
          );
          break;

        case '/clean':
        case '/clear':
          try {
            const minutes = parseInt(args[0]) || 3;
            const timeLimit = Date.now() - (minutes * 60 * 1000);
            const batchSize = 10;
            let deleted = 0;
            let lastKey = null;

            while (true) {
              const messages = await sock.fetchMessagesFromWA(chatId, batchSize, lastKey);
              if (!messages.length) break;

              const targetMessages = messages.filter(m => 
                (m.key.fromMe || m.key.participant === senderId) && 
                (m.messageTimestamp * 1000) > timeLimit
              );

              for (const msg of targetMessages) {
                for (let attempt = 1; attempt <= CONFIG.RETRY_ATTEMPTS; attempt++) {
                  try {
                    await sock.sendMessage(chatId, { delete: msg.key });
                    deleted++;
                    await new Promise(resolve => setTimeout(resolve, 300));
                    break;
                  } catch (err) {
                    logger.error(`Delete attempt ${attempt} failed:`, err);
                    if (err.message.includes('rate-overlimit')) {
                      await new Promise(resolve => setTimeout(resolve, CONFIG.RATE_LIMIT_DELAY));
                      continue;
                    }
                    break;
                  }
                }
              }

              lastKey = messages[messages.length - 1]?.key;
              if (messages.length < batchSize) break;
            }

            await sendMessage(`*Cleaned!* Removed ${deleted} messages from last ${minutes} minutes.`);
          } catch (error) {
            await logNetworkError(error);
            await sendMessage(`*Cleanup failed!* ${error.message}. Try /status.`);
          }
          break;

        case '/bind':
          if (args.length !== 2) {
            await sendMessage('*Wrong format!* Use: /bind <source-id/link> <target-id/link>');
            return;
          }
          const extractId = (input) => {
            if (input.includes('chat.whatsapp.com')) {
              try {
                const url = new URL(input);
                return url.pathname.split('/').pop() + '@g.us';
              } catch (e) {
                return input;
              }
            }
            return input.endsWith('@g.us') ? input : `${input}@g.us`;
          };
          const srcId = extractId(args[0]);
          const tgtId = extractId(args[1]);
          const srcAccess = await validateGroupAccess(sock, srcId, senderId, true);
          const tgtAccess = await validateGroupAccess(sock, tgtId, senderId, false);
          if (!srcAccess.valid || !tgtAccess.valid) {
            await sendMessage(`*Binding failed!* Source: ${srcAccess.reason}\nTarget: ${tgtAccess.reason}`);
            return;
          }
          bindings[srcId] = {
            target: tgtId,
            credit: settings.forwardCredit,
            note: settings.forwardNote,
            sourceName: srcAccess.metadata.subject,
            targetName: tgtAccess.metadata.subject,
          };
          await saveData(bindings, settings, permissions);
          await sendMessage(`*Success!* Bound *${srcAccess.metadata.subject}* to *${tgtAccess.metadata.subject}*`);
          break;

        case '/help':
          await sendMessage(
            `*Command Guide*
┃ ⚡ /allow +1234567890 - Allow user (owner)
┃ ⚡ /bindcommunity <name> <target-id> - Bind subgroups
┃ ⚡ /confirmbind - Finish binding
┃ ⚡ /bindviareply <target-id> - Bind via reply
┃ ⚡ /bind <source-id> <target-id> - Bind group
┃ ⚡ /cooldown - Check wait time
┃ ⚡ /clean - Clear bot messages
┃ ⚡ /listgroups - List groups
┃ ⚡ /getid - Get chat ID
┃ ⚡ /status - Check health
┃ ⚡ /settings note|credit|forward <value> - Tweak settings
┃ ⚡ /unbind <source-id> <target-id> - Remove binding
┃ ⚡ /listbinds - View bindings
┃ ⚡ /ai <command> <query> - Ask AI`
          );
          break;

        case '/getid':
          const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
          const quotedJid = contextInfo?.remoteJid || chatId;
          await sendMessage(`*Chat ID*: \`${quotedJid}\`\nShort ID: \`${quotedJid.split('@')[0]}\``);
          break;

        case '/listgroups':
          const chatData = await fetchUserChats(sock, senderId);
          if (!chatData.valid) {
            await sendMessage(`*Chat List Failed!* ${chatData.reason}`);
            return;
          }
          if (chatData.chats.length === 0) {
            await sendMessage('*No Groups!* Join groups/communities first.');
            return;
          }
          const formattedList = chatData.chats
            .map((chat, i) => {
              const base = `◈ *${i + 1}. ${chat.name}*\nID: \`${chat.id}\`\nType: ${chat.type}\nAdmin: ${chat.admin}`;
              return chat.type === 'Community' && chat.subgroups?.length
                ? `${base}\nSubgroups:\n${chat.subgroups.map((s, j) => `  ${j + 1}. ${s.name} (\`${s.id}\`)`).join('\n')}`
                : base;
            })
            .join('\n\n');
          await sendMessage(`*Your Groups & Communities*\n${formattedList}\n💡 Bind with /bindcommunity!`);
          break;

        case '/settings':
          if (!isAllowed) {
            await sendMessage('*Access Denied!* Ask owner to allow with /allow.');
            return;
          }
          if (args.length === 0) {
            await sendMessage(
              `*Settings*\nNote: *${settings.forwardNote}*\nCredit: *${settings.forwardCredit}*\nForwarding: ${settings.forwardingEnabled ? '*On*' : '*Off*'}\n💡 Use: /settings note|credit|forward <value>`
            );
            return;
          }
          const settingType = args[0].toLowerCase();
          const settingValue = args.slice(1).join(' ');
          if (!settingType || !settingValue) {
            await sendMessage('*Wrong format!* Use: /settings note|credit|forward <value>');
            return;
          }
          switch (settingType) {
            case 'note':
              settings.forwardNote = settingValue;
              await saveData(bindings, settings, permissions);
              await sendMessage(`*Note Updated!* New: *${settingValue}*`);
              break;
            case 'credit':
              settings.forwardCredit = settingValue;
              await saveData(bindings, settings, permissions);
              await sendMessage(`*Credit Updated!* New: *${settingValue}*`);
              break;
            case 'forward':
              if (!['on', 'off'].includes(settingValue.toLowerCase())) {
                await sendMessage('*Invalid value!* Use: /settings forward on|off');
                return;
              }
              settings.forwardingEnabled = settingValue.toLowerCase() === 'on';
              await saveData(bindings, settings, permissions);
              await sendMessage(`*Forwarding ${settings.forwardingEnabled ? 'Enabled' : 'Disabled'}!*`);
              break;
            default:
              await sendMessage('*Invalid setting!* Use: note|credit|forward');
          }
          break;

        case '/status':
          const health = await aiHandler.checkBotHealth();
          await sendMessage(health);
          break;

        case '/unbind':
          if (args.length !== 2) {
            await sendMessage('*Wrong format!* Use: /unbind <source-id> <target-id>');
            return;
          }
          const unbindSrcId = args[0].endsWith('@g.us') ? args[0] : `${args[0]}@g.us`;
          const unbindTgtId = args[1].endsWith('@g.us') ? args[1] : `${args[1]}@g.us`;
          if (!bindings[unbindSrcId] || bindings[unbindSrcId].target !== unbindTgtId) {
            await sendMessage('*No Binding!* Check /listbinds.');
            return;
          }
          const srcMeta = await validateGroupAccess(sock, unbindSrcId, senderId, true);
          const tgtMeta = await validateGroupAccess(sock, unbindTgtId, senderId, false);
          if (!srcMeta.valid || !tgtMeta.valid) {
            await sendMessage(`*Unbind Failed!* Source: ${srcMeta.reason}\nTarget: ${tgtMeta.reason}`);
            return;
          }
          delete bindings[unbindSrcId];
          await saveData(bindings, settings, permissions);
          await sendMessage(`*Unbound!* Removed binding from *${srcMeta.metadata.subject}* to *${tgtMeta.metadata.subject}*.`);
          break;

        case '/listbinds':
          if (Object.keys(bindings).length === 0) {
            await sendMessage('*No Bindings!* Create one with /bind or /bindcommunity.');
            return;
          }
          const bindList = Object.entries(bindings)
            .map(([srcId, bind], i) => `◈ *${i + 1}. ${bind.sourceName}* (\`${srcId}\`) → *${bind.targetName}* (\`${bind.target}\`)`)
            .join('\n');
          await sendMessage(`*Active Bindings*\n${bindList}`);
          break;

        default:
          await sendMessage('*Unknown Command!* Use /help for commands.');
      }
    } else if (bindings[chatId] && settings.forwardingEnabled) {
      try {
        const target = bindings[chatId];
        const forwardText = `${settings.forwardNote}\n\n${messageText}\n\n${settings.forwardCredit}`;
        await sock.sendMessage(target.target, { text: forwardText }, { timeout: CONFIG.MESSAGE_TIMEOUT });
      } catch (error) {
        await logNetworkError(error);
        await sendMessage(`*Forwarding failed!* ${error.message}. Try /status.`);
      }
    }
  } catch (error) {
    await logNetworkError(error);
    logger.error('Message processing error:', error);
    await sock.sendMessage(messages[0].key.remoteJid, { text: `*Error!* ${error.message}. Try /status.` }, { timeout: CONFIG.MESSAGE_TIMEOUT });
  }
});

startBot().catch(error => {
  logger.error('Bot startup error:', error);
});
}
