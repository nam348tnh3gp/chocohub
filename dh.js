// dh.js – Diffie-Hellman key exchange & session utilities
const crypto = require('crypto');

class DHExchange {
  /**
   * Sinh cặp khóa DH (2048-bit) + prime/generator.
   * @returns {{ privateKey: string, publicKey: string, prime: string, generator: string }} base64
   */
  static generateKeyPair() {
    const dh = crypto.createDiffieHellman(2048);
    dh.generateKeys();
    return {
      privateKey: dh.getPrivateKey('base64'),
      publicKey: dh.getPublicKey('base64'),
      prime: dh.getPrime('base64'),
      generator: dh.getGenerator('base64')
    };
  }

  /**
   * Tính shared secret từ private key của mình và public key của đối tác.
   * @param {string} ourPrivateKey base64
   * @param {string} theirPublicKey base64
   * @param {string} prime base64
   * @param {string} generator base64
   * @returns {string} shared secret base64
   */
  static computeSharedSecret(ourPrivateKey, theirPublicKey, prime, generator) {
    const dh = crypto.createDiffieHellman(
      Buffer.from(prime, 'base64'),
      Buffer.from(generator, 'base64')
    );
    dh.setPrivateKey(Buffer.from(ourPrivateKey, 'base64'));
    const secret = dh.computeSecret(Buffer.from(theirPublicKey, 'base64'));
    return secret.toString('base64');
  }

  /**
   * Dẫn xuất session key từ shared secret (SHA-256).
   * @param {string} sharedSecret base64
   * @returns {string} session key base64 (44 ký tự)
   */
  static deriveSessionKey(sharedSecret) {
    return crypto.createHash('sha256').update(sharedSecret).digest('base64');
  }

  /**
   * Tạo chữ ký HMAC-SHA256 cho thông điệp.
   * @param {string} message nội dung cần ký
   * @param {string} sessionKey base64
   * @returns {string} hex signature
   */
  static sign(message, sessionKey) {
    return crypto.createHmac('sha256', Buffer.from(sessionKey, 'base64'))
      .update(message)
      .digest('hex');
  }

  /**
   * Xác minh chữ ký HMAC (so sánh an toàn).
   * @param {string} message
   * @param {string} signature hex
   * @param {string} sessionKey base64
   * @returns {boolean}
   */
  static verify(message, signature, sessionKey) {
    const expected = DHExchange.sign(message, sessionKey);
    try {
      return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
    } catch {
      return false;
    }
  }
}

module.exports = DHExchange;
