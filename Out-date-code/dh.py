# dh.py – Diffie-Hellman (RFC 5114 / modp2048) + RSA signing
# Đã sửa lỗi tái tạo private key từ raw x bằng DHPrivateNumbers + DHPublicNumbers

import os
import base64
import hashlib
import hmac
from cryptography.hazmat.primitives.asymmetric import dh, rsa, padding
from cryptography.hazmat.primitives.asymmetric.dh import DHPublicNumbers, DHPrivateNumbers
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.serialization import (
    Encoding, PublicFormat, PrivateFormat, NoEncryption,
    load_pem_private_key, load_pem_public_key
)

# ─── Nhóm DH chuẩn modp2048 (RFC 5114, giống hệt Node.js) ──────────────────
_MODP2048_PRIME_HEX = (
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
    "15728E5A8AACAA68FFFFFFFFFFFFFFFF"
)
_MODP2048_PRIME = int(_MODP2048_PRIME_HEX, 16)
_MODP2048_GENERATOR = 2
_PRIME_BYTES_LEN = (_MODP2048_PRIME.bit_length() + 7) // 8   # = 256


class DHExchange:
    # ───────────── DH chuẩn (RFC 5114 modp2048) ────────────────────
    @staticmethod
    def generate_standard_keypair(group_name='modp2048'):
        param_numbers = dh.DHParameterNumbers(_MODP2048_PRIME, _MODP2048_GENERATOR)
        parameters = param_numbers.parameters()
        private_key = parameters.generate_private_key()
        public_key = private_key.public_key()

        x = private_key.private_numbers().x
        raw_private_bytes = x.to_bytes(_PRIME_BYTES_LEN, 'big')

        y = public_key.public_numbers().y
        raw_public_bytes = y.to_bytes(_PRIME_BYTES_LEN, 'big')

        prime_bytes = _MODP2048_PRIME.to_bytes(_PRIME_BYTES_LEN, 'big')
        generator_bytes = _MODP2048_GENERATOR.to_bytes(1, 'big')

        return {
            'private_key': base64.b64encode(raw_private_bytes).decode(),
            'public_key': base64.b64encode(raw_public_bytes).decode(),
            'prime': base64.b64encode(prime_bytes).decode(),
            'generator': base64.b64encode(generator_bytes).decode(),
            'group': group_name
        }

    @staticmethod
    def generate_keypair():
        return DHExchange.generate_standard_keypair('modp2048')

    @staticmethod
    def compute_shared_secret(our_private_key_b64, their_public_key_b64, prime_b64, generator_b64):
        # Giải mã private key raw (x)
        raw_private = base64.b64decode(our_private_key_b64)
        x = int.from_bytes(raw_private, 'big')

        # Khôi phục prime, generator
        prime_bytes = base64.b64decode(prime_b64)
        generator_bytes = base64.b64decode(generator_b64)
        prime_int = int.from_bytes(prime_bytes, 'big')
        generator_int = int.from_bytes(generator_bytes, 'big')
        key_size = len(prime_bytes)

        # Xử lý public key đối tác (đệm nếu cần)
        their_pub_raw = base64.b64decode(their_public_key_b64)
        if len(their_pub_raw) < key_size:
            padded = b'\x00' * (key_size - len(their_pub_raw)) + their_pub_raw
            their_pub_raw = padded
        y_their = int.from_bytes(their_pub_raw, 'big')

        # Tạo tham số nhóm
        param_numbers = dh.DHParameterNumbers(prime_int, generator_int)
        parameters = param_numbers.parameters()

        # Tái tạo private key từ x (cần public key tương ứng)
        y_mine = pow(generator_int, x, prime_int)              # public key của chính mình
        mine_public_numbers = DHPublicNumbers(y_mine, param_numbers)
        private_numbers = DHPrivateNumbers(x, mine_public_numbers)
        private_key = private_numbers.private_key(parameters)

        # Tái tạo public key của đối tác
        their_public_numbers = DHPublicNumbers(y_their, param_numbers)
        their_public_key = their_public_numbers.public_key(parameters)

        shared = private_key.exchange(their_public_key)
        return base64.b64encode(shared).decode()

    @staticmethod
    def derive_session_key(shared_secret_b64):
        secret_bytes = base64.b64decode(shared_secret_b64)
        digest = hashlib.sha256(secret_bytes).digest()
        return base64.b64encode(digest).decode()

    @staticmethod
    def sign(message, session_key_b64):
        key = base64.b64decode(session_key_b64)
        return hmac.new(key, message.encode(), hashlib.sha256).hexdigest()

    @staticmethod
    def verify(message, signature, session_key_b64):
        expected = DHExchange.sign(message, session_key_b64)
        return hmac.compare_digest(expected, signature)

    # ───────────── RSA signing ─────────────────────────────
    @staticmethod
    def sign_with_private_key(data, private_key_pem):
        key = load_pem_private_key(private_key_pem.encode(), password=None)
        signature = key.sign(
            data.encode(),
            padding.PKCS1v15(),
            hashes.SHA256()
        )
        return base64.b64encode(signature).decode()

    @staticmethod
    def verify_with_public_key(data, signature_b64, public_key_pem):
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
