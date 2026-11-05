// Recibe el aviso automático de Bold cuando un pago se aprueba (webhook).
// Esto es lo que soluciona el problema de "pagó pero el pedido no llegó":
// en vez de depender de que la persona marque "Ya realicé el pago" y haga
// clic en "Confirmar pedido", Bold nos avisa DIRECTAMENTE a este número cuando
// el cobro con tarjeta quedó aprobado, sin importar si la persona cerró la
// página, se le fue el internet, o lo que sea.
//
// Configuración necesaria en Netlify (Site settings > Environment variables),
// la misma llave que ya usas para bold-signature.js:
//   BOLD_SECRET_KEY = tu llave secreta del Botón de Pagos
//
// Configuración necesaria en Bold (Panel de Comercios > Integraciones >
// Webhooks): registrar esta URL como endpoint:
//   https://mickysandwichespedidoss.netlify.app/.netlify/functions/bold-webhook

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const GOOGLE_FORM_PREFILLED_LINK = "https://docs.google.com/forms/d/e/1FAIpQLSe7u36WS4to1_n9ZpP8XMeY9rT16vGZWLHGWsxXnWnqG2KmZQ/viewform?usp=pp_url&entry.136841471=NOMBRE&entry.196653551=TELEFONO&entry.281882894=DIRECCION&entry.1236839348=APARTAMENTO&entry.1918853519=PEDIDO&entry.1139703571=TOTAL&entry.1639098525=DIA&entry.1625365024=NOTA&entry.1155850296=FECHA";
const EMAIL_NOTIFICACIONES = "juanpabloandradea2@gmail.com";

function fmt(valor) {
  const n = Number(valor) || 0;
  return '$' + n.toLocaleString('es-CO');
}

function parseGoogleFormLink(link) {
  if (!link) return null;
  try {
    const url = new URL(link);
    const formActionUrl = url.origin + url.pathname.replace('/viewform', '/formResponse');
    const entryMap = {};
    url.searchParams.forEach((value, key) => {
      if (key.startsWith('entry.')) entryMap[value.trim().toUpperCase()] = key;
    });
    return { formActionUrl, entryMap };
  } catch (e) {
    console.error('Link de Google Form inválido:', e);
    return null;
  }
}

async function enviarAGoogleForm(pedido) {
  const config = parseGoogleFormLink(GOOGLE_FORM_PREFILLED_LINK);
  if (!config) return false;
  const { formActionUrl, entryMap } = config;
  const notaFinal = entryMap.DIA ? (pedido.nota || '') : (`Día: ${pedido.dia}` + (pedido.nota ? ` | ${pedido.nota}` : ''));
  const notaConApto = entryMap.APARTAMENTO ? notaFinal : (notaFinal + (pedido.apartamento ? ` | Apto: ${pedido.apartamento}` : ''));
  const datos = {
    NOMBRE: pedido.nombre, TELEFONO: pedido.telefono, DIRECCION: pedido.direccion,
    APARTAMENTO: pedido.apartamento || '', PEDIDO: pedido.items, TOTAL: String(pedido.total),
    DIA: pedido.dia, NOTA: notaConApto, FECHA: pedido.fecha
  };
  try {
    const params = new URLSearchParams();
    Object.keys(datos).forEach(campo => {
      if (entryMap[campo]) params.append(entryMap[campo], datos[campo]);
    });
    const res = await fetch(formActionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    // Google Forms responde 200 incluso en modo no-cors desde el navegador;
    // desde el servidor sí podemos leer el status real.
    return res.status < 400;
  } catch (e) {
    console.error('Error enviando a Google Form desde el webhook:', e);
    return false;
  }
}

async function enviarCorreo(asunto, campos) {
  if (!EMAIL_NOTIFICACIONES) return false;
  try {
    const res = await fetch(`https://formsubmit.co/ajax/${EMAIL_NOTIFICACIONES}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ _subject: asunto, ...campos })
    });
    return res.ok;
  } catch (e) {
    console.error('Error enviando correo desde el webhook:', e);
    return false;
  }
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  const secretKey = process.env.BOLD_SECRET_KEY;
  if (!secretKey) {
    console.error('Falta configurar BOLD_SECRET_KEY en Netlify — no se puede verificar el webhook de Bold');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'No configurado' }) };
  }

  // --- 1) Verificar que el aviso REALMENTE viene de Bold ---
  // Bold firma así: Base64(cuerpo crudo) -> HMAC-SHA256 con la llave secreta -> hex.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64')
    : Buffer.from(event.body || '', 'utf8');

  const firmaRecibida = event.headers && (event.headers['x-bold-signature'] || event.headers['X-Bold-Signature']);
  const bodyBase64 = rawBody.toString('base64');
  const firmaEsperada = crypto.createHmac('sha256', secretKey).update(bodyBase64).digest('hex');

  let firmaValida = false;
  try {
    firmaValida = !!firmaRecibida &&
      firmaRecibida.length === firmaEsperada.length &&
      crypto.timingSafeEqual(Buffer.from(firmaRecibida, 'hex'), Buffer.from(firmaEsperada, 'hex'));
  } catch (e) {
    firmaValida = false;
  }

  if (!firmaValida) {
    console.error('Webhook de Bold con firma inválida — se ignora por seguridad');
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Firma inválida' }) };
  }

  // --- 2) Leer el aviso ---
  let evento;
  try {
    evento = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON inválido' }) };
  }

  const tipo = evento.type;
  const paymentId = evento?.data?.payment_id || evento?.subject || null;
  const orderId = evento?.data?.metadata?.reference || null;
  const montoTotal = evento?.data?.amount?.total || null;

  // Solo nos interesa actuar cuando el pago quedó APROBADO.
  if (tipo !== 'SALE_APPROVED') {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ignorado: tipo }) };
  }

  const store = getStore('pedidos-bold');
  let registro = null;
  if (orderId) {
    try {
      registro = await store.get(orderId, { type: 'json' });
    } catch (e) {
      console.error('Error leyendo el respaldo del pedido en Blobs:', e);
    }
  }

  // Si ya procesamos este pago antes (Bold puede reenviar el mismo aviso
  // varias veces), no volvemos a mandar la notificación duplicada.
  if (registro && registro.estado === 'pago_confirmado') {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, duplicado: true }) };
  }

  // Marcamos como confirmado ANTES de enviar, para evitar carreras si Bold
  // reenvía el mismo aviso casi al mismo tiempo.
  if (orderId) {
    try {
      await store.setJSON(orderId, {
        ...(registro || {}),
        orderId,
        estado: 'pago_confirmado',
        paymentId,
        confirmadoEn: new Date().toISOString()
      });
    } catch (e) {
      console.error('Error marcando el pedido como confirmado en Blobs:', e);
    }
  }

  const pedido = registro && registro.pedido;

  if (pedido) {
    // Tenemos los datos completos del pedido (nombre, dirección, qué pidió, etc.)
    const notaConBold = (pedido.nota ? `${pedido.nota} | ` : '') + `Pago Bold confirmado automáticamente (orden ${orderId})`;
    enviarAGoogleForm({ ...pedido, nota: notaConBold }).catch(() => {});
    await enviarCorreo(`✅ PAGO CONFIRMADO (Bold) - ${pedido.nombre}`, {
      Aviso: 'Este pedido se confirma automáticamente porque Bold avisó que el pago con tarjeta fue aprobado. Si el cliente también marcó "Ya realicé el pago" en la página, puede que llegue un segundo correo igual — es el mismo pedido, no hay que preparar dos.',
      Nombre: pedido.nombre,
      Telefono: pedido.telefono,
      Direccion: pedido.direccion,
      Dia: pedido.dia,
      Pedido: pedido.items,
      Total: fmt(pedido.total),
      Nota: pedido.nota || '(sin nota)',
      'Orden Bold': orderId,
      'ID de pago Bold': paymentId || '(no disponible)'
    });
  } else {
    // Red de seguridad mínima: no tenemos los datos del pedido guardados
    // (por ejemplo, si bold-signature.js no alcanzó a guardarlos), pero
    // igual avisamos que llegó un pago para que nadie se quede sin saber.
    await enviarCorreo('⚠️ Pago de Bold recibido SIN datos del pedido', {
      Aviso: 'Bold confirmó un pago pero no encontramos los datos del pedido asociados (nombre, dirección, qué pidió). Puede que el cliente haya recargado la página varias veces antes de pagar. Revisa el panel de Bold con el ID de pago para ubicar el pago y contactar al cliente si es necesario.',
      'Orden Bold': orderId || '(no disponible)',
      'ID de pago Bold': paymentId || '(no disponible)',
      Monto: montoTotal ? fmt(montoTotal) : '(no disponible)'
    });
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
