// config.js
export const CONFIG = {
  STORE_FILE: './data/baileys_store.json',
  BINDINGS_FILE: './data_bindings.json',
  SETTINGS_FILE: './data_settings.json',
  PERMISSIONS_FILE: './data_permissions.json',
  ERROR_LOG: './data/network_errors.log',
  CACHE_DURATION: 4 * 60 * 60 * 1000, // 4 hours
  RETRY_ATTEMPTS: 5,
  BASE_RETRY_DELAY: 3000,
  RATE_LIMIT_DELAY: 10000,
  RATE_LIMIT_CACHE: 30 * 1000, // 30 seconds
  RATE_LIMIT_BACKOFF: 15 * 60 * 1000, // 15 minutes
  MAX_BATCH_SIZE: 15,
  BATCH_DELAY: 3000,
  CONNECTION_TIMEOUT: 120000,
  DEFAULT_QUERY_TIMEOUT: 30000,
  MESSAGE_TIMEOUT: 10000,
  GROUP_FETCH_TIMEOUT: 60000,
  GROUP_METADATA_TIMEOUT: 20000,
  AI_RATE_LIMIT: 1000,
  MAX_SUBGROUPS: 25,
  MIN_GROUP_COUNT: 2,
  RECONNECT_INTERVAL: 3000,
  MAX_MESSAGES: 500,
  MAX_STORE_AGE: 20000,
  STORE_WRITE_INTERVAL: 20000,
  DEFAULT_SETTINGS: {
    forwardingEnabled: true,
    forwardCredit: 'Forwarded by WhatsApp Bot',
    forwardNote: '🔄 Forwarded Message',
    reminders: {},
  },
};