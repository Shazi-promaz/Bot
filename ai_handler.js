// ai_handler.js
import { promises as fs } from 'fs';
import { CONFIG } from './config.js';

export class AIHandler {
  constructor() {
    this.apis = [
      { name: 'Pico LLM', url: 'https://backend.buildpicoapps.com/aero/run/llm-api?pk=v1-Z0FBQUFBQm5IZkJDMlNyYUVUTjIyZVN3UWFNX3BFTU85SWpCM2NUMUk3T2dxejhLSzBhNWNMMXNzZlp3c09BSTR6YW1Sc1BmdGNTVk1GY0liT1RoWDZZX1lNZlZ0Z1dqd3c9PQ==', param: 'prompt', responseKey: 'text', method: 'POST' },
      { name: 'Gemini', url: 'https://gemini-1-5-flash.bjcoderx.workers.dev/', param: 'text', responseKey: 'text', method: 'GET' },
      { name: 'Qwen', url: 'https://qwen-ai.apis-bj-devs.workers.dev/', param: 'text', responseKey: 'content', method: 'GET' },
      { name: 'GPT-3.5', url: 'https://gpt-3-5.apis-bj-devs.workers.dev/', param: 'prompt', responseKey: 'reply', method: 'POST' },
      { name: 'SeaArt', url: 'https://seaart-ai.apis-bj-devs.workers.dev/', param: 'Prompt', responseKey: 'result', method: 'GET', isImage: true },
    ];
    this.currentApiIndex = 0;
    this.errorLog = CONFIG.ERROR_LOG;
  }

  async fetchAIResponse(api, prompt, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await new Promise(resolve => setTimeout(resolve, CONFIG.AI_RATE_LIMIT * attempt));
        let response;
        if (api.method === 'POST') {
          response = await fetch(api.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [api.param]: prompt }),
          });
        } else {
          const query = new URLSearchParams({ [api.param]: prompt }).toString();
          response = await fetch(`${api.url}?${query}`, { method: 'GET' });
        }
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        const data = await response.json();
        let text = data[api.responseKey] || data.text || 'No response content';
        return text;
      } catch (error) {
        const errorMsg = `AI API Error (${api.name}): ${error.message}`;
        console.error(errorMsg);
        await fs.appendFile(this.errorLog, `${new Date().toISOString()} - ${errorMsg}\n`);
        if (attempt === retries) throw error;
      }
    }
  }

  async tryFetchAIResponse(prompt) {
    for (let i = 0; i < this.apis.length; i++) {
      const api = this.apis[this.currentApiIndex];
      try {
        const response = await this.fetchAIResponse(api, prompt);
        return { response, apiName: api.name };
      } catch (error) {
        this.currentApiIndex = (this.currentApiIndex + 1) % this.apis.length;
        if (i === this.apis.length - 1) throw new Error('All APIs failed');
      }
    }
  }

  async handleCommand(command, text) {
    try {
      switch (command?.toLowerCase()) {
        case 'image':
          return await this.generateImage(text);
        case 'fix':
          return await this.fixCode(text);
        case 'modify':
          return await this.modifyCode(text);
        case 'help':
          return await this.getHelp();
        case 'check':
          return await this.checkSystem();
        case 'debug':
          return await this.debugFeature(text);
        case 'checkhealth':
          return await this.checkBotHealth();
        case 'fixerror':
          return await this.fixBotError(text);
        default:
          if (text || command) {
            const query = text ? `${command} ${text}` : command;
            const { response, apiName } = await this.tryFetchAIResponse(query);
            return `*AI Response (${apiName})*:\n${response}`;
          }
          return '*No query!* Use: /ai <command> <query> or /ai help for commands.';
      }
    } catch (error) {
      return `*AI Error!* ${error.message}. Try again or use /status.`;
    }
  }

  async checkBotHealth() {
    try {
      const logContent = await fs.readFile(this.errorLog, 'utf8').catch(() => '');
      const recentErrors = logContent.split('\n').slice(-10).join('\n');
      const bindingsData = await fs.readFile(CONFIG.BINDINGS_FILE, 'utf8').catch(() => '{}');
      const bindings = JSON.parse(bindingsData);
      const prompt = `Check WhatsApp bot health:\nRecent logs:\n${recentErrors}\nBindings: ${Object.keys(bindings).length} active\nAssess connection, rate limits, and errors.`;
      const { response, apiName } = await this.tryFetchAIResponse(prompt);
      return `*Bot Health (${apiName})*:\n${response}`;
    } catch (error) {
      return `*Health check failed!* ${error.message}. Try again or check /status.`;
    }
  }

  async fixBotError(errorDescription) {
    try {
      const logContent = await fs.readFile(this.errorLog, 'utf8').catch(() => '');
      const botCode = await fs.readFile('./bot.js', 'utf8').catch(() => '');
      const prompt = `Suggest fixes for WhatsApp bot error:\nError: ${errorDescription}\nRecent logs: ${logContent.split('\n').slice(-10).join('\n')}\nBot code: ${botCode}\nProvide specific code changes safely.`;
      const { response, apiName } = await this.tryFetchAIResponse(prompt);
      return `*Fix Suggested (${apiName})*:\n${response}\n*Please review and apply manually.*`;
    } catch (error) {
      return `*Fix failed!* ${error.message}. Try again or check /status.`;
    }
  }

  async fixCode(code) {
    try {
      const prompt = `Analyze this code for errors and suggest fixes:\n${code}\nProvide updated code if needed.`;
      const { response, apiName } = await this.tryFetchAIResponse(prompt);
      return `*Code Analysis (${apiName})*:\n${response}`;
    } catch (error) {
      return `*Code analysis failed!* ${error.message}. Try again or check /status.`;
    }
  }

  async modifyCode(instruction) {
    try {
      const botCode = await fs.readFile('./bot.js', 'utf8').catch(() => '');
      const prompt = `Suggest modifications for WhatsApp bot based on:\n${instruction}\nCurrent bot.js:\n${botCode}\nProvide updated code and specify the file.`;
      const { response, apiName } = await this.tryFetchAIResponse(prompt);
      return `*Modification Suggested (${apiName})*:\n${response}`;
    } catch (error) {
      return `*Code modification failed!* ${error.message}. Try again or check /status.`;
    }
  }

  async getHelp() {
    return `*AI Commands*
🌟 /ai image <prompt> - Generate AI art
🌟 /ai fix <code> - Fix code errors
🌟 /ai modify <request> - Change bot code
🌟 /ai check - Check bot system
🌟 /ai debug <feature> - Debug a feature
🌟 /ai checkhealth - Check bot health
🌟 /ai fixerror <description> - Fix bot error
🌟 /ai help - Show this guide
🌟 /ai <query> - Ask a question`;
  }

  async checkSystem() {
    try {
      const prompt = 'Check for potential issues in the WhatsApp bot system.';
      const { response, apiName } = await this.tryFetchAIResponse(prompt);
      return `*System Check (${apiName})*:\n${response}`;
    } catch (error) {
      return `*System check failed!* ${error.message}. Try again or check /status.`;
    }
  }

  async debugFeature(feature) {
    try {
      const prompt = `Debug this feature and provide a solution:\n${feature}`;
      const { response, apiName } = await this.tryFetchAIResponse(prompt);
      return `*Debug Report (${apiName})*:\n${response}`;
    } catch (error) {
      return `*Debug failed!* ${error.message}. Try again or check /status.`;
    }
  }

  async generateImage(prompt) {
    if (!prompt) return '*No prompt!* Use: /ai image <description>';
    try {
      const api = this.apis.find(a => a.name === 'SeaArt');
      if (!api) throw new Error('SeaArt API not configured');
      const response = await fetch(`${api.url}?${api.param}=${encodeURIComponent(prompt)}`);
      if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
      const data = await response.json();
      if (data.status !== 'success' || !Array.isArray(data.result) || data.result.length === 0) {
        throw new Error('Invalid or empty image response');
      }
      const imageBuffers = await Promise.all(
        data.result.map(async (img) => {
          if (!img.url) throw new Error('Missing image URL');
          const imgResponse = await fetch(img.url);
          return Buffer.from(await imgResponse.arrayBuffer());
        })
      );
      return {
        text: `*AI Art*\nPrompt: ${prompt}\nImages: ${imageBuffers.length}`,
        images: imageBuffers
      };
    } catch (error) {
      return `*Image generation failed!* ${error.message}`;
    }
  }
}