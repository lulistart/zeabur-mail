const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// 配置
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const DATA_DIR = process.env.DATA_DIR || './data';
const MAIL_DOMAIN = process.env.MAIL_DOMAIN || 'tempmail.example.com';

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 初始化数据库
const db = new Database(path.join(DATA_DIR, 'mail.db'));

// 创建表
db.exec(`
  CREATE TABLE IF NOT EXISTS mailboxes (
    id TEXT PRIMARY KEY,
    address TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  
  CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    mailbox_id TEXT NOT NULL,
    from_address TEXT,
    from_name TEXT,
    subject TEXT,
    text_content TEXT,
    html_content TEXT,
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_read INTEGER DEFAULT 0,
    FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id)
  );
  
  CREATE INDEX IF NOT EXISTS idx_emails_mailbox ON emails(mailbox_id);
  CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(received_at);
`);

// 生成 JWT Token
function generateToken(mailboxId, address) {
  return jwt.sign(
    { mailbox_id: mailboxId, address: address },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// 验证 JWT Token
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

// 中间件：验证 Token
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  const queryToken = req.query.jwt;
  
  let token = queryToken;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  req.mailbox = decoded;
  next();
}

// API: 获取可用域名
app.get('/api/domains', (req, res) => {
  res.json({
    domains: [MAIL_DOMAIN],
    default: MAIL_DOMAIN
  });
});

// API: 创建邮箱
app.post('/api/mailboxes', (req, res) => {
  try {
    const { address, password } = req.body;
    
    // 生成随机地址（如果未提供）
    const mailAddress = address || `${uuidv4().substring(0, 8)}@${MAIL_DOMAIN}`;
    const mailPassword = password || uuidv4().substring(0, 16);
    const mailboxId = uuidv4();
    
    // 检查地址是否已存在
    const existing = db.prepare('SELECT id FROM mailboxes WHERE address = ?').get(mailAddress);
    if (existing) {
      return res.status(400).json({ error: 'Address already exists' });
    }
    
    // 创建邮箱
    db.prepare('INSERT INTO mailboxes (id, address, password) VALUES (?, ?, ?)')
      .run(mailboxId, mailAddress, mailPassword);
    
    const token = generateToken(mailboxId, mailAddress);
    
    res.json({
      id: mailboxId,
      address: mailAddress,
      token: token,
      // Business Gemini 需要的 URL 格式
      url: `${req.protocol}://${req.get('host')}/?jwt=${token}`
    });
  } catch (e) {
    console.error('Create mailbox error:', e);
    res.status(500).json({ error: 'Failed to create mailbox' });
  }
});

// API: 登录邮箱
app.post('/api/login', (req, res) => {
  try {
    const { address, password } = req.body;
    
    const mailbox = db.prepare('SELECT * FROM mailboxes WHERE address = ? AND password = ?')
      .get(address, password);
    
    if (!mailbox) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = generateToken(mailbox.id, mailbox.address);
    
    res.json({
      id: mailbox.id,
      address: mailbox.address,
      token: token,
      url: `${req.protocol}://${req.get('host')}/?jwt=${token}`
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// API: 获取邮件列表
app.get('/api/emails', authMiddleware, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    const emails = db.prepare(`
      SELECT * FROM emails 
      WHERE mailbox_id = ? 
      ORDER BY received_at DESC 
      LIMIT ? OFFSET ?
    `).all(req.mailbox.mailbox_id, limit, offset);
    
    res.json({
      emails: emails,
      total: db.prepare('SELECT COUNT(*) as count FROM emails WHERE mailbox_id = ?')
        .get(req.mailbox.mailbox_id).count
    });
  } catch (e) {
    console.error('Get emails error:', e);
    res.status(500).json({ error: 'Failed to get emails' });
  }
});

// API: 获取单封邮件
app.get('/api/emails/:id', authMiddleware, (req, res) => {
  try {
    const email = db.prepare(`
      SELECT * FROM emails 
      WHERE id = ? AND mailbox_id = ?
    `).get(req.params.id, req.mailbox.mailbox_id);
    
    if (!email) {
      return res.status(404).json({ error: 'Email not found' });
    }
    
    // 标记为已读
    db.prepare('UPDATE emails SET is_read = 1 WHERE id = ?').run(req.params.id);
    
    res.json(email);
  } catch (e) {
    console.error('Get email error:', e);
    res.status(500).json({ error: 'Failed to get email' });
  }
});

// API: 删除邮件
app.delete('/api/emails/:id', authMiddleware, (req, res) => {
  try {
    const result = db.prepare(`
      DELETE FROM emails 
      WHERE id = ? AND mailbox_id = ?
    `).run(req.params.id, req.mailbox.mailbox_id);
    
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Email not found' });
    }
    
    res.json({ success: true });
  } catch (e) {
    console.error('Delete email error:', e);
    res.status(500).json({ error: 'Failed to delete email' });
  }
});


// API: 接收邮件（Webhook - 用于邮件转发服务调用）
app.post('/api/webhook/receive', (req, res) => {
  try {
    console.log('=== Webhook 收到请求 ===');
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    console.log('Body:', JSON.stringify(req.body, null, 2));
    
    const { to, from, from_name, subject, text, html } = req.body;
    
    if (!to) {
      console.error('错误：缺少收件人地址');
      return res.status(400).json({ error: 'Missing "to" field' });
    }
    
    // 查找目标邮箱
    const mailbox = db.prepare('SELECT id FROM mailboxes WHERE address = ?').get(to);
    
    if (!mailbox) {
      console.error(`错误：邮箱不存在 - ${to}`);
      console.log('现有邮箱列表：', db.prepare('SELECT address FROM mailboxes').all());
      return res.status(404).json({ error: 'Mailbox not found', to: to });
    }
    
    const emailId = uuidv4();
    
    db.prepare(`
      INSERT INTO emails (id, mailbox_id, from_address, from_name, subject, text_content, html_content)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(emailId, mailbox.id, from, from_name || '', subject || '(No Subject)', text || '', html || '');
    
    console.log(`✓ 邮件已保存 - ID: ${emailId}, 邮箱: ${to}`);
    res.json({ success: true, id: emailId });
  } catch (e) {
    console.error('Receive email error:', e);
    res.status(500).json({ error: 'Failed to receive email', message: e.message });
  }
});

// API: 查看所有邮箱（调试用）
app.get('/api/debug/mailboxes', (req, res) => {
  try {
    const mailboxes = db.prepare('SELECT id, address, created_at FROM mailboxes ORDER BY created_at DESC LIMIT 20').all();
    const emailCount = db.prepare('SELECT COUNT(*) as count FROM emails').get();
    
    res.json({
      total_mailboxes: mailboxes.length,
      total_emails: emailCount.count,
      mailboxes: mailboxes
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: 模拟发送邮件（用于测试）
app.post('/api/test/send', (req, res) => {
  try {
    console.log('=== 测试邮件请求 ===');
    console.log('Body:', JSON.stringify(req.body, null, 2));
    
    const { to, from, subject, text, code } = req.body;
    
    const mailbox = db.prepare('SELECT id FROM mailboxes WHERE address = ?').get(to);
    
    if (!mailbox) {
      console.error(`错误：邮箱不存在 - ${to}`);
      return res.status(404).json({ error: 'Mailbox not found', to: to });
    }
    
    const emailId = uuidv4();
    const emailText = code ? `Your verification code is: ${code}` : (text || 'Test email');
    
    db.prepare(`
      INSERT INTO emails (id, mailbox_id, from_address, from_name, subject, text_content, html_content)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      emailId, 
      mailbox.id, 
      from || 'test@example.com', 
      'Test Sender',
      subject || 'Test Email',
      emailText,
      `<p>${emailText}</p>`
    );
    
    console.log(`✓ 测试邮件已保存 - ID: ${emailId}`);
    res.json({ success: true, id: emailId });
  } catch (e) {
    console.error('Test send error:', e);
    res.status(500).json({ error: 'Failed to send test email', message: e.message });
  }
});

// 前端页面
app.get('/', (req, res) => {
  const token = req.query.jwt;
  
  res.send(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>临时邮箱</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body { 
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", sans-serif;
      -webkit-font-smoothing: antialiased;
      background: #f5f5f7;
      min-height: 100vh;
      padding: 20px;
      position: relative;
    }
    
    /* Noise texture overlay for realism */
    body::before {
      content: '';
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      opacity: 0.015;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' /%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E");
      pointer-events: none;
      z-index: 1;
    }
    
    .container { 
      max-width: 900px; 
      margin: 0 auto; 
      position: relative;
      z-index: 2;
    }
    
    /* macOS Window Card - Thick Material */
    .card {
      background: rgba(255, 255, 255, 0.8);
      backdrop-filter: blur(40px) saturate(150%);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 16px;
      box-shadow: 
        0px 0px 1px rgba(0, 0, 0, 0.4),
        0px 16px 36px -8px rgba(0, 0, 0, 0.2),
        inset 0 1px 0 0 rgba(255, 255, 255, 0.4);
      border: 0.5px solid rgba(0, 0, 0, 0.05);
      transition: all 0.2s ease-out;
    }
    
    .card:hover {
      transform: translateY(-2px);
      box-shadow: 
        0px 0px 1px rgba(0, 0, 0, 0.4),
        0px 20px 40px -8px rgba(0, 0, 0, 0.25),
        inset 0 1px 0 0 rgba(255, 255, 255, 0.4);
    }
    
    /* Traffic Lights */
    .traffic-lights {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }
    
    .traffic-light {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      border: 0.5px solid rgba(0, 0, 0, 0.1);
    }
    
    .traffic-light.red { background: #FF5F57; }
    .traffic-light.yellow { background: #FFBD2E; }
    .traffic-light.green { background: #28CA42; }
    
    h1 { 
      color: #1d1d1f; 
      font-size: 28px;
      font-weight: 600;
      letter-spacing: -0.02em;
      margin-bottom: 8px;
    }
    
    h2 { 
      color: #1d1d1f; 
      font-size: 20px;
      font-weight: 600;
      letter-spacing: -0.01em;
      margin-bottom: 16px;
    }
    
    /* Glassmorphic Info Box */
    .mailbox-info {
      background: rgba(0, 0, 0, 0.02);
      backdrop-filter: blur(10px);
      padding: 16px;
      border-radius: 12px;
      margin-bottom: 20px;
      border: 0.5px solid rgba(0, 0, 0, 0.05);
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.06);
    }
    
    .mailbox-address {
      font-size: 18px;
      font-weight: 600;
      color: #007AFF;
      word-break: break-all;
      letter-spacing: -0.01em;
    }
    
    /* Primary Push Button - Apple Style */
    .btn {
      background: linear-gradient(180deg, #007AFF 0%, #0051D5 100%);
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      margin-right: 8px;
      margin-bottom: 8px;
      box-shadow: 
        0 1px 3px rgba(0, 0, 0, 0.12),
        inset 0 0.5px 0 0 rgba(255, 255, 255, 0.2);
      transition: all 0.2s ease-out;
      letter-spacing: -0.01em;
    }
    
    .btn:hover { 
      background: linear-gradient(180deg, #0077F0 0%, #004FC7 100%);
      box-shadow: 
        0 2px 6px rgba(0, 0, 0, 0.15),
        inset 0 0.5px 0 0 rgba(255, 255, 255, 0.2);
    }
    
    .btn:active {
      transform: scale(0.96);
    }
    
    .btn-secondary { 
      background: rgba(0, 0, 0, 0.05);
      color: #1d1d1f;
      box-shadow: 
        0 1px 2px rgba(0, 0, 0, 0.08),
        inset 0 0.5px 0 0 rgba(255, 255, 255, 0.5);
      border: none;
      padding: 10px 20px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      margin-right: 8px;
      margin-bottom: 8px;
      transition: all 0.2s ease-out;
      letter-spacing: -0.01em;
    }
    
    .btn-secondary:hover { 
      background: rgba(0, 0, 0, 0.08);
    }
    
    .btn-secondary:active {
      transform: scale(0.96);
    }
    
    /* Email List */
    .email-list { list-style: none; }
    
    .email-item {
      padding: 14px 16px;
      border-bottom: 0.5px solid rgba(0, 0, 0, 0.05);
      cursor: pointer;
      transition: all 0.15s ease-out;
      border-radius: 8px;
      margin-bottom: 4px;
    }
    
    .email-item:hover { 
      background: rgba(0, 0, 0, 0.02);
      transform: translateX(4px);
    }
    
    .email-item:active {
      transform: scale(0.98) translateX(4px);
    }
    
    .email-item:last-child { border-bottom: none; }
    
    .email-from { 
      font-weight: 600; 
      color: #1d1d1f;
      font-size: 15px;
      letter-spacing: -0.01em;
    }
    
    .email-subject { 
      color: #6e6e73; 
      margin-top: 4px;
      font-size: 14px;
    }
    
    .email-time { 
      color: #86868b; 
      font-size: 12px; 
      margin-top: 4px;
      letter-spacing: 0.01em;
    }
    
    /* Email Content Display */
    .email-content {
      background: rgba(0, 0, 0, 0.02);
      padding: 16px;
      border-radius: 12px;
      margin-top: 16px;
      white-space: pre-wrap;
      word-wrap: break-word;
      overflow-wrap: break-word;
      line-height: 1.6;
      border: 0.5px solid rgba(0, 0, 0, 0.05);
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.06);
      color: #1d1d1f;
      font-size: 14px;
    }
    
    .email-content iframe {
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    }
    
    .empty { 
      color: #86868b; 
      text-align: center; 
      padding: 40px;
      font-size: 15px;
    }
    
    /* URL Box - Success State */
    .url-box {
      background: rgba(52, 199, 89, 0.1);
      backdrop-filter: blur(10px);
      padding: 14px;
      border-radius: 12px;
      margin-top: 16px;
      word-break: break-all;
      font-size: 12px;
      border: 0.5px solid rgba(52, 199, 89, 0.2);
      box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.3);
    }
    
    .url-label { 
      font-weight: 600; 
      color: #1d8221; 
      margin-bottom: 8px;
      font-size: 13px;
      letter-spacing: -0.01em;
    }
    
    .url-text {
      color: #1d8221;
      font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
      font-size: 11px;
      letter-spacing: 0;
    }
    
    .hidden { display: none; }
    
    /* Subtle label text */
    .label-text {
      color: #6e6e73;
      font-size: 13px;
      margin-bottom: 8px;
      font-weight: 500;
      letter-spacing: -0.01em;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="traffic-lights">
        <div class="traffic-light red"></div>
        <div class="traffic-light yellow"></div>
        <div class="traffic-light green"></div>
      </div>
      
      <h1>📧 临时邮箱</h1>
      
      <div id="createSection" class="${token ? 'hidden' : ''}">
        <p class="label-text" style="margin-bottom: 16px;">创建一个临时邮箱来接收验证码</p>
        <button class="btn" onclick="createMailbox()">创建新邮箱</button>
      </div>
      
      <div id="mailboxSection" class="${token ? '' : 'hidden'}">
        <div class="mailbox-info">
          <div class="label-text">当前邮箱地址</div>
          <div class="mailbox-address" id="mailboxAddress">加载中...</div>
        </div>
        
        <button class="btn" onclick="refreshEmails()">刷新邮件</button>
        <button class="btn btn-secondary" onclick="copyUrl()">复制 URL</button>
        <button class="btn btn-secondary" onclick="sendTestEmail()">发送测试邮件</button>
        <button class="btn btn-secondary" onclick="createNew()">创建新邮箱</button>
        
        <div class="url-box">
          <div class="url-label">Business Gemini 临时邮箱 URL</div>
          <div class="url-text" id="mailboxUrl"></div>
        </div>
      </div>
    </div>
    
    <div id="emailsCard" class="card ${token ? '' : 'hidden'}">
      <h2>📬 收件箱</h2>
      <ul class="email-list" id="emailList">
        <li class="empty">暂无邮件</li>
      </ul>
    </div>
    
    <div id="emailDetail" class="card hidden">
      <button class="btn-secondary" style="margin-bottom: 16px;" onclick="closeEmail()">← 返回列表</button>
      <h2 id="emailSubject"></h2>
      <div class="label-text">
        <span id="emailFrom"></span> · <span id="emailTime"></span>
      </div>
      <div class="email-content" id="emailContent"></div>
    </div>
  </div>

  <script>
    let currentToken = '${token || ''}';
    let currentUrl = window.location.href;
    
    async function createMailbox() {
      try {
        const res = await fetch('/api/mailboxes', { method: 'POST' });
        const data = await res.json();
        
        if (data.token) {
          currentToken = data.token;
          currentUrl = data.url;
          window.history.pushState({}, '', '/?jwt=' + data.token);
          
          document.getElementById('createSection').classList.add('hidden');
          document.getElementById('mailboxSection').classList.remove('hidden');
          document.getElementById('emailsCard').classList.remove('hidden');
          document.getElementById('mailboxAddress').textContent = data.address;
          document.getElementById('mailboxUrl').textContent = data.url;
          
          refreshEmails();
        }
      } catch (e) {
        alert('创建失败: ' + e.message);
      }
    }
    
    async function refreshEmails() {
      if (!currentToken) return;
      
      try {
        const res = await fetch('/api/emails?jwt=' + currentToken);
        const data = await res.json();
        
        const list = document.getElementById('emailList');
        
        if (data.emails && data.emails.length > 0) {
          list.innerHTML = data.emails.map(email => \`
            <li class="email-item" onclick="viewEmail('\${email.id}')">
              <div class="email-from">\${email.from_name || email.from_address || '未知发件人'}</div>
              <div class="email-subject">\${email.subject || '(无主题)'}</div>
              <div class="email-time">\${new Date(email.received_at).toLocaleString('zh-CN', { 
                year: 'numeric', 
                month: '2-digit', 
                day: '2-digit', 
                hour: '2-digit', 
                minute: '2-digit' 
              })}</div>
            </li>
          \`).join('');
        } else {
          list.innerHTML = '<li class="empty">暂无邮件，点击刷新检查新邮件</li>';
        }
      } catch (e) {
        console.error('Refresh error:', e);
      }
    }
    
    async function viewEmail(id) {
      try {
        const res = await fetch('/api/emails/' + id + '?jwt=' + currentToken);
        const email = await res.json();
        
        document.getElementById('emailSubject').textContent = email.subject || '(无主题)';
        document.getElementById('emailFrom').textContent = email.from_name || email.from_address || '未知';
        document.getElementById('emailTime').textContent = new Date(email.received_at).toLocaleString('zh-CN', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
        
        // 优先显示文本内容，HTML 作为备选
        const contentDiv = document.getElementById('emailContent');
        const textContent = email.text_content && email.text_content.trim();
        const htmlContent = email.html_content && email.html_content.trim();
        
        if (textContent) {
          // 有文本内容，直接显示
          contentDiv.textContent = email.text_content;
          contentDiv.style.whiteSpace = 'pre-wrap';
        } else if (htmlContent) {
          // 只有 HTML 内容，创建 iframe 安全显示
          const iframe = document.createElement('iframe');
          iframe.style.width = '100%';
          iframe.style.minHeight = '200px';
          iframe.style.border = 'none';
          iframe.style.background = 'white';
          contentDiv.innerHTML = '';
          contentDiv.appendChild(iframe);
          contentDiv.style.whiteSpace = 'normal';
          
          // 写入 HTML 内容到 iframe
          const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
          iframeDoc.open();
          iframeDoc.write(email.html_content);
          iframeDoc.close();
          
          // 自动调整 iframe 高度
          setTimeout(() => {
            iframe.style.height = (iframeDoc.body.scrollHeight + 20) + 'px';
          }, 100);
        } else {
          contentDiv.textContent = '(无内容)';
          contentDiv.style.whiteSpace = 'pre-wrap';
        }
        
        document.getElementById('emailsCard').classList.add('hidden');
        document.getElementById('emailDetail').classList.remove('hidden');
      } catch (e) {
        alert('加载失败');
      }
    }
    
    function closeEmail() {
      document.getElementById('emailDetail').classList.add('hidden');
      document.getElementById('emailsCard').classList.remove('hidden');
    }
    
    function copyUrl() {
      navigator.clipboard.writeText(currentUrl).then(() => {
        alert('✓ URL 已复制到剪贴板');
      });
    }
    
    function createNew() {
      if (confirm('确定要创建新邮箱吗？当前邮箱将无法恢复。')) {
        currentToken = '';
        window.history.pushState({}, '', '/');
        document.getElementById('createSection').classList.remove('hidden');
        document.getElementById('mailboxSection').classList.add('hidden');
        document.getElementById('emailsCard').classList.add('hidden');
      }
    }
    
    async function sendTestEmail() {
      if (!currentToken) return;
      
      try {
        const payload = JSON.parse(atob(currentToken.split('.')[1]));
        const res = await fetch('/api/test/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: payload.address,
            from: 'test@example.com',
            subject: '测试邮件 - ' + new Date().toLocaleString(),
            text: '这是一封测试邮件。\\n\\n如果你能看到这封邮件，说明邮件接收功能正常工作。\\n\\n验证码示例：123456',
            code: Math.floor(100000 + Math.random() * 900000)
          })
        });
        
        if (res.ok) {
          alert('✓ 测试邮件已发送');
          setTimeout(refreshEmails, 500);
        } else {
          alert('✗ 发送失败');
        }
      } catch (e) {
        alert('✗ 发送失败: ' + e.message);
      }
    }
    
    // 初始化
    if (currentToken) {
      // 验证 token 并获取邮箱信息
      fetch('/api/emails?jwt=' + currentToken + '&limit=1')
        .then(res => {
          if (res.ok) {
            // Token 有效，解析获取地址
            const payload = JSON.parse(atob(currentToken.split('.')[1]));
            document.getElementById('mailboxAddress').textContent = payload.address;
            document.getElementById('mailboxUrl').textContent = currentUrl;
            refreshEmails();
          } else {
            // Token 无效
            currentToken = '';
            window.history.pushState({}, '', '/');
            document.getElementById('createSection').classList.remove('hidden');
            document.getElementById('mailboxSection').classList.add('hidden');
            document.getElementById('emailsCard').classList.add('hidden');
          }
        });
      
      // 自动刷新（每 2 秒检查一次）
      setInterval(refreshEmails, 2000);
    }
  </script>
</body>
</html>
  `);
});

// 启动服务
app.listen(PORT, () => {
  console.log(`临时邮箱服务已启动: http://localhost:${PORT}`);
  console.log(`邮件域名: ${MAIL_DOMAIN}`);
});
