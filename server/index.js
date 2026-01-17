require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');
const { Telegraf } = require('telegraf');

const app = express();
const db = new Database('database.sqlite');
const bot = new Telegraf(process.env.BOT_TOKEN);

// Middleware
app.use(cors());
app.use(express.json());

// Раздача статических файлов (для админки)
app.use(express.static(path.join(__dirname, 'public')));

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
    media TEXT,
    items TEXT,
    comment TEXT,
    base_price REAL,
    discount REAL,
    cashback_used REAL,
    total REAL,
    cashback_earned REAL,
    status TEXT DEFAULT 'pending',
    tx_hash TEXT,
    payment_method TEXT,
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

  CREATE TABLE IF NOT EXISTS pending_referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT,
    referral_code TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    services TEXT DEFAULT '[]',
    prices TEXT DEFAULT '{}',
    form_fields TEXT DEFAULT '[]',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS promo_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    discount_percent INTEGER NOT NULL,
    max_uses INTEGER DEFAULT NULL,
    current_uses INTEGER DEFAULT 0,
    expires_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS promo_uses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    promo_id INTEGER,
    user_id INTEGER,
    order_id TEXT,
    used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (promo_id) REFERENCES promo_codes(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    price INTEGER NOT NULL,
    icon TEXT DEFAULT '🎨',
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    order_id TEXT UNIQUE,
    user_id INTEGER,
    amount REAL NOT NULL,
    promo_code TEXT,
    discount_amount REAL DEFAULT 0,
    final_amount REAL NOT NULL,
    payment_address TEXT,
    tx_hash TEXT,
    status TEXT DEFAULT 'awaiting_payment',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    paid_at DATETIME,
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    wallet_address TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    tx_hash TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ==================== MIGRATIONS ====================

// Add media column to orders if it doesn't exist
try {
  db.prepare('ALTER TABLE orders ADD COLUMN media TEXT').run();
  console.log('Migration: Added media column to orders table');
} catch (error) {
  // Column already exists, ignore
  if (!error.message.includes('duplicate column name')) {
    console.error('Migration error:', error.message);
  }
}

// Add items and comment columns to orders if they don't exist
try {
  db.prepare('ALTER TABLE orders ADD COLUMN items TEXT').run();
  console.log('Migration: Added items column to orders table');
} catch (error) {
  if (!error.message.includes('duplicate column name')) {
    console.error('Migration error:', error.message);
  }
}

try {
  db.prepare('ALTER TABLE orders ADD COLUMN comment TEXT').run();
  console.log('Migration: Added comment column to orders table');
} catch (error) {
  if (!error.message.includes('duplicate column name')) {
    console.error('Migration error:', error.message);
  }
}

// Add promo_code column to orders if it doesn't exist
try {
  db.prepare('ALTER TABLE orders ADD COLUMN promo_code TEXT').run();
  console.log('Migration: Added promo_code column to orders table');
} catch (error) {
  if (!error.message.includes('duplicate column name')) {
    console.error('Migration error:', error.message);
  }
}

// Add discount_amount column to orders if it doesn't exist
try {
  db.prepare('ALTER TABLE orders ADD COLUMN discount_amount REAL DEFAULT 0').run();
  console.log('Migration: Added discount_amount column to orders table');
} catch (error) {
  if (!error.message.includes('duplicate column name')) {
    console.error('Migration error:', error.message);
  }
}

// Add subtotal column to orders if it doesn't exist
try {
  db.prepare('ALTER TABLE orders ADD COLUMN subtotal REAL').run();
  console.log('Migration: Added subtotal column to orders table');
} catch (error) {
  if (!error.message.includes('duplicate column name')) {
    console.error('Migration error:', error.message);
  }
}

// Seed initial products if table is empty
const productCount = db.prepare('SELECT COUNT(*) as count FROM products').get();
if (productCount.count === 0) {
  const initialProducts = [
    { name: 'Статика', description: 'Статичное изображение для рекламы', price: 10, icon: '🎨', sort_order: 1 },
    { name: 'Пак статики 5 шт', description: 'Набор из 5 статичных изображений', price: 30, icon: '🎬', sort_order: 2 },
    { name: 'Видео-креатив', description: 'Видеоролик для рекламы', price: 25, icon: '🎥', sort_order: 3 },
    { name: 'Липсинг', description: 'Видео с синхронизацией губ', price: 40, icon: '🗣️', sort_order: 4 },
    { name: 'AI-аватар', description: 'Сгенерированный AI аватар', price: 30, icon: '🤖', sort_order: 5 },
    { name: 'UGC видео', description: 'User Generated Content видео', price: 50, icon: '📹', sort_order: 6 },
    { name: 'Пресет для видео', description: 'Готовый пресет для обработки', price: 15, icon: '✨', sort_order: 7 },
    { name: 'Монтаж видео', description: 'Профессиональный монтаж', price: 35, icon: '💻', sort_order: 8 }
  ];

  const insertProduct = db.prepare('INSERT INTO products (name, description, price, icon, sort_order) VALUES (?, ?, ?, ?, ?)');
  for (const product of initialProducts) {
    insertProduct.run(product.name, product.description, product.price, product.icon, product.sort_order);
  }
  console.log('Migration: Seeded initial products');
}

// ==================== AUTH ====================

function validateTelegramData(initData) {
  try {
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
  } catch (error) {
    console.error('Auth validation error:', error);
    return false;
  }
}

function authMiddleware(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  
  // Allow demo mode for testing
  if (!initData || initData === 'demo') {
    req.telegramUser = { id: 'demo_user', first_name: 'Demo', username: 'demo' };
    return next();
  }
  
  if (!validateTelegramData(initData)) {
    return res.status(401).json({ error: 'Invalid auth' });
  }
  
  try {
    const urlParams = new URLSearchParams(initData);
    const user = JSON.parse(urlParams.get('user'));
    req.telegramUser = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid user data' });
  }
}

// Admin auth middleware
function adminAuthMiddleware(req, res, next) {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ==================== API ROUTES ====================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Root redirect to admin
app.get('/', (req, res) => {
  res.redirect('/admin');
});

// Admin panel route
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Get or create user
app.get('/api/user', authMiddleware, (req, res) => {
  try {
    const tgUser = req.telegramUser;
    
    let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgUser.id.toString());
    
    if (!user) {
      const referralCode = generateRefCode(tgUser.first_name);
      
      const result = db.prepare(`
        INSERT INTO users (telegram_id, name, username, referral_code)
        VALUES (?, ?, ?, ?)
      `).run(tgUser.id.toString(), tgUser.first_name, tgUser.username || '', referralCode);
      
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
      
      // Check for pending referral
      const pendingRef = db.prepare('SELECT * FROM pending_referrals WHERE telegram_id = ?').get(tgUser.id.toString());
      if (pendingRef) {
        const referrer = db.prepare('SELECT * FROM users WHERE referral_code = ?').get(pendingRef.referral_code);
        if (referrer && referrer.telegram_id !== tgUser.id.toString()) {
          db.prepare('UPDATE users SET referred_by = ? WHERE id = ?').run(referrer.id, user.id);
          db.prepare('INSERT INTO referrals (referrer_id, referred_id) VALUES (?, ?)').run(referrer.id, user.id);
        }
        db.prepare('DELETE FROM pending_referrals WHERE telegram_id = ?').run(tgUser.id.toString());
      }
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

    // Get invoices
    const invoices = db.prepare('SELECT * FROM invoices WHERE user_id = ? ORDER BY created_at DESC').all(user.id);

    res.json({
      id: user.id,
      telegramId: user.telegram_id,
      name: user.name,
      username: user.username,
      level: user.level,
      totalSpent: user.total_spent,
      cashback: user.cashback,
      referralCode: user.referral_code,
      referredBy: user.referred_by,
      referralEarnings: user.referral_earnings,
      trc20Wallet: user.trc20_wallet,
      orders: orders.map(o => ({
        id: o.id,
        service: o.service,
        niche: o.niche,
        formats: JSON.parse(o.formats || '[]'),
        description: o.description,
        refs: o.refs,
        media: JSON.parse(o.media || '[]'),
        items: JSON.parse(o.items || '[]'),
        comment: o.comment,
        basePrice: o.base_price,
        discount: o.discount,
        cashbackUsed: o.cashback_used,
        total: o.total,
        cashbackEarned: o.cashback_earned,
        status: o.status,
        txHash: o.tx_hash,
        paymentMethod: o.payment_method,
        reviewed: o.reviewed === 1,
        createdAt: o.created_at
      })),
      cashbackHistory: cashbackHistory.map(h => ({
        amount: h.amount,
        description: h.description,
        date: h.created_at
      })),
      referrals: referrals.map(r => ({
        name: r.name,
        username: r.username,
        earnings: r.earnings,
        date: r.created_at
      })),
      notifications: notifications.map(n => ({
        id: n.id,
        title: n.title,
        message: n.message,
        read: n.read === 1,
        date: n.created_at
      })),
      invoices: invoices.map(i => ({
        id: i.id,
        order_id: i.order_id,
        amount: i.amount,
        status: i.status,
        tx_hash: i.tx_hash,
        wallet_address: i.wallet_address,
        created_at: i.created_at,
        paid_at: i.paid_at
      })),
      settings: {
        notifOrders: true,
        notifPromo: true,
        notifRef: true
      }
    });
  } catch (error) {
    console.error('Error getting user:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user
app.post('/api/user', authMiddleware, (req, res) => {
  try {
    const tgUser = req.telegramUser;
    const { name, trc20Wallet } = req.body;
    
    db.prepare(`
      UPDATE users SET name = ?, trc20_wallet = ?
      WHERE telegram_id = ?
    `).run(name, trc20Wallet || null, tgUser.id.toString());
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create order
app.post('/api/orders', authMiddleware, (req, res) => {
  try {
    const tgUser = req.telegramUser;
    const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgUser.id.toString());
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const order = req.body;
    const orderId = order.id || ('ORD' + Date.now());
    
    // Insert order
    db.prepare(`
      INSERT INTO orders (id, user_id, service, niche, formats, description, refs, media, base_price, discount, cashback_used, total, cashback_earned, status, tx_hash, payment_method, promo_code, discount_amount, subtotal)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(
      orderId,
      user.id,
      order.service,
      order.niche,
      JSON.stringify(order.formats || []),
      order.description || '',
      order.refs || '',
      JSON.stringify(order.media || []),
      order.basePrice,
      order.discount,
      order.cashbackUsed || 0,
      order.total,
      order.cashbackEarned,
      order.txHash || null,
      order.paymentMethod || null,
      order.promoCode || null,
      (order.promoDiscount || 0) + (order.referralDiscount || 0),
      order.basePrice
    );
    
    // Update user cashback and total spent
    db.prepare(`
      UPDATE users SET 
        cashback = cashback - ? + ?,
        total_spent = total_spent + ?
      WHERE id = ?
    `).run(order.cashbackUsed || 0, order.cashbackEarned, order.total, user.id);
    
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
    
    // Process referral payment for first order
    processReferralPayment(user.id);
    
    // Add notification
    db.prepare(`
      INSERT INTO notifications (user_id, title, message)
      VALUES (?, ?, ?)
    `).run(user.id, '📦 Заказ создан', `Заказ #${orderId} принят в обработку`);
    
    // Notify admin
    notifyAdmin(
      `🆕 Новый заказ #${orderId}\n\n` +
      `👤 Клиент: ${user.name} (@${user.username || 'no username'})\n` +
      `📋 Услуга: ${order.service}\n` +
      `🎯 Ниша: ${order.niche}\n` +
      `💰 Сумма: $${order.total}\n` +
      `💳 Оплата: ${order.paymentMethod || 'не указано'}\n` +
      `${order.txHash ? `🔗 TxHash: ${order.txHash}` : ''}`
    );
    
    res.json({ success: true, orderId });
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create cart order (new order system with items)
app.post('/api/cart-orders', authMiddleware, (req, res) => {
  try {
    const tgUser = req.telegramUser;
    const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgUser.id.toString());

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const orderData = req.body;
    const orderId = orderData.id || ('ORD' + Date.now());

    // Insert cart order with items
    db.prepare(`
      INSERT INTO orders (id, user_id, items, comment, promo_code, discount_amount, subtotal, total, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      user.id,
      JSON.stringify(orderData.items || []),
      orderData.comment || '',
      orderData.promo_code || null,
      orderData.discount_amount || 0,
      orderData.subtotal || orderData.total,
      orderData.total,
      'awaiting_manager',
      new Date().toISOString()
    );

    // Calculate and add cashback (5%)
    const cashbackAmount = orderData.total * 0.05;
    db.prepare(`
      UPDATE users SET
        cashback = cashback + ?,
        total_spent = total_spent + ?
      WHERE id = ?
    `).run(cashbackAmount, orderData.total, user.id);

    // Add cashback history
    db.prepare(`
      INSERT INTO cashback_history (user_id, amount, description)
      VALUES (?, ?, ?)
    `).run(user.id, cashbackAmount, `Кешбэк за заказ #${orderId}`);

    // Check and update user level
    updateUserLevel(user.id);

    // Process referral payment for first order
    processReferralPayment(user.id);

    // Add notification to user
    db.prepare(`
      INSERT INTO notifications (user_id, title, message)
      VALUES (?, ?, ?)
    `).run(user.id, '📤 Заказ отправлен', `Заказ #${orderId} отправлен менеджеру. Ожидайте ответа.`);

    // Format items list for admin notification
    const itemsList = orderData.items.map(item =>
      `  • ${item.name} x${item.quantity} - $${item.total}`
    ).join('\n');

    // Build promo info for notification
    const promoInfo = orderData.promo_code
      ? `🎫 Промокод: ${orderData.promo_code} (-$${orderData.discount_amount})\n`
      : '';

    // Notify admin about new cart order
    notifyAdmin(
      `🛒 Новый заказ из корзины #${orderId}\n\n` +
      `👤 Клиент: ${user.name} (@${user.username || 'no username'})\n` +
      `Telegram ID: ${user.telegram_id}\n\n` +
      `📦 Товары:\n${itemsList}\n\n` +
      `${promoInfo}` +
      `💰 Итого: $${orderData.total}\n` +
      `${orderData.comment ? `💬 Комментарий: ${orderData.comment}\n` : ''}\n` +
      `⚡ Требуется создать инвойс в админ-панели`
    );

    res.json({ success: true, orderId });
  } catch (error) {
    console.error('Error creating cart order:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update order status (for admin - old endpoint, keep for compatibility)
app.post('/api/orders/:orderId/status', (req, res) => {
  try {
    const { orderId } = req.params;
    const { status, adminKey } = req.body;
    
    // Simple admin auth
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, orderId);
    
    // Notify user
    notifyOrderStatus(order.user_id, orderId, status);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Submit review
app.post('/api/reviews', authMiddleware, (req, res) => {
  try {
    const tgUser = req.telegramUser;
    const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgUser.id.toString());
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
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
    notifyAdmin(`⭐ Новый отзыв (${rating}/5)\n\n👤 Клиент: ${user.name}\n📦 Заказ: #${orderId}\n\n💬 ${text || 'Без текста'}`);
    
    res.json({ success: true, bonus: reviewBonus });
  } catch (error) {
    console.error('Error submitting review:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Apply promo/referral code
app.post('/api/referral/apply', authMiddleware, (req, res) => {
  try {
    const tgUser = req.telegramUser;
    const { code } = req.body;
    
    const referrer = db.prepare('SELECT * FROM users WHERE referral_code = ?').get(code);
    if (!referrer) {
      return res.status(400).json({ error: 'Invalid code' });
    }
    
    const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgUser.id.toString());
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
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
  } catch (error) {
    console.error('Error applying referral:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Mark notifications as read
app.post('/api/notifications/read', authMiddleware, (req, res) => {
  try {
    const tgUser = req.telegramUser;
    const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgUser.id.toString());
    
    if (user) {
      db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(user.id);
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error marking notifications as read:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ADMIN API ====================

// Get all orders (for admin panel)
app.get('/api/admin/orders', adminAuthMiddleware, (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT o.*, u.name as user_name, u.username, u.telegram_id
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      ORDER BY o.created_at DESC
    `).all();
    
    res.json(orders);
  } catch (error) {
    console.error('Error getting admin orders:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all users (for admin panel)
app.get('/api/admin/users', adminAuthMiddleware, (req, res) => {
  try {
    const users = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
    res.json(users);
  } catch (error) {
    console.error('Error getting admin users:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all referrals (for admin panel)
app.get('/api/admin/referrals', adminAuthMiddleware, (req, res) => {
  try {
    const referrals = db.prepare(`
      SELECT r.*, 
        u1.name as referrer_name, u1.username as referrer_username, u1.trc20_wallet,
        u2.name as referred_name, u2.username as referred_username
      FROM referrals r
      JOIN users u1 ON r.referrer_id = u1.id
      JOIN users u2 ON r.referred_id = u2.id
      ORDER BY r.created_at DESC
    `).all();
    
    res.json(referrals);
  } catch (error) {
    console.error('Error getting admin referrals:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update order status (admin panel - new endpoint with header auth)
app.post('/api/admin/orders/:orderId/status', adminAuthMiddleware, (req, res) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;
    
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, orderId);
    
    // Notify user
    notifyOrderStatus(order.user_id, orderId, status);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Send notification (admin panel)
app.post('/api/admin/notify', adminAuthMiddleware, async (req, res) => {
  try {
    const { userId, title, message, sendTelegram } = req.body;
    
    if (userId === 'all') {
      const users = db.prepare('SELECT * FROM users').all();
      for (const user of users) {
        db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(user.id, title, message);
        if (sendTelegram && user.telegram_id) {
          await bot.telegram.sendMessage(user.telegram_id, `${title}\n\n${message}`).catch(err => {
            console.error(`Failed to send to ${user.telegram_id}:`, err.message);
          });
        }
      }
    } else {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      if (user) {
        db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(userId, title, message);
        if (sendTelegram && user.telegram_id) {
          await bot.telegram.sendMessage(user.telegram_id, `${title}\n\n${message}`).catch(err => {
            console.error(`Failed to send to ${user.telegram_id}:`, err.message);
          });
        }
      }
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error sending notification:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Send message about order (admin panel)
app.post('/api/admin/orders/:orderId/message', adminAuthMiddleware, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { message } = req.body;
    
    const order = db.prepare(`
      SELECT o.*, u.telegram_id, u.name, u.id as uid
      FROM orders o
      JOIN users u ON o.user_id = u.id
      WHERE o.id = ?
    `).get(orderId);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    // Send Telegram message
    const webAppUrl = process.env.WEBAPP_URL || 'https://white-agency-app.vercel.app';
    await bot.telegram.sendMessage(order.telegram_id,
      `💬 Сообщение по заказу #${orderId}\n\n${message}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '📱 Открыть в приложении', web_app: { url: webAppUrl } }
          ]]
        }
      }
    );
    
    // Save notification
    db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
      order.uid, 
      `Сообщение по заказу #${orderId}`, 
      message
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error sending order message:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark referral as paid (admin panel)
app.post('/api/admin/referrals/:referralId/paid', adminAuthMiddleware, (req, res) => {
  try {
    const { referralId } = req.params;
    
    // Reset earnings to 0 after payment
    db.prepare('UPDATE referrals SET earnings = 0 WHERE id = ?').run(referralId);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error marking referral as paid:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get stats (admin panel)
app.get('/api/admin/stats', adminAuthMiddleware, (req, res) => {
  try {
    const totalOrders = db.prepare('SELECT COUNT(*) as count FROM orders').get().count;
    const pendingOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE status = 'pending'").get().count;
    const workingOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE status = 'working'").get().count;
    const completedOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE status = 'completed'").get().count;
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const totalRevenue = db.prepare("SELECT COALESCE(SUM(total), 0) as sum FROM orders WHERE status = 'completed'").get().sum;
    
    res.json({
      totalOrders,
      pendingOrders,
      workingOrders,
      completedOrders,
      totalUsers,
      totalRevenue
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== HELPERS ====================

function generateRefCode(name) {
  const prefix = (name || 'USER').substring(0, 4).toUpperCase().replace(/[^A-Z]/g, 'X');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return prefix + rand;
}

function updateUserLevel(userId) {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return;
    
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
      ).catch(err => console.error('Failed to send level notification:', err.message));
    }
  } catch (error) {
    console.error('Error updating user level:', error);
  }
}

function notifyAdmin(message) {
  if (process.env.ADMIN_CHAT_ID) {
    bot.telegram.sendMessage(process.env.ADMIN_CHAT_ID, message).catch(err => {
      console.error('Failed to notify admin:', err.message);
    });
  } else {
    console.log('ADMIN_CHAT_ID not set. Admin message:', message);
  }
}

// Process referral payment after first order
function processReferralPayment(userId) {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || !user.referred_by) return;
    
    // Check if this is first order
    const ordersCount = db.prepare('SELECT COUNT(*) as count FROM orders WHERE user_id = ?').get(userId).count;
    if (ordersCount !== 1) return;
    
    const firstOrder = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at LIMIT 1').get(userId);
    if (!firstOrder) return;

    // Use subtotal (before discounts) or base_price if subtotal not available
    const baseAmount = firstOrder.subtotal || firstOrder.base_price || firstOrder.total;
    const referralAmount = baseAmount * 0.25; // 25% of original price
    
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
    if (!referrer) return;
    
    // Notify referrer
    db.prepare(`
      INSERT INTO notifications (user_id, title, message)
      VALUES (?, ?, ?)
    `).run(referrer.id, '💰 Реферальный бонус!', `+$${referralAmount.toFixed(2)} за приглашённого ${user.name}`);
    
    const walletMessage = referrer.trc20_wallet 
      ? 'Выплата будет отправлена на ваш TRC-20 кошелёк'
      : '⚠️ Укажите TRC-20 кошелёк в настройках для получения выплаты';
    
    bot.telegram.sendMessage(referrer.telegram_id,
      `💰 Реферальный бонус!\n\n${user.name} сделал первый заказ.\nВаш бонус: $${referralAmount.toFixed(2)}\n\n${walletMessage}`
    ).catch(err => console.error('Failed to send referral notification:', err.message));
    
    // Notify admin about referral payment
    notifyAdmin(
      `💸 Реферальная выплата\n\n` +
      `👤 Получатель: ${referrer.name} (@${referrer.username || 'no username'})\n` +
      `💰 Сумма: $${referralAmount.toFixed(2)}\n` +
      `💎 Кошелёк: ${referrer.trc20_wallet || 'НЕ УКАЗАН'}\n` +
      `👥 За пользователя: ${user.name}`
    );
  } catch (error) {
    console.error('Error processing referral payment:', error);
  }
}

// Notify user about order status
async function notifyOrderStatus(userId, orderId, status) {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return;
    
    const statuses = {
      pending: { emoji: '⏳', text: 'Заказ ожидает обработки' },
      working: { emoji: '🎨', text: 'Ваш заказ в работе!' },
      completed: { emoji: '✅', text: 'Ваш заказ готов!' },
      cancelled: { emoji: '❌', text: 'Заказ отменён' }
    };
    
    const statusInfo = statuses[status] || { emoji: '📦', text: 'Статус заказа обновлён' };
    
    // Add notification to DB
    db.prepare(`
      INSERT INTO notifications (user_id, title, message)
      VALUES (?, ?, ?)
    `).run(userId, `${statusInfo.emoji} ${statusInfo.text}`, `Заказ #${orderId}`);
    
    // Send Telegram message
    const webAppUrl = process.env.WEBAPP_URL || 'https://white-agency-app.vercel.app';
    await bot.telegram.sendMessage(user.telegram_id,
      `${statusInfo.emoji} ${statusInfo.text}\n\nЗаказ #${orderId}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '📱 Открыть в приложении', web_app: { url: webAppUrl } }
          ]]
        }
      }
    );
  } catch (error) {
    console.error('Failed to notify order status:', error.message);
  }
}

// ==================== TELEGRAM BOT ====================

bot.command('start', async (ctx) => {
  try {
    const refCode = ctx.message.text.split(' ')[1];

    // Save pending referral
    if (refCode) {
      const existingUser = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(ctx.from.id.toString());
      if (!existingUser) {
        // Save for later when user opens the app
        db.prepare('INSERT OR REPLACE INTO pending_referrals (telegram_id, referral_code) VALUES (?, ?)')
          .run(ctx.from.id.toString(), refCode);

        // Notify the referrer that someone used their link
        const referrer = db.prepare('SELECT * FROM users WHERE referral_code = ?').get(refCode);
        if (referrer) {
          const userName = ctx.from.first_name || 'Новый пользователь';

          // Add notification
          db.prepare(`
            INSERT INTO notifications (user_id, title, message)
            VALUES (?, ?, ?)
          `).run(referrer.id, '🎉 Новый реферал!', `${userName} перешёл по вашей ссылке! Когда он сделает заказ, вы получите выплату.`);

          // Send Telegram notification
          bot.telegram.sendMessage(referrer.telegram_id,
            `🎉 По вашей реферальной ссылке перешёл ${userName}!\n\nКогда он сделает первый заказ, вы получите 25% от его суммы.`
          ).catch(err => console.error('Failed to send referral notification:', err.message));
        }
      }
    }

    const webAppUrl = process.env.WEBAPP_URL || 'https://white-agency-app.vercel.app';
    const keyboard = {
      inline_keyboard: [[
        { text: '🚀 Открыть личный кабинет', web_app: { url: webAppUrl } }
      ]]
    };

    const welcomeMessage =
      `👋 Добро пожаловать в *White Agency*!\n\n` +
      `Мы делаем креативы под результат для:\n` +
      `• 🎰 Gambling / Betting\n` +
      `• 💹 Crypto / Forex\n` +
      `• 📦 Товарка\n` +
      `• 💼 Вакансии / Лидген\n` +
      `• И другие ниши\n\n` +
      `${refCode ? '🎁 *Вас пригласил друг!*\nПолучите скидку 25% на первый заказ!\n\n' : ''}` +
      `✨ *Что вы получите:*\n` +
      `• Скидки до 20% по программе лояльности\n` +
      `• 5% кешбэк с каждого заказа\n` +
      `• 25% с первого заказа приглашенного друга\n\n` +
      `👇 *Нажмите кнопку ниже, чтобы начать*`;

    await ctx.reply(welcomeMessage, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  } catch (error) {
    console.error('Error in /start command:', error);
    const webAppUrl = process.env.WEBAPP_URL || 'https://white-agency-app.vercel.app';
    await ctx.reply('Добро пожаловать! Нажмите кнопку ниже:', {
      reply_markup: {
        inline_keyboard: [[
          { text: '🚀 Открыть', web_app: { url: webAppUrl } }
        ]]
      }
    }).catch(e => console.error('Fallback message failed:', e));
  }
});

bot.command('help', async (ctx) => {
  try {
    await ctx.reply(
      `📋 *Команды:*\n\n` +
      `/start - Открыть личный кабинет\n` +
      `/prices - Прайс-лист\n` +
      `/ref - Реферальная программа\n` +
      `/support - Связаться с менеджером`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Error in /help command:', error);
  }
});

bot.command('prices', async (ctx) => {
  try {
    const webAppUrl = process.env.WEBAPP_URL || 'https://white-agency-app.vercel.app';
    await ctx.reply(
      `💰 *Цены на услуги:*\n\n` +
      `📸 Статика — от $10\n` +
      `📸 Пак статики (5 шт) — от $30\n` +
      `🎬 Видео-креатив — от $25\n` +
      `💋 Липсинг — от $40\n` +
      `🤖 AI-аватар — от $30\n` +
      `📱 UGC-видео — от $100\n` +
      `🎞 GIF/Анимация — от $15\n` +
      `💻 Дизайн лендинга — от $200\n\n` +
      `➕ *5% кешбэк* с каждого заказа!`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🚀 Сделать заказ', web_app: { url: webAppUrl } }
          ]]
        }
      }
    );
  } catch (error) {
    console.error('Error in /prices command:', error);
  }
});

bot.command('ref', async (ctx) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(ctx.from.id.toString());
    const webAppUrl = process.env.WEBAPP_URL || 'https://white-agency-app.vercel.app';

    if (!user) {
      return ctx.reply('Сначала откройте личный кабинет 👇', {
        reply_markup: {
          inline_keyboard: [[
            { text: '🚀 Открыть', web_app: { url: webAppUrl } }
          ]]
        }
      });
    }

    const refCount = db.prepare('SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ?').get(user.id).count;
    const botUsername = process.env.BOT_USERNAME || 'WhiteAgency_Official_bot';

    await ctx.reply(
      `👥 *Реферальная программа*\n\n` +
      `📋 Ваш код: \`${user.referral_code}\`\n` +
      `🔗 Ваша ссылка: \`t.me/${botUsername}?start=${user.referral_code}\`\n\n` +
      `💰 Получайте *25%* с первого заказа каждого приглашённого друга!\n\n` +
      `📊 Статистика:\n` +
      `• Приглашено: ${refCount}\n` +
      `• Заработано: $${user.referral_earnings.toFixed(2)}`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Error in /ref command:', error);
  }
});

bot.command('support', async (ctx) => {
  try {
    await ctx.reply(
      `💬 Связаться с менеджером:\n\n@${process.env.MANAGER_USERNAME || 'WhiteAgency_manager'}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '✍️ Написать менеджеру', url: `https://t.me/${process.env.MANAGER_USERNAME || 'WhiteAgency_manager'}` }
          ]]
        }
      }
    );
  } catch (error) {
    console.error('Error in /support command:', error);
  }
});

// Handle any errors
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
});

// ==================== SETTINGS API ====================

// Get app settings (public)
app.get('/api/settings', (req, res) => {
  try {
    let settings = db.prepare('SELECT * FROM app_settings WHERE id = 1').get();

    if (!settings) {
      // Create default settings
      const defaultSettings = {
        services: JSON.stringify([
          { name: 'Статика', price: 10, desc: '1 креатив' },
          { name: 'Пак статики', price: 30, desc: '5 креативов' },
          { name: 'Видео-креатив', price: 25, desc: '9:16 / 4:5 / 1:1' },
          { name: 'Липсинг', price: 40, desc: 'Движение губ под текст' },
          { name: 'AI-аватар', price: 30, desc: 'Нейро-персонаж' },
          { name: 'UGC-видео', price: 100, desc: 'До 15 сек' },
          { name: 'GIF/Анимация', price: 15, desc: 'Motion-дизайн' },
          { name: 'Дизайн лендинга', price: 200, desc: 'UX/UI' }
        ]),
        prices: JSON.stringify({}),
        form_fields: JSON.stringify([])
      };

      db.prepare(`
        INSERT INTO app_settings (id, services, prices, form_fields)
        VALUES (1, ?, ?, ?)
      `).run(defaultSettings.services, defaultSettings.prices, defaultSettings.form_fields);

      settings = db.prepare('SELECT * FROM app_settings WHERE id = 1').get();
    }

    res.json({
      services: JSON.parse(settings.services || '[]'),
      prices: JSON.parse(settings.prices || '{}'),
      form_fields: JSON.parse(settings.form_fields || '[]')
    });
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// Update app settings (admin only)
app.post('/api/admin/settings', adminAuthMiddleware, (req, res) => {
  try {
    const { services, prices, form_fields } = req.body;

    db.prepare(`
      INSERT OR REPLACE INTO app_settings (id, services, prices, form_fields, updated_at)
      VALUES (1, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      JSON.stringify(services || []),
      JSON.stringify(prices || {}),
      JSON.stringify(form_fields || [])
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ==================== PRODUCTS ====================

// Get all products (public)
app.get('/api/products', (req, res) => {
  try {
    const products = db.prepare('SELECT * FROM products WHERE is_active = 1 ORDER BY sort_order, id').all();
    res.json(products);
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Failed to get products' });
  }
});

// Get all products (admin - including inactive)
app.get('/api/admin/products', adminAuthMiddleware, (req, res) => {
  try {
    const products = db.prepare('SELECT * FROM products ORDER BY sort_order, id').all();
    res.json(products);
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Failed to get products' });
  }
});

// Create product (admin only)
app.post('/api/admin/products', adminAuthMiddleware, (req, res) => {
  try {
    const { name, description, price, icon, sort_order } = req.body;

    const result = db.prepare(`
      INSERT INTO products (name, description, price, icon, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, description || '', price, icon || '🎨', sort_order || 0);

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
    res.json(product);
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// Update product (admin only)
app.put('/api/admin/products/:id', adminAuthMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, price, icon, sort_order, is_active } = req.body;

    db.prepare(`
      UPDATE products
      SET name = ?, description = ?, price = ?, icon = ?, sort_order = ?, is_active = ?
      WHERE id = ?
    `).run(name, description, price, icon, sort_order, is_active ? 1 : 0, id);

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    res.json(product);
  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// Delete product (admin only)
app.delete('/api/admin/products/:id', adminAuthMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// Test notification endpoint (admin only)
app.post('/api/admin/test-notification', adminAuthMiddleware, async (req, res) => {
  try {
    const { user_id } = req.body;

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.telegram_id) {
      return res.status(400).json({ error: 'User has no telegram_id' });
    }

    console.log('Testing notification to user:', user.telegram_id);

    const webAppUrl = process.env.WEB_APP_URL || 'https://white-agency-app-production.up.railway.app';

    const result = await bot.telegram.sendMessage(
      user.telegram_id,
      `🔔 *Тестовое уведомление*\n\nЭто тестовое сообщение от бота.\nВаш Telegram ID: ${user.telegram_id}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '📱 Открыть приложение', web_app: { url: webAppUrl } }
          ]]
        }
      }
    );

    console.log('Notification sent successfully:', result);
    res.json({ success: true, message: 'Notification sent', result });
  } catch (error) {
    console.error('Test notification error:', error);
    res.status(500).json({
      error: 'Failed to send notification',
      details: error.message,
      code: error.code
    });
  }
});

// ==================== INVOICES ====================

// Create invoice (admin only)
app.post('/api/admin/invoices', adminAuthMiddleware, (req, res) => {
  try {
    const { order_id, user_id, amount, promo_code, discount_amount } = req.body;

    const invoiceId = 'INV' + Date.now();
    const finalAmount = amount - (discount_amount || 0);
    const paymentAddress = process.env.PAYMENT_ADDRESS || 'TAXtuQh2zJHks5yZQ2zzVdEFExs7ktoYuV';

    // Create invoice
    db.prepare(`
      INSERT INTO invoices (id, order_id, user_id, amount, promo_code, discount_amount, final_amount, payment_address, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment')
    `).run(invoiceId, order_id, user_id, amount, promo_code || null, discount_amount || 0, finalAmount, paymentAddress);

    // Update order status to awaiting_payment
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('awaiting_payment', order_id);

    // Get user info
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Send notification to user
    db.prepare(`
      INSERT INTO notifications (user_id, title, message)
      VALUES (?, ?, ?)
    `).run(user_id, '💳 Счет выставлен', `Счет #${invoiceId} на сумму $${finalAmount.toFixed(2)}. Перейдите в приложение для оплаты.`);

    // Send Telegram notification with link
    if (user.telegram_id) {
      console.log(`Sending invoice notification to user ${user.telegram_id}, invoice ${invoiceId}`);

      // Use Web App URL from env or construct it
      const webAppUrl = process.env.WEB_APP_URL || 'https://white-agency-app-production.up.railway.app';
      const invoiceUrl = `${webAppUrl}#invoice_${invoiceId}`;

      bot.telegram.sendMessage(
        user.telegram_id,
        `💳 *Счет выставлен*\n\n` +
        `Номер счета: #${invoiceId}\n` +
        `Сумма к оплате: $${finalAmount.toFixed(2)}\n` +
        `${promo_code ? `Промокод: ${promo_code} (-$${discount_amount.toFixed(2)})\n` : ''}\n` +
        `Нажмите кнопку ниже для оплаты:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              {
                text: '💳 Оплатить',
                web_app: { url: invoiceUrl }
              }
            ]]
          }
        }
      ).then(() => {
        console.log(`Invoice notification sent successfully to ${user.telegram_id}`);
      }).catch(err => {
        console.error('Error sending invoice notification:', err);
        console.error('User telegram_id:', user.telegram_id);
        console.error('Invoice URL:', invoiceUrl);
      });
    } else {
      console.warn(`User ${user_id} has no telegram_id, cannot send notification`);
    }

    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    res.json(invoice);
  } catch (error) {
    console.error('Create invoice error:', error);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

// Get invoice by ID
app.get('/api/invoices/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const invoice = db.prepare(`
      SELECT i.*, o.items, o.comment, u.name as user_name
      FROM invoices i
      LEFT JOIN orders o ON i.order_id = o.id
      LEFT JOIN users u ON i.user_id = u.id
      WHERE i.id = ?
    `).get(id);

    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    res.json({
      ...invoice,
      items: JSON.parse(invoice.items || '[]')
    });
  } catch (error) {
    console.error('Get invoice error:', error);
    res.status(500).json({ error: 'Failed to get invoice' });
  }
});

// Verify invoice payment
app.post('/api/invoices/:id/verify', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { tx_hash } = req.body;

    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Update invoice with tx_hash
    db.prepare('UPDATE invoices SET tx_hash = ? WHERE id = ?').run(tx_hash, id);

    // Return invoice for verification (will be verified via TronScan in the client)
    res.json({ success: true, invoice: { ...invoice, tx_hash } });
  } catch (error) {
    console.error('Verify invoice error:', error);
    res.status(500).json({ error: 'Failed to verify invoice' });
  }
});

// Confirm invoice payment (after TronScan verification)
app.post('/api/invoices/:id/confirm', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;

    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Update invoice status
    db.prepare('UPDATE invoices SET status = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?').run('paid', id);

    // Update order status to working
    db.prepare('UPDATE orders SET status = ?, tx_hash = ? WHERE id = ?').run('working', invoice.tx_hash, invoice.order_id);

    // Send notification to user
    db.prepare(`
      INSERT INTO notifications (user_id, title, message)
      VALUES (?, ?, ?)
    `).run(invoice.user_id, '✅ Оплата подтверждена', `Счет #${id} оплачен. Заказ принят в работу!`);

    // Notify admin
    notifyAdmin(
      `✅ Оплата подтверждена\n\n` +
      `Счет: #${id}\n` +
      `Заказ: #${invoice.order_id}\n` +
      `Сумма: $${invoice.final_amount}\n` +
      `TxHash: ${invoice.tx_hash}`
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Confirm invoice error:', error);
    res.status(500).json({ error: 'Failed to confirm invoice' });
  }
});

// Get all invoices (admin only)
app.get('/api/admin/invoices', adminAuthMiddleware, (req, res) => {
  try {
    const invoices = db.prepare(`
      SELECT i.*, u.name as user_name, u.username, o.id as order_number
      FROM invoices i
      LEFT JOIN users u ON i.user_id = u.id
      LEFT JOIN orders o ON i.order_id = o.id
      ORDER BY i.created_at DESC
    `).all();
    res.json(invoices);
  } catch (error) {
    console.error('Get invoices error:', error);
    res.status(500).json({ error: 'Failed to get invoices' });
  }
});

// ==================== PROMO CODES ====================

// Get all promo codes (admin only)
app.get('/api/admin/promos', adminAuthMiddleware, (req, res) => {
  try {
    const promos = db.prepare(`
      SELECT * FROM promo_codes ORDER BY created_at DESC
    `).all();
    res.json(promos);
  } catch (error) {
    console.error('Get promos error:', error);
    res.status(500).json({ error: 'Failed to get promo codes' });
  }
});

// Create promo code (admin only)
app.post('/api/admin/promos', adminAuthMiddleware, (req, res) => {
  try {
    const { code, discount_percent, max_uses, expires_at } = req.body;

    if (!code || !discount_percent) {
      return res.status(400).json({ error: 'Code and discount are required' });
    }

    if (discount_percent < 1 || discount_percent > 100) {
      return res.status(400).json({ error: 'Discount must be between 1-100%' });
    }

    const result = db.prepare(`
      INSERT INTO promo_codes (code, discount_percent, max_uses, expires_at, is_active)
      VALUES (?, ?, ?, ?, 1)
    `).run(code.toUpperCase(), discount_percent, max_uses || null, expires_at || null);

    res.json({
      success: true,
      id: result.lastInsertRowid,
      code: code.toUpperCase()
    });
  } catch (error) {
    if (error.message.includes('UNIQUE constraint')) {
      res.status(400).json({ error: 'Promo code already exists' });
    } else {
      console.error('Create promo error:', error);
      res.status(500).json({ error: 'Failed to create promo code' });
    }
  }
});

// Delete promo code (admin only)
app.delete('/api/admin/promos/:id', adminAuthMiddleware, (req, res) => {
  try {
    db.prepare('DELETE FROM promo_codes WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete promo error:', error);
    res.status(500).json({ error: 'Failed to delete promo code' });
  }
});

// Check promo code validity (public)
app.get('/api/promo/:code', (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const promo = db.prepare('SELECT * FROM promo_codes WHERE code = ? AND is_active = 1').get(code);

    if (!promo) {
      return res.json({ valid: false, error: 'Промокод не найден' });
    }

    // Check expiration
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
      return res.json({ valid: false, error: 'Промокод истёк' });
    }

    // Check usage limit
    if (promo.max_uses && promo.current_uses >= promo.max_uses) {
      return res.json({ valid: false, error: 'Промокод исчерпан' });
    }

    res.json({
      valid: true,
      code: promo.code,
      discount: promo.discount_percent
    });
  } catch (error) {
    console.error('Check promo error:', error);
    res.status(500).json({ error: 'Failed to check promo code' });
  }
});

// Apply promo code (update uses count)
app.post('/api/promo/apply', (req, res) => {
  try {
    const { code, user_id, order_id } = req.body;
    const codeUpper = code.toUpperCase();

    const promo = db.prepare('SELECT * FROM promo_codes WHERE code = ? AND is_active = 1').get(codeUpper);

    if (!promo) {
      return res.json({ success: false, error: 'Промокод не найден' });
    }

    // Update use count
    db.prepare('UPDATE promo_codes SET current_uses = current_uses + 1 WHERE id = ?').run(promo.id);

    // Record use
    db.prepare(`
      INSERT INTO promo_uses (promo_id, user_id, order_id)
      VALUES (?, ?, ?)
    `).run(promo.id, user_id, order_id);

    res.json({
      success: true,
      discount: promo.discount_percent
    });
  } catch (error) {
    console.error('Apply promo error:', error);
    res.status(500).json({ error: 'Failed to apply promo code' });
  }
});

// Update user cashback (admin only)
app.post('/api/admin/users/:id/cashback', adminAuthMiddleware, (req, res) => {
  try {
    const { amount } = req.body;
    const userId = req.params.id;

    if (amount === undefined) {
      return res.status(400).json({ error: 'Amount is required' });
    }

    db.prepare('UPDATE users SET cashback = cashback + ? WHERE id = ?').run(amount, userId);

    res.json({ success: true });
  } catch (error) {
    console.error('Update cashback error:', error);
    res.status(500).json({ error: 'Failed to update cashback' });
  }
});

// ==================== WITHDRAWALS ====================

// Request withdrawal (user)
app.post('/api/withdrawal-request', authMiddleware, (req, res) => {
  try {
    const tgUser = req.telegramUser;
    const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgUser.id.toString());

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { type, amount } = req.body; // type: 'cashback' or 'referral'

    // Check if user has TRC20 wallet
    if (!user.trc20_wallet) {
      return res.status(400).json({ error: 'no_wallet', message: 'Пожалуйста, добавьте TRC20 кошелек в настройках профиля' });
    }

    // Validate amount
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'invalid_amount', message: 'Неверная сумма' });
    }

    // Check if user has enough balance
    if (type === 'cashback') {
      if (user.cashback < amount) {
        return res.status(400).json({ error: 'insufficient_balance', message: 'Недостаточно средств на балансе кешбэка' });
      }
    } else if (type === 'referral') {
      if (user.referral_earnings < amount) {
        return res.status(400).json({ error: 'insufficient_balance', message: 'Недостаточно реферальных средств' });
      }
    } else {
      return res.status(400).json({ error: 'invalid_type', message: 'Неверный тип выплаты' });
    }

    // Create withdrawal request
    const result = db.prepare(`
      INSERT INTO withdrawals (user_id, amount, wallet_address, type, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(user.id, amount, user.trc20_wallet, type);

    const withdrawalId = result.lastInsertRowid;

    // Add notification to user
    db.prepare(`
      INSERT INTO notifications (user_id, title, message)
      VALUES (?, ?, ?)
    `).run(user.id, '💸 Запрос на выплату', `Запрос на выплату $${amount} передан в обработку`);

    // Notify admin
    const typeText = type === 'cashback' ? 'кешбэк' : 'реферальный доход';
    notifyAdmin(
      `💸 Запрос на выплату #${withdrawalId}\n\n` +
      `👤 Клиент: ${user.name} (@${user.username || 'no username'})\n` +
      `Telegram ID: ${user.telegram_id}\n` +
      `💰 Сумма: $${amount}\n` +
      `📊 Тип: ${typeText}\n` +
      `💳 Кошелек: ${user.trc20_wallet}\n\n` +
      `⚡ Требуется обработать в админ-панели`
    );

    res.json({ success: true, withdrawalId });
  } catch (error) {
    console.error('Withdrawal request error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all withdrawals (admin only)
app.get('/api/admin/withdrawals', adminAuthMiddleware, (req, res) => {
  try {
    const withdrawals = db.prepare(`
      SELECT w.*, u.name as user_name, u.username, u.telegram_id, u.cashback, u.referral_earnings
      FROM withdrawals w
      LEFT JOIN users u ON w.user_id = u.id
      ORDER BY w.created_at DESC
    `).all();

    res.json(withdrawals);
  } catch (error) {
    console.error('Get withdrawals error:', error);
    res.status(500).json({ error: 'Failed to get withdrawals' });
  }
});

// Process withdrawal (admin only)
app.post('/api/admin/withdrawals/:id/process', adminAuthMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { tx_hash } = req.body;

    const withdrawal = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
    if (!withdrawal) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }

    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ error: 'Withdrawal already processed' });
    }

    // Update withdrawal status
    db.prepare(`
      UPDATE withdrawals
      SET status = 'completed', tx_hash = ?, processed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(tx_hash || null, id);

    // Deduct from user balance
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(withdrawal.user_id);
    if (withdrawal.type === 'cashback') {
      const newCashback = Math.max(0, user.cashback - withdrawal.amount);
      db.prepare('UPDATE users SET cashback = ? WHERE id = ?').run(newCashback, user.id);

      // Add to cashback history
      db.prepare(`
        INSERT INTO cashback_history (user_id, amount, description)
        VALUES (?, ?, ?)
      `).run(user.id, -withdrawal.amount, `Выплата #${id}`);
    } else if (withdrawal.type === 'referral') {
      const newEarnings = Math.max(0, user.referral_earnings - withdrawal.amount);
      db.prepare('UPDATE users SET referral_earnings = ? WHERE id = ?').run(newEarnings, user.id);
    }

    // Notify user
    db.prepare(`
      INSERT INTO notifications (user_id, title, message)
      VALUES (?, ?, ?)
    `).run(user.id, '✅ Выплата выполнена', `Выплата $${withdrawal.amount} успешно отправлена на ваш кошелек`);

    res.json({ success: true });
  } catch (error) {
    console.error('Process withdrawal error:', error);
    res.status(500).json({ error: 'Failed to process withdrawal' });
  }
});

// Cancel withdrawal (admin only)
app.post('/api/admin/withdrawals/:id/cancel', adminAuthMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const withdrawal = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
    if (!withdrawal) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }

    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ error: 'Withdrawal already processed' });
    }

    // Update withdrawal status
    db.prepare(`
      UPDATE withdrawals
      SET status = 'cancelled', processed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);

    // Notify user
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(withdrawal.user_id);
    db.prepare(`
      INSERT INTO notifications (user_id, title, message)
      VALUES (?, ?, ?)
    `).run(user.id, '❌ Выплата отменена', `Выплата $${withdrawal.amount} отменена. ${reason || 'Обратитесь к менеджеру'}`);

    res.json({ success: true });
  } catch (error) {
    console.error('Cancel withdrawal error:', error);
    res.status(500).json({ error: 'Failed to cancel withdrawal' });
  }
});

// Get user withdrawals
app.get('/api/withdrawals', authMiddleware, (req, res) => {
  try {
    const tgUser = req.telegramUser;
    const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgUser.id.toString());

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const withdrawals = db.prepare(`
      SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC
    `).all(user.id);

    res.json(withdrawals);
  } catch (error) {
    console.error('Get user withdrawals error:', error);
    res.status(500).json({ error: 'Failed to get withdrawals' });
  }
});

// ==================== TRONSCAN VERIFICATION ====================

// Verify TronScan transaction
app.post('/api/verify-tronscan', async (req, res) => {
  try {
    const { txHash, expectedAmount, recipientAddress } = req.body;

    if (!txHash) {
      return res.status(400).json({ error: 'Transaction hash required' });
    }

    if (!recipientAddress) {
      return res.status(400).json({ error: 'Recipient address required' });
    }

    console.log(`Verifying TronScan transaction: ${txHash} to ${recipientAddress}`);

    // Query TronScan API
    const apiUrl = `https://apilist.tronscan.org/api/transaction-info?hash=${txHash}`;
    const response = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      console.error('TronScan API error:', response.status);
      return res.status(400).json({
        verified: false,
        error: 'Transaction not found on TronScan'
      });
    }

    const txData = await response.json();
    console.log('TronScan response:', JSON.stringify(txData, null, 2));

    // Check if transaction exists and is confirmed
    if (!txData || txData.code === 'NOT_FOUND') {
      return res.json({
        verified: false,
        error: 'Транзакция не найдена. Убедитесь что она подтверждена в блокчейне.'
      });
    }

    // Check if transaction is confirmed
    if (!txData.confirmed) {
      return res.json({
        verified: false,
        error: 'Транзакция еще не подтверждена. Подождите несколько минут.'
      });
    }

    // For USDT TRC20 transfers, check contract data
    let transferAmount = 0;
    let transferTo = '';

    if (txData.contractData && txData.contractData.amount) {
      // USDT TRC20 amount is in smallest units (6 decimals)
      transferAmount = txData.contractData.amount / 1000000;
      transferTo = txData.contractData.to_address || txData.toAddress;
    } else if (txData.trigger_info && txData.trigger_info.parameter) {
      // Alternative structure
      const param = txData.trigger_info.parameter;
      if (param._value) {
        transferAmount = parseInt(param._value) / 1000000;
      }
      if (param._to) {
        transferTo = param._to;
      }
    }

    console.log(`Transfer amount: ${transferAmount} USDT to ${transferTo}`);

    // Verify amount if provided (with 1% tolerance for fees)
    if (expectedAmount && transferAmount > 0) {
      const tolerance = expectedAmount * 0.01; // 1% tolerance
      if (Math.abs(transferAmount - expectedAmount) > tolerance) {
        return res.json({
          verified: false,
          error: `Неверная сумма. Ожидалось: $${expectedAmount}, найдено: $${transferAmount}`
        });
      }
    }

    // Verify recipient address (mandatory)
    if (!transferTo) {
      return res.json({
        verified: false,
        error: 'Не удалось определить адрес получателя в транзакции'
      });
    }

    if (transferTo.toLowerCase() !== recipientAddress.toLowerCase()) {
      return res.json({
        verified: false,
        error: `Неверный адрес получателя. Ожидалось: ${recipientAddress}, получено: ${transferTo}`
      });
    }

    // Transaction verified successfully
    res.json({
      verified: true,
      amount: transferAmount,
      recipient: transferTo,
      confirmed: txData.confirmed,
      timestamp: txData.timestamp
    });

  } catch (error) {
    console.error('TronScan verification error:', error);
    res.status(500).json({
      verified: false,
      error: 'Ошибка при проверке транзакции: ' + error.message
    });
  }
});

// ==================== WEBHOOK SETUP ====================

// Webhook endpoint for Telegram
app.post(`/webhook/${process.env.BOT_TOKEN}`, (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

// ==================== START ====================

const PORT = process.env.PORT || 8080;

async function startApp() {
  // Start Express server first
  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Admin panel available at /admin`);
    
    // Setup bot based on environment
    if (process.env.RAILWAY_PUBLIC_DOMAIN || process.env.WEBHOOK_URL) {
      // Production: use webhook
      const webhookUrl = process.env.WEBHOOK_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/webhook/${process.env.BOT_TOKEN}`;
      
      try {
        // Delete any existing webhook first
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        // Set new webhook
        await bot.telegram.setWebhook(webhookUrl);
        console.log(`🤖 Bot webhook set to: ${webhookUrl}`);
      } catch (err) {
        console.error('Failed to set webhook:', err.message);
      }
    } else {
      // Development: use polling
      try {
        // Delete webhook first to use polling
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        await bot.launch();
        console.log('🤖 Bot started with polling');
      } catch (err) {
        console.error('Failed to start bot:', err.message);
      }
    }
  });
}

startApp();

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  bot.stop('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  bot.stop('SIGTERM');
  process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
