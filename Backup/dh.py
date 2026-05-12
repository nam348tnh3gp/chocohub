# dh.py – Diffie-Hellman key exchange & session utilities (Python)
import os
import base64
import hashlib
import hmac
from cryptography.hazmat.primitives.asymmetric import dh
from cryptography.hazmat.primitives.serialization import (
    Encoding, PublicFormat, PrivateFormat, NoEncryption
)

class DHExchange:
    @staticmethod
    def generate_keypair():
        """Sinh cặp khóa DH 2048-bit trả về base64 dict."""
        parameters = dh.generate_parameters(generator=2, key_size=2048)
        private_key = parameters.generate_private_key()
        public_key = private_key.public_key()

        prime_bytes = parameters.parameter_numbers().p.to_bytes(256, 'big')
        generator_bytes = parameters.parameter_numbers().g.to_bytes(1, 'big')

        return {
            'private_key': base64.b64encode(
                private_key.private_bytes(Encoding.DER, PrivateFormat.PKCS8, NoEncryption())
            ).decode(),
            'public_key': base64.b64encode(
                public_key.public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
            ).decode(),
            'prime': base64.b64encode(prime_bytes).decode(),
            'generator': base64.b64encode(generator_bytes).decode()
        }

    @staticmethod
    def compute_shared_secret(our_private_key_b64, their_public_key_b64, prime_b64, generator_b64):
        """Tính shared secret từ private key mình và public key đối tác."""
        from cryptography.hazmat.primitives.serialization import load_der_private_key, load_der_public_key

        private_key = load_der_private_key(base64.b64decode(our_private_key_b64), password=None)
        public_key = load_der_public_key(base64.b64decode(their_public_key_b64))

        shared = private_key.exchange(public_key)
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
