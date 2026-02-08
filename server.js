const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { RateLimiterMemory } = require('rate-limiter-flexible');

const app = express();

// Настройки для Render
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'forum.db');

// Создаем папку для базы данных если её нет
if (!fs.existsSync(path.dirname(DB_PATH))) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

// Middleware
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const rateLimiter = new RateLimiterMemory({
    points: 20,
    duration: 60,
});

const rateLimiterMiddleware = (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    rateLimiter.consume(ip)
        .then(() => next())
        .catch(() => res.status(429).json({ error: 'Слишком много запросов. Подождите немного.' }));
};

// Инициализация базы данных
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Ошибка подключения к SQLite:', err);
    } else {
        console.log('Подключен к SQLite базе:', DB_PATH);
        initDatabase();
    }
});

function initDatabase() {
    // Таблица досок
    db.run(`
        CREATE TABLE IF NOT EXISTS boards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Таблица тредов
    db.run(`
        CREATE TABLE IF NOT EXISTS threads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            board_id INTEGER,
            subject TEXT,
            name TEXT DEFAULT 'Аноним',
            text TEXT NOT NULL,
            password TEXT,
            image_url TEXT,
            ip_address TEXT,
            bump_time DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            reply_count INTEGER DEFAULT 0,
            is_sticky BOOLEAN DEFAULT 0,
            is_locked BOOLEAN DEFAULT 0,
            FOREIGN KEY (board_id) REFERENCES boards (id)
        )
    `);

    // Таблица постов
    db.run(`
        CREATE TABLE IF NOT EXISTS posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id INTEGER,
            name TEXT DEFAULT 'Аноним',
            text TEXT NOT NULL,
            password TEXT,
            image_url TEXT,
            ip_address TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (thread_id) REFERENCES threads (id)
        )
    `);

    // Создаем индексы
    db.run('CREATE INDEX IF NOT EXISTS idx_threads_board ON threads(board_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_posts_thread ON posts(thread_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_threads_bump ON threads(bump_time)');

    // Заполняем начальные данные (доски)
    const boards = [
        { code: 'b', name: 'Без темы', description: 'Абсолютно случайный контент' },
        { code: 'ykt', name: 'Якутск', description: 'Местные новости и обсуждения' },
        { code: 'pol', name: 'Политика', description: 'Политические дискуссии' },
        { code: 'a', name: 'Аниме', description: 'Аниме и манга' },
        { code: 'g', name: 'Технологии', description: 'Компьютеры и программирование' },
        { code: 'mu', name: 'Музыка', description: 'Музыка и аудио' },
        { code: 'tv', name: 'Телевидение', description: 'Фильмы и сериалы' },
        { code: 'v', name: 'Видеоигры', description: 'Игры и консоли' }
    ];

    boards.forEach(board => {
        db.run(
            'INSERT OR IGNORE INTO boards (code, name, description) VALUES (?, ?, ?)',
            [board.code, board.name, board.description]
        );
    });

    console.log('База данных инициализирована');
}

// Helper функции для базы данных
function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

// API Routes

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Получить все доски
app.get('/api/boards', async (req, res) => {
    try {
        const boards = await dbAll('SELECT * FROM boards ORDER BY id');
        res.json({ success: true, data: boards });
    } catch (error) {
        console.error('Ошибка получения досок:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Получить доску
app.get('/api/board/:code', async (req, res) => {
    try {
        const board = await dbGet('SELECT * FROM boards WHERE code = ?', [req.params.code]);
        if (!board) {
            return res.status(404).json({ error: 'Доска не найдена' });
        }

        const [threads, stickyThreads] = await Promise.all([
            dbAll(
                `SELECT * FROM threads 
                 WHERE board_id = ? AND is_sticky = 0 
                 ORDER BY bump_time DESC 
                 LIMIT 20`,
                [board.id]
            ),
            dbAll(
                'SELECT * FROM threads WHERE board_id = ? AND is_sticky = 1 ORDER BY created_at DESC',
                [board.id]
            )
        ]);

        res.json({
            success: true,
            data: {
                board,
                threads: [...stickyThreads, ...threads]
            }
        });
    } catch (error) {
        console.error('Ошибка загрузки доски:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Получить тред
app.get('/api/thread/:id', async (req, res) => {
    try {
        const thread = await dbGet('SELECT * FROM threads WHERE id = ?', [req.params.id]);
        if (!thread) {
            return res.status(404).json({ error: 'Тред не найден' });
        }

        const [posts, board] = await Promise.all([
            dbAll('SELECT * FROM posts WHERE thread_id = ? ORDER BY created_at LIMIT 100', [thread.id]),
            dbGet('SELECT * FROM boards WHERE id = ?', [thread.board_id])
        ]);

        res.json({
            success: true,
            data: {
                thread,
                posts,
                board: board || { code: 'unknown', name: 'Неизвестная доска' }
            }
        });
    } catch (error) {
        console.error('Ошибка загрузки треда:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Создать тред
app.post('/api/thread/create', rateLimiterMiddleware, async (req, res) => {
    try {
        const { board, subject, name, text, password, image_url } = req.body;
        
        if (!text || text.trim().length < 5) {
            return res.status(400).json({ error: 'Текст должен содержать минимум 5 символов' });
        }

        const boardData = await dbGet('SELECT * FROM boards WHERE code = ?', [board]);
        if (!boardData) {
            return res.status(400).json({ error: 'Неверная доска' });
        }

        const result = await dbRun(
            `INSERT INTO threads (board_id, subject, name, text, password, image_url, ip_address) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                boardData.id,
                subject || null,
                name || 'Аноним',
                text.trim(),
                password || null,
                image_url || null,
                req.ip || 'unknown'
            ]
        );

        res.json({
            success: true,
            message: 'Тред создан',
            threadId: result.lastID,
            board: board
        });
    } catch (error) {
        console.error('Ошибка создания треда:', error);
        res.status(500).json({ error: 'Ошибка создания треда' });
    }
});

// Создать пост
app.post('/api/post/create', rateLimiterMiddleware, async (req, res) => {
    try {
        const { thread_id, name, text, password, image_url } = req.body;
        
        if (!text || text.trim().length < 1) {
            return res.status(400).json({ error: 'Введите текст поста' });
        }

        const thread = await dbGet('SELECT * FROM threads WHERE id = ?', [thread_id]);
        if (!thread) {
            return res.status(404).json({ error: 'Тред не найден' });
        }

        if (thread.is_locked) {
            return res.status(400).json({ error: 'Тред закрыт для ответов' });
        }

        const result = await dbRun(
            `INSERT INTO posts (thread_id, name, text, password, image_url, ip_address) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                thread_id,
                name || 'Аноним',
                text.trim(),
                password || null,
                image_url || null,
                req.ip || 'unknown'
            ]
        );

        // Обновляем bump time и счетчик ответов
        await dbRun(
            'UPDATE threads SET bump_time = CURRENT_TIMESTAMP, reply_count = reply_count + 1 WHERE id = ?',
            [thread_id]
        );

        res.json({
            success: true,
            message: 'Пост добавлен',
            postId: result.lastID
        });
    } catch (error) {
        console.error('Ошибка создания поста:', error);
        res.status(500).json({ error: 'Ошибка создания поста' });
    }
});

// Удалить пост
app.post('/api/post/delete', async (req, res) => {
    try {
        const { post_id, password } = req.body;
        
        if (!password) {
            return res.status(400).json({ error: 'Введите пароль' });
        }

        const post = await dbGet('SELECT * FROM posts WHERE id = ? AND password = ?', [post_id, password]);
        
        if (post) {
            await dbRun('DELETE FROM posts WHERE id = ?', [post_id]);
            res.json({ success: true, message: 'Пост удален' });
        } else {
            res.status(400).json({ error: 'Неверный пароль или пост не найден' });
        }
    } catch (error) {
        console.error('Ошибка удаления поста:', error);
        res.status(500).json({ error: 'Ошибка удаления поста' });
    }
});

// Получить последние посты
app.get('/api/posts/recent', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 15;
        const posts = await dbAll(
            `SELECT p.*, b.code as board_code, t.subject as thread_subject
             FROM posts p
             JOIN threads t ON p.thread_id = t.id
             JOIN boards b ON t.board_id = b.id
             ORDER BY p.created_at DESC
             LIMIT ?`,
            [limit]
        );
        
        res.json({ success: true, data: posts });
    } catch (error) {
        console.error('Ошибка получения постов:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Статистика
app.get('/api/stats', async (req, res) => {
    try {
        const stats = await dbGet(`
            SELECT 
                (SELECT COUNT(*) FROM threads) as total_threads,
                (SELECT COUNT(*) FROM posts) as total_posts,
                (SELECT COUNT(*) FROM boards) as total_boards
        `);
        
        res.json({ success: true, data: stats });
    } catch (error) {
        console.error('Ошибка получения статистики:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Скачать backup базы данных
app.get('/api/backup', (req, res) => {
    if (NODE_ENV === 'production') {
        // В продакшене нужно добавить авторизацию
        return res.status(403).json({ error: 'Доступ запрещен' });
    }
    
    if (fs.existsSync(DB_PATH)) {
        res.download(DB_PATH, '14chanykt-backup.db');
    } else {
        res.status(404).json({ error: 'База данных не найдена' });
    }
});

// Health check для Render
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        environment: NODE_ENV 
    });
});

// SPA fallback (для клиентской маршрутизации)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`
    🚀 14chanykt запущен!
    📍 Порт: ${PORT}
    🎭 Режим: ${NODE_ENV}
    💾 База данных: ${DB_PATH}
    🌐 Ссылка: http://localhost:${PORT}
    `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM получен. Закрываем соединения...');
    db.close();
    process.exit(0);
});
