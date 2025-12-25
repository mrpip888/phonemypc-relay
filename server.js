// server.js - PhoneMyPC Relay Server for Render
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 5e6, // 5MB
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Lưu danh sách máy tính đang online
const computers = new Map();
// computer_id => { socket, info, lastSeen }

// Lưu danh sách client (Android) đang kết nối
const clients = new Map();
// client_id => { socket, connectedTo }

// Homepage
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>PhoneMyPC Relay Server</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: system-ui, -apple-system, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: white;
                    padding: 20px;
                }
                .container {
                    background: rgba(255,255,255,0.1);
                    backdrop-filter: blur(10px);
                    padding: 40px;
                    border-radius: 20px;
                    text-align: center;
                    max-width: 500px;
                    width: 100%;
                }
                h1 { font-size: 32px; margin-bottom: 20px; }
                .status {
                    background: #10b981;
                    padding: 10px 20px;
                    border-radius: 10px;
                    display: inline-block;
                    margin: 20px 0;
                    font-weight: 600;
                }
                .info {
                    background: rgba(0,0,0,0.2);
                    padding: 20px;
                    border-radius: 10px;
                    margin: 20px 0;
                    text-align: left;
                }
                .info-item {
                    padding: 10px 0;
                    border-bottom: 1px solid rgba(255,255,255,0.1);
                }
                .info-item:last-child { border-bottom: none; }
                .label { opacity: 0.7; font-size: 14px; }
                .value { font-size: 18px; font-weight: 600; margin-top: 5px; }
                a {
                    display: inline-block;
                    background: #3b82f6;
                    color: white;
                    padding: 12px 30px;
                    border-radius: 10px;
                    text-decoration: none;
                    margin: 10px;
                    transition: 0.2s;
                }
                a:hover { background: #2563eb; transform: scale(1.05); }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🚀 PhoneMyPC Server</h1>
                <div class="status">✅ Server đang hoạt động</div>
                
                <div class="info">
                    <div class="info-item">
                        <div class="label">Máy tính Online</div>
                        <div class="value">${computers.size}</div>
                    </div>
                    <div class="info-item">
                        <div class="label">Clients đang kết nối</div>
                        <div class="value">${clients.size}</div>
                    </div>
                    <div class="info-item">
                        <div class="label">Server URL</div>
                        <div class="value" style="font-size: 14px; word-break: break-all;">
                            ${req.protocol}://${req.get('host')}
                        </div>
                    </div>
                </div>

                <a href="/app">📱 Mở Android App</a>
                <a href="/api/computers">📊 API Computers</a>
            </div>
        </body>
        </html>
    `);
});

// API: Lấy danh sách máy tính online
app.get('/api/computers', (req, res) => {
    const list = Array.from(computers.entries()).map(([id, data]) => ({
        id,
        name: data.info.name,
        os: data.info.os,
        screen_width: data.info.screen_width,
        screen_height: data.info.screen_height,
        lastSeen: data.lastSeen,
        online: Date.now() - data.lastSeen < 30000
    }));
    
    res.json({ 
        success: true,
        count: list.length,
        computers: list 
    });
});

// API: Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        uptime: process.uptime(),
        computers: computers.size,
        clients: clients.size
    });
});

// Socket.IO Connection Handler
io.on('connection', (socket) => {
    console.log('✅ New connection:', socket.id);

    // Computer đăng ký
    socket.on('register_computer', (data) => {
        const computerId = data.computer_id || socket.id;
        computers.set(computerId, {
            socket: socket,
            info: {
                name: data.name || 'Unknown PC',
                os: data.os || 'Windows',
                screen_width: data.screen_width || 1920,
                screen_height: data.screen_height || 1080
            },
            lastSeen: Date.now()
        });
        
        socket.computerId = computerId;
        socket.emit('registered', { computer_id: computerId });
        
        console.log(`💻 Computer registered: ${computerId} - ${data.name}`);
        
        // Broadcast cập nhật danh sách
        io.emit('computers_updated', { 
            computers: Array.from(computers.keys()) 
        });
    });

    // Client (Android) kết nối đến máy tính
    socket.on('connect_to_computer', (data) => {
        const computerId = data.computer_id;
        const computer = computers.get(computerId);
        
        if (!computer) {
            socket.emit('error', { message: 'Computer not found or offline' });
            return;
        }

        clients.set(socket.id, {
            socket: socket,
            connectedTo: computerId
        });

        socket.emit('connected_to_computer', {
            computer_id: computerId,
            info: computer.info
        });

        console.log(`📱 Client ${socket.id} connected to ${computerId}`);
    });

    // Client gửi lệnh đến máy tính
    socket.on('command', (data) => {
        const client = clients.get(socket.id);
        if (!client) {
            socket.emit('error', { message: 'Not connected to any computer' });
            return;
        }

        const computer = computers.get(client.connectedTo);
        if (!computer) {
            socket.emit('error', { message: 'Computer offline' });
            return;
        }

        // Forward lệnh đến máy tính
        computer.socket.emit('command', {
            client_id: socket.id,
            command: data
        });
    });

    // Máy tính trả về kết quả
    socket.on('command_response', (data) => {
        const clientId = data.client_id;
        const client = clients.get(clientId);
        
        if (client) {
            client.socket.emit('command_response', data.response);
        }
    });

    // Heartbeat từ computer
    socket.on('heartbeat', () => {
        if (socket.computerId && computers.has(socket.computerId)) {
            computers.get(socket.computerId).lastSeen = Date.now();
        }
    });

    // Ping-pong
    socket.on('ping', () => {
        socket.emit('pong');
    });

    // Ngắt kết nối
    socket.on('disconnect', () => {
        console.log('❌ Disconnected:', socket.id);

        // Xóa computer
        if (socket.computerId) {
            computers.delete(socket.computerId);
            io.emit('computers_updated', { 
                computers: Array.from(computers.keys()) 
            });
            console.log(`💻 Computer removed: ${socket.computerId}`);
        }

        // Xóa client
        if (clients.has(socket.id)) {
            clients.delete(socket.id);
        }
    });
});

// Dọn dẹp máy tính offline (30s không heartbeat)
setInterval(() => {
    const now = Date.now();
    let removed = false;
    
    for (const [id, data] of computers.entries()) {
        if (now - data.lastSeen > 30000) {
            computers.delete(id);
            console.log(`⏰ Computer timeout: ${id}`);
            removed = true;
        }
    }
    
    if (removed) {
        io.emit('computers_updated', { 
            computers: Array.from(computers.keys()) 
        });
    }
}, 10000);

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(70));
    console.log('🚀 PhoneMyPC Relay Server Running on Render');
    console.log('='.repeat(70));
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log('='.repeat(70));
    console.log('✅ Server is ready to accept connections');
    console.log('📱 Android clients can now connect');
    console.log('💻 Windows clients can now register');
    console.log('='.repeat(70));
});