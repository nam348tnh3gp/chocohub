const crypto = require('crypto');

const MODP2048_PRIME_HEX =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1' +
  '29024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245' +
  'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D' +
  'C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F' +
  '83655D23DCA3AD961C62F356208552BB9ED529077096966D' +
  '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9' +
  'DE2BCBF6955817183995497CEA956AE515D2261898FA0510' +
  '15728E5A8AACAA68FFFFFFFFFFFFFFFF';

const MODP2048_PRIME = Buffer.from(MODP2048_PRIME_HEX, 'hex');
const MODP2048_GENERATOR = Buffer.from([2]);

const MODP2048_PRIME_B64 = MODP2048_PRIME.toString('base64');
const MODP2048_GENERATOR_B64 = MODP2048_GENERATOR.toString('base64');
const MODP2048_PRIME_LEN = MODP2048_PRIME.length;   // 256 bytes

class DHExchange {
  /**
   * Create a DH key pair from the standard group (recommended: 'modp2048').
   * @param {string} groupName - 'modp2048'
   * @returns {{ privateKey: string, publicKey: string, prime: string, generator: string, group: string }}
   */
  static generateStandardKeyPair(groupName = 'modp2048') {
    const dh = crypto.createDiffieHellman(MODP2048_PRIME, MODP2048_GENERATOR);
    dh.generateKeys();
    return {
      privateKey: dh.getPrivateKey('base64'),
      publicKey: dh.getPublicKey('base64'),
      prime: MODP2048_PRIME_B64,
      generator: MODP2048_GENERATOR_B64,
      group: groupName
    };
  }

  /**
   * Generate a 2048-bit DH key pair. Kept for compatibility and forwards to the standard helper.
   */
  static generateKeyPair() {
    return DHExchange.generateStandardKeyPair('modp2048');
  }

  /**
   * Compute the shared secret from our private key and the peer public key.
   * Pad the peer public key automatically when needed.
   */
  static computeSharedSecret(ourPrivateKey, theirPublicKey, prime, generator) {
    const primeBuf = Buffer.from(prime, 'base64');
    const generatorBuf = Buffer.from(generator, 'base64');
    const primeLen = primeBuf.length;   // 256 bytes cho modp2048

    const dh = crypto.createDiffieHellman(primeBuf, generatorBuf);
    dh.setPrivateKey(Buffer.from(ourPrivateKey, 'base64'));
    let theirPub = Buffer.from(theirPublicKey, 'base64');
    if (theirPub.length < primeLen) {
      const padded = Buffer.alloc(primeLen, 0);
      theirPub.copy(padded, primeLen - theirPub.length);
      theirPub = padded;
    }

    const secret = dh.computeSecret(theirPub);
    return secret.toString('base64');
  }

  /**
   * Dẫn xuất session key từ shared secret (SHA‑256).
   */
  static deriveSessionKey(sharedSecret) {
    return crypto.createHash('sha256')
      .update(sharedSecret)
      .digest('base64');
  }

  /**
   * Create an HMAC-SHA256 signature for a message.
   */
  static sign(message, sessionKey) {
    return crypto.createHmac('sha256', Buffer.from(sessionKey, 'base64'))
      .update(message)
      .digest('hex');
  }

  /**
   * Verify an HMAC signature with a constant-time comparison.
   */
  static verify(message, signature, sessionKey) {
    const expected = DHExchange.sign(message, sessionKey);
    try {
      return crypto.timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(signature, 'hex')
      );
    } catch {
      return false;
    }
  }

  /**
   * Sign data with an RSA private key (PEM).
   * @param {string} data - Data to sign (JSON string)
   * @param {string} privateKeyPem - Private key PEM
   * @returns {string} chữ ký base64
   */
  static signWithPrivateKey(data, privateKeyPem) {
    const sign = crypto.createSign('SHA256');
    sign.update(data);
    sign.end();
    return sign.sign(privateKeyPem, 'base64');
  }

  /**
   * Verify a signature with an RSA public key (PEM).
   * @param {string} data - Signed data
   * @param {string} signature - Base64 signature
   * @param {string} publicKeyPem - Public key PEM
   * @returns {boolean}
   */
  static verifyWithPublicKey(data, signature, publicKeyPem) {
    const verify = crypto.createVerify('SHA256');
    verify.update(data);
    verify.end();
    return verify.verify(publicKeyPem, signature, 'base64');
  }
}

module.exports = DHExchange;
