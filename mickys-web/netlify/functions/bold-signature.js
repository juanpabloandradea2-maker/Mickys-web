// Genera la firma de integridad que Bold necesita para cobrar el monto EXACTO
// del carrito. La llave secreta nunca viaja al navegador: solo vive aquí,
// en el servidor, leída desde la variable de entorno BOLD_SECRET_KEY que
// configuras en Netlify (Site settings > Environment variables).
//
// Además, desde aquí guardamos una "copia de seguridad" del pedido (nombre,
// teléfono, dirección, qué pidió, etc.) ANTES de que la persona pague, usando
// Netlify Blobs. Así, cuando llegue la confirmación de pago (bold-webhook.js),
// sabemos exactamente qué pedido corresponde a ese pago y lo podemos enviar
// aunque la persona nunca vuelva a la página ni marque "Ya realicé el pago".

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  // CORS básico, por si alguna vez se llama desde otro origen
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON inválido' }) };
  }

  const amount = Math.round(Number(payload.amount));
  if (!Number.isFinite(amount) || amount < 1000) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Monto inválido (mínimo 1000 COP)' }) };
  }

  const secretKey = process.env.BOLD_SECRET_KEY;
  if (!secretKey) {
    console.error('Falta configurar la variable de entorno BOLD_SECRET_KEY en Netlify');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Pago en línea no configurado' }) };
  }

  const currency = 'COP';
  const orderId = `MICKYS-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  // Firma = SHA-256( orderId + amount + currency + llaveSecreta )
  const raw = `${orderId}${amount}${currency}${secretKey}`;
  const signature = crypto.createHash('sha256').update(raw).digest('hex');

  // Guardamos los datos del pedido (si vienen) para poder recuperarlos cuando
  // llegue la confirmación de pago de Bold. Si esto falla por cualquier razón,
  // NO bloqueamos el pago — el cliente igual puede pagar, solo que no tendremos
  // la red de seguridad automática para ESE pedido en particular.
  try {
    const store = getStore('pedidos-bold');
    await store.setJSON(orderId, {
      orderId,
      amount,
      currency,
      pedido: payload.pedido || null,
      estado: 'pendiente_de_pago',
      creadoEn: new Date().toISOString()
    });
  } catch (e) {
    console.error('No se pudo guardar el respaldo del pedido en Netlify Blobs:', e);
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ orderId, amount, currency, signature })
  };
};
