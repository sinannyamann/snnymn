// GecexCore - Gelişmiş Mikroservis Platformu (Railway için Optimize Edilmiş)
const express = require('express');
const { WebSocketServer } = require('ws');
const mongoose = require('mongoose');
const { Client } = require('pg');
const axios = require('axios');
const { Octokit } = require('@octokit/rest');
const ngrok = require('ngrok');
const EventEmitter = require('events');
require('dotenv').config();

// Token'ların ortam değişkenlerinden alınması
const {
  SESSION_SECRET,
  OPENAI_API_KEY,
  DATABASE_URL,
  PGDATABASE,
  PGHOST,
  PGPORT,
  PGUSER,
  PGPASSWORD,
  GITHUB_PERSONAL_ACCESS_TOKEN,
  ANTHROPIC_API_KEY,
  DEEPSEEK_API_KEY,
  GOOGLE_SEARCH_API_KEY,
  GOOGLE_SEARCH_ENGINE_ID,
  NGROK_AUTH_TOKEN
} = process.env;

// MongoDB Şema Tanımları
const chatSchema = new mongoose.Schema({
  requestId: String,
  username: String,
  message: String,
  response: String,
  context: Object,
  timestamp: { type: Date, default: Date.now }
});
const Chat = mongoose.model('Chat', chatSchema);

class GecexCore extends EventEmitter {
  constructor() {
    super();
    this.app = express();
    this.plugins = new Map();
    this.services = new Map();
    this.middleware = [];
    this.config = {
      port: process.env.PORT || 4000, // Railway PORT değişkenini kullanır
      environment: process.env.NODE_ENV || 'production',
      logLevel: process.env.LOG_LEVEL || 'info',
      enableMetrics: true,
      enableHealthCheck: true,
      wsPort: process.env.WS_PORT || 4001
    };

    this.metrics = {
      requests: 0,
      errors: 0,
      activeConnections: 0,
      wsConnections: 0,
      pluginCalls: {},
      startTime: Date.now()
    };

    // PostgreSQL Bağlantısı
    this.pgClient = new Client({
      user: PGUSER,
      host: PGHOST,
      database: PGDATABASE,
      password: PGPASSWORD,
      port: PGPORT,
      connectionString: process.env.POSTGRES_URL || `postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}`
    });

    // GitHub Entegrasyonu
    this.octokit = new Octokit({ auth: GITHUB_PERSONAL_ACCESS_TOKEN });

    this.setupCore();
    this.setupWebSocket();
    this.setupDatabase();
  }

  async setupDatabase() {
    try {
      // MongoDB Bağlantısı
      await mongoose.connect(DATABASE_URL, {
        useNewUrlParser: true,
        useUnifiedTopology: true
      });
      this.log('info', 'MongoDB bağlantısı başarılı');

      // PostgreSQL Bağlantısı
      await this.pgClient.connect();
      this.log('info', 'PostgreSQL bağlantısı başarılı');

      // Kullanıcı tablosu oluşturma
      await this.pgClient.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(255) UNIQUE NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    } catch (error) {
      this.log('error', 'Veritabanı bağlantısı başarısız', { error: error.message });
      process.exit(1);
    }
  }

  setupCore() {
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(require('express-session')({
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false
    }));

    // İstek izleme middleware'i
    this.app.use((req, res, next) => {
      this.metrics.requests++;
      this.metrics.activeConnections++;

      req.gecexId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      req.startTime = Date.now();

      res.on('finish', () => {
        this.metrics.activeConnections--;
        const duration = Date.now() - req.startTime;
        this.emit('request:completed', {
          id: req.gecexId,
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          duration
        });
      });

      next();
    });

    this.setupCoreRoutes();
    this.setupNgrok();
  }

  async setupNgrok() {
    try {
      const url = await ngrok.connect({
        addr: this.config.port,
        authtoken: NGROK_AUTH_TOKEN
      });
      this.log('info', `Ngrok tüneli oluşturuldu: ${url}`);
      this.emit('ngrok:connected', { url });
    } catch (error) {
      this.log('error', 'Ngrok bağlantısı başarısız', { error: error.message });
    }
  }

  setupWebSocket() {
    this.wss = new WebSocketServer({ port: this.config.wsPort });
    this.wss.on('connection', (ws) => {
      this.metrics.wsConnections++;
      this.log('info', 'Yeni WebSocket bağlantısı');

      ws.on('message', async (message) => {
        try {
          const data = JSON.parse(message);
          const response = await this.orchestrateChat({
            message: data.message,
            username: data.username || 'anonymous',
            context: data.context || {},
            requestId: `ws_${Date.now()}`
          });
          ws.send(JSON.stringify(response));
        } catch (error) {
          ws.send(JSON.stringify({ error: error.message }));
        }
      });

      ws.on('close', () => {
        this.metrics.wsConnections--;
        this.log('info', 'WebSocket bağlantısı kapandı');
      });
    });
    this.log('info', `WebSocket sunucusu ${this.config.wsPort} portunda başlatıldı`);
  }

  setupCoreRoutes() {
    // Sağlık kontrolü
    this.app.get('/gecex/health', (req, res) => {
      const uptime = Date.now() - this.metrics.startTime;
      res.json({
        status: 'healthy',
        platform: 'GecexCore',
        version: '2.0.0',
        uptime: Math.floor(uptime / 1000),
        memory: {
          used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
        },
        plugins: {
          total: this.plugins.size,
          active: Array.from(this.plugins.entries()).filter(([_, plugin]) => plugin.status === 'active').length
        },
        services: {
          total: this.services.size,
          healthy: Array.from(this.services.values()).filter(service => service.health === 'healthy').length
        },
        metrics: this.metrics
      });
    });

    // Eklenti ve servis listeleme
    this.app.get('/gecex/plugins', (req, res) => {
      const pluginList = Array.from(this.plugins.entries()).map(([name, plugin]) => ({
        name,
        status: plugin.status,
        version: plugin.version,
        description: plugin.description,
        endpoints: plugin.endpoints || [],
        lastActivity: plugin.lastActivity
      }));
      res.json({ plugins: pluginList });
    });

    this.app.get('/gecex/services', (req, res) => {
      const serviceList = Array.from(this.services.entries()).map(([name, service]) => ({
        name,
        url: service.url,
        health: service.health,
        lastCheck: service.lastCheck,
        responseTime: service.responseTime
      }));
      res.json({ services: serviceList });
    });

    // Birleşik API uç noktası
    this.app.all('/api/*', async (req, res) => {
      const path = req.path.replace('/api/', '');
      const segments = path.split('/');
      const pluginName = segments[0];

      try {
        const result = await this.callPlugin(pluginName, req.method, path, req.body, req.query, req.headers);
        res.status(result.statusCode || 200).json(result.data);
      } catch (error) {
        this.metrics.errors++;
        this.emit('error', { plugin: pluginName, error: error.message, request: req.gecexId });
        res.status(500).json({
          error: 'Eklenti çalıştırma hatası',
          plugin: pluginName,
          message: error.message,
          requestId: req.gecexId
        });
      }
    });

    // Gelişmiş sohbet uç noktası
    this.app.post('/gecex/chat', async (req, res) => {
      const { message, username, context } = req.body;

      if (!message) {
        return res.status(400).json({ error: 'Mesaj gerekli' });
      }

      try {
        const orchestrationResult = await this.orchestrateChat({
          message,
          username: username || 'anonymous',
          context: context || {},
          requestId: req.gecexId
        });
        res.json(orchestrationResult);
      } catch (error) {
        this.metrics.errors++;
        res.status(500).json({
          error: 'Sohbet düzenleme başarısız',
          message: error.message,
          requestId: req.gecexId
        });
      }
    });

    // Google Arama uç noktası
    this.app.get('/gecex/search', async (req, res) => {
      const { query } = req.query;
      if (!query) {
        return res.status(400).json({ error: 'Arama sorgusu gerekli' });
      }

      try {
        const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
          params: {
            key: GOOGLE_SEARCH_API_KEY,
            cx: GOOGLE_SEARCH_ENGINE_ID,
            q: query
          }
        });
        res.json({ results: response.data.items });
      } catch (error) {
        res.status(500).json({ error: 'Arama başarısız', message: error.message });
      }
    });
  }

  // Eklenti Kaydı
  registerPlugin(name, pluginConfig) {
    const plugin = {
      name,
      version: pluginConfig.version || '1.0.0',
      description: pluginConfig.description || '',
      endpoints: pluginConfig.endpoints || [],
      handler: pluginConfig.handler,
      status: 'active',
      registeredAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      config: pluginConfig.config || {}
    };

    this.plugins.set(name, plugin);
    this.metrics.pluginCalls[name] = 0;

    if (pluginConfig.routes) {
      Object.entries(pluginConfig.routes).forEach(([route, handler]) => {
        const fullRoute = `/api/${name}${route}`;
        this.app.all(fullRoute, async (req, res) => {
          try {
            const result = await handler(req, res, this);
            if (!res.headersSent) {
              res.json(result);
            }
          } catch (error) {
            if (!res.headersSent) {
              res.status(500).json({ error: error.message });
            }
          }
        });
      });
    }

    this.emit('plugin:registered', { name, plugin });
    this.log('info', `Eklenti kaydedildi: ${name} v${plugin.version}`);

    return plugin;
  }

  // Servis Kaydı
  registerService(name, serviceConfig) {
    const service = {
      name,
      url: serviceConfig.url,
      health: 'unknown',
      timeout: serviceConfig.timeout || 5000,
      retries: serviceConfig.retries || 3,
      lastCheck: null,
      responseTime: null,
      registeredAt: new Date().toISOString()
    };

    this.services.set(name, service);
    this.emit('service:registered', { name, service });
    this.log('info', `Servis kaydedildi: ${name} at ${service.url}`);

    this.startServiceHealthCheck(name);
    return service;
  }

  // Eklenti Çalıştırma
  async callPlugin(pluginName, method, path, body, query, headers) {
    const plugin = this.plugins.get(pluginName);

    if (!plugin) {
      throw new Error(`Eklenti bulunamadı: ${pluginName}`);
    }

    if (plugin.status !== 'active') {
      throw new Error(`Eklenti aktif değil: ${pluginName}`);
    }

    this.metrics.pluginCalls[pluginName]++;
    plugin.lastActivity = new Date().toISOString();

    const context = {
      method,
      path,
      body,
      query,
      headers,
      gecex: this,
      plugin: plugin.name
    };

    try {
      const result = await plugin.handler(context);
      this.emit('plugin:called', { plugin: pluginName, success: true });
      return result;
    } catch (error) {
      this.emit('plugin:called', { plugin: pluginName, success: false, error: error.message });
      throw error;
    }
  }

  // Servis Sağlığı İzleme
  async startServiceHealthCheck(serviceName) {
    const service = this.services.get(serviceName);
    if (!service) return;

    const checkHealth = async () => {
      const startTime = Date.now();
      try {
        const response = await axios.get(`${service.url}/health`, {
          timeout: service.timeout
        });

        service.health = response.status === 200 ? 'healthy' : 'unhealthy';
        service.responseTime = Date.now() - startTime;
        service.lastCheck = new Date().toISOString();
      } catch (error) {
        service.health = 'unhealthy';
        service.responseTime = Date.now() - startTime;
        service.lastCheck = new Date().toISOString();
      }
    };

    await checkHealth();
    setInterval(checkHealth, 30000);
  }

  // Gelişmiş Sohbet Düzenleme
  async orchestrateChat(chatRequest) {
    const { message, username, context, requestId } = chatRequest;
    const orchestration = {
      requestId,
      steps: [],
      result: {},
      timing: {
        start: Date.now(),
        end: null,
        duration: null
      }
    };

    try {
      // Kullanıcı kaydı
      await this.pgClient.query(
        'INSERT INTO users (username) VALUES ($1) ON CONFLICT DO NOTHING',
        [username]
      );

      // Karakter analizi (Anthropic)
      if (this.plugins.has('character')) {
        orchestration.steps.push('character_analysis');
        const userAnalysis = await axios.post(
          'https://api.anthropic.com/v1/messages',
          {
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 1000,
            messages: [{ role: 'user', content: `Kullanıcı: ${username}, Mesaj: ${message}. Kullanıcı davranışını analiz et.` }]
          },
          { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } }
        );
        orchestration.result.user = userAnalysis.data.content[0].text;
      }

      // Yapay zeka yanıtı (OpenAI)
      if (this.plugins.has('ai')) {
        orchestration.steps.push('ai_generation');
        const aiResponse = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-4',
            messages: [{ role: 'user', content: message }],
            max_tokens: 1500
          },
          { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` } }
        );
        orchestration.result.response = aiResponse.data.choices[0].message.content;
      }

      // Derin analiz (DeepSeek)
      if (this.plugins.has('deepseek')) {
        orchestration.steps.push('deepseek_analysis');
        const deepResponse = await axios.post(
          'https://api.deepseek.com/v1/chat/completions',
          {
            model: 'deepseek-pro',
            messages: [{ role: 'user', content: `Analiz et: ${message}` }],
            max_tokens: 1000
          },
          { headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` } }
        );
        orchestration.result.deepAnalysis = deepResponse.data.choices[0].message.content;
      }

      // GitHub entegrasyonu
      if (context.github && this.plugins.has('github')) {
        orchestration.steps.push('github_integration');
        const repo = await this.octokit.repos.get({
          owner: context.github.owner,
          repo: context.github.repo
        });
        orchestration.result.github = { repo: repo.data.full_name };
      }

      // Veritabanına kaydetme
      await new Chat({
        requestId,
        username,
        message,
        response: orchestration.result.response,
        context
      }).save();

      // Analitik kaydı
      if (this.plugins.has('analytics')) {
        orchestration.steps.push('analytics_logging');
        await this.callPlugin('analytics', 'POST', 'analytics/record', {
          event: 'chat_interaction',
          username,
          message,
          response: orchestration.result.response,
          requestId
        });
      }

    } catch (error) {
      orchestration.error = error.message;
    }

    orchestration.timing.end = Date.now();
    orchestration.timing.duration = orchestration.timing.end - orchestration.timing.start;

    this.emit('chat:orchestrated', orchestration);

    return {
      response: orchestration.result.response || 'Düzenleme başarısız',
      sender: 'GecexCore',
      timestamp: new Date().toISOString(),
      orchestration: {
        requestId,
        steps: orchestration.steps,
        duration: orchestration.timing.duration,
        success: !orchestration.error
      },
      user: orchestration.result.user,
      deepAnalysis: orchestration.result.deepAnalysis,
      github: orchestration.result.github
    };
  }

  // Günlük Sistemi
  log(level, message, data = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
      platform: 'GecexCore'
    };

    console.log(`[${logEntry.timestamp}] [${level.toUpperCase()}] ${message}`, data);
    this.emit('log', logEntry);
  }

  // Platform Başlatma
  async start() {
    return new Promise((resolve) => {
      this.app.listen(this.config.port, () => {
        this.log('info', `GecexCore Platformu ${this.config.port} portunda başlatıldı`);
        this.log('info', `Ortam: ${this.config.environment}`);
        this.log('info', `Sağlık Kontrolü: http://localhost:${this.config.port}/gecex/health`);
        this.log('info', `Eklenti API: http://localhost:${this.config.port}/api/*`);
        this.log('info', `Gelişmiş Sohbet: http://localhost:${this.config.port}/gecex/chat`);
        this.log('info', `WebSocket: ws://localhost:${this.config.wsPort}`);

        this.emit('platform:started');
        resolve();
      });
    });
  }

  // Zarif Kapatma
  async shutdown() {
    this.log('info', 'GecexCore Platformu kapatılıyor...');

    this.emit('platform:shutdown');
    await mongoose.connection.close();
    await this.pgClient.end();
    await ngrok.disconnect();

    return new Promise((resolve) => {
      this.app.close(() => {
        this.log('info', 'GecexCore Platformu durduruldu');
        resolve();
      });
    });
  }
}

// Örnek Eklentiler
const core = new GecexCore();

core.registerPlugin('ai', {
  description: 'OpenAI Entegrasyonu',
  handler: async (context) => ({
    statusCode: 200,
    data: { message: 'AI yanıtı oluşturuldu' }
  })
});

core.registerPlugin('character', {
  description: 'Kullanıcı Karakter Analizi',
  handler: async (context) => ({
    statusCode: 200,
    data: { message: 'Karakter analizi tamamlandı' }
  })
});

core.registerPlugin('deepseek', {
  description: 'DeepSeek Analiz',
  handler: async (context) => ({
    statusCode: 200,
    data: { message: 'Derin analiz tamamlandı' }
  })
});

core.registerPlugin('github', {
  description: 'GitHub Entegrasyonu',
  handler: async (context) => ({
    statusCode: 200,
    data: { message: 'GitHub işlemi tamamlandı' }
  })
});

core.registerPlugin('analytics', {
  description: 'Analitik Kayıt',
  handler: async (context) => ({
    statusCode: 200,
    data: { message: 'Analitik kaydedildi' }
  })
});

core.start();

module.exports = GecexCore;



