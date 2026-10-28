// Genera la firma de integridad que Bold necesita para cobrar el monto EXACTO
// del carrito. La llave secreta nunca viaja al navegador: solo vive aquí,
// en el servidor, leída desde la variable de entorno BOLD_SECRET_KEY que
// configuras en Netlify (Site settings > Environment variables).

const crypto = require('crypto');

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

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ orderId, amount, currency, signature })
  };
};
