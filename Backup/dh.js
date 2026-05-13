// dh.js – Diffie‑Hellman (RFC 5114 modp2048) + RSA server authentication
const crypto = require('crypto');

// ─── Nhóm DH chuẩn (RFC 5114 modp2048) ──────────────────
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
   * Tạo cặp khóa DH từ nhóm chuẩn (khuyến nghị: 'modp2048').
   * @param {string} groupName – 'modp2048'
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
   * Sinh cặp khóa DH (2048‑bit) – giữ lại để tương thích, gọi hàm chuẩn.
   */
  static generateKeyPair() {
    return DHExchange.generateStandardKeyPair('modp2048');
  }

  /**
   * Tính shared secret từ private key của mình và public key của đối tác.
   * Tự động đệm public key nếu cần thiết.
   */
  static computeSharedSecret(ourPrivateKey, theirPublicKey, prime, generator) {
    const primeBuf = Buffer.from(prime, 'base64');
    const generatorBuf = Buffer.from(generator, 'base64');
    const primeLen = primeBuf.length;   // 256 bytes cho modp2048

    const dh = crypto.createDiffieHellman(primeBuf, generatorBuf);
    dh.setPrivateKey(Buffer.from(ourPrivateKey, 'base64'));

    // Xử lý public key của đối tác: đệm cho đủ primeLen nếu bị thiếu
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
   * Tạo chữ ký HMAC‑SHA256 cho thông điệp.
   */
  static sign(message, sessionKey) {
    return crypto.createHmac('sha256', Buffer.from(sessionKey, 'base64'))
      .update(message)
      .digest('hex');
  }

  /**
   * Xác minh chữ ký HMAC (so sánh an toàn).
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
   * Ký dữ liệu bằng RSA private key (PEM).
   * @param {string} data – dữ liệu cần ký (JSON string)
   * @param {string} privateKeyPem – private key PEM
   * @returns {string} chữ ký base64
   */
  static signWithPrivateKey(data, privateKeyPem) {
    const sign = crypto.createSign('SHA256');
    sign.update(data);
    sign.end();
    return sign.sign(privateKeyPem, 'base64');
  }

  /**
   * Xác minh chữ ký bằng RSA public key (PEM).
   * @param {string} data – dữ liệu đã ký
   * @param {string} signature – chữ ký base64
   * @param {string} publicKeyPem – public key PEM
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
