const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const bcrypt = require('bcrypt');
const fs = require('fs').promises;
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error("ГРЕШКА: JWT_SECRET не е дефиниран в .env файла!");
    process.exit(1);
}
const JWT_EXPIRES_IN = '1h';
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const SALT_ROUNDS = 10;

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.ndjson');
const SESSION_LOG_DIR = path.join(DATA_DIR, 'session_logs');
let currentSessionLogPath = '';

const pendingUsers = {};
let confirmedUsers = {};

const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT || "587"),
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

transporter.verify((error, success) => {
    if (error) {
        console.error("Грешка при конфигуриране на Nodemailer:", error);
    } else {
        console.log("Nodemailer е готов да изпраща имейли.");
    }
});

async function loadUsers() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        const data = await fs.readFile(USERS_FILE, 'utf8');
        const lines = data.split('\n');
        const users = {};
        lines.forEach(line => {
            if (line.trim()) {
                try {
                    const user = JSON.parse(line);
                    if (user && user.email) {
                        users[user.email] = user;
                    }
                } catch (parseError) {
                    console.error(`Грешка при парсване на ред от ${USERS_FILE}:`, line, parseError);
                }
            }
        });
        console.log(`Заредени ${Object.keys(users).length} потребители от ${USERS_FILE}`);
        return users;
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`${USERS_FILE} не е намерен, започваме с празен списък.`);
            return {};
        } else {
            console.error(`Грешка при зареждане на потребители от ${USERS_FILE}:`, error);
            return {};
        }
    }
}

async function saveUserToFile(user) {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        const userLine = JSON.stringify(user) + '\n';
        await fs.appendFile(USERS_FILE, userLine, 'utf8');
        console.log(`Потребител ${user.email} записан във ${USERS_FILE}`);
    } catch (error) {
        console.error(`Грешка при запис на потребител ${user.email} във ${USERS_FILE}:`, error);
    }
}

async function logSessionActivity(logEntry) {
    if (!currentSessionLogPath) {
        console.error("Грешка: Пътят до лог файла на текущата сесия не е инициализиран.");
        return;
    }
    try {
        await fs.mkdir(SESSION_LOG_DIR, { recursive: true });
        const logLine = JSON.stringify(logEntry) + '\n';
        await fs.appendFile(currentSessionLogPath, logLine, 'utf8');
    } catch (error) {
        console.error(`Грешка при запис в лог файла ${currentSessionLogPath}:`, error);
    }
}

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'client')));

function isValidEmail(email) {
    const regex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return typeof email === 'string' && regex.test(email);
}
function isValidPhone(phone) {
    const regex = /^(\+359|0)8[7-9][0-9]{7}$/;
    return typeof phone === 'string' && regex.test(phone);
}
function isValidPassword(password) {
    if (typeof password !== 'string' || password.length < 8) return false;
    if (!/[A-Z]/.test(password)) return false;
    if (!/[0-9]/.test(password)) return false;
    return true;
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'client', 'index.html'));
});

app.post('/register', async (req, res) => {
    const { email, phone, password, confirm_password } = req.body;

    if (!isValidEmail(email)) return res.status(400).json({ status: 'error', message: 'Невалиден имейл адрес.' });
    if (!isValidPhone(phone)) return res.status(400).json({ status: 'error', message: 'Невалиден телефонен номер.' });
    if (password !== confirm_password) return res.status(400).json({ status: 'error', message: 'Паролите не съвпадат.' });
    if (!isValidPassword(password)) return res.status(400).json({ status: 'error', message: 'Паролата не отговаря на изискванията.' });
    if (confirmedUsers[email] || pendingUsers[email]) {
        return res.status(409).json({ status: 'error', message: 'Потребител с този имейл вече съществува.' });
    }

    const userId = crypto.randomUUID();
    const tokenPayload = { email: email };
    const confirmationToken = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    const confirmationUrl = `${APP_BASE_URL}/confirm/${confirmationToken}`;
    const mailOptions = {
        from: process.env.EMAIL_FROM,
        to: email,
        subject: 'Потвърдете регистрацията си',
        text: `Здравейте, моля последвайте този линк, за да потвърдите регистрацията си: ${confirmationUrl}`,
        html: `
            <p>Здравейте,</p>
            <p>Благодарим Ви за регистрацията! Моля, кликнете на линка по-долу, за да потвърдите имейл адреса си:</p>
            <p><a href="${confirmationUrl}" style="padding: 10px 15px; background-color: #007bff; color: white; text-decoration: none; border-radius: 4px;">Потвърди имейл</a></p>
            <p>Ако бутонът не работи, копирайте и поставете следния адрес в браузъра си:</p>
            <p>${confirmationUrl}</p>
            <p>Линкът е валиден 1 час.</p>
        `
    };

    try {
        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
        await transporter.sendMail(mailOptions);
        console.log(`Имейл за потвърждение изпратен до ${email}`);

        pendingUsers[email] = {
            id: userId, phone: phone, passwordHash: hashedPassword, token: confirmationToken
        };
        console.log("Чакащи потребители:", pendingUsers);

        return res.status(200).json({ status: 'info', message: `Регистрацията е почти готова! Изпратихме линк за потвърждение на ${email}. Моля, проверете пощата си.` });

    } catch (error) {
        if (error.message && error.message.includes('bcrypt')) {
            console.error(`Грешка при хеширане на парола за ${email}:`, error);
            return res.status(500).json({ status: 'error', message: 'Възникна вътрешна грешка при регистрацията.' });
        } else {
            console.error(`Грешка при изпращане на имейл до ${email}:`, error);
            return res.status(500).json({ status: 'error', message: 'Възникна грешка при изпращане на имейл за потвърждение.' });
        }
    }
});

app.get('/confirm/:token', async (req, res) => {
    const { token } = req.params;
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const email = decoded.email;

        if (pendingUsers[email]) {
            const userData = pendingUsers[email];
            const confirmedUserData = {
                id: userData.id,
                email: email,
                phone: userData.phone,
                passwordHash: userData.passwordHash
            };

            confirmedUsers[email] = confirmedUserData;
            delete pendingUsers[email];

            console.log(`Потребител ${email} потвърди имейла си.`);
            console.log("Потвърдени:", confirmedUsers);
            console.log("Чакащи:", pendingUsers);

            await saveUserToFile(confirmedUserData);

            const logEntry = {
                timestamp: new Date().toISOString(),
                email: email,
                action: 'registration_confirmed'
            };
            await logSessionActivity(logEntry);

            res.send(`
                <!DOCTYPE html>
                <html lang="bg">
                <head>
                    <meta charset="UTF-8">
                    <title>Потвърждение Успешно</title>
                    <style>
                        body { font-family: sans-serif; background-color: #f0f9f4; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
                        .container { background-color: #d4edda; color: #155724; border: 1px solid #c3e6cb; border-radius: 8px; padding: 30px; text-align: center; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                        h1 { margin-top: 0; color: #0f5132; }
                        p { margin-bottom: 10px; }
                        a { color: #0a58ca; text-decoration: none; }
                        a:hover { text-decoration: underline; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>Имейлът е Потвърден!</h1>
                        <p>Вашият имейл адрес (<strong>${email}</strong>) беше успешно потвърден.</p>
                        <p>Вече можете да затворите този прозорец или да <a href="/">влезете в системата</a>.</p>
                    </div>
                </body>
                </html>
            `);

        } else if (confirmedUsers[email]) {
            res.send(`
                <!DOCTYPE html>
                <html lang="bg">
                <head>
                    <meta charset="UTF-8">
                    <title>Имейл Вече Потвърден</title>
                    <style>
                        body { font-family: sans-serif; background-color: #f8f9fa; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
                        .container { background-color: #e2e3e5; color: #41464b; border: 1px solid #d3d6d8; border-radius: 8px; padding: 30px; text-align: center; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                        h1 { margin-top: 0; color: #0a58ca; }
                        p { margin-bottom: 10px; }
                        a { color: #0a58ca; text-decoration: none; }
                        a:hover { text-decoration: underline; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>Имейлът Вече е Потвърден</h1>
                        <p>Този имейл адрес (<strong>${email}</strong>) вече е бил потвърден преди.</p>
                        <p>Можете да затворите този прозорец или да <a href="/">влезете директно</a>.</p>
                    </div>
                </body>
                </html>
            `);
        } else {
            const errorMessage = "Невалиден или вече използван линк за потвърждение.";
            res.status(400).send(`
                <!DOCTYPE html>
                <html lang="bg">
                <head>
                    <meta charset="UTF-8">
                    <title>Грешка при Потвърждение</title>
                    <style>
                        body { font-family: sans-serif; background-color: #fef3f4; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
                        .container { background-color: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; border-radius: 8px; padding: 30px; text-align: center; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                        h1 { margin-top: 0; color: #842029; }
                        p { margin-bottom: 10px; }
                        .error-details { font-style: italic; color: #58151c; margin-top: 10px; }
                        a { color: #0a58ca; text-decoration: none; }
                        a:hover { text-decoration: underline; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>Грешка при Потвърждение</h1>
                        <p>Възникна проблем при опита за потвърждение на имейл адреса.</p>
                        <p class="error-details">Причина: ${errorMessage}</p>
                        <p>Моля, <a href="/">опитайте да се регистрирате отново</a> или се свържете с поддръжката, ако проблемът продължава.</p>
                    </div>
                </body>
                </html>
            `);
        }
    } catch (error) {
        console.error("Грешка при верифициране на токен:", error.name, error.message);
        let errorMessage = "Невалиден линк за потвърждение.";
        if (error.name === 'TokenExpiredError') {
            errorMessage = "Линкът за потвърждение е изтекъл.";
        } else if (error.name === 'JsonWebTokenError') {
            errorMessage = "Невалиден или повреден линк за потвърждение.";
        }
        res.status(400).send(`
            <!DOCTYPE html>
            <html lang="bg">
            <head>
                <meta charset="UTF-8">
                <title>Грешка при Потвърждение</title>
                <style>
                    body { font-family: sans-serif; background-color: #fef3f4; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
                    .container { background-color: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; border-radius: 8px; padding: 30px; text-align: center; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                    h1 { margin-top: 0; color: #842029; }
                    p { margin-bottom: 10px; }
                    .error-details { font-style: italic; color: #58151c; margin-top: 10px; }
                    a { color: #0a58ca; text-decoration: none; }
                    a:hover { text-decoration: underline; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Грешка при Потвърждение</h1>
                    <p>Възникна проблем при опита за потвърждение на имейл адреса.</p>
                    <p class="error-details">Причина: ${errorMessage}</p>
                    <p>Моля, <a href="/">опитайте да се регистрирате отново</a> или се свържете с поддръжката, ако проблемът продължава.</p>
                </div>
            </body>
            </html>
        `);
    }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    const user = confirmedUsers[email];
    if (!user) {
        return res.status(401).json({ message: "Грешен имейл или парола." });
    }

    try {
        const match = await bcrypt.compare(password, user.passwordHash);
        if (match) {
            console.log(`Потребител ${email} се логна успешно.`);

            const logEntry = {
                timestamp: new Date().toISOString(),
                email: email,
                action: 'login'
            };
            await logSessionActivity(logEntry);

            return res.status(200).json({ message: "Успешен логин!" });
        } else {
            return res.status(401).json({ message: "Грешен имейл или парола." });
        }
    } catch (error) {
        console.error("Грешка при сравняване на парола или запис в лог:", error);
        return res.status(500).json({ message: "Възникна вътрешна грешка." });
    }
});

(async () => {
    confirmedUsers = await loadUsers();

    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.mkdir(SESSION_LOG_DIR, { recursive: true });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const sessionLogFilename = `session_log_${timestamp}.ndjson`;
        currentSessionLogPath = path.join(SESSION_LOG_DIR, sessionLogFilename);

        await fs.writeFile(currentSessionLogPath, '', 'utf8');

        console.log(`Лог файл за текущата сесия: ${currentSessionLogPath}`);

    } catch (error) {
        console.error(`Грешка при инициализиране на лог файла за сесията:`, error);
        currentSessionLogPath = '';
    }

    app.listen(PORT, () => {
        console.log(`Сървърът работи на ${APP_BASE_URL}`);
    });
})();
