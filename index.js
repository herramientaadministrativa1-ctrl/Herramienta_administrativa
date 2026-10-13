const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const POCKETBASE_URL = process.env.POCKETBASE_URL || 'https://pocketbase-production-1467.up.railway.app';
const PB_ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL || '';
const PB_ADMIN_PASS = process.env.PB_ADMIN_PASS || '';

let pbAdminToken = null;

async function getPBAdminToken() {
    if (pbAdminToken) return pbAdminToken;
    // Intento 1: PocketBase 0.23+ (superusers)
    try {
        const r = await axios.post(`${POCKETBASE_URL}/api/collections/_superusers/auth-with-password`, {
            identity: PB_ADMIN_EMAIL,
            password: PB_ADMIN_PASS
        });
        pbAdminToken = r.data.token;
        return pbAdminToken;
    } catch (e) {
        // Intento 2: PocketBase 0.21 y anteriores (admins)
        try {
            const r = await axios.post(`${POCKETBASE_URL}/api/admins/auth-with-password`, {
                identity: PB_ADMIN_EMAIL,
                password: PB_ADMIN_PASS
            });
            pbAdminToken = r.data.token;
            return pbAdminToken;
        } catch (e2) {
            throw new Error('No se pudo autenticar como admin en PocketBase: ' + e2.message);
        }
    }
}

// ==================== RUTA: ACTUALIZAR TASA BCV ====================
app.get('/update-rate', async (req, res) => {
    try {
        let newRate = null;
        let source = '';

        // 1. Pydolarve (principal)
        try {
            const r = await axios.get('https://pydolarve.org/api/v1/dollar?page=bcv', { timeout: 10000 });
            newRate = parseFloat(r.data.price);
            if (newRate > 0) source = 'pydolarve';
        } catch (e) { console.error('pydolarve falló:', e.message); }

        // 2. DolarAPI (respaldo 1)
        if (!newRate || isNaN(newRate) || newRate <= 0) {
            try {
                const r = await axios.get('https://ve.dolarapi.com/v1/dolares/oficial', { timeout: 10000 });
                newRate = parseFloat(r.data.promedio);
                if (newRate > 0) source = 'dolarapi';
            } catch (e) { console.error('dolarapi falló:', e.message); }
        }

        // 3. bcv-api.vercel.app (respaldo 2)
        if (!newRate || isNaN(newRate) || newRate <= 0) {
            try {
                const r = await axios.get('https://bcv-api.vercel.app/v1/dollar', { timeout: 10000 });
                newRate = parseFloat((r.data.bcv && r.data.bcv.value) || r.data.value || r.data.rate);
                if (newRate > 0) source = 'bcv-api';
            } catch (e) { console.error('bcv-api falló:', e.message); }
        }

        if (!newRate || isNaN(newRate) || newRate <= 0) {
            return res.status(502).json({ success: false, error: 'No se pudo obtener la tasa de ninguna fuente.' });
        }

        // Guardar en PocketBase
        const token = await getPBAdminToken();
        const list = await axios.get(
            `${POCKETBASE_URL}/api/collections/settings/records?sort=-created&perPage=1`,
            { headers: { Authorization: token } }
        );

        if (list.data.items.length > 0) {
            const id = list.data.items[0].id;
            await axios.patch(
                `${POCKETBASE_URL}/api/collections/settings/records/${id}`,
                { exchangeRate: newRate },
                { headers: { Authorization: token } }
            );
        } else {
            await axios.post(
                `${POCKETBASE_URL}/api/collections/settings/records`,
                {
                    exchangeRate: newRate,
                    lowStockThreshold: 5,
                    businessName: 'POS Comercial',
                    termsAccepted: false
                },
                { headers: { Authorization: token } }
            );
        }

        console.log(`✅ Tasa actualizada: ${newRate} Bs/$ (fuente: ${source})`);
        res.json({ success: true, rate: newRate, source });
    } catch (e) {
        console.error('Error update-rate:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==================== WEBHOOK: RECIBIR PEDIDOS DE WHATSAPP ====================
app.post('/webhook', async (req, res) => {
    const data = req.body;
    console.log('Mensaje recibido:', JSON.stringify(data).substring(0, 300));

    if (data.evento === 'mensajes.upsert' && data.datos && data.datos.key.fromMe === false) {
        const msg = data.datos;
        const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const remitente = msg.key.remoteJid;
        const nombre = msg.pushName || 'Cliente WhatsApp';
        const telefono = remitente.split('@')[0];

        try {
            const token = await getPBAdminToken();
            await axios.post(`${POCKETBASE_URL}/api/collections/orders/records`, {
                orderNumber: 'WA-' + Date.now().toString().slice(-6),
                customerName: nombre,
                customerPhone: telefono,
                items: JSON.stringify([{ name: texto, quantity: 1, price: 0 }]),
                totalUsd: 0,
                totalBs: 0,
                method: 'efectivo',
                status: 'pendiente',
                notes: 'Pedido recibido por WhatsApp',
                date: new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' }),
                timestamp: new Date().toISOString()
            }, { headers: { Authorization: token } });
            console.log('✅ Pedido WhatsApp creado para:', nombre);
        } catch (error) {
            console.error('❌ Error al crear pedido:', error.message);
        }
    }

    res.status(200).send('OK');
});

// ==================== NOTIFICACIÓN DE DESPACHO (FRONTEND) ====================
app.post('/notify-despachado', async (req, res) => {
    // Aquí puedes integrar el envío de mensaje de WhatsApp al cliente
    console.log('Pedido despachado:', req.body.orderId);
    res.status(200).send('OK');
});

// ==================== HEALTH CHECK ====================
app.get('/', (req, res) => res.send('POS Backend activo ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});
