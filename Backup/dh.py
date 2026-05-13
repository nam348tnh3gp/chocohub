# dh.py – Diffie-Hellman (RFC 3526 / 7919 groups) + RSA signing for server authentication
import os
import base64
import hashlib
import hmac
from cryptography.hazmat.primitives.asymmetric import dh, rsa, padding
from cryptography.hazmat.primitives.asymmetric.dh import DHPublicNumbers
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.serialization import (
    Encoding, PublicFormat, PrivateFormat, NoEncryption,
    load_der_private_key, load_pem_private_key, load_pem_public_key
)

# ─── Nhóm DH chuẩn (prime, generator) ──────────────────
#      modp2048 (RFC 3526) – tương thích với Node.js crypto.createDiffieHellmanGroup('modp2048')
_MODP2048_PRIME = int(
    "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1"
    "29024E088A67CC74020BBEA63B139B22514A08798E3404DD"
    "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245"
    "E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED"
    "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D"
    "C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F"
    "83655D23DCA3AD961C62F356208552BB9ED529077096966D"
    "670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B"
    "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9"
    "DE2BCBF6955817183995497CEA956AE515D2261898FA0510"
    "15728E5A8AACAA68FFFFFFFFFFFFFFFF", 16
)
_MODP2048_GENERATOR = 2

class DHExchange:
    # ───────────── DH tiêu chuẩn (RFC) ────────────────────
    @staticmethod
    def generate_standard_keypair(prime_int=_MODP2048_PRIME, generator_int=_MODP2048_GENERATOR):
        """Tạo cặp khóa DH từ nhóm chuẩn (mặc định modp2048).
        Public key được xuất dạng raw bytes (tương thích Node.js).
        """
        param_numbers = dh.DHParameterNumbers(prime_int, generator_int)
        parameters = param_numbers.parameters()
        private_key = parameters.generate_private_key()
        public_key = private_key.public_key()

        # Lấy raw bytes của public key (số nguyên y, big‑endian)
        y = public_key.public_numbers().y
        key_size = (prime_int.bit_length() + 7) // 8
        raw_public_bytes = y.to_bytes(key_size, 'big')

        # Lấy prime và generator dưới dạng bytes (big‑endian)
        prime_bytes = prime_int.to_bytes(key_size, 'big')
        generator_bytes = generator_int.to_bytes(1, 'big')

        return {
            'private_key': base64.b64encode(
                private_key.private_bytes(Encoding.DER, PrivateFormat.PKCS8, NoEncryption())
            ).decode(),
            'public_key': base64.b64encode(raw_public_bytes).decode(),
            'prime': base64.b64encode(prime_bytes).decode(),
            'generator': base64.b64encode(generator_bytes).decode(),
            'group': 'modp2048'
        }

    @staticmethod
    def generate_keypair():
        """Giữ lại method cũ (dùng nhóm chuẩn modp2048)."""
        return DHExchange.generate_standard_keypair()

    @staticmethod
    def compute_shared_secret(our_private_key_b64, their_public_key_b64, prime_b64, generator_b64):
        """Tính shared secret từ private key mình và public key đối tác.
        their_public_key_b64 là raw bytes (tương thích Node.js).
        """
        # Giải mã khóa riêng (PKCS8 DER)
        private_key = load_der_private_key(base64.b64decode(our_private_key_b64), password=None)

        # Khôi phục tham số nhóm từ prime và generator
        prime_bytes = base64.b64decode(prime_b64)
        generator_bytes = base64.b64decode(generator_b64)
        prime_int = int.from_bytes(prime_bytes, 'big')
        generator_int = int.from_bytes(generator_bytes, 'big')
        param_numbers = dh.DHParameterNumbers(prime_int, generator_int)
        parameters = param_numbers.parameters()

        # Tạo public key từ raw bytes (tương thích mọi phiên bản cryptography)
        their_public_bytes = base64.b64decode(their_public_key_b64)
        their_y = int.from_bytes(their_public_bytes, 'big')
        their_public_numbers = DHPublicNumbers(their_y, param_numbers)
        their_public_key = their_public_numbers.public_key()

        shared = private_key.exchange(their_public_key)
        return base64.b64encode(shared).decode()

    @staticmethod
    def derive_session_key(shared_secret_b64):
        """Dẫn xuất session key từ shared secret (SHA-256)."""
        return base64.b64encode(
            hashlib.sha256(base64.b64decode(shared_secret_b64)).digest()
        ).decode()

    @staticmethod
    def sign(message, session_key_b64):
        """Tạo chữ ký HMAC-SHA256 cho thông điệp."""
        key = base64.b64decode(session_key_b64)
        return hmac.new(key, message.encode(), hashlib.sha256).hexdigest()

    @staticmethod
    def verify(message, signature, session_key_b64):
        """Xác minh chữ ký HMAC (so sánh an toàn)."""
        expected = DHExchange.sign(message, session_key_b64)
        return hmac.compare_digest(expected, signature)

    # ───────────── RSA signing (server authentication) ────
    @staticmethod
    def sign_with_private_key(data, private_key_pem):
        """Ký dữ liệu bằng RSA private key (PEM)."""
        key = load_pem_private_key(private_key_pem.encode(), password=None)
        signature = key.sign(
            data.encode(),
            padding.PKCS1v15(),
            hashes.SHA256()
        )
        return base64.b64encode(signature).decode()

    @staticmethod
    def verify_with_public_key(data, signature_b64, public_key_pem):
        """Xác minh chữ ký bằng RSA public key (PEM)."""
        try:
            key = load_pem_public_key(public_key_pem.encode())
            key.verify(
                base64.b64decode(signature_b64),
                data.encode(),
                padding.PKCS1v15(),
                hashes.SHA256()
            )
            return True
        except Exception:
            return False
