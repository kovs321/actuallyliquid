import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// Serve uploaded images
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// Multer for image uploads
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

// In-memory session store (API keys live here temporarily, never persisted)
const sessions = new Map();

// Cleanup sessions older than 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > 30 * 60 * 1000) sessions.delete(id);
  }
}, 60_000);

// ──────────────────────────────────────────────
// 1. Create PumpPortal wallet + API key
// ──────────────────────────────────────────────
app.post('/api/create-wallet', async (req, res) => {
  try {
    const ppResp = await fetch('https://pumpportal.fun/api/create-wallet');
    if (!ppResp.ok) throw new Error('PumpPortal wallet creation failed: ' + ppResp.statusText);
    const data = await ppResp.json();

    const sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    sessions.set(sessionId, {
      apiKey: data.apiKey,
      walletPublicKey: data.walletPublicKey,
      createdAt: Date.now(),
    });

    res.json({
      sessionId,
      walletPublicKey: data.walletPublicKey,
      privateKey: data.privateKey,
    });
  } catch (err) {
    console.error('create-wallet error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// 2. Upload image (saved on Railway disk)
// ──────────────────────────────────────────────
app.post('/api/upload-image', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  res.json({
    url: `${baseUrl}/uploads/${req.file.filename}`,
    filename: req.file.filename,
  });
});

// ──────────────────────────────────────────────
// 3. Launch token via PumpPortal trade API
// ──────────────────────────────────────────────
app.post('/api/launch', async (req, res) => {
  const { sessionId, name, symbol, description, twitter, telegram, website, devBuyAmount, imageFilename, userWallet } = req.body;

  if (!sessionId || !name || !symbol) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session expired or not found' });
  }

  try {
    // Step A: Upload metadata + image to pump.fun IPFS
    const formData = new FormData();
    formData.append('name', name);
    formData.append('symbol', symbol);
    formData.append('description', description || '');
    if (twitter) formData.append('twitter', twitter);
    if (telegram) formData.append('telegram', telegram);
    if (website) formData.append('website', website);
    formData.append('showName', 'true');

    // Attach image file if provided
    let imageUrl = null;
    if (imageFilename) {
      const imgPath = path.join(uploadsDir, imageFilename);
      if (fs.existsSync(imgPath)) {
        const imgBuffer = fs.readFileSync(imgPath);
        const ext = path.extname(imageFilename).slice(1) || 'png';
        const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
        const blob = new Blob([imgBuffer], { type: mimeMap[ext] || 'image/png' });
        formData.append('file', blob, imageFilename);
        const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
        imageUrl = `${baseUrl}/uploads/${imageFilename}`;
      }
    }

    const ipfsResp = await fetch('https://pump.fun/api/ipfs', { method: 'POST', body: formData });
    if (!ipfsResp.ok) throw new Error('IPFS upload failed: ' + ipfsResp.statusText);
    const ipfsData = await ipfsResp.json();

    // Grab IPFS image URL if available
    if (ipfsData.metadata?.image) {
      imageUrl = ipfsData.metadata.image;
    }

    // Step B: Generate a mint keypair
    const { Keypair } = await import('@solana/web3.js');
    const mintKeypair = Keypair.generate();

    const bs58 = (await import('bs58')).default;
    const mintSecretBase58 = bs58.encode(mintKeypair.secretKey);
    const mintAddress = mintKeypair.publicKey.toBase58();

    // Step C: Call PumpPortal trade API to create token
    const tradeBody = {
      action: 'create',
      tokenMetadata: {
        name: ipfsData.metadata?.name || name,
        symbol: ipfsData.metadata?.symbol || symbol,
        uri: ipfsData.metadataUri,
      },
      mint: mintSecretBase58,
      denominatedInSol: 'true',
      amount: devBuyAmount || 0,
      slippage: 10,
      priorityFee: 0.0005,
      pool: 'pump',
    };

    const tradeResp = await fetch(
      `https://pumpportal.fun/api/trade?api-key=${session.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tradeBody),
      }
    );

    if (!tradeResp.ok) {
      const errText = await tradeResp.text();
      throw new Error('PumpPortal trade failed: ' + errText);
    }

    const tradeData = await tradeResp.json();
    const txSignature = tradeData.signature || tradeData.tx;
    const pumpUrl = `https://pump.fun/coin/${mintAddress}`;

    // Clean up session
    sessions.delete(sessionId);

    // ── Save to database ──
    await prisma.launchedToken.create({
      data: {
        name,
        symbol,
        description: description || null,
        imageUrl,
        mintAddress,
        txSignature,
        twitter: twitter || null,
        telegram: telegram || null,
        website: website || null,
        userWallet: userWallet || session.walletPublicKey,
        pumpUrl,
      },
    });

    res.json({
      success: true,
      mintAddress,
      txSignature,
      pumpUrl,
    });
  } catch (err) {
    console.error('launch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// 4. Get all launched tokens (for homepage)
// ──────────────────────────────────────────────
app.get('/api/tokens', async (req, res) => {
  try {
    const tokens = await prisma.launchedToken.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        symbol: true,
        description: true,
        imageUrl: true,
        mintAddress: true,
        pumpUrl: true,
        userWallet: true,
        createdAt: true,
      },
    });
    res.json({ tokens });
  } catch (err) {
    console.error('tokens error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
