require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { Telegraf } = require('telegraf');

const app = express();
const db = new Database('database.sqlite');
const bot = new Telegraf(process.env.BOT_TOKEN);

// Middleware
app.use(cors());
app.use(express.json());

// ==================== DATABASE ====================

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    telegram_id TEXT UNIQUE,
    name TEXT,
    username TEXT,
    level TEXT DEFAULT 'none',
    total_spent REAL DEFAULT 0,
    cashback REAL DEFAULT 0,
    referral_code TEXT UNIQUE,
    referred_by TEXT,
    referral_earnings REAL DEFAULT 0,
    trc20_wallet TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id INTEGER,
    service TEXT,
    niche TEXT,
    formats TEXT,
    description TEXT,
    refs TEXT,
    base_price REAL,
    discount REAL,
    cashback_used REAL,
    total REAL,
    cashback_earned REAL,
    status TEXT DEFAULT 'pending',
    reviewed INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS cashback_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    amount REAL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id INTEGER,
    referred_id INTEGER,
    earnings REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (referrer_id) REFERENCES users(id),
    FOREIGN KEY (referred_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    title TEXT,
    message TEXT,
    read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ==================== AUTH ====================

function validateTelegramData(initData) {
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');
  
  const dataCheckString = Array.from(urlParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  
  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(process.env.BOT_TOKEN)
    .digest();
  
  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');
  
  return calculatedHash === hash;
}

function authMiddleware(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  
  if (!initData) {
    return res.status(401).json({ error: 'No auth data' });
  }
  
  if (!validateTelegramData(initData)) {
    return res.status(401).json({ error: 'Invalid auth' });
  }
  
  const urlParams = new URLSearchParams(initData);
  const user = JSON.parse(urlParams.get('user'));
  req.telegramUser = user;
  next();
}

// ==================== API ROUTES ====================

// Get or create user
app.get('/api/user', authMiddleware, (req, res) => {
  const tgUser = req.telegramUser;
  
  let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgUser.id.toString());
  
  if (!user) {
    const referralCode = generateRefCode(tgUser.first_name);
    
    const result = db.prepare(`
      INSERT INTO users (telegram_id, name, username, referral_code)
      VALUES (?, ?, ?, ?)
    `).run(tgUser.id.toString(), tgUser.first_name, tgUser.username || '', referralCode);
    
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  }
  
  // Get orders
  const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
  
  // Get cashback history
  const cashbackHistory = db.prepare('SELECT * FROM cashback_history WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
  
  // Get referrals
  const referrals = db.prepare(`
    SELECT u.name, u.username, r.earnings, r.created_at
    FROM referrals r
    JOIN users u ON r.referred_id = u.id
    WHERE r.referrer_id = ?
  `).all(user.id);
  
  // Get notifications
  const notifications = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(user.id);
  
  res.json({
    id: user.id,
    telegramId: user.telegram_id,
    name: user.name,
    username: user.username,
    level: user.level,
    totalSpent: user.total_spent,
    cashback: user.cashback,
    referralCode: user.referral_code,
    referralEarnings: user.referral_earnings,
    trc20Wallet: user.trc20_wallet,
    orders: orders.map(o => ({
      ...o,
      formats: JSON.parse(o.formats || '[]')
    })),
    cashbackHistory,
    referrals,
    notifications,
    settings: {
      notifOrders: true,
      notifPromo: true,
      notifRef: true
    }
  });
});

// Update user
app.post('/api/user', authMiddleware, (req, res) => {
  const tgUser = req.telegramUser;
  const { name, trc20Wallet, settings } = req.body;
  
  db.prepare(`
    UPDATE users SET name = ?, trc20_wallet = ?
    WHERE telegram_id = ?
  `).run(name, trc20Wallet, tgUser.id.toString());
  
  res.json({ success: true });
});

// Create order
app.post('/api/orders', authMiddleware, (req, res) => {
  const tgUser = req.telegramUser;
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgUser.id.toString());
  
  const order = req.body;
  const orderId = 'ORD' + Date.now();
  
  // Insert order
  db.prepare(`
    INSERT INTO orders (id, user_id, service, niche, formats, description, refs, base_price, discount, cashback_used, total, cashback_earned, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    orderId,
    user.id,
    order.service,
    order.niche,
    JSON.stringify(order.formats),
    order.description,
    order.refs,
    order.basePrice,
    order.discount,
    order.cashbackUsed,
    order.total,
    order.cashbackEarned
  );
  
  // Update user cashback and total spent
  db.prepare(`
    UPDATE users SET 
      cashback = cashback - ? + ?,
      total_spent = total_spent + ?
    WHERE id = ?
  `).run(order.cashbackUsed, order.cashbackEarned, order.total, user.id);
  
  // Add cashback history
  if (order.cashbackUsed > 0) {
    db.prepare(`
      INSERT INTO cashback_history (user_id, amount, description)
      VALUES (?, ?, ?)
    `).run(user.id, -order.cashbackUsed, `Оплата заказа #${orderId}`);
  }
  
  db.prepare(`
    INSERT INTO cashback_history (user_id, amount, description)
    VALUES (?, ?, ?)
  `).run(user.id, order.cashbackEarned, `Кешбэк за заказ #${orderId}`);
  
  // Check and update level
  updateUserLevel(user.id);
  
  // Add notification
  db.prepare(`
    INSERT INTO notifications (user_id, title, message)
    VALUES (?, ?, ?)
  `).run(user.id, '📦 Заказ создан', `Заказ #${orderId} принят в обработку`);
  
  // Notify admin
  notifyAdmin(`🆕 Новый заказ #${orderId}\n\nКлиент: ${user.name} (@${user.username})\nУслуга: ${order.service}\nНиша: ${order.niche}\nСумма: $${order.total}`);
  
  res.json({ success: true, orderId });
});

// Submit review
app.post('/api/reviews', authMiddleware, (req, res) => {
  const tgUser = req.telegramUser;
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgUser.id.toString());
  
  const { orderId, rating, text } = req.body;
  
  // Mark order as reviewed
  db.prepare('UPDATE orders SET reviewed = 1 WHERE id = ? AND user_id = ?').run(orderId, user.id);
  
  // Add review bonus
  const reviewBonus = 2;
  db.prepare('UPDATE users SET cashback = cashback + ? WHERE id = ?').run(reviewBonus, user.id);
  
  db.prepare(`
    INSERT INTO cashback_history (user_id, amount, description)
    VALUES (?, ?, ?)
  `).run(user.id, reviewBonus, 'Бонус за отзыв');
  
  // Notify admin
  notifyAdmin(`⭐ Новый отзыв (${rating}/5)\n\nКлиент: ${user.name}\nЗаказ: #${orderId}\n\n${text}`);
  
  res.json({ success: true });
});

// Apply referral
app.post('/api/referral/apply', authMiddleware, (req, res) => {
  const tgUser = req.telegramUser;
  const { code } = req.body;
  
  const referrer = db.prepare('SELECT * FROM users WHERE referral_code = ?').get(code);
  if (!referrer) {
    return res.status(400).json({ error: 'Invalid code' });
  }
  
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgUser.id.toString());
  
  if (user.referred_by) {
    return res.status(400).json({ error: 'Already referred' });
  }
  
  if (referrer.telegram_id === user.telegram_id) {
    return res.status(400).json({ error: 'Cannot refer yourself' });
  }
  
  // Set referred_by
  db.prepare('UPDATE users SET referred_by = ? WHERE id = ?').run(referrer.id, user.id);
  
  // Add to referrals table
  db.prepare(`
    INSERT INTO referrals (referrer_id, referred_id)
    VALUES (?, ?)
  `).run(referrer.id, user.id);
  
  res.json({ success: true, discount: 15 });
});

// ==================== HELPERS ====================

function generateRefCode(name) {
  const prefix = (name || 'USER').substring(0, 4).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return prefix + rand;
}

function updateUserLevel(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const spent = user.total_spent;
  
  let newLevel = 'none';
  if (spent >= 10000) newLevel = 'platinum';
  else if (spent >= 1000) newLevel = 'gold';
  else if (spent >= 500) newLevel = 'silver';
  else if (spent >= 100) newLevel = 'bronze';
  
  if (newLevel !== user.level && newLevel !== 'none') {
    db.prepare('UPDATE users SET level = ? WHERE id = ?').run(newLevel, userId);
    
    const discounts = { bronze: 5, silver: 10, gold: 15, platinum: 20 };
    
    db.prepare(`
      INSERT INTO notifications (user_id, title, message)
      VALUES (?, ?, ?)
    `).run(userId, '🎉 Новый уровень!', `Теперь вы ${newLevel}. Скидка ${discounts[newLevel]}%`);
    
    // Send Telegram notification
    bot.telegram.sendMessage(user.telegram_id, 
      `🎉 Поздравляем! Вы достигли уровня ${newLevel.toUpperCase()}!\n\nТеперь ваша скидка: ${discounts[newLevel]}%`
    ).catch(() => {});
  }
}

function notifyAdmin(message) {
  if (process.env.ADMIN_CHAT_ID) {
    bot.telegram.sendMessage(process.env.ADMIN_CHAT_ID, message).catch(() => {});
  }
}

// Process referral payment after first order
function processReferralPayment(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user.referred_by) return;
  
  // Check if this is first order
  const ordersCount = db.prepare('SELECT COUNT(*) as count FROM orders WHERE user_id = ?').get(userId).count;
  if (ordersCount !== 1) return;
  
  const firstOrder = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at LIMIT 1').get(userId);
  const referralAmount = firstOrder.total * 0.25; // 25%
  
  // Update referrer earnings
  db.prepare(`
    UPDATE users SET referral_earnings = referral_earnings + ?
    WHERE id = ?
  `).run(referralAmount, user.referred_by);
  
  db.prepare(`
    UPDATE referrals SET earnings = ?
    WHERE referrer_id = ? AND referred_id = ?
  `).run(referralAmount, user.referred_by, userId);
  
  const referrer = db.prepare('SELECT * FROM users WHERE id = ?').get(user.referred_by);
  
  // Notify referrer
  db.prepare(`
    INSERT INTO notifications (user_id, title, message)
    VALUES (?, ?, ?)
  `).run(referrer.id, '💰 Реферальный бонус!', `+$${referralAmount.toFixed(2)} за приглашённого ${user.name}`);
  
  bot.telegram.sendMessage(referrer.telegram_id,
    `💰 Реферальный бонус!\n\n${user.name} сделал первый заказ.\nВаш бонус: $${referralAmount.toFixed(2)}\n\n${referrer.trc20_wallet ? 'Выплата на ваш TRC-20 кошелёк' : '⚠️ Укажите TRC-20 кошелёк в настройках для получения выплаты'}`
  ).catch(() => {});
}

// ==================== TELEGRAM BOT ====================

bot.command('start', async (ctx) => {
  const refCode = ctx.message.text.split(' ')[1];
  
  const keyboard = {
    inline_keyboard: [[
      { text: '🚀 Открыть личный кабинет', web_app: { url: process.env.WEBAPP_URL } }
    ]]
  };
  
  await ctx.replyWithPhoto(
    { url: 'https://via.placeholder.com/800x400/000000/ffffff?text=White+Agency' },
    {
      caption: `👋 Добро пожаловать в White Agency!\n\n` +
        `Мы делаем креативы под результат для:\n` +
        `• Gambling / Betting\n` +
        `• Crypto / Forex\n` +
        `• Товарка\n` +
        `• И другие ниши\n\n` +
        `${refCode ? '🎁 У вас промокод на -15% на первый заказ!' : ''}\n\n` +
        `Нажмите кнопку ниже, чтобы открыть личный кабинет 👇`,
      reply_markup: keyboard
    }
  );
  
  // Apply referral if code provided
  if (refCode) {
    const referrer = db.prepare('SELECT * FROM users WHERE referral_code = ?').get(refCode);
    if (referrer && referrer.telegram_id !== ctx.from.id.toString()) {
      // Will be applied when user opens the app
    }
  }
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    `📋 Команды:\n\n` +
    `/start - Открыть личный кабинет\n` +
    `/prices - Прайс-лист\n` +
    `/ref - Реферальная программа\n` +
    `/support - Связаться с менеджером`
  );
});

bot.command('prices', async (ctx) => {
  await ctx.reply(
    `💰 Цены на услуги:\n\n` +
    `📸 Статика — от $10\n` +
    `📸 Пак статики (5 шт) — от $30\n` +
    `🎬 Видео-креатив — от $25\n` +
    `💋 Липсинг — от $40\n` +
    `🤖 AI-аватар — от $30\n` +
    `📱 UGC-видео — от $100\n` +
    `🎞 GIF/Анимация — от $15\n` +
    `💻 Дизайн лендинга — от $200\n\n` +
    `➕ 5% кешбэк с каждого заказа!`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🚀 Сделать заказ', web_app: { url: process.env.WEBAPP_URL } }
        ]]
      }
    }
  );
});

bot.command('ref', async (ctx) => {
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(ctx.from.id.toString());
  
  if (!user) {
    return ctx.reply('Сначала откройте личный кабинет', {
      reply_markup: {
        inline_keyboard: [[
          { text: '🚀 Открыть', web_app: { url: process.env.WEBAPP_URL } }
        ]]
      }
    });
  }
  
  await ctx.reply(
    `👥 Реферальная программа\n\n` +
    `Ваш код: ${user.referral_code}\n` +
    `Ваша ссылка: t.me/${ctx.botInfo.username}?start=${user.referral_code}\n\n` +
    `💰 Получайте 25% с первого заказа каждого приглашённого друга!\n` +
    `🎁 Друг получит -15% на первый заказ\n\n` +
    `Приглашено: ${db.prepare('SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ?').get(user.id).count}\n` +
    `Заработано: $${user.referral_earnings.toFixed(2)}`
  );
});

bot.command('support', async (ctx) => {
  await ctx.reply(
    `💬 Связаться с менеджером:\n\n@WhiteAgency_manager`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '✍️ Написать менеджеру', url: 'https://t.me/WhiteAgency_manager' }
        ]]
      }
    }
  );
});

// Notify user about order status
async function notifyOrderStatus(userId, orderId, status) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const statuses = {
    working: '🎨 Ваш заказ в работе!',
    completed: '✅ Ваш заказ готов!'
  };
  
  await bot.telegram.sendMessage(user.telegram_id, 
    `${statuses[status]}\n\nЗаказ #${orderId}`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '📱 Открыть в приложении', web_app: { url: process.env.WEBAPP_URL } }
        ]]
      }
    }
  ).catch(() => {});
}

// ==================== START ====================

const PORT = process.env.PORT || 3000;

bot.launch().then(() => {
  console.log('🤖 Bot started');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
```
