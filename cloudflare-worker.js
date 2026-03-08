/**
 * Cloudflare Email Worker
 * Parses raw MIME mail and forwards the extracted payload to the app webhook.
 */

export default {
  async email(message, env) {
    const webhookUrl = env.WEBHOOK_URL;

    try {
      if (!webhookUrl) {
        throw new Error('Missing WEBHOOK_URL environment variable');
      }

      const rawEmail = await readRawEmail(message.raw);
      const parsed = parseEmail(rawEmail);

      const payload = {
        to: normalizeAddress(message.to),
        from: normalizeAddress(message.from),
        from_name: parsed.from || message.headers.get('from') || message.from || '',
        subject: parsed.subject || message.headers.get('subject') || '(No Subject)',
        text: parsed.text || '',
        html: parsed.html || ''
      };

      console.log('Forwarding email', JSON.stringify({
        to: payload.to,
        from: payload.from,
        subject: payload.subject,
        textLength: payload.text.length,
        htmlLength: payload.html.length
      }));

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const responseText = await response.text();
        console.error('Webhook failed', response.status, responseText);
      }
    } catch (error) {
      console.error('Email processing failed:', error.message);
      console.error(error.stack);
    }
  }
};

async function readRawEmail(stream) {
  const reader = stream.getReader();
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder('latin1').decode(merged);
}

function parseEmail(rawEmail) {
  const rootPart = parsePart(rawEmail);
  const collected = collectBodies(rootPart);

  return {
    subject: decodeMimeHeader(rootPart.headers.subject || ''),
    from: decodeMimeHeader(rootPart.headers.from || ''),
    text: cleanupContent(collected.text),
    html: cleanupContent(collected.html)
  };
}

function parsePart(rawPart) {
  const separatorIndex = findHeaderSeparator(rawPart);
  const headerText = separatorIndex >= 0 ? rawPart.slice(0, separatorIndex) : rawPart;
  const bodyText = separatorIndex >= 0 ? rawPart.slice(separatorIndex).replace(/^\r?\n\r?\n/, '') : '';
  const headers = parseHeaders(headerText);
  const contentType = parseContentType(headers['content-type']);

  if (contentType.type.startsWith('multipart/')) {
    return {
      headers,
      parts: splitMultipartBody(bodyText, contentType.boundary).map(parsePart)
    };
  }

  return {
    headers,
    contentType,
    body: decodeBody(bodyText, headers['content-transfer-encoding'], contentType.charset)
  };
}

function findHeaderSeparator(value) {
  const crlf = value.indexOf('\r\n\r\n');
  if (crlf >= 0) {
    return crlf + 4;
  }

  const lf = value.indexOf('\n\n');
  if (lf >= 0) {
    return lf + 2;
  }

  return -1;
}

function parseHeaders(headerText) {
  const headers = {};
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, ' ');

  for (const line of unfolded.split(/\r?\n/)) {
    const colonIndex = line.indexOf(':');
    if (colonIndex < 0) {
      continue;
    }

    const key = line.slice(0, colonIndex).trim().toLowerCase();
    const value = line.slice(colonIndex + 1).trim();
    headers[key] = value;
  }

  return headers;
}

function parseContentType(contentTypeHeader = 'text/plain; charset=utf-8') {
  const [typePart, ...paramParts] = contentTypeHeader.split(';');
  const params = {};

  for (const paramPart of paramParts) {
    const [rawKey, ...rawValue] = paramPart.split('=');
    if (!rawKey || rawValue.length === 0) {
      continue;
    }

    params[rawKey.trim().toLowerCase()] = rawValue.join('=').trim().replace(/^"|"$/g, '');
  }

  return {
    type: typePart.trim().toLowerCase(),
    charset: params.charset || 'utf-8',
    boundary: params.boundary || ''
  };
}

function splitMultipartBody(bodyText, boundary) {
  if (!boundary) {
    return [];
  }

  const normalized = bodyText.replace(/\r\n/g, '\n');
  const marker = `--${boundary}`;
  const closingMarker = `--${boundary}--`;
  const parts = [];
  let current = [];
  let insidePart = false;

  for (const line of normalized.split('\n')) {
    if (line === marker || line === closingMarker) {
      if (insidePart && current.length > 0) {
        parts.push(current.join('\n').replace(/^\n+|\n+$/g, ''));
        current = [];
      }

      insidePart = line !== closingMarker;
      continue;
    }

    if (insidePart) {
      current.push(line);
    }
  }

  if (insidePart && current.length > 0) {
    parts.push(current.join('\n').replace(/^\n+|\n+$/g, ''));
  }

  return parts;
}

function decodeBody(bodyText, transferEncoding = '', charset = 'utf-8') {
  const encoding = transferEncoding.trim().toLowerCase();
  let bytes;

  if (encoding === 'base64') {
    bytes = decodeBase64(bodyText);
  } else if (encoding === 'quoted-printable') {
    bytes = quotedPrintableToBytes(bodyText);
  } else {
    bytes = latin1StringToBytes(bodyText);
  }

  return decodeBytes(bytes, charset);
}

function decodeBase64(value) {
  const normalized = value.replace(/\s+/g, '');
  if (!normalized) {
    return new Uint8Array();
  }

  const binary = atob(normalized);
  return latin1StringToBytes(binary);
}

function quotedPrintableToBytes(value) {
  const normalized = value.replace(/=\r?\n/g, '');
  const bytes = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(normalized.slice(index + 1, index + 3))) {
      bytes.push(parseInt(normalized.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }

    bytes.push(normalized.charCodeAt(index) & 0xff);
  }

  return new Uint8Array(bytes);
}

function latin1StringToBytes(value) {
  const bytes = new Uint8Array(value.length);

  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }

  return bytes;
}

function decodeBytes(bytes, charset) {
  const normalizedCharset = normalizeCharset(charset);

  try {
    return new TextDecoder(normalizedCharset, { fatal: false }).decode(bytes);
  } catch (error) {
    console.warn(`Unsupported charset "${charset}", fallback to utf-8`);
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function normalizeCharset(charset = 'utf-8') {
  const normalized = charset.trim().toLowerCase();

  if (normalized === 'gb2312' || normalized === 'gbk') {
    return 'gb18030';
  }

  return normalized || 'utf-8';
}

function collectBodies(part) {
  if (part.parts) {
    const merged = { text: '', html: '' };

    for (const child of part.parts) {
      const current = collectBodies(child);
      if (!merged.text && current.text) {
        merged.text = current.text;
      }
      if (!merged.html && current.html) {
        merged.html = current.html;
      }
    }

    return merged;
  }

  if (!part.contentType) {
    return { text: '', html: '' };
  }

  if (part.contentType.type === 'text/plain') {
    return { text: part.body, html: '' };
  }

  if (part.contentType.type === 'text/html') {
    return { text: '', html: part.body };
  }

  return { text: '', html: '' };
}

function cleanupContent(value = '') {
  return value.replace(/\0/g, '').trim();
}

function decodeMimeHeader(value) {
  if (!value) {
    return '';
  }

  return value.replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_, charset, encoding, content) => {
    const upperEncoding = encoding.toUpperCase();

    if (upperEncoding === 'B') {
      return decodeBytes(decodeBase64(content), charset);
    }

    return decodeBytes(
      quotedPrintableToBytes(content.replace(/_/g, ' ')),
      charset
    );
  });
}

function normalizeAddress(value = '') {
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1] : value).trim();
}
