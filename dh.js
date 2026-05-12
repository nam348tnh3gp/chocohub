// dh.js – Diffie‑Hellman (RFC 7919 groups) + RSA server authentication
const crypto = require('crypto');

class DHExchange {
  /**
   * Tạo cặp khóa DH từ nhóm chuẩn (khuyến nghị: 'modp2048', 'modp3072', 'modp4096').
   * @param {string} groupName – 'modp2048' | 'modp3072' | 'modp4096'
   * @returns {{ privateKey: string, publicKey: string, prime: string, generator: string, group: string }}
   */
  static generateStandardKeyPair(groupName = 'modp2048') {
    const dh = crypto.createDiffieHellmanGroup(groupName);
    dh.generateKeys();
    return {
      privateKey: dh.getPrivateKey('base64'),
      publicKey: dh.getPublicKey('base64'),
      prime: dh.getPrime('base64'),
      generator: dh.getGenerator('base64'),
      group: groupName
    };
  }

  /**
   * Sinh cặp khóa DH (2048‑bit) – giữ lại để tương thích, nhưng gọi hàm chuẩn.
   */
  static generateKeyPair() {
    return DHExchange.generateStandardKeyPair('modp2048');
  }

  /**
   * Tính shared secret từ private key của mình và public key của đối tác.
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
   * 🆕 Ký dữ liệu bằng RSA/ECDSA private key (PEM).
   * @param {string} data – dữ liệu cần ký (thường là JSON string)
   * @param {string} privateKeyPem – private key ở định dạng PEM
   * @returns {string} chữ ký base64
   */
  static signWithPrivateKey(data, privateKeyPem) {
    const sign = crypto.createSign('SHA256');
    sign.update(data);
    sign.end();
    return sign.sign(privateKeyPem, 'base64');
  }

  /**
   * 🆕 Xác minh chữ ký bằng public key (PEM).
   * @param {string} data – dữ liệu đã ký
   * @param {string} signature – chữ ký base64
   * @param {string} publicKeyPem – public key ở định dạng PEM
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
