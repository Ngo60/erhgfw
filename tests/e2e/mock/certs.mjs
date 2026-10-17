// Self-signed TLS material for the mock servers (chatgpt.com, promts.vibecods.xyz, localhost, 127.0.0.1).
import selfsigned from 'selfsigned';

const HOURS = 3600 * 1000;

/**
 * @param {{days?: number}} [opts]
 * @returns {Promise<{key: string, cert: string}>} PEM strings usable with https.createServer()
 */
export async function makeCerts({ days = 2 } = {}) {
  // Start one hour in the past so clock skew between host and browser never invalidates the cert.
  const notBeforeDate = new Date(Date.now() - HOURS);
  const notAfterDate = new Date(notBeforeDate.getTime() + days * 24 * HOURS);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'chatgpt.com' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'chatgpt.com' },
          { type: 2, value: 'promts.vibecods.xyz' },
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
        ],
      },
    ],
  });
  return { key: pems.private, cert: pems.cert };
}
